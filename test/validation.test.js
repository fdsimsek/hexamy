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
