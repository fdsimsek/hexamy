const SCALE = 0.64;

module.exports = {
  SCALE,
  W: 1100,
  H: 640,
  CX: 1100 / 2,
  CY: 640 / 2,

  FIELD_HW: 594.56 * SCALE,
  FIELD_HH: 297.28 * SCALE,

  GOAL_HH: 88.08 * SCALE,
  GOAL_DEPTH: 55 * SCALE,
  GOAL_POST_R: 8.8 * SCALE,
  KICKOFF_R: 88 * SCALE,

  PLAYER_R: 15 * SCALE * 1.35,
  BALL_R: 7 * SCALE,
  PLAYER_OUTSIDE_MARGIN: 60 * SCALE,

  DEFAULT_GAME_SETTINGS: {
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
  },

  SETTINGS_LIMITS: {
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
  },

  PLAYER_INV_MASS: 0.5,
  BALL_INV_MASS: 1,
  GOAL_CELEBRATION_FRAMES: 300,
  SPAWN_DIST: 170 * SCALE,
  MAX_TEAM_SIZE: 4,
  TICK_MS: 1000 / 60,

  MAX_WS_PAYLOAD_BYTES: Number(process.env.MAX_WS_PAYLOAD_BYTES || 16 * 1024),
  MAX_CONNECTIONS: Number(process.env.MAX_CONNECTIONS || 64),
  MAX_BUFFERED_AMOUNT_BYTES: Number(
    process.env.MAX_BUFFERED_AMOUNT_BYTES || 512 * 1024,
  ),
  STATE_BROADCAST_HZ: Number(process.env.STATE_BROADCAST_HZ || 30),
  SERVER_JITTER_BUFFER_MS: Number(process.env.SERVER_JITTER_BUFFER_MS || 24),
  MAX_UPDATES_PER_CYCLE: Number(process.env.MAX_UPDATES_PER_CYCLE || 2),
  PING_INTERVAL_MS: Number(process.env.PING_INTERVAL_MS || 200),
  PING_SCAN_INTERVAL_MS: Number(process.env.PING_SCAN_INTERVAL_MS || 50),
  PING_JITTER_MS: Number(process.env.PING_JITTER_MS || 10),
  PONG_TIMEOUT_MS: Number(process.env.PONG_TIMEOUT_MS || 6000),
  PING_SMOOTHING_ALPHA: Number(process.env.PING_SMOOTHING_ALPHA || 0.15),
  PING_MIN_GAP_MS: Number(process.env.PING_MIN_GAP_MS || 150),
  RATE_WINDOW_MS: Number(process.env.RATE_WINDOW_MS || 1000),
  RECONNECT_TTL_MS: Number(process.env.RECONNECT_TTL_MS || 30000),

  BANNED_CHAT_TERMS: String(
    process.env.BANNED_CHAT_TERMS || "aq,salak,mal,oç,oc,amk,anan",
  )
    .split(",")
    .map((it) => it.trim().toLowerCase())
    .filter(Boolean),

  QUICK_CHAT_MAP: {
    hype: "Hadi baski!",
    pass: "Pas ver!",
    defend: "Defansa don!",
    gg: "GG!",
  },
};
