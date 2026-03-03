"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { WebSocket } = require("ws");

const ROOT = path.join(__dirname, "..");

function waitFor(condition, timeoutMs = 10000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await condition()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 80);
    };
    void tick();
  });
}

test("debug network endpoint includes telemetry and recommendations", async () => {
  const port = 3600 + Math.floor(Math.random() * 200);
  const proc = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SERVER_JITTER_BUFFER_MS: "30",
      ENABLE_EXTRAPOLATION: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let ws = null;
  try {
    await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        return res.ok;
      } catch {
        return false;
      }
    }, 12000);

    const welcome = await new Promise((resolve, reject) => {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const timeoutId = setTimeout(() => reject(new Error("welcome timeout")), 5000);
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "join", name: "TelemetryTest" }));
      });
      ws.on("message", (buf) => {
        const msg = JSON.parse(String(buf));
        if (msg.type === "welcome") {
          clearTimeout(timeoutId);
          resolve(msg);
        }
      });
      ws.on("error", reject);
    });

    assert.equal(typeof welcome.stateTickMs, "number");
    assert.equal(typeof welcome.jitterBufferMs, "number");
    assert.equal(typeof welcome.extrapolationEnabled, "boolean");
    assert.equal(welcome.extrapolationEnabled, false);
    assert.equal(welcome.jitterBufferMs, 30);

    const netRes = await fetch(`http://127.0.0.1:${port}/debug/network`);
    assert.equal(netRes.ok, true);
    const payload = await netRes.json();
    assert.equal(payload.ok, true);
    assert.equal(typeof payload.config.stateBroadcastHz, "number");
    assert.equal(typeof payload.config.serverJitterBufferMs, "number");
    assert.equal(typeof payload.network.tickElapsedP95Ms, "number");
    assert.equal(typeof payload.network.wsBufferedP95Bytes, "number");
    assert.equal(Array.isArray(payload.rooms), true);
    assert.equal(Array.isArray(payload.recommendations), true);

    ws.send(
      JSON.stringify({
        type: "netTelemetry",
        stateDeltaP95Ms: 42,
        stateDeltaMaxMs: 95,
        jitterBufferMs: 28,
        extrapolationEnabled: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    const netRes2 = await fetch(`http://127.0.0.1:${port}/debug/network`);
    const payload2 = await netRes2.json();
    assert.equal(Array.isArray(payload2.rooms), true);
  } finally {
    try {
      ws?.close();
    } catch {}
    proc.kill("SIGTERM");
  }
});
