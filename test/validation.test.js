"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateMessageShape } = require("../lib/validation");

test("accepts valid chat message", () => {
  assert.equal(validateMessageShape({ type: "chat", text: "hello" }), true);
});

test("rejects unknown message", () => {
  assert.equal(validateMessageShape({ type: "not-real" }), false);
});

test("rejects invalid createRoom payload", () => {
  assert.equal(validateMessageShape({ type: "createRoom", roomName: 123 }), false);
});

test("accepts valid transferHost payload", () => {
  assert.equal(validateMessageShape({ type: "transferHost", playerId: 42 }), true);
});

test("rejects invalid transferHost payload", () => {
  assert.equal(validateMessageShape({ type: "transferHost" }), false);
});

test("accepts valid net telemetry payload", () => {
  assert.equal(
    validateMessageShape({
      type: "netTelemetry",
      stateDeltaP95Ms: 38,
      stateDeltaMaxMs: 74,
      jitterBufferMs: 24,
      extrapolationEnabled: false,
    }),
    true,
  );
});
