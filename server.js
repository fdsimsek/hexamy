const express = require("express");
const http = require("node:http");
const crypto = require("node:crypto");
const { WebSocketServer } = require("ws");
const os = require("node:os");
const path = require("node:path");
const logger = require("./lib/logger");
const { validateMessageShape } = require("./lib/validation");
const { loadStore, saveStore } = require("./lib/persistence");
const { Metrics } = require("./lib/metrics");

const app = express();
const server = http.createServer(app);
const MAX_WS_PAYLOAD_BYTES = Number(
  process.env.MAX_WS_PAYLOAD_BYTES || 16 * 1024,
);
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS || 64);
const MAX_BUFFERED_AMOUNT_BYTES = Number(
  process.env.MAX_BUFFERED_AMOUNT_BYTES || 512 * 1024,
);
const STATE_BROADCAST_HZ = Number(process.env.STATE_BROADCAST_HZ || 30);
const STATE_BROADCAST_MS = Math.max(
  12,
  1000 / Math.max(10, STATE_BROADCAST_HZ),
);
const SERVER_JITTER_BUFFER_MS = Number(
  process.env.SERVER_JITTER_BUFFER_MS || 24,
);
const MAX_UPDATES_PER_CYCLE = Number(process.env.MAX_UPDATES_PER_CYCLE || 2);
const ENABLE_EXTRAPOLATION = !["0", "false", "off"].includes(
  String(process.env.ENABLE_EXTRAPOLATION || "1").toLowerCase(),
);
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS || 200);
const PING_SCAN_INTERVAL_MS = Number(process.env.PING_SCAN_INTERVAL_MS || 50);
const PING_JITTER_MS = Number(process.env.PING_JITTER_MS || 10);
const PONG_TIMEOUT_MS = Number(process.env.PONG_TIMEOUT_MS || 6000);
const PING_SMOOTHING_ALPHA = Number(process.env.PING_SMOOTHING_ALPHA || 0.15);
const PING_MIN_GAP_MS = Number(process.env.PING_MIN_GAP_MS || 150);
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 1000);
const RATE_LIMIT_PER_WINDOW = {
  input: Number(process.env.RATE_LIMIT_INPUT || 120),
  chat: Number(process.env.RATE_LIMIT_CHAT || 10),
  team: Number(process.env.RATE_LIMIT_TEAM || 8),
  join: Number(process.env.RATE_LIMIT_JOIN || 5),
  listRooms: Number(process.env.RATE_LIMIT_LIST_ROOMS || 20),
  createRoom: Number(process.env.RATE_LIMIT_CREATE_ROOM || 6),
  joinRoom: Number(process.env.RATE_LIMIT_JOIN_ROOM || 12),
  leaveRoom: Number(process.env.RATE_LIMIT_LEAVE_ROOM || 8),
  settings: Number(process.env.RATE_LIMIT_SETTINGS || 30),
  resetSettings: Number(process.env.RATE_LIMIT_RESET_SETTINGS || 6),
  start: Number(process.env.RATE_LIMIT_START || 6),
  pause: Number(process.env.RATE_LIMIT_PAUSE || 6),
  resume: Number(process.env.RATE_LIMIT_RESUME || 6),
  restart: Number(process.env.RATE_LIMIT_RESTART || 6),
  transferHost: Number(process.env.RATE_LIMIT_TRANSFER_HOST || 8),
  netTelemetry: Number(process.env.RATE_LIMIT_NET_TELEMETRY || 8),
  default: Number(process.env.RATE_LIMIT_DEFAULT || 40),
};
const wss = new WebSocketServer({
  server,
  maxPayload: MAX_WS_PAYLOAD_BYTES,
  perMessageDeflate: false,
});

app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 3000);

function p95(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.max(0, Math.floor(sorted.length * 0.95) - 1);
  return sorted[idx];
}

function pushSample(samples, value, cap = 180) {
  if (!Number.isFinite(value)) return;
  if (samples.length >= cap) samples.shift();
  samples.push(value);
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function pickValue(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function emptyRoomNetStats() {
  return {
    tickElapsedSamples: [],
    catchupUpdates: 0,
    accumulatorResets: 0,
    droppedAccumulatorMs: 0,
    immediateSchedules: 0,
    timeoutSchedules: 0,
    bufferedSamples: [],
    bufferedMaxBytes: 0,
    stateBursts: 0,
  };
}

function summarizeNetworkStats() {
  const summary = {
    roomCount: rooms.size,
    activeWsClients: clients.size,
    tickElapsedP95Ms: 0,
    tickElapsedMaxMs: 0,
    catchupUpdates: 0,
    accumulatorResets: 0,
    droppedAccumulatorMs: 0,
    immediateSchedules: 0,
    timeoutSchedules: 0,
    wsBufferedP95Bytes: 0,
    wsBufferedMaxBytes: 0,
    stateBursts: 0,
  };
  const allTickSamples = [];
  const allBufferedSamples = [];
  for (const room of rooms.values()) {
    if (!room?.netStats) continue;
    allTickSamples.push(...room.netStats.tickElapsedSamples);
    allBufferedSamples.push(...room.netStats.bufferedSamples);
    summary.catchupUpdates += room.netStats.catchupUpdates || 0;
    summary.accumulatorResets += room.netStats.accumulatorResets || 0;
    summary.droppedAccumulatorMs += room.netStats.droppedAccumulatorMs || 0;
    summary.immediateSchedules += room.netStats.immediateSchedules || 0;
    summary.timeoutSchedules += room.netStats.timeoutSchedules || 0;
    summary.stateBursts += room.netStats.stateBursts || 0;
    summary.wsBufferedMaxBytes = Math.max(
      summary.wsBufferedMaxBytes,
      Number(room.netStats.bufferedMaxBytes) || 0,
    );
  }
  summary.tickElapsedP95Ms = Math.round(p95(allTickSamples) * 100) / 100;
  summary.tickElapsedMaxMs = round2(Math.max(...allTickSamples, 0));
  summary.wsBufferedP95Bytes = Math.round(p95(allBufferedSamples));
  summary.droppedAccumulatorMs = round2(summary.droppedAccumulatorMs);
  return summary;
}

function summarizeRoomsDetailed() {
  const roomsData = [];
  for (const room of rooms.values()) {
    const roomClients = getRoomClients(room);
    const clientRows = roomClients
      .filter((c) => c.team === "red" || c.team === "blue")
      .map((client) => ({
        id: client.id,
        name: client.name,
        team: client.team,
        pingMs: pickValue(client.pingMs, null),
        pingRawMs: pickValue(client.pingRawMs, null),
        clientStateDeltaP95Ms: pickValue(
          client.netTelemetry?.stateDeltaP95Ms,
          null,
        ),
        clientStateDeltaMaxMs: pickValue(
          client.netTelemetry?.stateDeltaMaxMs,
          null,
        ),
        clientJitterBufferMs: pickValue(
          client.netTelemetry?.jitterBufferMs,
          null,
        ),
        clientExtrapolationEnabled:
          client.netTelemetry?.extrapolationEnabled ?? null,
        telemetryAgeMs: client.netTelemetry?.updatedAt
          ? Math.max(0, Date.now() - client.netTelemetry.updatedAt)
          : null,
      }));
    const deltas = clientRows
      .map((row) => row.clientStateDeltaP95Ms)
      .filter((value) => Number.isFinite(value));
    const rawPings = clientRows
      .map((row) => row.pingRawMs)
      .filter((value) => Number.isFinite(value));
    roomsData.push({
      id: room.id,
      name: room.name,
      roomType: room.roomType,
      gameState: room.gameState,
      playerCount: clientRows.length,
      stateDeltaP95Ms: Math.round(p95(deltas)),
      pingRawP95Ms: Math.round(p95(rawPings)),
      clients: clientRows,
    });
  }
  return roomsData;
}

function buildNetworkRecommendations(networkSummary, roomBreakdown) {
  const recs = [];
  if (
    (networkSummary.wsBufferedP95Bytes || 0) > 4096 ||
    (networkSummary.wsBufferedMaxBytes || 0) > 65536
  ) {
    recs.push(
      "Socket kuyruk baskisi var: STATE_BROADCAST_HZ dusur veya payloadi sadeleştir.",
    );
  }
  if (
    (networkSummary.accumulatorResets || 0) > 0 ||
    (networkSummary.tickElapsedP95Ms || 0) > 19
  ) {
    recs.push(
      "Server tick timing zorlanıyor: MAX_UPDATES_PER_CYCLE=2/3 ve yayin Hz dengesini test et.",
    );
  }
  const highDeltaRooms = roomBreakdown.filter(
    (room) => (room.stateDeltaP95Ms || 0) > 45,
  );
  if (highDeltaRooms.length > 0) {
    recs.push(
      "Client inter-arrival jitter yuksek: SERVER_JITTER_BUFFER_MS 24->32 ve extrapolation kapali A/B dene.",
    );
  }
  if (recs.length === 0) {
    recs.push(
      "Belirgin server-side darboğaz görünmüyor; Wi-Fi parazit/kanal yoğunluğu ve cihaz FPS tarafını kontrol et.",
    );
  }
  return recs;
}

function calculateP95Ping() {
  const values = [];
  for (const [, client] of clients) {
    if (Number.isFinite(client.pingMs)) values.push(client.pingMs);
  }
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  const idx = Math.max(0, Math.floor(values.length * 0.95) - 1);
  return values[idx];
}

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    wsClients: clients.size,
    rooms: rooms.size,
  });
});

app.get("/readyz", (_req, res) => {
  const ready = !shuttingDown;
  res.status(ready ? 200 : 503).json({
    ready,
    wsClients: clients.size,
    rooms: rooms.size,
  });
});

app.get("/metrics", (_req, res) => {
  const net = summarizeNetworkStats();
  metrics.setGauge("wsClients", clients.size);
  metrics.setGauge("activeRooms", rooms.size);
  metrics.setGauge("p95PingMs", calculateP95Ping());
  metrics.setGauge("tickElapsedP95Ms", net.tickElapsedP95Ms);
  metrics.setGauge("tickElapsedMaxMs", net.tickElapsedMaxMs);
  metrics.setGauge("tickAccumulatorResets", net.accumulatorResets);
  metrics.setGauge("tickDroppedAccumulatorMs", net.droppedAccumulatorMs);
  metrics.setGauge("tickImmediateSchedules", net.immediateSchedules);
  metrics.setGauge("tickTimeoutSchedules", net.timeoutSchedules);
  metrics.setGauge("wsBufferedP95Bytes", net.wsBufferedP95Bytes);
  metrics.setGauge("wsBufferedMaxBytes", net.wsBufferedMaxBytes);
  metrics.setGauge("stateBursts", net.stateBursts);
  res.type("text/plain").send(metrics.toPrometheus());
});

