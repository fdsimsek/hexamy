const express = require("express");
const http = require("node:http");
const { WebSocketServer } = require("ws");
const os = require("node:os");
const path = require("node:path");

const app = express();
const server = http.createServer(app);
const MAX_WS_PAYLOAD_BYTES = Number(process.env.MAX_WS_PAYLOAD_BYTES || 16 * 1024);
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS || 64);
const MAX_BUFFERED_AMOUNT_BYTES = Number(
  process.env.MAX_BUFFERED_AMOUNT_BYTES || 512 * 1024,
);
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS || 1000);
const PONG_TIMEOUT_MS = Number(process.env.PONG_TIMEOUT_MS || 6000);
const PING_SMOOTHING_ALPHA = Number(process.env.PING_SMOOTHING_ALPHA || 0.35);
const PING_SPIKE_CAP_MULTIPLIER = Number(process.env.PING_SPIKE_CAP_MULTIPLIER || 1.8);
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 1000);
const RATE_LIMIT_PER_WINDOW = {
  input: Number(process.env.RATE_LIMIT_INPUT || 120),
  chat: Number(process.env.RATE_LIMIT_CHAT || 10),
  team: Number(process.env.RATE_LIMIT_TEAM || 8),
  join: Number(process.env.RATE_LIMIT_JOIN || 5),
  settings: Number(process.env.RATE_LIMIT_SETTINGS || 30),
  resetSettings: Number(process.env.RATE_LIMIT_RESET_SETTINGS || 6),
  start: Number(process.env.RATE_LIMIT_START || 6),
  restart: Number(process.env.RATE_LIMIT_RESTART || 6),
  default: Number(process.env.RATE_LIMIT_DEFAULT || 40),
};
const wss = new WebSocketServer({
  server,
  maxPayload: MAX_WS_PAYLOAD_BYTES,
});

app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 3000);

// ============ GAME CONSTANTS (from .hbs map) ============

const SCALE = 0.58;
const W = 1100,
  H = 640;
const CX = W / 2,
  CY = H / 2;

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
};

const SETTINGS_LIMITS = {
  playerAccel: [0.03 * SCALE, 0.2 * SCALE],
  playerDamping: [0.85, 0.995],
  playerKickAccel: [0.02 * SCALE, 0.18 * SCALE],
  playerKickDamping: [0.85, 0.995],
  kickStrength: [2 * SCALE, 12 * SCALE],
  kickRangeBonus: [0, 24],
  ballDamping: [0.93, 0.999],
};

const PLAYER_INV_MASS = 0.5;
const BALL_INV_MASS = 1;

const WIN_SCORE = 5;
const GOAL_CELEBRATION_FRAMES = 300;
const SPAWN_DIST = 170 * SCALE;

const goalPosts = [
  { x: FIELD_X1, y: GOAL_Y1, r: GOAL_POST_R },
  { x: FIELD_X1, y: GOAL_Y2, r: GOAL_POST_R },
  { x: FIELD_X2, y: GOAL_Y1, r: GOAL_POST_R },
  { x: FIELD_X2, y: GOAL_Y2, r: GOAL_POST_R },
];

// ============ GAME STATE ============

let nextId = 1;
const clients = new Map(); // ws -> { id, name, team, keys, kickCooldown }

let gameState = "lobby"; // 'lobby' | 'playing' | 'ended'
let hostId = null;
let ball = { x: CX, y: CY, vx: 0, vy: 0, r: BALL_R };
let scoreRed = 0;
let scoreBlue = 0;
let gameTime = 0;
let goalScoredState = null;
let goalScoredTimer = 0;
let gameLoopInterval = null;
let broadcastInterval = null;
let pingInterval = null;
let gameSettings = { ...DEFAULT_GAME_SETTINGS };
let kickoffPending = false;
let kickoffTeam = "red";
let nextKickoffTeam = "red";

// ============ PHYSICS ============

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sanitizeSettings(rawSettings) {
  const next = { ...gameSettings };
  if (!rawSettings || typeof rawSettings !== "object") return next;
  for (const [key, [min, max]] of Object.entries(SETTINGS_LIMITS)) {
    const value = Number(rawSettings[key]);
    if (!Number.isFinite(value)) continue;
    next[key] = clamp(value, min, max);
  }
  return next;
}

