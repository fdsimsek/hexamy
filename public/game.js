// ============ CONNECTION ============

const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
const urlParams = new URLSearchParams(location.search);
const forceNoExtrapolation = ["1", "true", "on"].includes(
  String(urlParams.get("noExtrap") || "").toLowerCase(),
);
const fixedJitterBufferMs = Number(urlParams.get("jitterBufferMs"));
const MIN_JITTER_BUFFER_MS = 8;
let ws = null;
let myId = null;
let currentHostId = null;
let myName = "";
let currentRoomId = null;
let currentRoomName = "";
let currentRoomType = "casual";
let myTeam = null;
let currentGameState = "lobby";
let isLobbyOverlayOpen = false;
let isScoreboardOpen = false;
let availableRooms = [];
let mutedIds = new Set();
const reconnectStorageKey = "hexamy-reconnect-token-v1";
let reconnectToken = localStorage.getItem(reconnectStorageKey) || "";
let reconnectAttempts = 0;
let reconnectTimerId = 0;
let sentReconnect = false;
let lobbyStatusTimerId = 0;
const netStatsEl = document.getElementById("net-stats");
const connectionStatusEl = document.getElementById("connection-status");
const lobbyActionStatusEl = document.getElementById("lobby-action-status");
const leaderboardListEl = document.getElementById("leaderboard-list");
const fpsValueEl = document.getElementById("fps-value");
const chatMessagesEl = document.getElementById("chat-messages");
const chatFormEl = document.getElementById("chat-form");
const chatInputEl = document.getElementById("chat-input");
const adminSettingsEl = document.getElementById("admin-settings");
const settingsRoleNoteEl = document.getElementById("settings-role-note");
const resetSettingsBtn = document.getElementById("reset-settings-btn");
const quickPlayerSizeEl = document.getElementById("quick-player-size");
const quickFieldScaleEl = document.getElementById("quick-field-scale");
const quickPlayerSizeValEl = document.getElementById("quick-player-size-val");
const quickFieldScaleValEl = document.getElementById("quick-field-scale-val");
const mobileControlsEl = document.getElementById("mobile-controls");
const mobileJoystickEl = document.getElementById("mobile-joystick");
const mobileJoystickKnobEl = document.getElementById("mobile-joystick-knob");
const mobileKickBtnEl = document.getElementById("mobile-kick-btn");
const controlsSettingsBtnEl = document.getElementById("controls-settings-btn");
const controlsSettingsModalEl = document.getElementById(
  "controls-settings-modal",
);
const controlsSettingsCloseEl = document.getElementById(
  "controls-settings-close",
);
const controlsBindStatusEl = document.getElementById("controls-bind-status");
const scoreboardOverlayEl = document.getElementById("scoreboard-overlay");
const bindButtons = Array.from(document.querySelectorAll(".bind-btn"));
const nameFormEl = document.getElementById("name-form");
const lobbyContentEl = document.getElementById("lobby-content");
const roomBrowserEl = document.getElementById("room-browser");
const roomListEl = document.getElementById("room-list");
const roomRefreshBtnEl = document.getElementById("room-refresh-btn");
const createRoomFormEl = document.getElementById("create-room-form");
const createRoomNameEl = document.getElementById("create-room-name");
const createRoomPasswordEl = document.getElementById("create-room-password");
const createRoomTypeEl = document.getElementById("create-room-type");
const roomNameLabelEl = document.getElementById("room-name-label");
const roleBadgeEl = document.getElementById("role-badge");
const leaveRoomBtnEl = document.getElementById("leave-room-btn");
const keybindLobbyPassEl = document.getElementById("keybind-pass-lobby");
const keybindLobbyThroughEl = document.getElementById("keybind-through-lobby");
const keybindLobbyShootEl = document.getElementById("keybind-shoot-lobby");
const keybindGamePassEl = document.getElementById("keybind-pass-game");
const keybindGameThroughEl = document.getElementById("keybind-through-game");
const keybindGameShootEl = document.getElementById("keybind-shoot-game");
const touchPointerMq = window.matchMedia("(pointer: coarse)");
const orientationLandscapeMq = window.matchMedia("(orientation: landscape)");
const settingsInputs = Array.from(
  document.querySelectorAll("#admin-settings [data-setting]"),
);
const settingsValueEls = Array.from(
  document.querySelectorAll("[data-setting-value]"),
);
const DEFAULT_GAME_SETTINGS = {
  playerAccel: 0.064,
  playerDamping: 0.96,
  playerKickAccel: 0.0448,
  playerKickDamping: 0.96,
  kickStrength: 3.84,
  kickRangeBonus: 4,
  ballDamping: 0.99,
  playerSizeScale: 1,
  fieldScale: 1,
};
const KEYBINDS_STORAGE_KEY = "hexamy-keybinds-v1";
const defaultKeyBinds = {
  pass: "KeyJ",
  throughPass: "KeyK",
  shoot: "KeyL",
};
const blockedActionCodes = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowLeft",
  "ArrowDown",
  "ArrowRight",
]);
let gameSettings = { ...DEFAULT_GAME_SETTINGS };
let sendSettingsTimer = null;
let awaitingBindAction = null;
let keyBinds = loadKeyBinds();
function setConnectionStatus(text) {
  if (connectionStatusEl) connectionStatusEl.textContent = text;
}