app.get("/debug/network", (_req, res) => {
  const net = summarizeNetworkStats();
  const roomBreakdown = summarizeRoomsDetailed();
  const pingValues = [];
  const pingRawValues = [];
  for (const [, client] of clients) {
    if (Number.isFinite(client.pingMs)) pingValues.push(client.pingMs);
    if (Number.isFinite(client.pingRawMs)) pingRawValues.push(client.pingRawMs);
  }
  res.json({
    ok: true,
    sampledAt: Date.now(),
    config: {
      stateBroadcastHz: STATE_BROADCAST_HZ,
      stateBroadcastMs: Math.round(STATE_BROADCAST_MS * 100) / 100,
      maxUpdatesPerCycle: MAX_UPDATES_PER_CYCLE,
      maxCatchupSteps: MAX_CATCHUP_STEPS,
      pingIntervalMs: PING_INTERVAL_MS,
      pingScanIntervalMs: PING_SCAN_INTERVAL_MS,
      pingSmoothingAlpha: PING_SMOOTHING_ALPHA,
      serverJitterBufferMs: SERVER_JITTER_BUFFER_MS,
      enableExtrapolation: ENABLE_EXTRAPOLATION,
    },
    ping: {
      clientsWithPing: pingValues.length,
      p95Ms: Math.round(p95(pingValues)),
      p95RawMs: Math.round(p95(pingRawValues)),
    },
    network: net,
    rooms: roomBreakdown,
    recommendations: buildNetworkRecommendations(net, roomBreakdown),
  });
});

app.get("/api/leaderboard", (_req, res) => {
  const rows = Object.values(store.players)
    .sort((a, b) => (b.elo || 1000) - (a.elo || 1000))
    .slice(0, 30);
  res.json({
    season: store.season,
    leaderboard: rows,
  });
});

// ============ GAME CONSTANTS ============

const SCALE = 0.64;
const W = 1100;
const H = 640;
const CX = W / 2;
const CY = H / 2;

const FIELD_HW = 594.56 * SCALE;
const FIELD_HH = 297.28 * SCALE;
const FIELD_X1 = CX - FIELD_HW;
const FIELD_X2 = CX + FIELD_HW;
const FIELD_Y1 = CY - FIELD_HH;
const FIELD_Y2 = CY + FIELD_HH;

const GOAL_HH = 88.08 * SCALE;
const GOAL_DEPTH = 55 * SCALE;
const GOAL_Y1 = CY - GOAL_HH;
const GOAL_Y2 = CY + GOAL_HH;
const GOAL_POST_R = 8.8 * SCALE;
const KICKOFF_R = 88 * SCALE;

const PLAYER_R = 15 * SCALE * 1.35;
const BALL_R = 7 * SCALE;
const PLAYER_OUTSIDE_MARGIN = 60 * SCALE;

const DEFAULT_GAME_SETTINGS = {
  playerAccel: 0.1 * SCALE,
  playerDamping: 0.96,
  playerKickAccel: 0.07 * SCALE,
  playerKickDamping: 0.96,
  kickStrength: 6 * SCALE,
  kickRangeBonus: 4,
  ballDamping: 0.99,
  playerSizeScale: 1,
  fieldScale: 1,
  winScore: 5,
};

const SETTINGS_LIMITS = {
  playerAccel: [0.03 * SCALE, 0.2 * SCALE],
  playerDamping: [0.85, 0.995],
  playerKickAccel: [0.02 * SCALE, 0.18 * SCALE],
  playerKickDamping: [0.85, 0.995],
  kickStrength: [2 * SCALE, 12 * SCALE],
  kickRangeBonus: [0, 24],
  ballDamping: [0.93, 0.999],
  playerSizeScale: [0.7, 1.35],
  fieldScale: [0.8, 1.25],
  winScore: [1, 50],
};

const PLAYER_INV_MASS = 0.5;
const BALL_INV_MASS = 1;
const WIN_SCORE = 5;
const GOAL_CELEBRATION_FRAMES = 300;
const SPAWN_DIST = 170 * SCALE;
const MAX_TEAM_SIZE = 4;
const TICK_MS = 1000 / 60;
const BROADCAST_EVERY_N_TICKS = Math.max(
  1,
  Math.round(STATE_BROADCAST_MS / TICK_MS),
);
const MAX_CATCHUP_STEPS = 4;
const PASSWORD_FAIL_WINDOW_MS = 10000;
const PASSWORD_FAIL_LIMIT = 8;
const ROOM_NAME_MAX_LEN = 28;
const ROOM_PASSWORD_MAX_LEN = 64;
const RECONNECT_TTL_MS = Number(process.env.RECONNECT_TTL_MS || 30000);
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((it) => it.trim())
  .filter(Boolean);
const BANNED_CHAT_TERMS = String(
  process.env.BANNED_CHAT_TERMS || "aq,salak,mal,oç,oc,amk,anan",
)
  .split(",")
  .map((it) => it.trim().toLowerCase())
  .filter(Boolean);
const CHAT_FLOOD_WINDOW_MS = Number(process.env.CHAT_FLOOD_WINDOW_MS || 6000);
const CHAT_FLOOD_LIMIT = Number(process.env.CHAT_FLOOD_LIMIT || 5);
const QUICK_CHAT_MAP = {
  hype: "Hadi baski!",
  pass: "Pas ver!",
  defend: "Defansa don!",
  gg: "GG!",
};

const goalPosts = [
  { x: FIELD_X1, y: GOAL_Y1, r: GOAL_POST_R },
  { x: FIELD_X1, y: GOAL_Y2, r: GOAL_POST_R },
  { x: FIELD_X2, y: GOAL_Y1, r: GOAL_POST_R },
  { x: FIELD_X2, y: GOAL_Y2, r: GOAL_POST_R },
];

function getFieldMetrics(room) {
  const fieldScale = clamp(
    Number(room?.gameSettings?.fieldScale) || 1,
    0.8,
    1.25,
  );
  const hw = FIELD_HW * fieldScale;
  const hh = FIELD_HH * fieldScale;
  const goalHH = GOAL_HH * fieldScale;
  const goalDepth = GOAL_DEPTH * fieldScale;
  const kickoffR = KICKOFF_R * fieldScale;
  return {
    fieldScale,
    x1: CX - hw,
    x2: CX + hw,
    y1: CY - hh,
    y2: CY + hh,
    goalY1: CY - goalHH,
    goalY2: CY + goalHH,
    goalDepth,
    kickoffR,
    goalPosts: [
      { x: CX - hw, y: CY - goalHH, r: GOAL_POST_R },
      { x: CX - hw, y: CY + goalHH, r: GOAL_POST_R },
      { x: CX + hw, y: CY - goalHH, r: GOAL_POST_R },
      { x: CX + hw, y: CY + goalHH, r: GOAL_POST_R },
    ],
  };
}

function getPlayerRadius(room) {
  const playerScale = clamp(
    Number(room?.gameSettings?.playerSizeScale) || 1,
    0.7,
    1.35,
  );
  return PLAYER_R * playerScale;
}

// ============ GLOBAL STATE ============

let nextId = 1;
let nextRoomId = 1;
const clients = new Map(); // ws -> client
const clientsById = new Map(); // id -> client
const rooms = new Map(); // roomId -> room
const reconnectSessions = new Map(); // token -> session snapshot
let pingInterval = null;
let shuttingDown = false;
const metrics = new Metrics();
const store = loadStore();

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sanitizeSettings(rawSettings, currentSettings) {
  const next = { ...currentSettings };
  if (!rawSettings || typeof rawSettings !== "object") return next;
  for (const [key, [min, max]] of Object.entries(SETTINGS_LIMITS)) {
    const value = Number(rawSettings[key]);
    if (!Number.isFinite(value)) continue;
    next[key] = clamp(value, min, max);
  }
  return next;
}

function sanitizeName(rawName, fallback) {
  const name = String(rawName ?? "")
    .trim()
    .slice(0, 16);
  return name || fallback;
}

function sanitizeRoomName(rawName, fallback) {
  const name = String(rawName ?? "")
    .trim()
    .slice(0, ROOM_NAME_MAX_LEN);
  return name || fallback;
}

function sanitizePassword(rawPassword) {
  if (rawPassword == null) return "";
  return String(rawPassword).slice(0, ROOM_PASSWORD_MAX_LEN);
}

function sanitizeRoomType(rawType) {
  return rawType === "ranked" ? "ranked" : "casual";
}

function createReconnectToken() {
  return crypto.randomBytes(18).toString("base64url");
}

function cleanupReconnectSessions() {
  const now = Date.now();
  for (const [token, session] of reconnectSessions) {
    if (session.expiresAt <= now) reconnectSessions.delete(token);
  }
}

function sanitizeChatText(rawText) {
  let text = String(rawText ?? "")
    .trim()
    .slice(0, 180);
  if (!text) return "";
  const lowered = text.toLowerCase();
  for (const term of BANNED_CHAT_TERMS) {
    if (!term) continue;
    if (lowered.includes(term)) {
      const mask = "*".repeat(Math.min(term.length, 6));
      text = text.replace(new RegExp(term, "gi"), mask);
    }
  }
  return text;
}

function getPlayerStoreEntryByClient(client) {
  const key = client.reconnectToken;
  if (!store.players[key]) {
    store.players[key] = {
      key,
      name: client.name,
      elo: 1000,
      matches: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      goals: 0,
      assists: 0,
      weeklyQuests: {
        goals3: 0,
        assists2: 0,
        wins2: 0,
      },
      updatedAt: Date.now(),
    };
  }
  return store.players[key];
}

function updateWeeklyQuests(entry, matchStats, didWin) {
  if (!entry?.weeklyQuests)
    entry.weeklyQuests = { goals3: 0, assists2: 0, wins2: 0 };
  if ((matchStats.goals || 0) >= 3) entry.weeklyQuests.goals3 = 1;
  if ((matchStats.assists || 0) >= 2) entry.weeklyQuests.assists2 = 1;
  if (didWin)
    entry.weeklyQuests.wins2 = Math.min(2, (entry.weeklyQuests.wins2 || 0) + 1);
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHashHex) {
  const candidateHex = crypto.scryptSync(password, salt, 64).toString("hex");
  const expected = Buffer.from(expectedHashHex, "hex");
  const candidate = Buffer.from(candidateHex, "hex");
  if (expected.length !== candidate.length) return false;
  return crypto.timingSafeEqual(expected, candidate);
}

