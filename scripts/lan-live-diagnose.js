"use strict";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.max(0, Math.floor(sorted.length * q) - 1);
  return sorted[idx];
}

async function main() {
  const baseUrl = process.argv[2] || "http://127.0.0.1:3000";
  const seconds = Math.max(8, Number(process.argv[3] || 30));
  const intervalMs = 2000;
  const polls = Math.max(2, Math.floor((seconds * 1000) / intervalMs));

  const snapshots = [];
  console.log(`LAN live diagnose: ${baseUrl} (${seconds}s, ${polls} sample)`);
  for (let i = 0; i < polls; i++) {
    const res = await fetch(`${baseUrl}/debug/network`);
    if (!res.ok) throw new Error(`debug/network failed: ${res.status}`);
    const payload = await res.json();
    snapshots.push(payload);
    const roomInfo = Array.isArray(payload.rooms)
      ? payload.rooms.map((room) => `${room.name}:deltaP95=${room.stateDeltaP95Ms || 0}`).join(" | ")
      : "no room data";
    console.log(
      `[${i + 1}/${polls}] tickP95=${payload.network?.tickElapsedP95Ms || 0} wsBufP95=${payload.network?.wsBufferedP95Bytes || 0} ${roomInfo}`,
    );
    if (i < polls - 1) await sleep(intervalMs);
  }

  const tickP95Series = snapshots.map((s) => Number(s.network?.tickElapsedP95Ms) || 0);
  const wsBufP95Series = snapshots.map((s) => Number(s.network?.wsBufferedP95Bytes) || 0);
  const roomDeltas = [];
  for (const s of snapshots) {
    for (const room of s.rooms || []) {
      if (Number.isFinite(room.stateDeltaP95Ms)) roomDeltas.push(room.stateDeltaP95Ms);
    }
  }

  const summary = {
    tickP95Ms: Math.round(percentile(tickP95Series, 0.95) * 100) / 100,
    wsBufferedP95Bytes: Math.round(percentile(wsBufP95Series, 0.95)),
    roomStateDeltaP95Ms: Math.round(percentile(roomDeltas, 0.95)),
    recommendation: snapshots[snapshots.length - 1]?.recommendations || [],
  };

  console.log("\n=== Live Summary ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("\nLast rooms snapshot:");
  console.log(JSON.stringify(snapshots[snapshots.length - 1]?.rooms || [], null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