function setLobbyActionStatus(text, level = "info", ttlMs = 2600) {
  if (!lobbyActionStatusEl) return;
  lobbyActionStatusEl.textContent = text || "";
  lobbyActionStatusEl.classList.remove("info", "success", "error");
  lobbyActionStatusEl.classList.add(level || "info");
  if (lobbyStatusTimerId) {
    clearTimeout(lobbyStatusTimerId);
    lobbyStatusTimerId = 0;
  }
  if (ttlMs > 0 && text) {
    lobbyStatusTimerId = window.setTimeout(() => {
      lobbyStatusTimerId = 0;
      lobbyActionStatusEl.textContent = "";
      lobbyActionStatusEl.classList.remove("success", "error");
      lobbyActionStatusEl.classList.add("info");
    }, ttlMs);
  }
}

function updateRoleBadge() {
  if (!roleBadgeEl) return;
  if (!currentRoomId) {
    roleBadgeEl.textContent = "İzleyici";
    return;
  }
  if (isMeHost()) {
    roleBadgeEl.textContent = "Host";
    return;
  }
  roleBadgeEl.textContent = myTeam ? "Oyuncu" : "İzleyici";
}

function scheduleReconnect() {
  if (reconnectTimerId) return;
  reconnectAttempts += 1;
  const waitMs = Math.min(12000, 400 * 2 ** Math.min(6, reconnectAttempts - 1));
  setConnectionStatus(
    `Bağlantı koptu. ${Math.round(waitMs / 1000)} sn sonra tekrar denenecek.`,
  );
  reconnectTimerId = window.setTimeout(() => {
    reconnectTimerId = 0;
    connectWs();
  }, waitMs);
}

function connectWs() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  setConnectionStatus("Sunucuya bağlanıyor...");
  ws = new WebSocket(`${wsProtocol}//${location.host}`);
  sentReconnect = false;

  ws.onopen = () => {
    reconnectAttempts = 0;
    setConnectionStatus("Bağlı");
    if (reconnectToken && !sentReconnect) {
      sentReconnect = true;
      send({ type: "reconnect", token: reconnectToken, name: myName });
    } else if (myName) {
      send({ type: "join", name: myName });
    }
    send({ type: "requestLeaderboard" });
  };

  ws.onclose = () => {
    scheduleReconnect();
  };

  ws.onmessage = (e) => {
    let msg = null;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case "welcome":
        onWelcome(msg);
        break;
      case "reconnectResult":
        onReconnectResult(msg);
        break;
      case "roomList":
        onRoomList(msg);
        break;
      case "roomJoined":
        onRoomJoined(msg);
        break;
      case "roomLeft":
        onRoomLeft();
        break;
      case "roomError":
        onRoomError(msg);
        break;
      case "actionResult":
        onActionResult(msg);
        break;
      case "lobby":
        onLobbyUpdate(msg);
        break;
      case "settings":
        onSettingsUpdate(msg);
        break;
      case "gameStart":
        onGameStart();
        break;
      case "state":
        onGameState(msg);
        break;
      case "goal":
        onGoal(msg);
        break;
      case "winner":
        onWinner(msg);
        break;
      case "chat":
        onChatMessage(msg);
        break;
      case "myPing":
        onMyPing(msg);
        break;
      case "leaderboard":
        onLeaderboard(msg);
        break;
    }
  };
}

