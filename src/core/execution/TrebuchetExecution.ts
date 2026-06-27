import { Execution, Game, Player, Unit, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";

/**
 * The trebuchet structure. It does not auto-fire (the player aims it with a
 * slingshot gesture → FireTrebuchetExecution); this execution just owns the
 * structure and clears its reload cooldown over time, like a missile silo.
 */
export class TrebuchetExecution implements Execution {
  private mg: Game;
  private active = true;

  constructor(
    private player: Player,
    private tile: TileRef | null,
    private trebuchet: Unit | null = null,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    if (this.trebuchet === null) {
      if (this.tile === null) {
        this.active = false;
        return;
      }
      const spawn = this.player.canBuild(UnitType.Trebuchet, this.tile);
      if (spawn === false) {
        this.active = false;
        return;
      }
      this.trebuchet = this.player.buildUnit(UnitType.Trebuchet, spawn, {});
    }

    if (this.trebuchet.isUnderConstruction()) return;
    if (!this.trebuchet.isActive()) {
      this.active = false;
      return;
    }

    // Clear the reload cooldown once enough ticks have elapsed since firing.
    const frontTime = this.trebuchet.missileTimerQueue()[0];
    if (frontTime !== undefined) {
      const elapsed = this.mg.ticks() - frontTime;
      if (elapsed >= this.mg.config().trebuchetCooldown()) {
        this.trebuchet.reloadMissile();
      }
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
