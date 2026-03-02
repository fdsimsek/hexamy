const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = 3000;

// ============ GAME CONSTANTS (from .hbs map) ============

const SCALE = 0.58;
const W = 1100, H = 640;
const CX = W / 2, CY = H / 2;

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

const PLAYER_R = 15 * SCALE * 1.35;
const BALL_R = 7 * SCALE;

const PLAYER_ACCEL = 0.1 * SCALE;
const PLAYER_DAMPING = 0.96;
const PLAYER_KICK_ACCEL = 0.07 * SCALE;
const PLAYER_KICK_DAMPING = 0.96;
const KICK_STRENGTH = 6 * SCALE;
const KICK_RANGE = PLAYER_R + BALL_R + 4;

const BALL_DAMPING = 0.99;
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

let gameState = 'lobby'; // 'lobby' | 'playing' | 'ended'
let hostId = null;
let ball = { x: CX, y: CY, vx: 0, vy: 0, r: BALL_R };
let scoreRed = 0;
let scoreBlue = 0;
let gameTime = 0;
let goalScoredState = null;
let goalScoredTimer = 0;
let gameLoopInterval = null;
let broadcastInterval = null;
let physicsTick = 0;

// ============ PHYSICS ============

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
    if (c.team === 'red' && c.player) reds.push(c.player);
    if (c.team === 'blue' && c.player) blues.push(c.player);
  }

  const redSpacing = reds.length > 1 ? 50 : 0;
  reds.forEach((p, i) => {
    p.x = CX - SPAWN_DIST;
    p.y = CY + (i - (reds.length - 1) / 2) * redSpacing;
    p.vx = 0; p.vy = 0;
  });

  const blueSpacing = blues.length > 1 ? 50 : 0;
  blues.forEach((p, i) => {
    p.x = CX + SPAWN_DIST;
    p.y = CY + (i - (blues.length - 1) / 2) * blueSpacing;
    p.vx = 0; p.vy = 0;
  });

  ball.x = CX; ball.y = CY; ball.vx = 0; ball.vy = 0;
}

function handlePlayerInput(client) {
  const p = client.player;
  const keys = client.keys;
  if (!p || !keys) return;

  let ax = 0, ay = 0;
  if (keys.up) ay -= 1;
  if (keys.down) ay += 1;
  if (keys.left) ax -= 1;
  if (keys.right) ax += 1;

  if (ax !== 0 && ay !== 0) { ax *= 0.7071; ay *= 0.7071; }

  const isKicking = keys.kick;
  p.kicking = isKicking;
  const accel = isKicking ? PLAYER_KICK_ACCEL : PLAYER_ACCEL;
  let damp = isKicking ? PLAYER_KICK_DAMPING : PLAYER_DAMPING;

  if (ax !== 0 || ay !== 0) {
    const dot = p.vx * ax + p.vy * ay;
    if (dot < 0) damp *= 0.88;
  }

  p.vx = p.vx * damp + ax * accel;
  p.vy = p.vy * damp + ay * accel;
}

function circleCollision(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const minDist = a.r + b.r;
  if (dist < minDist && dist > 0.001) {
    const nx = dx / dist, ny = dy / dist;
    const overlap = minDist - dist;
    const aIM = a.isBall ? BALL_INV_MASS : PLAYER_INV_MASS;
    const bIM = b.isBall ? BALL_INV_MASS : PLAYER_INV_MASS;
    const totalIM = aIM + bIM;

    a.x -= nx * overlap * (aIM / totalIM);
    a.y -= ny * overlap * (aIM / totalIM);
    b.x += nx * overlap * (bIM / totalIM);
    b.y += ny * overlap * (bIM / totalIM);

    const dvx = a.vx - b.vx, dvy = a.vy - b.vy;
    const dvn = dvx * nx + dvy * ny;
    if (dvn > 0) {
      const j = dvn / totalIM;
      a.vx -= j * aIM * nx;
      a.vy -= j * aIM * ny;
      b.vx += j * bIM * nx;
      b.vy += j * bIM * ny;
    }
  }
}

function kickBall(player) {
  const dx = ball.x - player.x, dy = ball.y - player.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < KICK_RANGE && dist > 0.001) {
    const nx = dx / dist, ny = dy / dist;
    ball.vx += nx * KICK_STRENGTH;
    ball.vy += ny * KICK_STRENGTH;
    return true;
  }
  return false;
}