function getPlayersArray() {
  const players = [];
  for (const [, client] of clients) {
    if (client.team && client.player) {
      players.push({ client, player: client.player });
    }
  }
  return players;
}

function resetPositions() {
  const reds = [];
  const blues = [];
  for (const [, c] of clients) {
    if (c.team === "red" && c.player) reds.push(c.player);
    if (c.team === "blue" && c.player) blues.push(c.player);
  }

  const redSpacing = reds.length > 1 ? 50 : 0;
  reds.forEach((p, i) => {
    p.x = CX - SPAWN_DIST;
    p.y = CY + (i - (reds.length - 1) / 2) * redSpacing;
    p.vx = 0;
    p.vy = 0;
  });

  const blueSpacing = blues.length > 1 ? 50 : 0;
  blues.forEach((p, i) => {
    p.x = CX + SPAWN_DIST;
    p.y = CY + (i - (blues.length - 1) / 2) * blueSpacing;
    p.vx = 0;
    p.vy = 0;
  });

  ball.x = CX;
  ball.y = CY;
  ball.vx = 0;
  ball.vy = 0;
}

function spawnPlayerForClient(client) {
  if (!client?.player || !client.team) return;
  const teamPlayers = [...clients.values()].filter(
    (c) => c.team === client.team && c.player,
  );
  const idx = Math.max(0, teamPlayers.findIndex((c) => c.id === client.id));
  const spacing = 45;
  const x = client.team === "red" ? CX - SPAWN_DIST : CX + SPAWN_DIST;
  const y = CY + (idx - (teamPlayers.length - 1) / 2) * spacing;
  client.player.x = x;
  client.player.y = y;
  client.player.vx = 0;
  client.player.vy = 0;
}