function createRoomState(name, password, roomType = "casual", settings = null) {
  const roomId = String(nextRoomId++);
  const room = {
    id: roomId,
    name,
    roomType: sanitizeRoomType(roomType),
    createdAt: Date.now(),
    passwordSalt: null,
    passwordHash: null,
    clientIds: new Set(),
    joinOrder: new Map(),
    nextJoinSeq: 1,
    hostId: null,
    gameState: "lobby",
    ball: { x: CX, y: CY, vx: 0, vy: 0, r: BALL_R, isBall: true },
    scoreRed: 0,
    scoreBlue: 0,
    gameTime: 0,
    goalScoredState: null,
    goalScoredTimer: 0,
    gameSettings: sanitizeSettings(settings, { ...DEFAULT_GAME_SETTINGS }),
    kickoffPending: false,
    kickoffTeam: "red",
    nextKickoffTeam: "red",
    gameLoopRunning: false,
    gameLoopTimer: null,
    mutedIds: new Set(),
    lastTouchId: null,
    lastAssistTouchId: null,
    pingBcastCounter: 0,
    stateSeq: 0,
    lastStateSentAt: 0,
    activePlayersPool: [],
    bcastPlayersPool: [],
    bcastBall: { x: 0, y: 0, vx: 0, vy: 0, r: 0 },
    bcastMsg: {
      type: "state",
      players: null,
      ball: null,
      scoreRed: 0,
      scoreBlue: 0,
      time: 0,
      goalScoredState: null,
      kickoffPending: false,
      kickoffTeam: "",
      seq: 0,
      sentAt: 0,
    },
    netStats: emptyRoomNetStats(),
  };
  room.bcastMsg.players = room.bcastPlayersPool;
  room.bcastMsg.ball = room.bcastBall;

  const normalizedPassword = sanitizePassword(password);
  if (normalizedPassword) {
    const { salt, hash } = createPasswordHash(normalizedPassword);
    room.passwordSalt = salt;
    room.passwordHash = hash;
  }
  rooms.set(roomId, room);
  return room;
}

function getRoomByClient(client) {
  if (!client?.roomId) return null;
  return rooms.get(client.roomId) || null;
}

function getRoomClients(room) {
  const list = [];
  for (const id of room.clientIds) {
    const client = clientsById.get(id);
    if (client) list.push(client);
  }
  return list;
}

function sendActionResult(client, action, ok, code, message, extra = {}) {
  const payload = {
    type: "actionResult",
    action,
    ok: !!ok,
    code: code || (ok ? "OK" : "ERROR"),
    message: message || "",
    ...extra,
  };
  sendToClient(client, payload);
  // Keep legacy clients working while moving to actionResult-driven UX.
  if (!ok && message) {
    sendToClient(client, { type: "roomError", message });
  }
}

function sendToClient(client, msg) {
  const ws = client?.ws;
  if (!ws || ws.readyState !== 1) return;
  if (ws.bufferedAmount > MAX_BUFFERED_AMOUNT_BYTES) {
    ws.terminate();
    return;
  }
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    ws.terminate();
  }
}

function broadcastRoom(room, msg) {
  const data = JSON.stringify(msg);
  for (const clientId of room.clientIds) {
    const client = clientsById.get(clientId);
    if (!client) continue;
    const ws = client.ws;
    if (!ws || ws.readyState !== 1) continue;
    const buffered = Number(ws.bufferedAmount) || 0;
    if (room?.netStats) {
      pushSample(room.netStats.bufferedSamples, buffered);
      if (buffered > room.netStats.bufferedMaxBytes)
        room.netStats.bufferedMaxBytes = buffered;
    }
    if (ws.bufferedAmount > MAX_BUFFERED_AMOUNT_BYTES) {
      ws.terminate();
      continue;
    }
    try {
      ws.send(data);
    } catch {
      ws.terminate();
    }
  }
}

function getRoomSummary(room) {
  let red = 0;
  let blue = 0;
  let spectators = 0;
  for (const client of getRoomClients(room)) {
    if (client.team === "red") red++;
    else if (client.team === "blue") blue++;
    else spectators++;
  }
  return {
    roomId: room.id,
    name: room.name,
    roomType: room.roomType,
    hasPassword: !!room.passwordHash,
    gameState: room.gameState,
    hostId: room.hostId,
    redCount: red,
    blueCount: blue,
    spectatorCount: spectators,
    totalCount: red + blue + spectators,
    createdAt: room.createdAt,
  };
}

function sendRoomList(client) {
  const roomList = [...rooms.values()]
    .map(getRoomSummary)
    .sort((a, b) => a.createdAt - b.createdAt);
  sendToClient(client, { type: "roomList", rooms: roomList });
}

function broadcastRoomListAll() {
  for (const [, client] of clients) sendRoomList(client);
}

function ensureRoomHost(room) {
  if (room.hostId && room.clientIds.has(room.hostId)) return;
  let fallbackHostId = null;
  let fallbackSeq = Infinity;
  for (const clientId of room.clientIds) {
    const seq = Number(room.joinOrder.get(clientId));
    if (!Number.isFinite(seq) || seq >= fallbackSeq) continue;
    fallbackSeq = seq;
    fallbackHostId = clientId;
  }
  room.hostId = fallbackHostId;
}

function sendLobbyUpdate(room) {
  ensureRoomHost(room);
  const players = getRoomClients(room).map((c) => ({
    id: c.id,
    name: c.name,
    team: c.team,
  }));
  broadcastRoom(room, {
    type: "lobby",
    roomId: room.id,
    roomName: room.name,
    players,
    hostId: room.hostId,
    gameState: room.gameState,
    roomType: room.roomType,
    mutedIds: [...room.mutedIds],
    settings: room.gameSettings,
  });
}

function publishRoomState(room, options = {}) {
  const withLobby = options.withLobby !== false;
  const withRoomList = options.withRoomList !== false;
  if (room && withLobby) sendLobbyUpdate(room);
  if (withRoomList) broadcastRoomListAll();
}

function stopGameLoop(room) {
  room.gameLoopRunning = false;
  if (room.gameLoopTimer) {
    clearTimeout(room.gameLoopTimer);
    room.gameLoopTimer = null;
  }
}

function maybeCleanupRoom(room) {
  if (room.clientIds.size > 0) return;
  stopGameLoop(room);
  rooms.delete(room.id);
}

function leaveCurrentRoom(client, options = {}) {
  const room = getRoomByClient(client);
  if (!room) return;
  room.clientIds.delete(client.id);
  room.joinOrder.delete(client.id);
  room.mutedIds.delete(client.id);
  if (room.hostId === client.id) room.hostId = null;
  client.roomId = null;
  client.team = null;
  client.player = null;
  client.kickCooldown = 0;
  client.keys.up = false;
  client.keys.down = false;
  client.keys.left = false;
  client.keys.right = false;
  client.keys.pass = false;
  client.keys.throughPass = false;
  client.keys.shoot = false;
  client.keys.kick = false;

  if (room.clientIds.size === 0) {
    maybeCleanupRoom(room);
  } else {
    ensureRoomHost(room);
    publishRoomState(room, { withLobby: true, withRoomList: false });
  }

  if (options.sendActionResult) {
    sendActionResult(
      client,
      options.action || "leaveRoom",
      true,
      "LEFT_ROOM",
      "Odadan ayrıldın.",
    );
  }
  broadcastRoomListAll();
  if (options.sendRoomLeft) {
    sendToClient(client, { type: "roomLeft" });
  }
}

function joinRoom(client, room, password, options = {}) {
  const action = options.action || "joinRoom";
  if (!room) {
    sendActionResult(
      client,
      action,
      false,
      "ROOM_NOT_FOUND",
      "Oda bulunamadı.",
    );
    return { ok: false, code: "ROOM_NOT_FOUND" };
  }
  const normalizedPassword = sanitizePassword(password);
  if (room.passwordHash && !options.skipPassword) {
    if (isPasswordAttemptsBlocked(client)) {
      sendActionResult(
        client,
        action,
        false,
        "PASSWORD_ATTEMPTS_BLOCKED",
        "Çok fazla hatalı şifre denemesi.",
      );
      return { ok: false, code: "PASSWORD_ATTEMPTS_BLOCKED" };
    }
    const ok = verifyPassword(
      normalizedPassword,
      room.passwordSalt,
      room.passwordHash,
    );
    if (!ok) {
      registerFailedPasswordAttempt(client);
      sendActionResult(
        client,
        action,
        false,
        "INVALID_PASSWORD",
        "Şifre hatalı.",
      );
      return { ok: false, code: "INVALID_PASSWORD" };
    }
  }
  clearFailedPasswordAttempts(client);

  if (client.roomId && client.roomId !== room.id) {
    leaveCurrentRoom(client);
  }

  if (!room.clientIds.has(client.id)) {
    room.clientIds.add(client.id);
    room.joinOrder.set(client.id, room.nextJoinSeq++);
  }
  if (!room.hostId) room.hostId = client.id;
  client.roomId = room.id;
  client.team = null;
  client.player = null;
  client.kickCooldown = 0;

  sendToClient(client, { type: "roomJoined", room: getRoomSummary(room) });
  publishRoomState(room);
  if (!options.silentActionResult) {
    sendActionResult(client, action, true, "JOINED_ROOM", "Odaya katıldın.", {
      roomId: room.id,
      roomName: room.name,
    });
  }
  return { ok: true, code: "JOINED_ROOM", roomId: room.id };
}

function isClientMutedInRoom(room, clientId) {
  return room?.mutedIds?.has(clientId);
}

function canModerateRoom(room, client) {
  ensureRoomHost(room);
  return room && client && room.hostId === client.id;
}

function isLobbyOrEnded(room) {
  return room.gameState === "lobby" || room.gameState === "ended";
}

// ============ PHYSICS (ROOM SCOPED) ============

function getPlayersArray(room) {
  let len = 0;
  const roomClients = getRoomClients(room);
  for (const client of roomClients) {
    if (client.team && client.player) {
      if (len >= room.activePlayersPool.length) {
        room.activePlayersPool.push({ client: null, player: null });
      }
      room.activePlayersPool[len].client = client;
      room.activePlayersPool[len].player = client.player;
      len++;
    }
  }
  room.activePlayersPool.length = len;
  return room.activePlayersPool;
}