function constrainObj(obj) {
  const r = obj.r;
  const insideLeftGoalX = obj.x - r < FIELD_X1;
  const insideRightGoalX = obj.x + r > FIELD_X2;

  if (insideLeftGoalX) {
    if (obj.x - r < FIELD_X1 - GOAL_DEPTH) { obj.x = FIELD_X1 - GOAL_DEPTH + r; obj.vx = Math.abs(obj.vx) * 0.5; }
    if (obj.y - r < GOAL_Y1) { obj.y = GOAL_Y1 + r; obj.vy = Math.abs(obj.vy) * 0.5; }
    if (obj.y + r > GOAL_Y2) { obj.y = GOAL_Y2 - r; obj.vy = -Math.abs(obj.vy) * 0.5; }
  } else if (insideRightGoalX) {
    if (obj.x + r > FIELD_X2 + GOAL_DEPTH) { obj.x = FIELD_X2 + GOAL_DEPTH - r; obj.vx = -Math.abs(obj.vx) * 0.5; }
    if (obj.y - r < GOAL_Y1) { obj.y = GOAL_Y1 + r; obj.vy = Math.abs(obj.vy) * 0.5; }
    if (obj.y + r > GOAL_Y2) { obj.y = GOAL_Y2 - r; obj.vy = -Math.abs(obj.vy) * 0.5; }
  } else {
    if (obj.y - r < FIELD_Y1) { obj.y = FIELD_Y1 + r; obj.vy = Math.abs(obj.vy) * 0.5; }
    if (obj.y + r > FIELD_Y2) { obj.y = FIELD_Y2 - r; obj.vy = -Math.abs(obj.vy) * 0.5; }
  }

  if (!insideLeftGoalX && !insideRightGoalX) {
    if (obj.x - r < FIELD_X1) { obj.x = FIELD_X1 + r; obj.vx = Math.abs(obj.vx) * 0.5; }
    if (obj.x + r > FIELD_X2) { obj.x = FIELD_X2 - r; obj.vx = -Math.abs(obj.vx) * 0.5; }
  }

  for (const post of goalPosts) {
    const dx = obj.x - post.x, dy = obj.y - post.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const minD = obj.r + post.r;
    if (dist < minD && dist > 0.001) {
      const nx = dx / dist, ny = dy / dist;
      obj.x = post.x + nx * minD;
      obj.y = post.y + ny * minD;
      const dot = obj.vx * nx + obj.vy * ny;
      if (dot < 0) {
        obj.vx -= 1.5 * dot * nx;
        obj.vy -= 1.5 * dot * ny;
      }
    }
  }
}

function isGoal() {
  if (ball.x < FIELD_X1 && ball.y > GOAL_Y1 && ball.y < GOAL_Y2) return 'blue';
  if (ball.x > FIELD_X2 && ball.y > GOAL_Y1 && ball.y < GOAL_Y2) return 'red';
  return null;
}

function gameUpdate() {
  if (gameState !== 'playing') return;

  if (goalScoredState) {
    goalScoredTimer--;
    if (goalScoredTimer <= 0) {
      if (scoreRed >= WIN_SCORE) {
        gameState = 'ended';
        broadcast({ type: 'winner', team: 'red', scoreRed, scoreBlue, time: gameTime });
        return;
      }
      if (scoreBlue >= WIN_SCORE) {
        gameState = 'ended';
        broadcast({ type: 'winner', team: 'blue', scoreRed, scoreBlue, time: gameTime });
        return;
      }
      goalScoredState = null;
      resetPositions();
    }
  }

  gameTime += 1 / 60;

  const activePlayers = getPlayersArray();

  for (const { client } of activePlayers) {
    handlePlayerInput(client);
  }

  for (const { client } of activePlayers) {
    if (client.keys && client.keys.kick && client.kickCooldown <= 0) {
      if (kickBall(client.player)) client.kickCooldown = 8;
    }
    if (client.kickCooldown > 0) client.kickCooldown--;
  }

  ball.vx *= BALL_DAMPING;
  ball.vy *= BALL_DAMPING;

  for (const { player } of activePlayers) {
    player.x += player.vx;
    player.y += player.vy;
  }
  ball.x += ball.vx;
  ball.y += ball.vy;

  for (const { player } of activePlayers) {
    circleCollision(player, ball);
  }
  for (let i = 0; i < activePlayers.length; i++) {
    for (let j = i + 1; j < activePlayers.length; j++) {
      circleCollision(activePlayers[i].player, activePlayers[j].player);
    }
  }

  for (const { player } of activePlayers) {
    constrainObj(player);
  }
  constrainObj(ball);

  const goal = goalScoredState ? null : isGoal();
  if (goal) {
    if (goal === 'red') scoreRed++;
    else scoreBlue++;
    goalScoredState = goal;
    goalScoredTimer = GOAL_CELEBRATION_FRAMES;
    broadcast({ type: 'goal', team: goal, scoreRed, scoreBlue });
  }

}