connectWs();

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function isTextEntryFocused() {
  const el = document.activeElement;
  if (!el) return false;
  if (el === chatInputEl) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable === true;
}

function isValidActionCode(code) {
  return typeof code === "string" && code.startsWith("Key");
}

function codeToLabel(code) {
  if (!code) return "--";
  if (code.startsWith("Key")) return code.slice(3).toUpperCase();
  return code;
}

function sanitizeKeyBinds(next) {
  const sanitized = { ...defaultKeyBinds };
  if (!next || typeof next !== "object") return sanitized;
  for (const action of Object.keys(defaultKeyBinds)) {
    const code = next[action];
    if (isValidActionCode(code) && !blockedActionCodes.has(code))
      sanitized[action] = code;
  }
  const used = new Set();
  for (const action of Object.keys(sanitized)) {
    if (used.has(sanitized[action]))
      sanitized[action] = defaultKeyBinds[action];
    used.add(sanitized[action]);
  }
  return sanitized;
}

function loadKeyBinds() {
  try {
    const raw = localStorage.getItem(KEYBINDS_STORAGE_KEY);
    if (!raw) return { ...defaultKeyBinds };
    return sanitizeKeyBinds(JSON.parse(raw));
  } catch {
    return { ...defaultKeyBinds };
  }
}

function persistKeyBinds() {
  localStorage.setItem(KEYBINDS_STORAGE_KEY, JSON.stringify(keyBinds));
}

function updateKeybindUI() {
  if (keybindLobbyPassEl)
    keybindLobbyPassEl.textContent = codeToLabel(keyBinds.pass);
  if (keybindLobbyThroughEl)
    keybindLobbyThroughEl.textContent = codeToLabel(keyBinds.throughPass);
  if (keybindLobbyShootEl)
    keybindLobbyShootEl.textContent = codeToLabel(keyBinds.shoot);
  if (keybindGamePassEl)
    keybindGamePassEl.textContent = codeToLabel(keyBinds.pass);
  if (keybindGameThroughEl)
    keybindGameThroughEl.textContent = codeToLabel(keyBinds.throughPass);
  if (keybindGameShootEl)
    keybindGameShootEl.textContent = codeToLabel(keyBinds.shoot);
  for (const btn of bindButtons) {
    const action = btn.dataset.action;
    if (!action || !(action in keyBinds)) continue;
    btn.textContent = codeToLabel(keyBinds[action]);
  }
}

function setBindStatus(text) {
  if (controlsBindStatusEl) controlsBindStatusEl.textContent = text;
}

function openControlsSettings() {
  if (!controlsSettingsModalEl) return;
  awaitingBindAction = null;
  bindButtons.forEach((btn) => btn.classList.remove("waiting"));
  setBindStatus("Bir aksiyon seçip yeni tuşa bas.");
  controlsSettingsModalEl.classList.add("show");
}

function closeControlsSettings() {
  if (!controlsSettingsModalEl) return;
  awaitingBindAction = null;
  bindButtons.forEach((btn) => btn.classList.remove("waiting"));
  controlsSettingsModalEl.classList.remove("show");
}

function handleBindKeydown(e) {
  if (!awaitingBindAction) return false;
  e.preventDefault();
  e.stopPropagation();
  if (e.code === "Escape") {
    awaitingBindAction = null;
    bindButtons.forEach((btn) => btn.classList.remove("waiting"));
    setBindStatus("Atama iptal edildi.");
    return true;
  }
  if (!isValidActionCode(e.code) || blockedActionCodes.has(e.code)) {
    setBindStatus("WASD/ok tuşları ve özel tuşlar atanamaz.");
    return true;
  }
  const alreadyUsedBy = Object.entries(keyBinds).find(
    ([action, code]) => action !== awaitingBindAction && code === e.code,
  );
  if (alreadyUsedBy) {
    setBindStatus("Bu tuş başka bir aksiyonda kullanılıyor.");
    return true;
  }
  const oldCode = keyBinds[awaitingBindAction];
  keyBinds[awaitingBindAction] = e.code;
  keys[oldCode] = false;
  keys[e.code] = false;
  persistKeyBinds();
  updateKeybindUI();
  bindButtons.forEach((btn) => btn.classList.remove("waiting"));
  setBindStatus(`Atandı: ${codeToLabel(e.code)}`);
  awaitingBindAction = null;
  return true;
}

chatFormEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInputEl.value.trim();
  if (!text) return;
  send({ type: "chat", text });
  chatInputEl.value = "";
});
chatInputEl.addEventListener("focus", () => {
  clearGameplayKeys();
});
document.addEventListener("pointerdown", (e) => {
  if (
    document.activeElement === chatInputEl &&
    !chatFormEl.contains(e.target)
  ) {
    chatInputEl.blur();
    clearGameplayKeys();
  }
});

function clearGameplayKeys() {
  for (const k in keys) keys[k] = false;
  updateInputs();
}

// ============ RENDERER & INPUTS ============
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d", { alpha: false });
const keys = {};
let players = [];
let ball = { x: 550, y: 320, r: 4.48 };
let score = { red: 0, blue: 0 };
let gameTime = 0;
let kickoffPending = false;
let kickoffTeam = "";

// --- Interpolation state ---
let prevPlayers = [];
let prevBall = { x: 550, y: 320, r: 4.48 };
let lastStateTime = 0;
let interpFactor = 1;
const LERP_SPEED = 0.25; // interpolation speed (0-1)

const FIELD_COLOR = "#1a1b26";
const LINE_COLOR = "rgba(255, 255, 255, 0.1)";

// --- Input throttling: only send when state actually changes ---
let lastSentInputState = null;
let inputDirty = false;
let inputThrottleTimer = 0;
const INPUT_THROTTLE_MS = 16; // ~60 per second max

function buildInputState() {
  return {
    up: !!(keys["KeyW"] || keys["ArrowUp"]),
    down: !!(keys["KeyS"] || keys["ArrowDown"]),
    left: !!(keys["KeyA"] || keys["ArrowLeft"]),
    right: !!(keys["KeyD"] || keys["ArrowRight"]),
    pass: !!keys[keyBinds.pass],
    throughPass: !!keys[keyBinds.throughPass],
    shoot: !!keys[keyBinds.shoot],
  };
}

function inputStateChanged(a, b) {
  if (!a || !b) return true;
  return (
    a.up !== b.up ||
    a.down !== b.down ||
    a.left !== b.left ||
    a.right !== b.right ||
    a.pass !== b.pass ||
    a.throughPass !== b.throughPass ||
    a.shoot !== b.shoot
  );
}

function flushInput() {
  if (!currentRoomId || isTextEntryFocused()) return;
  const state = buildInputState();
  if (!inputStateChanged(state, lastSentInputState)) return;
  lastSentInputState = state;
  send({ type: "input", keys: state });
}

function updateInputs() {
  inputDirty = true;
  if (inputThrottleTimer) return;
  flushInput();
  inputDirty = false;
  inputThrottleTimer = setTimeout(() => {
    inputThrottleTimer = 0;
    if (inputDirty) {
      flushInput();
      inputDirty = false;
    }
  }, INPUT_THROTTLE_MS);
}

window.addEventListener("keydown", (e) => {
  if (isTextEntryFocused()) {
    if (e.code === "Enter") chatFormEl.dispatchEvent(new Event("submit"));
    return;
  }
  if (awaitingBindAction) {
    handleBindKeydown(e);
    return;
  }
  if (e.code === "Tab") {
    e.preventDefault();
    isScoreboardOpen = true;
    scoreboardOverlayEl.classList.add("show");
  }
  if (e.code === "Escape") {
    if (currentRoomId) {
      if (document.getElementById("lobby").style.display === "none") {
        document.getElementById("lobby").style.display = "flex";
        document.getElementById("game-container").style.display = "none";
      } else {
        document.getElementById("lobby").style.display = "none";
        document.getElementById("game-container").style.display = "block";
      }
    }
  }
  keys[e.code] = true;
  updateInputs();
});