function handlePlayerInput(client) {
  const p = client.player;
  const keys = client.keys;
  if (!p || !keys) return;

  let ax = 0,
    ay = 0;
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
  const accel = isKicking ? gameSettings.playerKickAccel : gameSettings.playerAccel;
  let damp = isKicking ? gameSettings.playerKickDamping : gameSettings.playerDamping;

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

  // Keep a tiny gap so circles never visually sink into each other.
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

function kickBall(player, powerScale = 1, dirOverride = null) {
  const dx = ball.x - player.x,
    dy = ball.y - player.y;
  const dist = Math.hypot(dx, dy);
  const kickRange = PLAYER_R + BALL_R + gameSettings.kickRangeBonus;
  if (dist < kickRange && dist > 0.001) {
    const nx = dx / dist;
    const ny = dy / dist;
    const dirX = dirOverride?.x ?? nx;
    const dirY = dirOverride?.y ?? ny;
    const dirLen = Math.hypot(dirX, dirY);
    const fx = dirLen > 0.0001 ? dirX / dirLen : nx;
    const fy = dirLen > 0.0001 ? dirY / dirLen : ny;
    ball.vx += fx * gameSettings.kickStrength * powerScale;
    ball.vy += fy * gameSettings.kickStrength * powerScale;
    return true;
  }
  return false;
}

function findTeammateTarget(client, teamPlayers, leadFrames = 0) {
  const teammates = (teamPlayers[client.team] || []).filter(
    ({ client: teammate }) => teammate.id !== client.id,
  );
  if (teammates.length === 0) return null;

  let best = null;
  let bestDist = Infinity;
  for (const { player } of teammates) {
    const tx = player.x + player.vx * leadFrames;
    const ty = player.y + player.vy * leadFrames;
    const dx = tx - ball.x;
    const dy = ty - ball.y;
    const d = Math.hypot(dx, dy);
    if (d < bestDist) {
      bestDist = d;
      best = { x: dx, y: dy };
    }
  }
  return best;
}

function performBallAction(client, teamPlayers, actionType) {
  const action = actionType === "kick" ? "shoot" : actionType;
  if (action === "pass") {
    const passDir = findTeammateTarget(client, teamPlayers, 0);
    return kickBall(client.player, 0.56, passDir);
  }
  if (action === "throughPass") {
    const throughDir = findTeammateTarget(client, teamPlayers, 10);
    return kickBall(client.player, 0.74, throughDir);
  }
  return kickBall(client.player, 1);
}

function clampAxis(obj, pos, limit, prop, velProp, sign) {
  obj[prop] = limit + sign * obj.r;
  obj[velProp] = sign * Math.abs(obj[velProp]) * 0.5;
}

function constrainGoalZone(obj, xMin, xMax, yMin, yMax) {
  if (obj.x - obj.r < xMin) clampAxis(obj, obj.x, xMin, "x", "vx", 1);
  if (obj.x + obj.r > xMax) clampAxis(obj, obj.x, xMax, "x", "vx", -1);
  if (obj.y - obj.r < yMin) clampAxis(obj, obj.y, yMin, "y", "vy", 1);
  if (obj.y + obj.r > yMax) clampAxis(obj, obj.y, yMax, "y", "vy", -1);
}

function constrainPostCollision(obj, post) {
  const dx = obj.x - post.x,
    dy = obj.y - post.y;
  const dist = Math.hypot(dx, dy);
  const minD = obj.r + post.r;
  if (dist >= minD || dist <= 0.001) return;
  const nx = dx / dist,
    ny = dy / dist;
  obj.x = post.x + nx * minD;
  obj.y = post.y + ny * minD;
  const dot = obj.vx * nx + obj.vy * ny;
  if (dot < 0) {
    obj.vx -= 1.5 * dot * nx;
    obj.vy -= 1.5 * dot * ny;
  }
}

function constrainObj(obj) {
  const outsideMargin = obj.isBall ? 0 : PLAYER_OUTSIDE_MARGIN;
  const pastLeftX = obj.x - obj.r < FIELD_X1;
  const pastRightX = obj.x + obj.r > FIELD_X2;
  const inGoalY = obj.y + obj.r > GOAL_Y1 && obj.y - obj.r < GOAL_Y2;

  const inLeftGoal = pastLeftX && inGoalY;
  const inRightGoal = pastRightX && inGoalY;

  if (inLeftGoal) {
    constrainGoalZone(
      obj,
      FIELD_X1 - GOAL_DEPTH - outsideMargin,
      Infinity,
      GOAL_Y1 - outsideMargin,
      GOAL_Y2 + outsideMargin,
    );
  } else if (inRightGoal) {
    constrainGoalZone(
      obj,
      -Infinity,
      FIELD_X2 + GOAL_DEPTH + outsideMargin,
      GOAL_Y1 - outsideMargin,
      GOAL_Y2 + outsideMargin,
    );
  } else {
    constrainGoalZone(
      obj,
      FIELD_X1 - outsideMargin,
      FIELD_X2 + outsideMargin,
      FIELD_Y1 - outsideMargin,
      FIELD_Y2 + outsideMargin,
    );
  }

  for (const post of goalPosts) constrainPostCollision(obj, post);
}

function isGoal() {
  if (ball.x < FIELD_X1 && ball.y > GOAL_Y1 && ball.y < GOAL_Y2) return "blue";
  if (ball.x > FIELD_X2 && ball.y > GOAL_Y1 && ball.y < GOAL_Y2) return "red";
  return null;
}

function handleGoalCelebration() {
  goalScoredTimer--;
  if (goalScoredTimer > 0) return false;

  let winner = null;
  if (scoreRed >= WIN_SCORE) winner = "red";
  else if (scoreBlue >= WIN_SCORE) winner = "blue";
  if (winner) {
    gameState = "ended";
    broadcast({
      type: "winner",
      team: winner,
      scoreRed,
      scoreBlue,
      time: gameTime,
    });
    return true;
  }
  goalScoredState = null;
  resetPositions();
  kickoffPending = true;
  kickoffTeam = nextKickoffTeam;
  return false;
}

function processKicks(activePlayers) {
  const teamPlayers = { red: [], blue: [] };
  for (const entry of activePlayers) {
    if (entry.client.team === "red" || entry.client.team === "blue") {
      teamPlayers[entry.client.team].push(entry);
    }
  }
  for (const { client } of activePlayers) {
    if (kickoffPending && client.team !== kickoffTeam) {
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
      if (actionType && performBallAction(client, teamPlayers, actionType)) {
        client.kickCooldown = actionType === "pass" ? 6 : actionType === "throughPass" ? 7 : 8;
        if (kickoffPending && client.team === kickoffTeam) kickoffPending = false;
      }
    }
    if (client.kickCooldown > 0) client.kickCooldown--;
  }
}

function applyMovement(activePlayers) {
  for (const { player } of activePlayers) {
    player.x += player.vx;
    player.y += player.vy;
  }
  ball.vx *= gameSettings.ballDamping;
  ball.vy *= gameSettings.ballDamping;
  ball.x += ball.vx;
  ball.y += ball.vy;
}

function resolveCollisions(activePlayers) {
  for (const { client, player } of activePlayers) {
    if (kickoffPending && client.team !== kickoffTeam) continue;
    circleCollision(player, ball);
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < activePlayers.length; i++) {
      for (let j = i + 1; j < activePlayers.length; j++) {
        circleCollision(activePlayers[i].player, activePlayers[j].player);
      }
    }
  }
  if (kickoffPending && Math.hypot(ball.vx, ball.vy) > 0.05) kickoffPending = false;
  for (const { player } of activePlayers) constrainObj(player);
  constrainObj(ball);
}

