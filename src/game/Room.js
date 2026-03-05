const {
  CX,
  CY,
  BALL_R,
  DEFAULT_GAME_SETTINGS,
} = require("../config/constants");
const {
  sanitizeSettings,
  sanitizePassword,
  sanitizeRoomType,
} = require("../utils/helpers");

let nextRoomId = 1;

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

  return room;
}

function ensureRoomHost(room, clientsById) {
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

module.exports = {
  createRoomState,
  ensureRoomHost,
  emptyRoomNetStats,
};
