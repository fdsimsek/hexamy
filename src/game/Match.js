const {
  CX,
  CY,
  BALL_R,
  GOAL_POST_R,
  FIELD_HW,
  FIELD_HH,
  GOAL_HH,
  GOAL_DEPTH,
  KICKOFF_R,
  GOAL_CELEBRATION_FRAMES,
  WIN_SCORE,
} = require("../config/constants");
const { clamp } = require("../utils/math");
const {
  handlePlayerInput,
  circleCollision,
  constrainObj,
  isGoal,
} = require("./physics");

function getFieldMetrics(room) {
  const fieldScale = clamp(
    Number(room?.gameSettings?.fieldScale) || 1,
    0.8,
    1.25,
  );
  const hw = FIELD_HW * fieldScale;
  const hh = FIELD_HH * fieldScale;
  const goalHH = GOAL_HH * fieldScale;
  const goalDepth = GOAL_DEPTH * fieldScale;
  const kickoffR = KICKOFF_R * fieldScale;
  return {
    fieldScale,
    x1: CX - hw,
    x2: CX + hw,
    y1: CY - hh,
    y2: CY + hh,
    goalY1: CY - goalHH,
    goalY2: CY + goalHH,
    goalDepth,
    kickoffR,
    goalPosts: [
      { x: CX - hw, y: CY - goalHH, r: GOAL_POST_R },
      { x: CX - hw, y: CY + goalHH, r: GOAL_POST_R },
      { x: CX + hw, y: CY - goalHH, r: GOAL_POST_R },
      { x: CX + hw, y: CY + goalHH, r: GOAL_POST_R },
    ],
  };
}

function kickBall(
  room,
  player,
  powerScale = 1,
  dirOverride = null,
  toucherClientId = null,
) {
  const dx = room.ball.x - player.x;
  const dy = room.ball.y - player.y;
  const dist = Math.hypot(dx, dy);

  const playerScale = clamp(
    Number(room?.gameSettings?.playerSizeScale) || 1,
    0.7,
    1.35,
  );
  const playerR = 15 * 0.64 * 1.35 * playerScale; // Simplified from getPlayerRadius

  const kickRange = playerR + BALL_R + room.gameSettings.kickRangeBonus;
  if (dist < kickRange && dist > 0.001) {
    const nx = dx / dist;
    const ny = dy / dist;
    const dirX = dirOverride?.x ?? nx;
    const dirY = dirOverride?.y ?? ny;
    const dirLen = Math.hypot(dirX, dirY);
    const fx = dirLen > 0.0001 ? dirX / dirLen : nx;
    const fy = dirLen > 0.0001 ? dirY / dirLen : ny;
    room.ball.vx += fx * room.gameSettings.kickStrength * powerScale;
    room.ball.vy += fy * room.gameSettings.kickStrength * powerScale;
    if (toucherClientId != null) {
      room.lastAssistTouchId = room.lastTouchId;
      room.lastTouchId = toucherClientId;
    }
    return true;
  }
  return false;
}

function findTeammateTarget(room, client, teamPlayers, leadFrames = 0) {
  const teammates = (teamPlayers[client.team] || []).filter(
    ({ client: teammate }) => teammate.id !== client.id,
  );
  if (teammates.length === 0) return null;
  let best = null;
  let bestDist = Infinity;
  for (const { player } of teammates) {
    const tx = player.x + player.vx * leadFrames;
    const ty = player.y + player.vy * leadFrames;
    const dx = tx - room.ball.x;
    const dy = ty - room.ball.y;
    const d = Math.hypot(dx, dy);
    if (d < bestDist) {
      bestDist = d;
      best = { x: dx, y: dy };
    }
  }
  return best;
}

function performBallAction(room, client, teamPlayers, actionType) {
  const action = actionType === "kick" ? "shoot" : actionType;
  if (action === "pass") {
    const passDir = findTeammateTarget(room, client, teamPlayers, 0);
    return kickBall(room, client.player, 0.56, passDir, client.id);
  }
  if (action === "throughPass") {
    const throughDir = findTeammateTarget(room, client, teamPlayers, 10);
    return kickBall(room, client.player, 0.74, throughDir, client.id);
  }
  return kickBall(room, client.player, 1, null, client.id);
}