function applyKickoffWaitingRules(activePlayers) {
  if (!kickoffPending) return;
  for (const { client, player } of activePlayers) {
    if (client.team === kickoffTeam) continue;

    // Non-kickoff team cannot cross the halfway line.
    if (client.team === "red" && player.x + player.r > CX) {
      player.x = CX - player.r;
      if (player.vx > 0) player.vx *= -0.3;
    } else if (client.team === "blue" && player.x - player.r < CX) {
      player.x = CX + player.r;
      if (player.vx < 0) player.vx *= -0.3;
    }

    // Non-kickoff team cannot enter the center circle before play starts.
    const dx = player.x - CX;
    const dy = player.y - CY;
    const minDist = KICKOFF_R + player.r;
    const dist = Math.hypot(dx, dy);
    if (dist < minDist) {
      const nx = dist > 0.001 ? dx / dist : (client.team === "red" ? -1 : 1);
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

function checkGoalScored() {
  if (goalScoredState) return;
  const goal = isGoal();
  if (!goal) return;
  if (goal === "red") scoreRed++;
  else scoreBlue++;
  nextKickoffTeam = goal === "red" ? "blue" : "red";
  goalScoredState = goal;
  goalScoredTimer = GOAL_CELEBRATION_FRAMES;
  broadcast({ type: "goal", team: goal, scoreRed, scoreBlue });
}

function gameUpdate() {
  if (gameState !== "playing") return;
  if (goalScoredState && handleGoalCelebration()) return;

  gameTime += 1 / 60;
  const activePlayers = getPlayersArray();

  for (const { client } of activePlayers) handlePlayerInput(client);
  processKicks(activePlayers);
  applyMovement(activePlayers);
  resolveCollisions(activePlayers);
  applyKickoffWaitingRules(activePlayers);
  checkGoalScored();
}

function broadcastState() {
  if (gameState !== "playing") return;

  const playersState = [];
  for (const [, c] of clients) {
    if (c.team && c.player) {
      playersState.push({
        id: c.id,
        name: c.name,
        team: c.team,
        x: Math.round(c.player.x * 10) / 10,
        y: Math.round(c.player.y * 10) / 10,
        r: c.player.r,
        kicking: c.player.kicking || false,
        ping: c.pingMs ?? null,
      });
    }
  }

  broadcast({
    type: "state",
    players: playersState,
    ball: {
      x: Math.round(ball.x * 10) / 10,
      y: Math.round(ball.y * 10) / 10,
      vx: Math.round(ball.vx * 100) / 100,
      vy: Math.round(ball.vy * 100) / 100,
      r: ball.r,
    },
    scoreRed,
    scoreBlue,
    time: gameTime,
    goalScoredState,
    kickoffPending,
    kickoffTeam,
  });
}

// ============ LOBBY & NETWORKING ============

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const [ws, client] of clients) {
    if (ws.readyState !== 1) continue;
    if (ws.bufferedAmount > MAX_BUFFERED_AMOUNT_BYTES) {
      ws.terminate();
      continue;
    }
    try {
      ws.send(data);
    } catch {
      if (client) clients.delete(ws);
      ws.terminate();
    }
  }
}

function sendLobbyUpdate() {
  const playersList = [];
  for (const [, c] of clients) {
    playersList.push({ id: c.id, name: c.name, team: c.team });
  }
  broadcast({
    type: "lobby",
    players: playersList,
    hostId,
    gameState,
    settings: gameSettings,
  });
}

function startGameLoop() {
  gameState = "playing";
  scoreRed = 0;
  scoreBlue = 0;
  gameTime = 0;
  goalScoredState = null;
  goalScoredTimer = 0;
  kickoffPending = true;
  kickoffTeam = "red";
  nextKickoffTeam = "red";

  ball = { x: CX, y: CY, vx: 0, vy: 0, r: BALL_R, isBall: true };

  for (const [, c] of clients) {
    if (c.team) {
      c.player = {
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        r: PLAYER_R,
        kicking: false,
        isBall: false,
      };
      c.kickCooldown = 0;
    }
  }

  resetPositions();
  broadcast({ type: "gameStart" });

  if (gameLoopInterval) clearInterval(gameLoopInterval);
  if (broadcastInterval) clearInterval(broadcastInterval);
  gameLoopInterval = setInterval(gameUpdate, 1000 / 60);
  broadcastInterval = setInterval(broadcastState, 1000 / 20);
}

function stopGameLoop() {
  if (gameLoopInterval) {
    clearInterval(gameLoopInterval);
    gameLoopInterval = null;
  }
  if (broadcastInterval) {
    clearInterval(broadcastInterval);
    broadcastInterval = null;
  }
}

function isLobbyOrEnded() {
  return gameState === "lobby" || gameState === "ended";
}

function handleJoin(client, msg) {
  client.name = (msg.name || "Oyuncu").slice(0, 16);
  sendLobbyUpdate();
}

function handleTeam(client, msg) {
  if (!["red", "blue"].includes(msg.team)) return;
  if (gameState === "playing" && client.team) return;
  const teamCount = [...clients.values()].filter(
    (c) => c.team === msg.team,
  ).length;
  if (teamCount >= 4) return;
  client.team = msg.team;
  if (gameState === "playing" && !client.player) {
    client.player = {
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      r: PLAYER_R,
      kicking: false,
      isBall: false,
    };
    client.kickCooldown = 0;
    spawnPlayerForClient(client);
  }
  sendLobbyUpdate();
}

function handleStart(client) {
  if (client.id !== hostId || !isLobbyOrEnded()) return;
  const hasRed = [...clients.values()].some((c) => c.team === "red");
  const hasBlue = [...clients.values()].some((c) => c.team === "blue");
  if (hasRed && hasBlue) startGameLoop();
}

function handleRestart(client) {
  if (client.id !== hostId) return;
  stopGameLoop();
  gameState = "lobby";
  for (const [, c] of clients) c.player = null;
  sendLobbyUpdate();
}

function handleInput(client, msg) {
  if (gameState !== "playing" || !msg.keys) return;
  client.keys = {
    up: !!msg.keys.up,
    down: !!msg.keys.down,
    left: !!msg.keys.left,
    right: !!msg.keys.right,
    pass: !!msg.keys.pass,
    throughPass: !!msg.keys.throughPass,
    shoot: !!msg.keys.shoot,
    kick: !!msg.keys.kick,
  };
}

function handleSettings(client, msg) {
  if (client.id !== hostId) return;
  gameSettings = sanitizeSettings(msg.settings);
  broadcast({ type: "settings", settings: gameSettings, hostId });
  sendLobbyUpdate();
}

function handleResetSettings(client) {
  if (client.id !== hostId) return;
  gameSettings = { ...DEFAULT_GAME_SETTINGS };
  broadcast({ type: "settings", settings: gameSettings, hostId });
  sendLobbyUpdate();
}

function handleChat(client, msg) {
  const text = String(msg?.text ?? "")
    .trim()
    .slice(0, 180);
  if (!text) return;
  broadcast({
    type: "chat",
    fromId: client.id,
    fromName: client.name || `Oyuncu ${client.id}`,
    text,
    time: Date.now(),
  });
}

const messageHandlers = {
  join: handleJoin,
  team: handleTeam,
  start: handleStart,
  restart: handleRestart,
  input: handleInput,
  settings: handleSettings,
  resetSettings: handleResetSettings,
  chat: handleChat,
};

function handleClientMessage(client, msg) {
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
  if (isRateLimited(client, msg.type)) return;
  const handler = messageHandlers[msg.type];
  if (handler) handler(client, msg);
}

function startPingLoop() {
  if (pingInterval) return;
  pingInterval = setInterval(() => {
    const now = Date.now();
    for (const [ws, client] of clients) {
      if (
        (client.awaitingPong && now - client.lastPingSentAt > PONG_TIMEOUT_MS) ||
        now - client.lastPongAt > PONG_TIMEOUT_MS
      ) {
        ws.terminate();
        continue;
      }
      if (ws.readyState === 1 && !client.awaitingPong) {
        client.awaitingPong = true;
        client.lastPingSentAt = now;
        ws.ping();
      }
    }
  }, PING_INTERVAL_MS);
}

function isRateLimited(client, type) {
  const now = Date.now();
  if (!client.rateLimitWindowStart || now - client.rateLimitWindowStart >= RATE_WINDOW_MS) {
    client.rateLimitWindowStart = now;
    client.rateLimitCounts = {};
  }
  const key = typeof type === "string" ? type : "default";
  const limit = RATE_LIMIT_PER_WINDOW[key] ?? RATE_LIMIT_PER_WINDOW.default;
  const nextCount = (client.rateLimitCounts[key] || 0) + 1;
  client.rateLimitCounts[key] = nextCount;
  return nextCount > limit;
}

wss.on("connection", (ws) => {
  if (clients.size >= MAX_CONNECTIONS) {
    ws.close(1013, "Server busy");
    return;
  }
  const id = nextId++;
  const clientData = {
    id,
    name: "Oyuncu " + id,
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
    lastPongAt: Date.now(),
    lastPingSentAt: 0,
    awaitingPong: false,
    rateLimitWindowStart: Date.now(),
    rateLimitCounts: {},
  };
  if (ws._socket) {
    ws._socket.setNoDelay(true);
    ws._socket.setKeepAlive(true, 2000);
  }
  clients.set(ws, clientData);
  startPingLoop();

  if (!hostId) hostId = id;

  ws.send(JSON.stringify({ type: "welcome", id, hostId, settings: gameSettings }));
  sendLobbyUpdate();

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
    const now = Date.now();
    client.lastPongAt = now;
    if (!client.awaitingPong) return;
    client.awaitingPong = false;

    const rawPing = Math.max(0, Math.round(now - client.lastPingSentAt));
    client.pingRawMs = rawPing;
    if (!Number.isFinite(client.pingMs)) {
      client.pingMs = rawPing;
      return;
    }
    const cappedRaw = Math.min(rawPing, Math.round(client.pingMs * PING_SPIKE_CAP_MULTIPLIER));
    const smooth = client.pingMs + (cappedRaw - client.pingMs) * PING_SMOOTHING_ALPHA;
    client.pingMs = Math.max(0, Math.round(smooth));
  });

  ws.on("close", () => {
    const client = clients.get(ws);
    clients.delete(ws);

    if (client && client.id === hostId) {
      const remaining = [...clients.values()];
      hostId = remaining.length > 0 ? remaining[0].id : null;
    }

    if (clients.size === 0) {
      stopGameLoop();
      gameState = "lobby";
      scoreRed = 0;
      scoreBlue = 0;
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
    }

    sendLobbyUpdate();
  });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} alindi, sunucu kapatiliyor...`);
  stopGameLoop();
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
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 4000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ============ START SERVER ============

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
});