window.addEventListener("keyup", (e) => {
  if (e.code === "Tab") {
    isScoreboardOpen = false;
    scoreboardOverlayEl.classList.remove("show");
  }
  keys[e.code] = false;
  updateInputs();
});

// ============ UI HANDLERS ============
const nameBtn = document.getElementById("name-btn");
const nameInput = document.getElementById("name-input");
if (nameBtn) {
  nameBtn.addEventListener("click", () => {
    const name = nameInput.value.trim();
    if (!name) return;
    myName = name;
    localStorage.setItem("hexamy-nickname", name);
    nameFormEl.style.display = "none";
    roomBrowserEl.classList.add("show");
    send({ type: "join", name });
  });
}

const savedNick = localStorage.getItem("hexamy-nickname");
if (savedNick && nameInput) nameInput.value = savedNick;

roomRefreshBtnEl.addEventListener("click", () => {
  send({ type: "listRooms" });
});

createRoomFormEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const roomName = document.getElementById("create-room-name").value;
  const password = document.getElementById("create-room-password").value;
  const roomType = document.getElementById("create-room-type").value;
  send({
    type: "createRoom",
    roomName,
    password,
    roomType,
    settings: gameSettings,
  });
});

leaveRoomBtnEl.addEventListener("click", () => {
  send({ type: "leaveRoom" });
});

document
  .getElementById("join-red")
  .addEventListener("click", () => send({ type: "team", team: "red" }));
document
  .getElementById("join-blue")
  .addEventListener("click", () => send({ type: "team", team: "blue" }));
document
  .getElementById("join-spectators")
  .addEventListener("click", () => send({ type: "team", team: "spectator" }));

document
  .getElementById("start-btn")
  .addEventListener("click", () => send({ type: "start" }));
document
  .getElementById("add-bot-btn")
  .addEventListener("click", () => send({ type: "addBot" }));
document
  .getElementById("pause-btn")
  .addEventListener("click", () => send({ type: "pause" }));
document
  .getElementById("resume-btn")
  .addEventListener("click", () => send({ type: "resume" }));
document
  .getElementById("reset-match-btn")
  .addEventListener("click", () => send({ type: "resetMatch" }));
document
  .getElementById("restart-btn")
  .addEventListener("click", () => send({ type: "leaveRoom" }));

const toggleAdminBtn = document.getElementById("toggle-admin-btn");
if (toggleAdminBtn) {
  toggleAdminBtn.addEventListener("click", () => {
    const s = adminSettingsEl.style.display;
    adminSettingsEl.style.display = s === "block" ? "none" : "block";
  });
}

settingsInputs.forEach((input) => {
  input.addEventListener("input", (e) => {
    const key = e.target.dataset.setting;
    const val = parseFloat(e.target.value);
    const label = document.querySelector(`[data-setting-value="${key}"]`);
    if (label) label.textContent = val.toFixed(3);

    if (sendSettingsTimer) clearTimeout(sendSettingsTimer);
    sendSettingsTimer = setTimeout(() => {
      send({ type: "settings", settings: { [key]: val } });
    }, 120);
  });
});

resetSettingsBtn.addEventListener("click", () =>
  send({ type: "resetSettings" }),
);

// ============ WS HANDLERS ============
function onWelcome(msg) {
  myId = msg.id;
  reconnectToken = msg.reconnectToken;
  localStorage.setItem(reconnectStorageKey, reconnectToken);
}

function onRoomList(msg) {
  availableRooms = msg.rooms;
  roomListEl.innerHTML = "";
  availableRooms.forEach((room) => {
    const li = document.createElement("li");
    li.className = "room-item";
    li.innerHTML = `
      <div>
        <b>${room.name}</b>
        <span class="room-meta">${room.roomType.toUpperCase()} • ${room.totalCount}/8 • ${room.hasPassword ? "🔒" : "🔓"}</span>
      </div>
      <button class="room-join-btn" onclick="joinRoomById('${room.roomId}')">GİRİŞ</button>
    `;
    roomListEl.appendChild(li);
  });
}