function processKicks(room, activePlayers) {
  const teamPlayers = { red: [], blue: [] };
  for (const entry of activePlayers) {
    if (entry.client.team === "red" || entry.client.team === "blue") {
      teamPlayers[entry.client.team].push(entry);
    }
  }
  for (const { client } of activePlayers) {
    if (room.kickoffPending && client.team !== room.kickoffTeam) {
      if (client.kickCooldown > 0) client.kickCooldown--;
      continue;
    }
    if (client.kickCooldown <= 0) {
      const actionType = client.keys?.shoot
        ? "shoot"
        : client.keys?.throughPass
          ? "throughPass"
          : client.keys?.pass
            ? "pass"
            : client.keys?.kick
              ? "kick"
              : null;
      if (
        actionType &&
        performBallAction(room, client, teamPlayers, actionType)
      ) {
        client.matchStats = client.matchStats || {
          goals: 0,
          assists: 0,
          touches: 0,
        };
        client.matchStats.touches += 1;
        client.kickCooldown =
          actionType === "pass" ? 6 : actionType === "throughPass" ? 7 : 8;
        if (room.kickoffPending && client.team === room.kickoffTeam) {
          room.kickoffPending = false;
        }
      }
    }
    if (client.kickCooldown > 0) client.kickCooldown--;
  }
}

function applyMovement(room, activePlayers) {
  for (const { player } of activePlayers) {
    player.x += player.vx;
    player.y += player.vy;
  }
  room.ball.vx *= room.gameSettings.ballDamping;
  room.ball.vy *= room.gameSettings.ballDamping;
  room.ball.x += room.ball.vx;
  room.ball.y += room.ball.vy;
}

function resolveCollisionsInMatch(room, activePlayers, field) {
  for (const { client, player } of activePlayers) {
    if (room.kickoffPending && client.team !== room.kickoffTeam) continue;
    circleCollision(player, room.ball);
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < activePlayers.length; i++) {
      for (let j = i + 1; j < activePlayers.length; j++) {
        circleCollision(activePlayers[i].player, activePlayers[j].player);
      }
    }
  }
  if (room.kickoffPending && Math.hypot(room.ball.vx, room.ball.vy) > 0.05) {
    room.kickoffPending = false;
  }
  for (const { player } of activePlayers) constrainObj(room, player, field);
  constrainObj(room, room.ball, field);
}

function applyKickoffWaitingRules(room, activePlayers, field) {
  if (!room.kickoffPending) return;
  for (const { client, player } of activePlayers) {
    if (client.team === room.kickoffTeam) continue;
    if (client.team === "red" && player.x + player.r > CX) {
      player.x = CX - player.r;
      if (player.vx > 0) player.vx *= -0.3;
    } else if (client.team === "blue" && player.x - player.r < CX) {
      player.x = CX + player.r;
      if (player.vx < 0) player.vx *= -0.3;
    }
    const dx = player.x - CX;
    const dy = player.y - CY;
    const minDist = field.kickoffR + player.r;
    const dist = Math.hypot(dx, dy);
    if (dist < minDist) {
      const nx = dist > 0.001 ? dx / dist : client.team === "red" ? -1 : 1;
      const ny = dist > 0.001 ? dy / dist : 0;
      player.x = CX + nx * minDist;
      player.y = CY + ny * minDist;
      const dot = player.vx * nx + player.vy * ny;
      if (dot < 0) {
        player.vx -= dot * nx;
        player.vy -= dot * ny;
      }
    }
  }
}

function gameUpdate(room, activePlayers, broadcastState, onGoal, onMatchEnd) {
  if (room.gameState !== "playing") return;

  const field = getFieldMetrics(room);

  if (room.goalScoredState) {
    room.goalScoredTimer--;
    if (room.goalScoredTimer <= 0) {
      onGoal(room);
    }
    return;
  }

  room.gameTime += 1 / 60;
  for (const { client } of activePlayers) handlePlayerInput(room, client);

  processKicks(room, activePlayers);
  applyMovement(room, activePlayers);
  resolveCollisionsInMatch(room, activePlayers, field);
  applyKickoffWaitingRules(room, activePlayers, field);

  const goal = isGoal(room, field);
  if (goal) {
    onGoal(room, goal);
  }
}

module.exports = {
  getFieldMetrics,
  kickBall,
  performBallAction,
  gameUpdate,
  processKicks,
  applyMovement,
  resolveCollisionsInMatch,
  applyKickoffWaitingRules,
};