function broadcastState() {
  if (gameState !== 'playing') return;

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
      });
    }
  }

  broadcast({
    type: 'state',
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
  });
}

// ============ LOBBY & NETWORKING ============

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const [ws] of clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function sendLobbyUpdate() {
  const playersList = [];
  for (const [, c] of clients) {
    playersList.push({ id: c.id, name: c.name, team: c.team });
  }
  broadcast({ type: 'lobby', players: playersList, hostId, gameState });
}

function startGameLoop() {
  gameState = 'playing';
  scoreRed = 0;
  scoreBlue = 0;
  gameTime = 0;
  goalScoredState = null;
  goalScoredTimer = 0;

  ball = { x: CX, y: CY, vx: 0, vy: 0, r: BALL_R, isBall: true };

  for (const [, c] of clients) {
    if (c.team) {
      c.player = {
        x: 0, y: 0, vx: 0, vy: 0,
        r: PLAYER_R, kicking: false, isBall: false,
      };
      c.kickCooldown = 0;
    }
  }

  resetPositions();
  broadcast({ type: 'gameStart' });

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

wss.on('connection', (ws) => {
  const id = nextId++;
  const clientData = {
    id,
    name: 'Oyuncu ' + id,
    team: null,
    keys: { up: false, down: false, left: false, right: false, kick: false },
    player: null,
    kickCooldown: 0,
  };
  clients.set(ws, clientData);

  if (!hostId) hostId = id;

  ws.send(JSON.stringify({ type: 'welcome', id, hostId }));
  sendLobbyUpdate();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const client = clients.get(ws);
    if (!client) return;

    switch (msg.type) {
      case 'join':
        client.name = (msg.name || 'Oyuncu').slice(0, 16);
        sendLobbyUpdate();
        break;

      case 'team':
        if (gameState === 'lobby' || gameState === 'ended') {
          const teamCount = [...clients.values()].filter(c => c.team === msg.team).length;
          if (teamCount < 4) {
            client.team = msg.team;
          }
          sendLobbyUpdate();
        }
        break;

      case 'start':
        if (client.id === hostId && (gameState === 'lobby' || gameState === 'ended')) {
          const hasRed = [...clients.values()].some(c => c.team === 'red');
          const hasBlue = [...clients.values()].some(c => c.team === 'blue');
          if (hasRed && hasBlue) {
            startGameLoop();
          }
        }
        break;

      case 'restart':
        if (client.id === hostId) {
          stopGameLoop();
          gameState = 'lobby';
          for (const [, c] of clients) {
            c.player = null;
          }
          sendLobbyUpdate();
        }
        break;

      case 'input':
        if (gameState === 'playing' && msg.keys) {
          client.keys = {
            up: !!msg.keys.up,
            down: !!msg.keys.down,
            left: !!msg.keys.left,
            right: !!msg.keys.right,
            kick: !!msg.keys.kick,
          };
        }
        break;
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    clients.delete(ws);

    if (client && client.id === hostId) {
      const remaining = [...clients.values()];
      hostId = remaining.length > 0 ? remaining[0].id : null;
    }

    if (clients.size === 0) {
      stopGameLoop();
      gameState = 'lobby';
      scoreRed = 0;
      scoreBlue = 0;
    }

    sendLobbyUpdate();
  });
});

// ============ START SERVER ============

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  let lanIP = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        lanIP = net.address;
        break;
      }
    }
  }

  console.log('');
  console.log('========================================');
  console.log('  HaxBall LAN Sunucu Baslatildi!');
  console.log('========================================');
  console.log(`  Yerel:  http://localhost:${PORT}`);
  console.log(`  LAN:    http://${lanIP}:${PORT}`);
  console.log('');
  console.log('  Arkadaslarin ayni WiFi/LAN\'daysa');
  console.log('  LAN adresini paylasarak katilabilir.');
  console.log('========================================');
  console.log('');
});
