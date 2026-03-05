const crypto = require("node:crypto");
const { BANNED_CHAT_TERMS } = require("../config/constants");

function sanitizeName(rawName, fallback) {
  const name = String(rawName ?? "")
    .trim()
    .slice(0, 16);
  return name || fallback;
}

function sanitizeRoomName(rawName, fallback, maxLen = 28) {
  const name = String(rawName ?? "")
    .trim()
    .slice(0, maxLen);
  return name || fallback;
}

function sanitizePassword(rawPassword, maxLen = 64) {
  if (rawPassword == null) return "";
  return String(rawPassword).slice(0, maxLen);
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

function createReconnectToken() {
  return crypto.randomBytes(18).toString("base64url");
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

function sanitizeRoomType(type) {
  return type === "ranked" ? "ranked" : "casual";
}

function sanitizeSettings(custom, defaults) {
  const { SETTINGS_LIMITS } = require("../config/constants");
  const result = { ...defaults };
  if (!custom || typeof custom !== "object") return result;
  for (const [key, limit] of Object.entries(SETTINGS_LIMITS)) {
    if (custom[key] !== undefined) {
      const val = Number(custom[key]);
      if (Number.isFinite(val)) {
        result[key] = Math.max(limit[0], Math.min(limit[1], val));
      }
    }
  }
  return result;
}

module.exports = {
  sanitizeName,
  sanitizeRoomName,
  sanitizePassword,
  sanitizeChatText,
  createReconnectToken,
  createPasswordHash,
  verifyPassword,
  sanitizeRoomType,
  sanitizeSettings,
};
