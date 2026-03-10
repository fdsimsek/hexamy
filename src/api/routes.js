const express = require("express");

function createRouter(deps) {
  const router = express.Router();
  const {
    clients,
    rooms,
    metrics,
    store,
    summarizeNetworkStats,
    summarizeRoomsDetailed,
    calculateP95Ping,
    buildNetworkRecommendations,
  } = deps;

  router.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      wsClients: clients.size,
      rooms: rooms.size,
    });
  });

  router.get("/readyz", (_req, res) => {
    const ready = !deps.shuttingDown();
    res.status(ready ? 200 : 503).json({
      ready,
      wsClients: clients.size,
      rooms: rooms.size,
    });
  });

  router.get("/metrics", (_req, res) => {
    const net = summarizeNetworkStats();
    metrics.setGauge("wsClients", clients.size);
    metrics.setGauge("activeRooms", rooms.size);
    metrics.setGauge("p95PingMs", calculateP95Ping());
    metrics.setGauge("tickElapsedP95Ms", net.tickElapsedP95Ms);
    metrics.setGauge("tickElapsedMaxMs", net.tickElapsedMaxMs);
    metrics.setGauge("tickAccumulatorResets", net.accumulatorResets);
    metrics.setGauge("tickDroppedAccumulatorMs", net.droppedAccumulatorMs);
    metrics.setGauge("tickImmediateSchedules", net.immediateSchedules);
    metrics.setGauge("tickTimeoutSchedules", net.timeoutSchedules);
    metrics.setGauge("wsBufferedP95Bytes", net.wsBufferedP95Bytes);
    metrics.setGauge("wsBufferedMaxBytes", net.wsBufferedMaxBytes);
    metrics.setGauge("stateBursts", net.stateBursts);
    res.type("text/plain").send(metrics.toPrometheus());
  });

  router.get("/debug/network", (_req, res) => {
    const net = summarizeNetworkStats();
    const roomBreakdown = summarizeRoomsDetailed();
    const pingValues = [];
    const pingRawValues = [];
    for (const [, client] of clients) {
      if (Number.isFinite(client.pingMs)) pingValues.push(client.pingMs);
      if (Number.isFinite(client.pingRawMs))
        pingRawValues.push(client.pingRawMs);
    }
    res.json({
      ok: true,
      sampledAt: Date.now(),
      config: deps.config,
      ping: {
        clientsWithPing: pingValues.length,
        p95Ms: Math.round(deps.p95(pingValues)),
        p95RawMs: Math.round(deps.p95(pingRawValues)),
      },
      network: net,
      rooms: roomBreakdown,
      recommendations: buildNetworkRecommendations(net, roomBreakdown),
    });
  });

  router.get("/api/leaderboard", (_req, res) => {
    const rows = Object.values(store.players)
      .sort((a, b) => (b.elo || 1000) - (a.elo || 1000))
      .slice(0, 30);
    res.json({
      season: store.season,
      leaderboard: rows,
    });
  });

  return router;
}

module.exports = createRouter;
