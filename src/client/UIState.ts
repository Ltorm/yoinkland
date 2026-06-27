import { PlayerBuildableUnitType } from "../core/game/Game";

export interface UIState {
  attackRatio: number;
  ghostStructure: PlayerBuildableUnitType | null;
  rocketDirectionUp: boolean;
  // True while "Land Bridge" build mode is active (toggle with B). In this mode
  // right-click queues a land-bridge segment instead of opening the radial menu.
  landBridgeMode: boolean;
  // True while the player is dragging a trebuchet's slingshot to aim a shot.
  // Suppresses map panning / attacks until the boulder is fired or cancelled.
  trebuchetAiming: boolean;
  // True while "Sell Land" mode is active — the player lassos a parcel of their
  // own land to offer to a neighbor. Suppresses map panning / attacks.
  sellLandMode: boolean;
}
