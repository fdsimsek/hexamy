function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function p95(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.max(0, Math.floor(sorted.length * 0.95) - 1);
  return sorted[idx];
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function pickValue(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

module.exports = {
  clamp,
  p95,
  round2,
  pickValue,
};
