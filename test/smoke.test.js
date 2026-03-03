"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { WebSocket } = require("ws");

const ROOT = path.join(__dirname, "..");

function waitFor(condition, timeoutMs = 8000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      const ok = await condition();
      if (ok) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 80);
    };
    void tick();
  });
}

test("server boots and lobby action flow returns actionResult", async () => {
  const port = 3400 + Math.floor(Math.random() * 200);
  const proc = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        return res.ok;
      } catch {
        return false;
      }
    }, 10000);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let gotRoomList = false;
    let gotCreateRoomResult = false;
    let gotRoomJoined = false;
    await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error("ws timeout")), 6000);
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "join", name: "Smoke" }));
      });
      ws.on("message", (buf) => {
        const msg = JSON.parse(String(buf));
        if (msg.type === "roomList") {
          gotRoomList = true;
          ws.send(JSON.stringify({ type: "createRoom", roomName: "Smoke Room" }));
        }
        if (msg.type === "roomJoined") {
          gotRoomJoined = true;
        }
        if (msg.type === "actionResult" && msg.action === "createRoom" && msg.ok) {
          gotCreateRoomResult = true;
        }
        if (gotRoomList && gotRoomJoined && gotCreateRoomResult) {
          clearTimeout(timeoutId);
          ws.close();
          resolve();
        }
      });
      ws.on("error", reject);
    });
    assert.equal(gotRoomList, true);
    assert.equal(gotRoomJoined, true);
    assert.equal(gotCreateRoomResult, true);
  } finally {
    proc.kill("SIGTERM");
  }
});
