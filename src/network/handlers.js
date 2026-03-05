const { RATE_LIMIT_PER_WINDOW } = require("../config/constants");

function createHandlers(deps) {
  const { clients, rooms, clientsById, store, metrics } = deps;

  function handleMessage(client, msg) {
    if (!msg || typeof msg !== "object") return;

    // Rate limiting
    const now = Date.now();
    const type = msg.type || "default";
    const limit = RATE_LIMIT_PER_WINDOW[type] || RATE_LIMIT_PER_WINDOW.default;

    client.rateLimits = client.rateLimits || {};
    client.rateLimits[type] = client.rateLimits[type] || {
      count: 0,
      resetAt: now + 1000,
    };

    if (now > client.rateLimits[type].resetAt) {
      client.rateLimits[type].count = 0;
      client.rateLimits[type].resetAt = now + 1000;
    }

    if (client.rateLimits[type].count >= limit) {
      metrics.inc("rateLimitTriggeredTotal", 1);
      return;
    }
    client.rateLimits[type].count++;

    // Dispatch
    switch (msg.type) {
      case "pong":
        onPong(client, msg);
        break;
      case "join":
        onJoin(client, msg);
        break;
      case "listRooms":
        onListRooms(client, msg);
        break;
      case "createRoom":
        onCreateRoom(client, msg);
        break;
      case "joinRoom":
        onJoinRoom(client, msg);
        break;
      case "leaveRoom":
        onLeaveRoom(client, msg);
        break;
      case "input":
        onInput(client, msg);
        break;
      case "team":
        onTeam(client, msg);
        break;
      case "chat":
        onChat(client, msg);
        break;
      case "settings":
        onSettings(client, msg);
        break;
      case "start":
        onStart(client, msg);
        break;
      // ... more cases
    }
  }

  function onPong(client, msg) {
    client.lastPongAt = Date.now();
    if (client.lastPingSentAt > 0) {
      const pingArr = Array.isArray(client.pingSamples)
        ? client.pingSamples
        : (client.pingSamples = []);
      const raw = Date.now() - client.lastPingSentAt;
      client.pingRawMs = raw;
      if (pingArr.length >= 20) pingArr.shift();
      pingArr.push(raw);
    }
  }

  // ... implementation of other handlers will be complex to migrate in one go,
  // but I'll move them to here.

  return { handleMessage };
}

module.exports = createHandlers;