function resetPositions(room) {
  const { fieldScale } = getFieldMetrics(room);
  const spawnDist = SPAWN_DIST * fieldScale;
  const reds = [];
  const blues = [];
  for (const client of getRoomClients(room)) {
    if (client.team === "red" && client.player) reds.push(client.player);
    if (client.team === "blue" && client.player) blues.push(client.player);
  }

  const redSpacing = reds.length > 1 ? 50 : 0;
  reds.forEach((p, i) => {
    p.r = getPlayerRadius(room);
    p.x = CX - spawnDist;
    p.y = CY + (i - (reds.length - 1) / 2) * redSpacing;
    p.vx = 0;
    p.vy = 0;
  });

  const blueSpacing = blues.length > 1 ? 50 : 0;
  blues.forEach((p, i) => {
    p.r = getPlayerRadius(room);
    p.x = CX + spawnDist;
    p.y = CY + (i - (blues.length - 1) / 2) * blueSpacing;
    p.vx = 0;
    p.vy = 0;
  });

  room.ball.x = CX;
  room.ball.y = CY;
  room.ball.vx = 0;
  room.ball.vy = 0;
}

function spawnPlayerForClient(room, client) {
  if (!client?.player || !client.team) return;
  const { fieldScale } = getFieldMetrics(room);
  const teamPlayers = getRoomClients(room).filter(
    (c) => c.team === client.team && c.player,
  );
  const idx = Math.max(
    0,
    teamPlayers.findIndex((c) => c.id === client.id),
  );
  const spacing = 45;
  const spawnDist = SPAWN_DIST * fieldScale;
  const x = client.team === "red" ? CX - spawnDist : CX + spawnDist;
  const y = CY + (idx - (teamPlayers.length - 1) / 2) * spacing;
  client.player.r = getPlayerRadius(room);
  client.player.x = x;
  client.player.y = y;
  client.player.vx = 0;
  client.player.vy = 0;
}

function handlePlayerInput(room, client) {
  const p = client.player;
  const keys = client.keys;
  if (!p || !keys) return;

  let ax = 0;
  let ay = 0;
  if (keys.up) ay -= 1;
  if (keys.down) ay += 1;
  if (keys.left) ax -= 1;
  if (keys.right) ax += 1;

  if (ax !== 0 && ay !== 0) {
    ax *= 0.7071;
    ay *= 0.7071;
  }

  const isKicking = keys.shoot || keys.pass || keys.throughPass || keys.kick;
  p.kicking = isKicking;
  const accel = isKicking
    ? room.gameSettings.playerKickAccel
    : room.gameSettings.playerAccel;
  let damp = isKicking
    ? room.gameSettings.playerKickDamping
    : room.gameSettings.playerDamping;

  if (ax !== 0 || ay !== 0) {
    const dot = p.vx * ax + p.vy * ay;
    if (dot < 0) damp *= 0.88;
  }

  p.vx = p.vx * damp + ax * accel;
  p.vy = p.vy * damp + ay * accel;
}

function circleCollision(a, b) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let dist = Math.hypot(dx, dy);
  const minDist = a.r + b.r;
  if (dist >= minDist) return;

  if (dist <= 0.000001) {
    const rvx = b.vx - a.vx;
    const rvy = b.vy - a.vy;
    const rvLen = Math.hypot(rvx, rvy);
    if (rvLen > 0.000001) {
      dx = rvx;
      dy = rvy;
      dist = rvLen;
    } else {
      dx = 1;
      dy = 0;
      dist = 1;
    }
  }

  const nx = dx / dist;
  const ny = dy / dist;
  const aIM = a.isBall ? BALL_INV_MASS : PLAYER_INV_MASS;
  const bIM = b.isBall ? BALL_INV_MASS : PLAYER_INV_MASS;
  const totalIM = aIM + bIM;

  const targetDist = minDist + 0.001;
  const overlap = targetDist - dist;
  a.x -= nx * overlap * (aIM / totalIM);
  a.y -= ny * overlap * (aIM / totalIM);
  b.x += nx * overlap * (bIM / totalIM);
  b.y += ny * overlap * (bIM / totalIM);

  const dvx = a.vx - b.vx;
  const dvy = a.vy - b.vy;
  const dvn = dvx * nx + dvy * ny;
  if (dvn > 0) {
    const j = dvn / totalIM;
    a.vx -= j * aIM * nx;
    a.vy -= j * aIM * ny;
    b.vx += j * bIM * nx;
    b.vy += j * bIM * ny;
  }
}

function kickBall(
  room,
  player,
  powerScale = 1,
  dirOverride = null,
  toucherClientId = null,
) {
  const dx = room.ball.x - player.x;
  const dy = room.ball.y - player.y;
  const dist = Math.hypot(dx, dy);
  const kickRange =
    (player?.r || getPlayerRadius(room)) +
    BALL_R +
    room.gameSettings.kickRangeBonus;
  if (dist < kickRange && dist > 0.001) {
    const nx = dx / dist;
    const ny = dy / dist;
    const dirX = dirOverride?.x ?? nx;
    const dirY = dirOverride?.y ?? ny;
    const dirLen = Math.hypot(dirX, dirY);
    const fx = dirLen > 0.0001 ? dirX / dirLen : nx;
    const fy = dirLen > 0.0001 ? dirY / dirLen : ny;
    room.ball.vx += fx * room.gameSettings.kickStrength * powerScale;
    room.ball.vy += fy * room.gameSettings.kickStrength * powerScale;
    if (toucherClientId != null) {
      room.lastAssistTouchId = room.lastTouchId;
      room.lastTouchId = toucherClientId;
    }
    return true;
  }
  return false;
}

function findTeammateTarget(room, client, teamPlayers, leadFrames = 0) {
  const teammates = (teamPlayers[client.team] || []).filter(
    ({ client: teammate }) => teammate.id !== client.id,
  );
  if (teammates.length === 0) return null;
  let best = null;
  let bestDist = Infinity;
  for (const { player } of teammates) {
    const tx = player.x + player.vx * leadFrames;
    const ty = player.y + player.vy * leadFrames;
    const dx = tx - room.ball.x;
    const dy = ty - room.ball.y;
    const d = Math.hypot(dx, dy);
    if (d < bestDist) {
      bestDist = d;
      best = { x: dx, y: dy };
    }
  }
  return best;
}

function performBallAction(room, client, teamPlayers, actionType) {
  const action = actionType === "kick" ? "shoot" : actionType;
  if (action === "pass") {
    const passDir = findTeammateTarget(room, client, teamPlayers, 0);
    return kickBall(room, client.player, 0.56, passDir, client.id);
  }
  if (action === "throughPass") {
    const throughDir = findTeammateTarget(room, client, teamPlayers, 10);
    return kickBall(room, client.player, 0.74, throughDir, client.id);
  }
  return kickBall(room, client.player, 1, null, client.id);
}

function clampAxis(obj, limit, prop, velProp, sign) {
  obj[prop] = limit + sign * obj.r;
  obj[velProp] = sign * Math.abs(obj[velProp]) * 0.5;
}

function constrainGoalZone(obj, xMin, xMax, yMin, yMax) {
  if (obj.x - obj.r < xMin) clampAxis(obj, xMin, "x", "vx", 1);
  if (obj.x + obj.r > xMax) clampAxis(obj, xMax, "x", "vx", -1);
  if (obj.y - obj.r < yMin) clampAxis(obj, yMin, "y", "vy", 1);
  if (obj.y + obj.r > yMax) clampAxis(obj, yMax, "y", "vy", -1);
}

function constrainPostCollision(obj, post) {
  const dx = obj.x - post.x;
  const dy = obj.y - post.y;
  const dist = Math.hypot(dx, dy);
  const minD = obj.r + post.r;
  if (dist >= minD || dist <= 0.001) return;
  const nx = dx / dist;
  const ny = dy / dist;
  obj.x = post.x + nx * minD;
  obj.y = post.y + ny * minD;
  const dot = obj.vx * nx + obj.vy * ny;
  if (dot < 0) {
    obj.vx -= 1.5 * dot * nx;
    obj.vy -= 1.5 * dot * ny;
  }
}

function constrainObj(room, obj) {
  const field = getFieldMetrics(room);
  const outsideMargin = obj.isBall ? 0 : PLAYER_OUTSIDE_MARGIN;
  const pastLeftX = obj.x - obj.r < field.x1;
  const pastRightX = obj.x + obj.r > field.x2;
  const inGoalY = obj.y + obj.r > field.goalY1 && obj.y - obj.r < field.goalY2;
  const inLeftGoal = pastLeftX && inGoalY;
  const inRightGoal = pastRightX && inGoalY;

  if (inLeftGoal) {
    constrainGoalZone(
      obj,
      field.x1 - field.goalDepth - outsideMargin,
      Infinity,
      field.goalY1 - outsideMargin,
      field.goalY2 + outsideMargin,
    );
  } else if (inRightGoal) {
    constrainGoalZone(
      obj,
      -Infinity,
      field.x2 + field.goalDepth + outsideMargin,
      field.goalY1 - outsideMargin,
      field.goalY2 + outsideMargin,
    );
  } else {
    constrainGoalZone(
      obj,
      field.x1 - outsideMargin,
      field.x2 + outsideMargin,
      field.y1 - outsideMargin,
      field.y2 + outsideMargin,
    );
  }

  for (const post of field.goalPosts) constrainPostCollision(obj, post);
}

function isGoal(room) {
  const field = getFieldMetrics(room);
  if (
    room.ball.x < field.x1 &&
    room.ball.y > field.goalY1 &&
    room.ball.y < field.goalY2
  )
    return "blue";
  if (
    room.ball.x > field.x2 &&
    room.ball.y > field.goalY1 &&
    room.ball.y < field.goalY2
  )
    return "red";
  return null;
}

function calculateEloDelta(playerElo, opponentAvgElo, score) {
  const expected = 1 / (1 + 10 ** ((opponentAvgElo - playerElo) / 400));
  const kFactor = 24;
  return Math.round(kFactor * (score - expected));
}

