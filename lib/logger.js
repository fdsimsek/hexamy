"use strict";

function formatLog(level, message, fields = {}) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...fields,
  });
}

function log(level, message, fields = {}) {
  const line = formatLog(level, message, fields);
  if (level === "error" || level === "warn") {
    console.error(line);
    return;
  }
  console.log(line);
}

module.exports = {
  info(message, fields) {
    log("info", message, fields);
  },
  warn(message, fields) {
    log("warn", message, fields);
  },
  error(message, fields) {
    log("error", message, fields);
  },
};
