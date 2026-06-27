import { Execution, Game, MessageType, Player, Unit } from "../game/Game";
import { TileRef } from "../game/GameMap";
import { trebuchetRangeTiles } from "../Grid";
import { BoulderExecution } from "./BoulderExecution";

/**
 * Player-triggered: launch one boulder from a trebuchet at a target tile,
 * validating ownership, reload cooldown and range, then putting the trebuchet
 * on cooldown.
 */
export class FireTrebuchetExecution implements Execution {
  private mg: Game;
  private active = true;

  constructor(
    private player: Player,
    private trebuchet: Unit,
    private targetTile: TileRef,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    const treb = this.trebuchet;
    if (
      !treb.isActive() ||
      treb.owner() !== this.player ||
      treb.isUnderConstruction()
    ) {
      this.active = false;
      return;
    }
    if (!this.mg.isValidRef(this.targetTile)) {
      this.active = false;
      return;
    }
    if (treb.isInCooldown()) {
      this.mg.displayMessage(
        "events_display.trebuchet_reloading",
        MessageType.ATTACK_FAILED,
        this.player.id(),
      );
      this.active = false;
      return;
    }
    // Small tolerance so a maxed-out shot isn't rejected by tile rounding.
    const range = trebuchetRangeTiles(this.mg.width(), this.mg.height()) + 4;
    const d2 = this.mg.euclideanDistSquared(treb.tile(), this.targetTile);
    if (d2 > range * range) {
      this.mg.displayMessage(
        "events_display.trebuchet_out_of_range",
        MessageType.ATTACK_FAILED,
        this.player.id(),
      );
      this.active = false;
      return;
    }

    const cost = this.mg.config().trebuchetShotCost();
    if (this.player.gold() < cost) {
      this.mg.displayMessage(
        "events_display.trebuchet_no_gold",
        MessageType.ATTACK_FAILED,
        this.player.id(),
      );
      this.active = false;
      return;
    }
    this.player.removeGold(cost);

    treb.launch(); // start the reload cooldown
    this.mg.addExecution(
      new BoulderExecution(this.player, treb.tile(), this.targetTile),
    );
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
