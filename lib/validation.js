"use strict";

const MESSAGE_SCHEMAS = {
  join: { name: "string" },
  listRooms: {},
  createRoom: { roomName: "string?", password: "string?", roomType: "string?" },
  joinRoom: { roomId: "string|number", password: "string?" },
  leaveRoom: {},
  team: { team: "string" },
  start: {},
  restart: {},
  input: { keys: "object" },
  settings: { settings: "object" },
  resetSettings: {},
  chat: { text: "string" },
  quickChat: { code: "string" },
  mutePlayer: { playerId: "number|string", muted: "boolean" },
  kickPlayer: { playerId: "number|string" },
  transferHost: { playerId: "number|string" },
  requestLeaderboard: {},
  netTelemetry: {
    stateDeltaP95Ms: "number",
    stateDeltaMaxMs: "number",
    jitterBufferMs: "number?",
    extrapolationEnabled: "boolean?",
  },
  reconnect: { token: "string", name: "string?" },
};

function matchesType(value, typeSpec) {
  const optional = typeSpec.endsWith("?");
  const spec = optional ? typeSpec.slice(0, -1) : typeSpec;
  if (optional && (value === undefined || value === null)) return true;
  if (spec.includes("|")) {
    return spec.split("|").some((part) => matchesType(value, part));
  }
  if (spec === "array") return Array.isArray(value);
  if (spec === "object") return value != null && typeof value === "object" && !Array.isArray(value);
  return typeof value === spec;
}

function validateMessageShape(msg) {
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return false;
  const schema = MESSAGE_SCHEMAS[msg.type];
  if (!schema) return false;
  for (const [key, typeSpec] of Object.entries(schema)) {
    if (!matchesType(msg[key], typeSpec)) return false;
  }
  return true;
}

module.exports = { validateMessageShape };