window.joinRoomById = (id) => {
  const pass = prompt("Şifre (gerekiyorsa):") || "";
  send({ type: "joinRoom", roomId: id, password: pass });
};

function onRoomJoined(msg) {
  currentRoomId = msg.room.roomId;
  roomBrowserEl.classList.remove("show");
  lobbyContentEl.classList.add("show");
  roomNameLabelEl.textContent = msg.room.name;
  updateRoleBadge();
}

function onRoomLeft() {
  currentRoomId = null;
  lobbyContentEl.classList.remove("show");
  roomBrowserEl.classList.add("show");
  document.getElementById("game-container").style.display = "none";
  document.getElementById("lobby").style.display = "flex";
}

function onLobbyUpdate(msg) {
  const redList = document.getElementById("red-list");
  const blueList = document.getElementById("blue-list");
  const specList = document.getElementById("spectators-list");
  if (!redList) return;
  redList.innerHTML = "";
  blueList.innerHTML = "";
  specList.innerHTML = "";

  msg.players.forEach((p) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${p.name}${p.id === msg.hostId ? " 👑" : ""}</span>`;
    if (p.id === myId) {
      li.classList.add("me");
      myTeam = p.team;
    }
    if (p.team === "red") redList.appendChild(li);
    else if (p.team === "blue") blueList.appendChild(li);
    else specList.appendChild(li);
  });

  currentHostId = msg.hostId;
  currentGameState = msg.gameState;
  const isHost = isMeHost();

  const startBtn = document.getElementById("start-btn");
  const addBotBtn = document.getElementById("add-bot-btn");
  const adminToggle = document.getElementById("toggle-admin-btn");

  if (adminToggle) adminToggle.style.display = isHost ? "block" : "none";
  if (addBotBtn) addBotBtn.style.display = isHost ? "block" : "none";
  if (startBtn)
    startBtn.style.display =
      isHost && msg.gameState !== "playing" ? "block" : "none";

  updateRoleBadge();
}

function isMeHost() {
  return myId === currentHostId;
}

function onGameState(msg) {
  // Store previous state for interpolation
  prevPlayers = players.map((p) => ({ ...p }));
  prevBall = { ...ball };
  lastStateTime = performance.now();
  interpFactor = 0;

  players = msg.players;
  ball = msg.ball;
  score = { red: msg.scoreRed, blue: msg.scoreBlue };
  gameTime = msg.time;
  kickoffPending = msg.kickoffPending;
  kickoffTeam = msg.kickoffTeam;

  if (currentGameState !== "playing") {
    currentGameState = "playing";
    prevPlayers = players.map((p) => ({ ...p }));
    prevBall = { ...ball };
    interpFactor = 1;
    const lobby = document.getElementById("lobby");
    const game = document.getElementById("game-container");
    if (lobby) lobby.style.display = "none";
    if (game) game.style.display = "block";
    const overlay = document.getElementById("winner-overlay");
    if (overlay) overlay.style.display = "none";
  }

  const scoreRedEl = document.getElementById("score-red");
  const scoreBlueEl = document.getElementById("score-blue");
  if (scoreRedEl) scoreRedEl.textContent = score.red;
  if (scoreBlueEl) scoreBlueEl.textContent = score.blue;

  const timerEl = document.getElementById("timer");
  if (timerEl) {
    const mins = Math.floor(gameTime / 60);
    const secs = Math.floor(gameTime % 60);
    timerEl.textContent = `${mins}:${secs < 10 ? "0" : ""}${secs}`;
  }

  // Update Scoreboard if open or always for sync
  const sbRedList = document.getElementById("sb-red-list");
  const sbBlueList = document.getElementById("sb-blue-list");
  if (sbRedList && sbBlueList) {
    sbRedList.innerHTML = "";
    sbBlueList.innerHTML = "";
    players.forEach((p) => {
      const li = document.createElement("li");
      li.innerHTML = `<span>${p.name}</span> <span>${p.id === myId ? "(Siz)" : ""}</span>`;
      if (p.team === "red") sbRedList.appendChild(li);
      else if (p.team === "blue") sbBlueList.appendChild(li);
    });
  }
}

function onGoal(msg) {
  const flash = document.getElementById("goal-flash");
  const text = document.getElementById("goal-text");
  flash.classList.add("show");
  text.classList.add("show");
  setTimeout(() => {
    flash.classList.remove("show");
    text.classList.remove("show");
  }, 2000);
}

function onWinner(msg) {
  // handled by lobby state change usually
}

function onGameStart() {
  currentGameState = "playing";
  document.getElementById("lobby").style.display = "none";
  document.getElementById("game-container").style.display = "block";
}

function onSettingsUpdate(msg) {
  if (msg.settings) {
    Object.assign(gameSettings, msg.settings);
    // Update ranges if UI is open
    settingsInputs.forEach((input) => {
      const key = input.dataset.setting;
      if (msg.settings[key] !== undefined) {
        input.value = msg.settings[key];
        const valLabel = document.querySelector(
          `[data-setting-value="${key}"]`,
        );
        if (valLabel)
          valLabel.textContent = Number(msg.settings[key]).toFixed(3);
      }
    });
  }
}

function onWinner(msg) {
  currentGameState = "ended";
  const winnerTitle = document.getElementById("winner-title");
  const winnerSub = document.getElementById("winner-sub");
  const overlay = document.getElementById("winner-overlay");

  if (overlay) {
    overlay.style.display = "flex";
    if (winnerTitle) {
      winnerTitle.textContent =
        msg.team === "red" ? "KIRMIZI KAZANDI!" : "MAVİ KAZANDI!";
      winnerTitle.style.color =
        msg.team === "red" ? "var(--accent-red)" : "var(--accent-blue)";
    }
  }
}

function onChatMessage(msg) {
  const div = document.createElement("div");
  div.className = "chat-msg";
  div.innerHTML = `<span class="name">${msg.name}:</span> <span class="text">${msg.text}</span>`;
  chatMessagesEl.appendChild(div);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

// ============ RENDER LOOP ============
function lerp(a, b, t) {
  return a + (b - a) * t;
}

function getInterpPosition(prev, curr, t) {
  if (!prev) return curr;
  return {
    x: lerp(prev.x, curr.x, t),
    y: lerp(prev.y, curr.y, t),
  };
}

function draw() {
  requestAnimationFrame(draw);
  if (currentGameState !== "playing") return;

  // Update interpolation factor
  if (interpFactor < 1) {
    interpFactor = Math.min(1, interpFactor + LERP_SPEED);
  }
  const t = interpFactor;

  ctx.fillStyle = FIELD_COLOR;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw simple field
  ctx.strokeStyle = LINE_COLOR;
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.strokeRect(50, 50, canvas.width - 100, canvas.height - 100);

  ctx.beginPath();
  ctx.moveTo(canvas.width / 2, 50);
  ctx.lineTo(canvas.width / 2, canvas.height - 50);
  ctx.stroke();

  // Circle
  ctx.beginPath();
  ctx.arc(canvas.width / 2, canvas.height / 2, 80, 0, Math.PI * 2);
  ctx.stroke();

  // Ball — interpolated position
  const prevB = prevBall || ball;
  const bx = lerp(prevB.x, ball.x, t);
  const by = lerp(prevB.y, ball.y, t);
  ctx.fillStyle = "#fff";
  ctx.shadowBlur = 10;
  ctx.shadowColor = "#fff";
  ctx.beginPath();
  ctx.arc(bx, by, ball.r || 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  // Players — interpolated positions
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const pp = prevPlayers.find((prev) => prev.id === p.id);
    const pos = pp ? getInterpPosition(pp, p, t) : p;

    ctx.fillStyle = p.team === "red" ? "#ff4757" : "#2e86de";
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, p.r || 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = p.kicking ? "#fff" : "rgba(255,255,255,0.4)";
    ctx.lineWidth = 3;
    ctx.stroke();

    // Name
    ctx.fillStyle = "#fff";
    ctx.font = "bold 13px Outfit";
    ctx.textAlign = "center";
    ctx.fillText(p.name, pos.x, pos.y - (p.r || 15) - 7);
  }
}

function resizeCanvas() {
  canvas.width = 1100;
  canvas.height = 640;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();
draw();