function completeMatchPersistence(room, winnerTeam) {
  const participants = getRoomClients(room).filter(
    (c) => c.team === "red" || c.team === "blue",
  );
  if (!participants.length) return { mvp: null };

  const withStats = participants.map((client) => ({
    client,
    stats: client.matchStats || { goals: 0, assists: 0, touches: 0 },
  }));
  withStats.sort(
    (a, b) =>
      b.stats.goals * 4 +
      b.stats.assists * 3 +
      b.stats.touches -
      (a.stats.goals * 4 + a.stats.assists * 3 + a.stats.touches),
  );
  const mvp = withStats[0]?.client
    ? {
        id: withStats[0].client.id,
        name: withStats[0].client.name,
        team: withStats[0].client.team,
        goals: withStats[0].stats.goals,
        assists: withStats[0].stats.assists,
      }
    : null;

  const red = withStats.filter((x) => x.client.team === "red");
  const blue = withStats.filter((x) => x.client.team === "blue");
  const redAvgElo = red.length
    ? red.reduce(
        (sum, x) => sum + (getPlayerStoreEntryByClient(x.client).elo || 1000),
        0,
      ) / red.length
    : 1000;
  const blueAvgElo = blue.length
    ? blue.reduce(
        (sum, x) => sum + (getPlayerStoreEntryByClient(x.client).elo || 1000),
        0,
      ) / blue.length
    : 1000;

  for (const { client, stats } of withStats) {
    const entry = getPlayerStoreEntryByClient(client);
    entry.name = client.name;
    entry.matches += 1;
    entry.goals += stats.goals || 0;
    entry.assists += stats.assists || 0;
    const won = winnerTeam === client.team;
    const draw = !winnerTeam;
    if (draw) entry.draws += 1;
    else if (won) entry.wins += 1;
    else entry.losses += 1;
    updateWeeklyQuests(entry, stats, won);
    if (room.roomType === "ranked") {
      const score = draw ? 0.5 : won ? 1 : 0;
      const opponentAvg = client.team === "red" ? blueAvgElo : redAvgElo;
      entry.elo = Math.max(
        600,
        (entry.elo || 1000) +
          calculateEloDelta(entry.elo || 1000, opponentAvg, score),
      );
    }
    entry.updatedAt = Date.now();
  }

  store.matches.push({
    id: `m-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    at: Date.now(),
    roomId: room.id,
    roomName: room.name,
    roomType: room.roomType,
    winnerTeam,
    scoreRed: room.scoreRed,
    scoreBlue: room.scoreBlue,
    time: room.gameTime,
    mvp,
  });
  if (store.matches.length > 400) store.matches.shift();
  saveStore(store);
  return { mvp };
}

function handleGoalCelebration(room) {
  room.goalScoredTimer--;
  if (room.goalScoredTimer > 0) return false;

  let winner = null;
  const targetScore = room.gameSettings.winScore || WIN_SCORE;
  if (room.scoreRed >= targetScore) winner = "red";
  else if (room.scoreBlue >= targetScore) winner = "blue";
  if (winner) {
    room.gameState = "ended";
    const { mvp } = completeMatchPersistence(room, winner);
    metrics.inc("matchesCompletedTotal", 1);
    broadcastRoom(room, {
      type: "winner",
      team: winner,
      scoreRed: room.scoreRed,
      scoreBlue: room.scoreBlue,
      time: room.gameTime,
      roomType: room.roomType,
      mvp,
    });
    sendLobbyUpdate(room);
    return true;
  }
  room.goalScoredState = null;
  resetPositions(room);
  room.kickoffPending = true;
  room.kickoffTeam = room.nextKickoffTeam;
  return false;
}

function processKicks(room, activePlayers) {
  const teamPlayers = { red: [], blue: [] };
  for (const entry of activePlayers) {
    if (entry.client.team === "red" || entry.client.team === "blue") {
      teamPlayers[entry.client.team].push(entry);
    }
  }
  for (const { client } of activePlayers) {
    if (room.kickoffPending && client.team !== room.kickoffTeam) {
      if (client.kickCooldown > 0) client.kickCooldown--;
      continue;
    }
    if (client.kickCooldown <= 0) {
      const actionType = client.keys?.shoot
        ? "shoot"
        : client.keys?.throughPass
          ? "throughPass"
          : client.keys?.pass
            ? "pass"
            : client.keys?.kick
              ? "kick"
              : null;
      if (
        actionType &&
        performBallAction(room, client, teamPlayers, actionType)
      ) {
        client.matchStats = client.matchStats || {
          goals: 0,
          assists: 0,
          touches: 0,
        };
        client.matchStats.touches += 1;
        client.kickCooldown =
          actionType === "pass" ? 6 : actionType === "throughPass" ? 7 : 8;
        if (room.kickoffPending && client.team === room.kickoffTeam) {
          room.kickoffPending = false;
        }
      }
    }
    if (client.kickCooldown > 0) client.kickCooldown--;
  }
}

function applyMovement(room, activePlayers) {
  for (const { player } of activePlayers) {
    player.x += player.vx;
    player.y += player.vy;
  }
  room.ball.vx *= room.gameSettings.ballDamping;
  room.ball.vy *= room.gameSettings.ballDamping;
  room.ball.x += room.ball.vx;
  room.ball.y += room.ball.vy;
}

function resolveCollisions(room, activePlayers) {
  for (const { client, player } of activePlayers) {
    if (room.kickoffPending && client.team !== room.kickoffTeam) continue;
    circleCollision(player, room.ball);
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < activePlayers.length; i++) {
      for (let j = i + 1; j < activePlayers.length; j++) {
        circleCollision(activePlayers[i].player, activePlayers[j].player);
      }
    }
  }
  if (room.kickoffPending && Math.hypot(room.ball.vx, room.ball.vy) > 0.05) {
    room.kickoffPending = false;
  }
  for (const { player } of activePlayers) constrainObj(room, player);
  constrainObj(room, room.ball);
}

function applyKickoffWaitingRules(room, activePlayers) {
  if (!room.kickoffPending) return;
  const field = getFieldMetrics(room);
  for (const { client, player } of activePlayers) {
    if (client.team === room.kickoffTeam) continue;
    if (client.team === "red" && player.x + player.r > CX) {
      player.x = CX - player.r;
      if (player.vx > 0) player.vx *= -0.3;
    } else if (client.team === "blue" && player.x - player.r < CX) {
      player.x = CX + player.r;
      if (player.vx < 0) player.vx *= -0.3;
    }
    const dx = player.x - CX;
    const dy = player.y - CY;
    const minDist = field.kickoffR + player.r;
    const dist = Math.hypot(dx, dy);
    if (dist < minDist) {
      const nx = dist > 0.001 ? dx / dist : client.team === "red" ? -1 : 1;
      const ny = dist > 0.001 ? dy / dist : 0;
      player.x = CX + nx * minDist;
      player.y = CY + ny * minDist;
      const dot = player.vx * nx + player.vy * ny;
      if (dot < 0) {
        player.vx -= dot * nx;
        player.vy -= dot * ny;
      }
    }
  }
}

function checkGoalScored(room) {
  if (room.goalScoredState) return;
  const goal = isGoal(room);
  if (!goal) return;
  const scorerId = room.lastTouchId;
  const assisterId = room.lastAssistTouchId;
  if (goal === "red") room.scoreRed++;
  else room.scoreBlue++;
  if (scorerId != null) {
    const scorer = clientsById.get(scorerId);
    if (scorer?.team === goal) {
      scorer.matchStats = scorer.matchStats || {
        goals: 0,
        assists: 0,
        touches: 0,
      };
      scorer.matchStats.goals += 1;
      if (assisterId != null && assisterId !== scorerId) {
        const assister = clientsById.get(assisterId);
        if (assister?.team === goal) {
          assister.matchStats = assister.matchStats || {
            goals: 0,
            assists: 0,
            touches: 0,
          };
          assister.matchStats.assists += 1;
        }
      }
    }
  }
  room.nextKickoffTeam = goal === "red" ? "blue" : "red";
  room.goalScoredState = goal;
  room.goalScoredTimer = GOAL_CELEBRATION_FRAMES;
  broadcastRoom(room, {
    type: "goal",
    team: goal,
    scoreRed: room.scoreRed,
    scoreBlue: room.scoreBlue,
    scorerId,
  });
}

function gameUpdate(room) {
  if (room.gameState !== "playing") return;
  if (room.goalScoredState && handleGoalCelebration(room)) return;
  room.gameTime += 1 / 60;
  const activePlayers = getPlayersArray(room);
  for (const { client } of activePlayers) handlePlayerInput(room, client);
  processKicks(room, activePlayers);
  applyMovement(room, activePlayers);
  resolveCollisions(room, activePlayers);
  applyKickoffWaitingRules(room, activePlayers);
  checkGoalScored(room);
}

function broadcastState(room) {
  if (room.gameState !== "playing") return;
  const now = Date.now();
  let len = 0;
  for (const client of getRoomClients(room)) {
    if (client.team && client.player) {
      if (len >= room.bcastPlayersPool.length) {
        room.bcastPlayersPool.push({
          id: 0,
          name: "",
          team: "",
          x: 0,
          y: 0,
          r: 0,
          kicking: false,
        });
      }
      const entry = room.bcastPlayersPool[len];
      entry.id = client.id;
      entry.name = client.name;
      entry.team = client.team;
      entry.x = Math.round(client.player.x * 10) / 10;
      entry.y = Math.round(client.player.y * 10) / 10;
      entry.r = client.player.r;
      entry.kicking = client.player.kicking || false;
      len++;
    }
  }
  room.bcastPlayersPool.length = len;

  room.bcastBall.x = Math.round(room.ball.x * 10) / 10;
  room.bcastBall.y = Math.round(room.ball.y * 10) / 10;
  room.bcastBall.vx = Math.round(room.ball.vx * 100) / 100;
  room.bcastBall.vy = Math.round(room.ball.vy * 100) / 100;
  room.bcastBall.r = room.ball.r;

  room.bcastMsg.scoreRed = room.scoreRed;
  room.bcastMsg.scoreBlue = room.scoreBlue;
  room.bcastMsg.time = room.gameTime;
  room.bcastMsg.goalScoredState = room.goalScoredState;
  room.bcastMsg.kickoffPending = room.kickoffPending;
  room.bcastMsg.kickoffTeam = room.kickoffTeam;
  room.bcastMsg.seq = ++room.stateSeq;
  room.bcastMsg.sentAt = now;
  if (
    room.lastStateSentAt > 0 &&
    now - room.lastStateSentAt > STATE_BROADCAST_MS * 1.8
  ) {
    room.netStats.stateBursts++;
  }
  room.lastStateSentAt = now;
  broadcastRoom(room, room.bcastMsg);

  room.pingBcastCounter++;
  if (room.pingBcastCounter >= 6) {
    room.pingBcastCounter = 0;
    for (const client of getRoomClients(room)) {
      if (!client.team) continue;
      sendToClient(client, {
        type: "myPing",
        ping: client.pingMs ?? null,
        pingRaw: Number.isFinite(client.pingRawMs)
          ? Math.round(client.pingRawMs)
          : null,
      });
    }
  }
}

function startGameLoop(room) {
  room.gameState = "playing";
  room.scoreRed = 0;
  room.scoreBlue = 0;
  room.gameTime = 0;
  room.goalScoredState = null;
  room.goalScoredTimer = 0;
  room.kickoffPending = true;
  room.kickoffTeam = "red";
  room.nextKickoffTeam = "red";
  room.lastTouchId = null;
  room.lastAssistTouchId = null;
  room.ball = { x: CX, y: CY, vx: 0, vy: 0, r: BALL_R, isBall: true };

  for (const client of getRoomClients(room)) {
    if (client.team) {
      client.player = {
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        r: getPlayerRadius(room),
        kicking: false,
        isBall: false,
      };
      client.kickCooldown = 0;
      client.matchStats = { goals: 0, assists: 0, touches: 0 };
    } else {
      client.player = null;
      client.matchStats = { goals: 0, assists: 0, touches: 0 };
    }
  }
  resetPositions(room);
  broadcastRoom(room, { type: "gameStart" });
  publishRoomState(room);

  stopGameLoop(room);
  room.gameLoopRunning = true;
  let lastHrNs = process.hrtime.bigint();
  let accumulator = 0;
  let tickCount = 0;

  function tick() {
    if (!room.gameLoopRunning) return;
    const nowNs = process.hrtime.bigint();
    const elapsedMs = Number(nowNs - lastHrNs) / 1e6;
    lastHrNs = nowNs;
    accumulator += elapsedMs;
    pushSample(room.netStats.tickElapsedSamples, elapsedMs);

    let updatesThisCycle = 0;
    while (
      accumulator >= TICK_MS &&
      updatesThisCycle < Math.max(1, MAX_UPDATES_PER_CYCLE)
    ) {
      gameUpdate(room);
      accumulator -= TICK_MS;
      updatesThisCycle++;
      tickCount++;
      if (tickCount % BROADCAST_EVERY_N_TICKS === 0) {
        broadcastState(room);
      }
    }
    if (updatesThisCycle > 1) {
      room.netStats.catchupUpdates += updatesThisCycle - 1;
    }

    if (accumulator > TICK_MS * MAX_CATCHUP_STEPS) {
      room.netStats.accumulatorResets++;
      room.netStats.droppedAccumulatorMs += accumulator;
      accumulator = 0;
    }

    if (room.gameState === "playing" && room.gameLoopRunning) {
      if (accumulator >= TICK_MS) {
        room.netStats.immediateSchedules++;
        room.gameLoopTimer = setImmediate(tick);
      } else {
        room.netStats.timeoutSchedules++;
        room.gameLoopTimer = setTimeout(
          tick,
          Math.max(1, TICK_MS - accumulator),
        );
      }
    }
  }
  room.gameLoopTimer = setTimeout(tick, TICK_MS);
}

// ============ MESSAGE HANDLERS ============

function handleJoin(client, msg) {
  client.name = sanitizeName(msg?.name, `Oyuncu ${client.id}`);
  getPlayerStoreEntryByClient(client).name = client.name;
  saveStore(store);
  sendRoomList(client);
  const room = getRoomByClient(client);
  if (room) sendLobbyUpdate(room);
}

function handleListRooms(client) {
  sendRoomList(client);
}

function handleCreateRoom(client, msg) {
  const roomName = sanitizeRoomName(msg?.roomName, `Oda ${nextRoomId}`);
  const password = sanitizePassword(msg?.password);
  const room = createRoomState(
    roomName,
    password,
    msg?.roomType,
    msg?.settings,
  );
  logger.info("room_created", {
    roomId: room.id,
    roomName: room.name,
    roomType: room.roomType,
  });
  const joined = joinRoom(client, room, password, { action: "createRoom" });
  if (joined.ok) {
    sendActionResult(
      client,
      "createRoom",
      true,
      "ROOM_CREATED",
      "Oda oluşturuldu.",
      {
        roomId: room.id,
        roomName: room.name,
        roomType: room.roomType,
      },
    );
  }
}

function handleJoinRoom(client, msg) {
  const roomId = String(msg?.roomId ?? "");
  const room = rooms.get(roomId);
  const password = sanitizePassword(msg?.password);
  joinRoom(client, room, password, { action: "joinRoom" });
}

function handleLeaveRoom(client) {
  if (!client.roomId) {
    sendActionResult(
      client,
      "leaveRoom",
      false,
      "NOT_IN_ROOM",
      "Herhangi bir odada değilsin.",
    );
    return;
  }
  leaveCurrentRoom(client, {
    sendRoomLeft: true,
    sendActionResult: true,
    action: "leaveRoom",
  });
}

function handleTeam(client, msg) {
  const room = getRoomByClient(client);
  if (!room) {
    sendActionResult(
      client,
      "team",
      false,
      "NOT_IN_ROOM",
      "Önce bir odaya katılmalısın.",
    );
    return;
  }
  if (!["red", "blue"].includes(msg.team)) {
    sendActionResult(
      client,
      "team",
      false,
      "INVALID_TEAM",
      "Geçersiz takım seçimi.",
    );
    return;
  }
  if (room.gameState === "playing" && client.team) {
    sendActionResult(
      client,
      "team",
      false,
      "TEAM_LOCKED_DURING_MATCH",
      "Maç sırasında takım değiştirilemez.",
    );
    return;
  }
  const teamCount = getRoomClients(room).filter(
    (c) => c.team === msg.team,
  ).length;
  if (teamCount >= MAX_TEAM_SIZE) {
    sendActionResult(
      client,
      "team",
      false,
      "TEAM_FULL",
      "Seçtiğin takım dolu.",
    );
    return;
  }
  client.team = msg.team;
  if (room.gameState === "playing" && !client.player) {
    client.player = {
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      r: getPlayerRadius(room),
      kicking: false,
      isBall: false,
    };
    client.kickCooldown = 0;
    client.matchStats = { goals: 0, assists: 0, touches: 0 };
    spawnPlayerForClient(room, client);
  }
  publishRoomState(room);
  sendActionResult(
    client,
    "team",
    true,
    "TEAM_JOINED",
    "Takım seçimi güncellendi.",
    {
      team: msg.team,
    },
  );
}

function handleStart(client) {
  const room = getRoomByClient(client);
  if (!room) {
    sendActionResult(
      client,
      "start",
      false,
      "NOT_IN_ROOM",
      "Önce bir odaya katılmalısın.",
    );
    return;
  }
  ensureRoomHost(room);
  if (client.id !== room.hostId) {
    sendActionResult(
      client,
      "start",
      false,
      "NOT_HOST",
      "Sadece oda sahibi maçı başlatabilir.",
    );
    return;
  }
  if (!isLobbyOrEnded(room)) {
    sendActionResult(
      client,
      "start",
      false,
      "INVALID_GAME_STATE",
      "Maç zaten devam ediyor.",
    );
    return;
  }
  const roomClients = getRoomClients(room);
  const hasRed = roomClients.some((c) => c.team === "red");
  const hasBlue = roomClients.some((c) => c.team === "blue");
  if (!(hasRed && hasBlue)) {
    sendActionResult(
      client,
      "start",
      false,
      "TEAMS_NOT_READY",
      "Maçı başlatmak için iki takımda da en az bir oyuncu olmalı.",
    );
    return;
  }
  startGameLoop(room);
  sendActionResult(client, "start", true, "GAME_STARTED", "Maç başlatıldı.");
}

function handleRestart(client) {
  const room = getRoomByClient(client);
  if (!room) {
    sendActionResult(
      client,
      "restart",
      false,
      "NOT_IN_ROOM",
      "Önce bir odaya katılmalısın.",
    );
    return;
  }
  ensureRoomHost(room);
  if (client.id !== room.hostId) {
    sendActionResult(
      client,
      "restart",
      false,
      "NOT_HOST",
      "Sadece oda sahibi lobiye döndürebilir.",
    );
    return;
  }
  stopGameLoop(room);
  room.gameState = "lobby";
  room.scoreRed = 0;
  room.scoreBlue = 0;
  room.goalScoredState = null;
  room.goalScoredTimer = 0;
  room.gameTime = 0;
  room.kickoffPending = false;
  room.kickoffTeam = "red";
  room.nextKickoffTeam = "red";
  room.lastTouchId = null;
  room.lastAssistTouchId = null;
  for (const c of getRoomClients(room)) {
    c.player = null;
    c.matchStats = { goals: 0, assists: 0, touches: 0 };
  }
  publishRoomState(room);
  sendActionResult(
    client,
    "restart",
    true,
    "ROOM_RESET",
    "Oda tekrar lobiye alındı.",
  );
}

function handlePause(client) {
  const room = getRoomByClient(client);
  if (!room) {
    sendActionResult(
      client,
      "pause",
      false,
      "NOT_IN_ROOM",
      "Önce bir odaya katılmalısın.",
    );
    return;
  }
  ensureRoomHost(room);
  if (client.id !== room.hostId) {
    sendActionResult(
      client,
      "pause",
      false,
      "NOT_HOST",
      "Sadece oda sahibi duraklatabilir.",
    );
    return;
  }
  if (room.gameState !== "playing") {
    sendActionResult(
      client,
      "pause",
      false,
      "NOT_PLAYING",
      "Oyun devam etmiyor.",
    );
    return;
  }
  room.gameState = "paused";
  stopGameLoop(room);
  publishRoomState(room);
  sendActionResult(client, "pause", true, "GAME_PAUSED", "Oyun duraklatıldı.");
}

function handleResume(client) {
  const room = getRoomByClient(client);
  if (!room) {
    sendActionResult(
      client,
      "resume",
      false,
      "NOT_IN_ROOM",
      "Önce bir odaya katılmalısın.",
    );
    return;
  }
  ensureRoomHost(room);
  if (client.id !== room.hostId) {
    sendActionResult(
      client,
      "resume",
      false,
      "NOT_HOST",
      "Sadece oda sahibi devam ettirebilir.",
    );
    return;
  }
  if (room.gameState !== "paused") {
    sendActionResult(
      client,
      "resume",
      false,
      "NOT_PAUSED",
      "Oyun duraklatılmamış.",
    );
    return;
  }
  room.gameState = "playing";
  startGameLoop(room);
  publishRoomState(room);
  sendActionResult(
    client,
    "resume",
    true,
    "GAME_RESUMED",
    "Oyun devam ediyor.",
  );
}

function handleInput(client, msg) {
  const room = getRoomByClient(client);
  if (!room || room.gameState !== "playing" || !msg.keys) return;
  if (!client.team) return;
  const k = client.keys;
  k.up = !!msg.keys.up;
  k.down = !!msg.keys.down;
  k.left = !!msg.keys.left;
  k.right = !!msg.keys.right;
  k.pass = !!msg.keys.pass;
  k.throughPass = !!msg.keys.throughPass;
  k.shoot = !!msg.keys.shoot;
  k.kick = !!msg.keys.kick;
}

function handleSettings(client, msg) {
  const room = getRoomByClient(client);
  if (!room) {
    sendActionResult(
      client,
      "settings",
      false,
      "NOT_IN_ROOM",
      "Önce bir odaya katılmalısın.",
    );
    return;
  }
  ensureRoomHost(room);
  if (client.id !== room.hostId) {
    sendActionResult(
      client,
      "settings",
      false,
      "NOT_HOST",
      "Sadece oda sahibi ayar değiştirebilir.",
    );
    return;
  }
  room.gameSettings = sanitizeSettings(msg.settings, room.gameSettings);
  const nextR = getPlayerRadius(room);
  for (const c of getRoomClients(room)) {
    if (c.player) c.player.r = nextR;
  }
  constrainObj(room, room.ball);
  for (const c of getRoomClients(room)) {
    if (c.player) constrainObj(room, c.player);
  }
  broadcastRoom(room, {
    type: "settings",
    settings: room.gameSettings,
    hostId: room.hostId,
  });
  sendLobbyUpdate(room);
}

function handleResetSettings(client) {
  const room = getRoomByClient(client);
  if (!room) {
    sendActionResult(
      client,
      "resetSettings",
      false,
      "NOT_IN_ROOM",
      "Önce bir odaya katılmalısın.",
    );
    return;
  }
  ensureRoomHost(room);
  if (client.id !== room.hostId) {
    sendActionResult(
      client,
      "resetSettings",
      false,
      "NOT_HOST",
      "Sadece oda sahibi ayarları sıfırlayabilir.",
    );
    return;
  }
  room.gameSettings = { ...DEFAULT_GAME_SETTINGS };
  const nextR = getPlayerRadius(room);
  for (const c of getRoomClients(room)) {
    if (c.player) c.player.r = nextR;
  }
  constrainObj(room, room.ball);
  for (const c of getRoomClients(room)) {
    if (c.player) constrainObj(room, c.player);
  }
  broadcastRoom(room, {
    type: "settings",
    settings: room.gameSettings,
    hostId: room.hostId,
  });
  sendLobbyUpdate(room);
  sendActionResult(
    client,
    "resetSettings",
    true,
    "SETTINGS_RESET",
    "Ayarlar varsayılanlara döndü.",
  );
}

function handleChat(client, msg) {
  const room = getRoomByClient(client);
  if (!room) return;
  if (isClientMutedInRoom(room, client.id)) return;
  const now = Date.now();
  client.chatTimestamps = (client.chatTimestamps || []).filter(
    (ts) => now - ts < CHAT_FLOOD_WINDOW_MS,
  );
  if (client.chatTimestamps.length >= CHAT_FLOOD_LIMIT) {
    sendToClient(client, {
      type: "roomError",
      message: "Sohbet limiti asildi. Biraz bekle.",
    });
    return;
  }
  client.chatTimestamps.push(now);
  const text = sanitizeChatText(msg?.text);
  if (!text) return;
  broadcastRoom(room, {
    type: "chat",
    fromId: client.id,
    fromName: client.name || `Oyuncu ${client.id}`,
    text,
    time: Date.now(),
  });
}

function handleQuickChat(client, msg) {
  const room = getRoomByClient(client);
  if (!room) return;
  if (isClientMutedInRoom(room, client.id)) return;
  const key = String(msg?.code || "");
  const text = QUICK_CHAT_MAP[key];
  if (!text) return;
  broadcastRoom(room, {
    type: "chat",
    fromId: client.id,
    fromName: client.name || `Oyuncu ${client.id}`,
    text,
    quick: true,
    time: Date.now(),
  });
}

function handleMutePlayer(client, msg) {
  const room = getRoomByClient(client);
  if (!room) {
    sendActionResult(
      client,
      "mutePlayer",
      false,
      "NOT_IN_ROOM",
      "Önce bir odaya katılmalısın.",
    );
    return;
  }
  if (!canModerateRoom(room, client)) {
    sendActionResult(
      client,
      "mutePlayer",
      false,
      "NOT_HOST",
      "Sadece oda sahibi susturabilir.",
    );
    return;
  }
  const playerId = Number(msg?.playerId);
  if (!Number.isFinite(playerId) || playerId === client.id) {
    sendActionResult(
      client,
      "mutePlayer",
      false,
      "INVALID_TARGET",
      "Geçersiz oyuncu seçimi.",
    );
    return;
  }
  const muted = !!msg?.muted;
  if (muted) room.mutedIds.add(playerId);
  else room.mutedIds.delete(playerId);
  sendLobbyUpdate(room);
  sendActionResult(
    client,
    "mutePlayer",
    true,
    muted ? "PLAYER_MUTED" : "PLAYER_UNMUTED",
    muted ? "Oyuncu susturuldu." : "Oyuncunun susturması kaldırıldı.",
    { playerId, muted },
  );
}

function handleKickPlayer(client, msg) {
  const room = getRoomByClient(client);
  if (!room) {
    sendActionResult(
      client,
      "kickPlayer",
      false,
      "NOT_IN_ROOM",
      "Önce bir odaya katılmalısın.",
    );
    return;
  }
  if (!canModerateRoom(room, client)) {
    sendActionResult(
      client,
      "kickPlayer",
      false,
      "NOT_HOST",
      "Sadece oda sahibi oyuncu atabilir.",
    );
    return;
  }
  const playerId = Number(msg?.playerId);
  if (!Number.isFinite(playerId) || playerId === client.id) {
    sendActionResult(
      client,
      "kickPlayer",
      false,
      "INVALID_TARGET",
      "Geçersiz oyuncu seçimi.",
    );
    return;
  }
  const target = clientsById.get(playerId);
  if (!target || target.roomId !== room.id) {
    sendActionResult(
      client,
      "kickPlayer",
      false,
      "TARGET_NOT_IN_ROOM",
      "Oyuncu odada değil.",
    );
    return;
  }
  sendActionResult(
    target,
    "kickedByHost",
    false,
    "KICKED_BY_HOST",
    "Oda sahibi tarafından odadan atıldın.",
  );
  leaveCurrentRoom(target, { sendRoomLeft: true });
  sendActionResult(
    client,
    "kickPlayer",
    true,
    "PLAYER_KICKED",
    "Oyuncu odadan atıldı.",
    {
      playerId,
    },
  );
}

function handleTransferHost(client, msg) {
  const room = getRoomByClient(client);
  if (!room) {
    sendActionResult(
      client,
      "transferHost",
      false,
      "NOT_IN_ROOM",
      "Önce bir odaya katılmalısın.",
    );
    return;
  }
  ensureRoomHost(room);
  if (client.id !== room.hostId) {
    sendActionResult(
      client,
      "transferHost",
      false,
      "NOT_HOST",
      "Sadece oda sahibi host devredebilir.",
    );
    return;
  }
  const playerId = Number(msg?.playerId);
  if (!Number.isFinite(playerId) || playerId === client.id) {
    sendActionResult(
      client,
      "transferHost",
      false,
      "INVALID_TARGET",
      "Geçersiz host adayı.",
    );
    return;
  }
  if (!room.clientIds.has(playerId)) {
    sendActionResult(
      client,
      "transferHost",
      false,
      "TARGET_NOT_IN_ROOM",
      "Oyuncu odada değil.",
    );
    return;
  }
  room.hostId = playerId;
  publishRoomState(room, { withRoomList: false });
  sendActionResult(
    client,
    "transferHost",
    true,
    "HOST_TRANSFERRED",
    "Host devri tamamlandı.",
    {
      nextHostId: playerId,
    },
  );
  const target = clientsById.get(playerId);
  if (target) {
    sendActionResult(
      target,
      "transferHost",
      true,
      "NOW_HOST",
      "Artık bu odanın sahibisin.",
      {
        nextHostId: playerId,
      },
    );
  }
}

function handleRequestLeaderboard(client) {
  const leaderboard = Object.values(store.players)
    .sort((a, b) => (b.elo || 1000) - (a.elo || 1000))
    .slice(0, 10);
  sendToClient(client, {
    type: "leaderboard",
    season: store.season,
    leaderboard,
  });
}

function handleNetTelemetry(client, msg) {
  const room = getRoomByClient(client);
  if (!room || room.gameState !== "playing") return;
  const stateDeltaP95Ms = Number(msg?.stateDeltaP95Ms);
  const stateDeltaMaxMs = Number(msg?.stateDeltaMaxMs);
  const jitterBufferMs = Number(msg?.jitterBufferMs);
  const extrapolationEnabled = !!msg?.extrapolationEnabled;
  if (!Number.isFinite(stateDeltaP95Ms) || !Number.isFinite(stateDeltaMaxMs))
    return;
  client.netTelemetry = {
    stateDeltaP95Ms: Math.max(0, Math.min(500, Math.round(stateDeltaP95Ms))),
    stateDeltaMaxMs: Math.max(0, Math.min(1200, Math.round(stateDeltaMaxMs))),
    jitterBufferMs: Number.isFinite(jitterBufferMs)
      ? Math.max(0, Math.min(120, Math.round(jitterBufferMs)))
      : null,
    extrapolationEnabled,
    updatedAt: Date.now(),
  };
}

function handleReconnect(client, msg) {
  cleanupReconnectSessions();
  const token = String(msg?.token || "");
  const session = reconnectSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    metrics.inc("reconnectFailuresTotal", 1);
    sendToClient(client, { type: "reconnectResult", ok: false });
    return;
  }
  reconnectSessions.delete(token);
  client.name = sanitizeName(msg?.name || session.name, `Oyuncu ${client.id}`);
  client.reconnectToken = token;
  sendToClient(client, { type: "reconnectResult", ok: true, token });
  if (session.roomId && rooms.has(session.roomId)) {
    const room = rooms.get(session.roomId);
    const joined = joinRoom(client, room, "", {
      skipPassword: true,
      action: "reconnectJoinRoom",
      silentActionResult: true,
    });
    if (joined.ok && (session.team === "red" || session.team === "blue")) {
      const teamCount = getRoomClients(room).filter(
        (c) => c.id !== client.id && c.team === session.team,
      ).length;
      if (teamCount >= MAX_TEAM_SIZE) {
        sendActionResult(
          client,
          "reconnectJoinRoom",
          false,
          "TEAM_FULL",
          "Eski takimina donus yapilamadi: takim dolu.",
        );
      } else {
        client.team = session.team;
      }
      publishRoomState(room, { withRoomList: false });
    } else if (joined.ok) {
      publishRoomState(room, { withRoomList: false });
    }
  }
  metrics.inc("reconnectSuccessTotal", 1);
}

const messageHandlers = {
  join: handleJoin,
  listRooms: handleListRooms,
  createRoom: handleCreateRoom,
  joinRoom: handleJoinRoom,
  leaveRoom: handleLeaveRoom,
  team: handleTeam,
  start: handleStart,
  pause: handlePause,
  resume: handleResume,
  restart: handleRestart,
  input: handleInput,
  settings: handleSettings,
  resetSettings: handleResetSettings,
  chat: handleChat,
  quickChat: handleQuickChat,
  mutePlayer: handleMutePlayer,
  kickPlayer: handleKickPlayer,
  transferHost: handleTransferHost,
  requestLeaderboard: handleRequestLeaderboard,
  netTelemetry: handleNetTelemetry,
  reconnect: handleReconnect,
};

function handleClientMessage(client, msg) {
  if (!validateMessageShape(msg)) {
    metrics.inc("wsRejectedMessagesTotal", 1);
    return;
  }
  metrics.inc("wsMessagesTotal", 1);
  if (isRateLimited(client, msg.type)) return;
  const handler = messageHandlers[msg.type];
  if (handler) handler(client, msg);
}

function isRateLimited(client, type) {
  const now = Date.now();
  if (
    !client.rateLimitWindowStart ||
    now - client.rateLimitWindowStart >= RATE_WINDOW_MS
  ) {
    client.rateLimitWindowStart = now;
    client.rateLimitCounts = {};
  }
  const key = typeof type === "string" ? type : "default";
  const limit = RATE_LIMIT_PER_WINDOW[key] ?? RATE_LIMIT_PER_WINDOW.default;
  const nextCount = (client.rateLimitCounts[key] || 0) + 1;
  client.rateLimitCounts[key] = nextCount;
  return nextCount > limit;
}

function isPasswordAttemptsBlocked(client) {
  const now = Date.now();
  if (
    !client.passwordFailWindowStart ||
    now - client.passwordFailWindowStart >= PASSWORD_FAIL_WINDOW_MS
  ) {
    client.passwordFailWindowStart = now;
    client.passwordFailCount = 0;
    return false;
  }
  return client.passwordFailCount >= PASSWORD_FAIL_LIMIT;
}

function registerFailedPasswordAttempt(client) {
  const now = Date.now();
  if (
    !client.passwordFailWindowStart ||
    now - client.passwordFailWindowStart >= PASSWORD_FAIL_WINDOW_MS
  ) {
    client.passwordFailWindowStart = now;
    client.passwordFailCount = 0;
  }
  client.passwordFailCount += 1;
}

function clearFailedPasswordAttempts(client) {
  client.passwordFailWindowStart = 0;
  client.passwordFailCount = 0;
}

function startPingLoop() {
  if (pingInterval) return;
  pingInterval = setInterval(() => {
    const now = Date.now();
    for (const [ws, client] of clients) {
      if (
        (client.awaitingPong &&
          now - client.lastPingSentAt > PONG_TIMEOUT_MS) ||
        now - client.lastPongAt > PONG_TIMEOUT_MS
      ) {
        ws.terminate();
        continue;
      }
      if (ws.readyState === 1 && !client.awaitingPong) {
        if (now < client.nextPingAt) continue;
        if (now - client.lastPingSentAt < PING_MIN_GAP_MS) continue;
        client.awaitingPong = true;
        client.lastPingSentAt = now;
        client.lastPingHrNs = process.hrtime.bigint();
        client.nextPingAt =
          now +
          PING_INTERVAL_MS +
          Math.floor(Math.random() * Math.max(1, PING_JITTER_MS));
        ws.ping();
      }
    }
  }, PING_SCAN_INTERVAL_MS);
}

function handleDisconnect(client) {
  if (!client) return;
  cleanupReconnectSessions();
  if (client.reconnectToken) {
    reconnectSessions.set(client.reconnectToken, {
      token: client.reconnectToken,
      name: client.name,
      roomId: client.roomId,
      team: client.team,
      expiresAt: Date.now() + RECONNECT_TTL_MS,
    });
  }
  leaveCurrentRoom(client);
  clients.delete(client.ws);
  clientsById.delete(client.id);
  metrics.inc("wsDisconnectsTotal", 1);
  if (clients.size === 0 && pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

wss.on("connection", (ws, req) => {
  const origin = String(req?.headers?.origin || "");
  if (
    ALLOWED_ORIGINS.length > 0 &&
    origin &&
    !ALLOWED_ORIGINS.includes(origin)
  ) {
    ws.close(1008, "Origin not allowed");
    return;
  }
  if (clients.size >= MAX_CONNECTIONS) {
    ws.close(1013, "Server busy");
    return;
  }

  const id = nextId++;
  const now = Date.now();
  const reconnectToken = createReconnectToken();
  const clientData = {
    ws,
    id,
    name: `Oyuncu ${id}`,
    roomId: null,
    team: null,
    keys: {
      up: false,
      down: false,
      left: false,
      right: false,
      pass: false,
      throughPass: false,
      shoot: false,
      kick: false,
    },
    player: null,
    kickCooldown: 0,
    pingMs: null,
    pingRawMs: null,
    lastPongAt: now,
    lastPingSentAt: 0,
    lastPingHrNs: null,
    nextPingAt: now + Math.floor(Math.random() * Math.max(1, PING_INTERVAL_MS)),
    awaitingPong: false,
    rateLimitWindowStart: now,
    rateLimitCounts: {},
    passwordFailWindowStart: 0,
    passwordFailCount: 0,
    reconnectToken,
    chatTimestamps: [],
    matchStats: { goals: 0, assists: 0, touches: 0 },
    netTelemetry: null,
  };

  if (ws._socket) {
    ws._socket.setNoDelay(true);
    ws._socket.setKeepAlive(true, 2000);
  }

  clients.set(ws, clientData);
  clientsById.set(id, clientData);
  metrics.inc("wsConnectionsTotal", 1);
  startPingLoop();

  sendToClient(clientData, {
    type: "welcome",
    id,
    reconnectToken,
    stateTickMs: STATE_BROADCAST_MS,
    jitterBufferMs: Math.max(0, SERVER_JITTER_BUFFER_MS),
    extrapolationEnabled: ENABLE_EXTRAPOLATION,
  });
  sendRoomList(clientData);

  ws.on("message", (raw) => {
    const rawSize = Buffer.isBuffer(raw)
      ? raw.length
      : Buffer.byteLength(String(raw), "utf8");
    if (rawSize > MAX_WS_PAYLOAD_BYTES) {
      ws.close(1009, "Payload too large");
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const client = clients.get(ws);
    if (!client) return;
    handleClientMessage(client, msg);
  });

  ws.on("pong", () => {
    const client = clients.get(ws);
    if (!client) return;
    client.lastPongAt = Date.now();
    if (!client.awaitingPong) return;
    client.awaitingPong = false;
    let rawPing;
    if (typeof client.lastPingHrNs === "bigint") {
      rawPing = Number(process.hrtime.bigint() - client.lastPingHrNs) / 1e6;
    } else {
      rawPing = Date.now() - client.lastPingSentAt;
    }
    rawPing = Math.max(0, Math.round(rawPing));
    client.pingRawMs = rawPing;
    if (!Number.isFinite(client.pingMs)) {
      client.pingMs = rawPing;
    } else {
      client.pingMs = Math.max(
        0,
        Math.round(
          client.pingMs + (rawPing - client.pingMs) * PING_SMOOTHING_ALPHA,
        ),
      );
    }
  });

  ws.on("close", () => {
    const client = clients.get(ws);
    handleDisconnect(client);
  });
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} alindi, sunucu kapatiliyor...`);
  logger.warn("server_shutdown", { signal });

  for (const room of rooms.values()) stopGameLoop(room);
  rooms.clear();

  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }

  for (const [ws] of clients) {
    try {
      ws.close(1001, "Server shutting down");
    } catch {
      ws.terminate();
    }
  }
  clients.clear();
  clientsById.clear();

  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 4000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  logger.error("uncaught_exception", {
    error: err?.message,
    stack: err?.stack,
  });
  // On fatal startup errors like EADDRINUSE, we must exit so the supervisor can restart
  // or the user can see the process has finished/failed.
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled_rejection", { reason: String(reason) });
});

// ============ START SERVER ============

// Handle server errors (like EADDRINUSE) explicitly
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    logger.error("server_error", {
      message: `Port ${PORT} is already in use.`,
      code: err.code,
    });
    process.exit(1);
  } else {
    logger.error("server_error", {
      message: err.message,
      stack: err.stack,
    });
    process.exit(1);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  const nets = os.networkInterfaces();
  let lanIP = "localhost";
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        lanIP = net.address;
        break;
      }
    }
  }

  console.log("");
  console.log("========================================");
  console.log("  HaxBall LAN Sunucu Baslatildi!");
  console.log("========================================");
  console.log(`  Yerel:  http://localhost:${PORT}`);
  console.log(`  LAN:    http://${lanIP}:${PORT}`);
  console.log("");
  console.log("  Arkadaslarin ayni WiFi/LAN'daysa");
  console.log("  LAN adresini paylasarak katilabilir.");
  console.log("========================================");
  console.log("");
  logger.info("server_started", {
    port: PORT,
    allowedOrigins: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : ["*"],
  });
});
