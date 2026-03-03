"use strict";

class Metrics {
  constructor() {
    this.counters = {
      wsConnectionsTotal: 0,
      wsDisconnectsTotal: 0,
      wsMessagesTotal: 0,
      wsRejectedMessagesTotal: 0,
      matchesCompletedTotal: 0,
      reconnectSuccessTotal: 0,
      reconnectFailuresTotal: 0,
    };
    this.gauges = {
      wsClients: 0,
      activeRooms: 0,
      p95PingMs: 0,
    };
  }

  inc(counter, by = 1) {
    this.counters[counter] = (this.counters[counter] || 0) + by;
  }

  setGauge(name, value) {
    this.gauges[name] = value;
  }

  toPrometheus() {
    const rows = [];
    for (const [key, value] of Object.entries(this.counters)) {
      rows.push(`# TYPE hexamy_${key} counter`);
      rows.push(`hexamy_${key} ${Number(value) || 0}`);
    }
    for (const [key, value] of Object.entries(this.gauges)) {
      rows.push(`# TYPE hexamy_${key} gauge`);
      rows.push(`hexamy_${key} ${Number(value) || 0}`);
    }
    return `${rows.join("\n")}\n`;
  }
}

module.exports = { Metrics };
