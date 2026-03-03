"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { WebSocket } = require("ws");

const ROOT = path.join(__dirname, "..");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.max(0, Math.floor(sorted.length * q) - 1);
  return sorted[idx];
}

function stddev(values) {
  if (!values.length) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const varSum = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(varSum);
}

async function waitFor(condition, timeoutMs = 12000, stepMs = 80) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) return;
    await sleep(stepMs);
  }
  throw new Error("timeout");
}

class Bot {
  constructor(url, name) {
    this.url = url;
    this.name = name;
    this.ws = null;
    this.id = null;
    this.roomId = null;
    this.stateDeltas = [];
    this.lastStateAt = 0;
    this.pingRawValues = [];
    this.actions = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on("open", () => {
        this.send({ type: "join", name: this.name });
        resolve();
      });
      this.ws.on("message", (buf) => this.onMessage(String(buf)));
      this.ws.on("error", reject);
    });
  }

  onMessage(payload) {
    let msg = null;
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    if (msg.type === "welcome") {
      this.id = msg.id;
    } else if (msg.type === "roomJoined") {
      this.roomId = String(msg?.room?.roomId || this.roomId || "");
    } else if (msg.type === "actionResult") {
      this.actions.set(msg.action, msg);
      if (msg.action === "createRoom" && msg.ok && msg.roomId != null) {
        this.roomId = String(msg.roomId);
      }
    } else if (msg.type === "state") {
      const now = Date.now();
      if (this.lastStateAt > 0) this.stateDeltas.push(now - this.lastStateAt);
      this.lastStateAt = now;
    } else if (msg.type === "myPing" && Number.isFinite(msg.pingRaw)) {
      this.pingRawValues.push(Number(msg.pingRaw));
    }
  }

  send(msg) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(msg));
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}

async function startServer(port, envOverrides) {
  const proc = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ...envOverrides },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", () => {});
  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      return res.ok;
    } catch {
      return false;
    }
  }, 15000, 120);
  return proc;
}

async function runVariant(variant) {
  const port = 4200 + Math.floor(Math.random() * 1000);
  const proc = await startServer(port, variant.env);
  const wsUrl = `ws://127.0.0.1:${port}`;
  const bots = Array.from({ length: 4 }, (_, i) => new Bot(wsUrl, `Bench${variant.name}-${i + 1}`));
  try {
    await Promise.all(bots.map((b) => b.connect()));
    await sleep(300);

    bots[0].send({ type: "createRoom", roomName: `Bench ${variant.name}` });
    await waitFor(() => Boolean(bots[0].roomId), 8000);
    const roomId = bots[0].roomId;
    for (let i = 1; i < bots.length; i++) {
      bots[i].send({ type: "joinRoom", roomId });
    }
    await waitFor(() => bots.every((b) => b.roomId === roomId), 8000);

    bots[0].send({ type: "team", team: "red" });
    bots[1].send({ type: "team", team: "blue" });
    bots[2].send({ type: "team", team: "red" });
    bots[3].send({ type: "team", team: "blue" });
    await sleep(200);
    bots[0].send({ type: "start" });

    const sampleMs = 8500;
    const inputInterval = setInterval(() => {
      for (let i = 0; i < bots.length; i++) {
        const left = Math.random() > 0.5;
        const up = Math.random() > 0.5;
        bots[i].send({ type: "input", keys: { left, right: !left, up, down: !up, kick: Math.random() > 0.8 } });
      }
    }, 50);
    await sleep(sampleMs);
    clearInterval(inputInterval);

    const netRes = await fetch(`http://127.0.0.1:${port}/debug/network`);
    const netJson = await netRes.json();
    const nonHost = bots.slice(1);
    const combinedDeltas = nonHost.flatMap((b) => b.stateDeltas);
    const combinedPingRaw = nonHost.flatMap((b) => b.pingRawValues);

    const result = {
      variant: variant.name,
      samples: {
        stateDeltaCount: combinedDeltas.length,
        pingRawCount: combinedPingRaw.length,
      },
      stateDelta: {
        p50Ms: Math.round(percentile(combinedDeltas, 0.5)),
        p95Ms: Math.round(percentile(combinedDeltas, 0.95)),
        maxMs: Math.round(Math.max(...combinedDeltas, 0)),
        stdMs: Math.round(stddev(combinedDeltas) * 100) / 100,
      },
      pingRaw: {
        p50Ms: Math.round(percentile(combinedPingRaw, 0.5)),
        p95Ms: Math.round(percentile(combinedPingRaw, 0.95)),
        stdMs: Math.round(stddev(combinedPingRaw) * 100) / 100,
      },
      server: netJson.network || {},
      config: netJson.config || {},
    };
    return result;
  } finally {
    for (const bot of bots) bot.close();
    proc.kill("SIGTERM");
    await sleep(120);
  }
}

