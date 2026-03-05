const {
  BALL_INV_MASS,
  PLAYER_INV_MASS,
  PLAYER_OUTSIDE_MARGIN,
  BALL_R,
  CX,
  CY,
} = require("../config/constants");

function handlePlayerInput(room, client) {
  const p = client.player;
  const keys = client.keys;
  if (!p || !keys) return;

  let ax = 0;
  let ay = 0;
  if (keys.up) ay -= 1;
  if (keys.down) ay += 1;
  if (keys.left) ax -= 1;
  if (keys.right) ax += 1;

  if (ax !== 0 && ay !== 0) {
    ax *= 0.7071;
    ay *= 0.7071;
  }

  const isKicking = keys.shoot || keys.pass || keys.throughPass || keys.kick;
  p.kicking = isKicking;
  const accel = isKicking
    ? room.gameSettings.playerKickAccel
    : room.gameSettings.playerAccel;
  let damp = isKicking
    ? room.gameSettings.playerKickDamping
    : room.gameSettings.playerDamping;

  if (ax !== 0 || ay !== 0) {
    const dot = p.vx * ax + p.vy * ay;
    if (dot < 0) damp *= 0.88;
  }

  p.vx = p.vx * damp + ax * accel;
  p.vy = p.vy * damp + ay * accel;
}

function circleCollision(a, b) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let dist = Math.hypot(dx, dy);
  const minDist = a.r + b.r;
  if (dist >= minDist) return;

  if (dist <= 0.000001) {
    const rvx = b.vx - a.vx;
    const rvy = b.vy - a.vy;
    const rvLen = Math.hypot(rvx, rvy);
    if (rvLen > 0.000001) {
      dx = rvx;
      dy = rvy;
      dist = rvLen;
    } else {
      dx = 1;
      dy = 0;
      dist = 1;
    }
  }

  const nx = dx / dist;
  const ny = dy / dist;
  const aIM = a.isBall ? BALL_INV_MASS : PLAYER_INV_MASS;
  const bIM = b.isBall ? BALL_INV_MASS : PLAYER_INV_MASS;
  const totalIM = aIM + bIM;

  const targetDist = minDist + 0.001;
  const overlap = targetDist - dist;
  a.x -= nx * overlap * (aIM / totalIM);
  a.y -= ny * overlap * (aIM / totalIM);
  b.x += nx * overlap * (bIM / totalIM);
  b.y += ny * overlap * (bIM / totalIM);

  const dvx = a.vx - b.vx;
  const dvy = a.vy - b.vy;
  const dvn = dvx * nx + dvy * ny;
  if (dvn > 0) {
    const j = dvn / totalIM;
    a.vx -= j * aIM * nx;
    a.vy -= j * aIM * ny;
    b.vx += j * bIM * nx;
    b.vy += j * bIM * ny;
  }
}

function clampAxis(obj, limit, prop, velProp, sign) {
  obj[prop] = limit + sign * obj.r;
  obj[velProp] = sign * Math.abs(obj[velProp]) * 0.5;
}

function constrainGoalZone(obj, xMin, xMax, yMin, yMax) {
  if (obj.x - obj.r < xMin) clampAxis(obj, xMin, "x", "vx", 1);
  if (obj.x + obj.r > xMax) clampAxis(obj, xMax, "x", "vx", -1);
  if (obj.y - obj.r < yMin) clampAxis(obj, yMin, "y", "vy", 1);
  if (obj.y + obj.r > yMax) clampAxis(obj, yMax, "y", "vy", -1);
}

function constrainPostCollision(obj, post) {
  const dx = obj.x - post.x;
  const dy = obj.y - post.y;
  const dist = Math.hypot(dx, dy);
  const minD = obj.r + post.r;
  if (dist >= minD || dist <= 0.001) return;
  const nx = dx / dist;
  const ny = dy / dist;
  obj.x = post.x + nx * minD;
  obj.y = post.y + ny * minD;
  const dot = obj.vx * nx + obj.vy * ny;
  if (dot < 0) {
    obj.vx -= 1.5 * dot * nx;
    obj.vy -= 1.5 * dot * ny;
  }
}

function constrainObj(room, obj, field) {
  const outsideMargin = obj.isBall ? 0 : PLAYER_OUTSIDE_MARGIN;
  const pastLeftX = obj.x - obj.r < field.x1;
  const pastRightX = obj.x + obj.r > field.x2;
  const inGoalY = obj.y + obj.r > field.goalY1 && obj.y - obj.r < field.goalY2;
  const inLeftGoal = pastLeftX && inGoalY;
  const inRightGoal = pastRightX && inGoalY;

  if (inLeftGoal) {
    constrainGoalZone(
      obj,
      field.x1 - field.goalDepth - outsideMargin,
      Infinity,
      field.goalY1 - outsideMargin,
      field.goalY2 + outsideMargin,
    );
  } else if (inRightGoal) {
    constrainGoalZone(
      obj,
      -Infinity,
      field.x2 + field.goalDepth + outsideMargin,
      field.goalY1 - outsideMargin,
      field.goalY2 + outsideMargin,
    );
  } else {
    constrainGoalZone(
      obj,
      field.x1 - outsideMargin,
      field.x2 + outsideMargin,
      field.y1 - outsideMargin,
      field.y2 + outsideMargin,
    );
  }

  for (const post of field.goalPosts) constrainPostCollision(obj, post);
}

function isGoal(room, field) {
  if (
    room.ball.x < field.x1 &&
    room.ball.y > field.goalY1 &&
    room.ball.y < field.goalY2
  )
    return "blue";
  if (
    room.ball.x > field.x2 &&
    room.ball.y > field.goalY1 &&
    room.ball.y < field.goalY2
  )
    return "red";
  return null;
}

module.exports = {
  handlePlayerInput,
  circleCollision,
  constrainObj,
  isGoal,
};
