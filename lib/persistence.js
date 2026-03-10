"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function createDefaultStore() {
  return {
    season: {
      id: `season-${new Date().toISOString().slice(0, 10)}`,
      startedAt: Date.now(),
    },
    matches: [],
    players: {},
  };
}

function loadStore() {
  ensureDir();
  if (!fs.existsSync(STORE_FILE)) {
    const init = createDefaultStore();
    fs.writeFileSync(STORE_FILE, JSON.stringify(init, null, 2), "utf8");
    return init;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return {
      season: parsed.season || createDefaultStore().season,
      matches: Array.isArray(parsed.matches) ? parsed.matches : [],
      players:
        parsed.players && typeof parsed.players === "object"
          ? parsed.players
          : {},
    };
  } catch {
    return createDefaultStore();
  }
}

let saveTimer = null;
let pendingStore = null;

function saveStore(store) {
  pendingStore = store;
  if (saveTimer) return; // already scheduled
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!pendingStore) return;
    try {
      ensureDir();
      const data = JSON.stringify(pendingStore, null, 2);
      fs.writeFile(STORE_FILE, data, "utf8", (err) => {
        if (err) console.error("Store save error:", err.message);
      });
    } catch (e) {
      console.error("Store save error:", e.message);
    }
    pendingStore = null;
  }, 2000); // batch writes: at most once per 2 seconds
}

module.exports = {
  loadStore,
  saveStore,
};