function inferRootCause(run) {
  const reasons = [];
  const score = { serverTiming: 0, socketBackpressure: 0, arrivalJitter: 0 };
  if ((run.server?.accumulatorResets || 0) > 0 || (run.server?.tickElapsedP95Ms || 0) > 20) {
    score.serverTiming += 2;
    reasons.push("tick catch-up/reset gözlendi");
  }
  if ((run.server?.wsBufferedP95Bytes || 0) > 4096 || (run.server?.wsBufferedMaxBytes || 0) > 32768) {
    score.socketBackpressure += 2;
    reasons.push("socket bufferedAmount yükseldi");
  }
  if ((run.stateDelta?.stdMs || 0) > 8 || (run.stateDelta?.p95Ms || 0) > (run.config?.stateBroadcastMs || 33) * 1.6) {
    score.arrivalJitter += 2;
    reasons.push("state inter-arrival jitter yüksek");
  }
  const maxScore = Math.max(...Object.values(score));
  const dominant = maxScore > 0
    ? Object.entries(score).sort((a, b) => b[1] - a[1])[0][0]
    : "inconclusive";
  return { dominant, reasons };
}

async function main() {
  const variants = [
    {
      name: "baseline-30hz",
      env: {
        STATE_BROADCAST_HZ: "30",
        PING_SMOOTHING_ALPHA: "0.15",
        ENABLE_EXTRAPOLATION: "1",
      },
    },
    {
      name: "low-20hz",
      env: {
        STATE_BROADCAST_HZ: "20",
        PING_SMOOTHING_ALPHA: "0.15",
        ENABLE_EXTRAPOLATION: "1",
      },
    },
    {
      name: "high-45hz",
      env: {
        STATE_BROADCAST_HZ: "45",
        PING_SMOOTHING_ALPHA: "0.15",
        ENABLE_EXTRAPOLATION: "1",
      },
    },
    {
      name: "no-extrap-30hz",
      env: {
        STATE_BROADCAST_HZ: "30",
        PING_SMOOTHING_ALPHA: "0.15",
        ENABLE_EXTRAPOLATION: "0",
      },
    },
    {
      name: "high-smooth-30hz",
      env: {
        STATE_BROADCAST_HZ: "30",
        PING_SMOOTHING_ALPHA: "0.35",
        ENABLE_EXTRAPOLATION: "1",
      },
    },
  ];

  const results = [];
  for (const variant of variants) {
    const run = await runVariant(variant);
    run.rootCause = inferRootCause(run);
    results.push(run);
    console.log(
      `[${run.variant}] delta p95=${run.stateDelta.p95Ms}ms std=${run.stateDelta.stdMs} pingRaw p95=${run.pingRaw.p95Ms} tickP95=${run.server.tickElapsedP95Ms}`,
    );
  }

  console.log("\n=== LAN jitter analysis summary ===");
  for (const run of results) {
    console.log(
      `${run.variant.padEnd(16)} | deltaP95=${String(run.stateDelta.p95Ms).padStart(3)}ms | deltaStd=${String(run.stateDelta.stdMs).padStart(6)} | pingRawP95=${String(run.pingRaw.p95Ms).padStart(3)}ms | cause=${run.rootCause.dominant}`,
    );
  }
  console.log("\nJSON:");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
