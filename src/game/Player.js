const { PLAYER_R, CX, CY, FIELD_HW } = require("../config/constants");

function createPlayerState(client) {
  const isRedSide = Math.random() > 0.5;
  const x = isRedSide ? CX - FIELD_HW * 0.5 : CX + FIELD_HW * 0.5;
  const y = CY;

  return {
    id: client.id,
    name: client.name,
    team: client.team || "spectator",
    x,
    y,
    vx: 0,
    vy: 0,
    r: PLAYER_R,
    kicking: false,
  };
}

function getPlayerRadius(room) {
  const playerScale = Number(room?.gameSettings?.playerSizeScale) || 1;
  return PLAYER_R * playerScale;
}

module.exports = {
  createPlayerState,
  getPlayerRadius,
};
