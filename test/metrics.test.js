"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Metrics } = require("../lib/metrics");

test("prometheus output includes counters and gauges", () => {
  const metrics = new Metrics();
  metrics.inc("wsConnectionsTotal", 2);
  metrics.setGauge("wsClients", 5);
  const out = metrics.toPrometheus();
  assert.match(out, /hexamy_wsConnectionsTotal 2/);
  assert.match(out, /hexamy_wsClients 5/);
});
