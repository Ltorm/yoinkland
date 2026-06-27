import { Execution, Game, MessageType, Player, PlayerID } from "../game/Game";

/**
 * Unconditional surrender: `vassal` becomes the vassal of `lordID`. From then on
 * the vassal can never attack or nuke the lord or the lord's allies, and any
 * alliance between them is dropped so the lord may take the vassal's land freely
 * (no traitor debuff). The vassal can still fight everyone else. One-shot.
 */
export class SurrenderExecution implements Execution {
  private active = true;

  constructor(
    private vassal: Player,
    private lordID: PlayerID,
  ) {}

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game, ticks: number): void {
    this.active = false; // one-shot
    if (!mg.hasPlayer(this.lordID)) {
      console.warn(`Surrender: lord ${this.lordID} not found`);
      return;
    }
    const lord = mg.player(this.lordID);
    if (!this.vassal.canSurrenderTo(lord)) {
      console.warn(
        `Surrender: ${this.vassal.displayName()} cannot surrender to ${lord.displayName()}`,
      );
      return;
    }

    this.vassal.surrenderTo(lord);
    mg.displayMessage(
      "events_display.surrendered_to",
      MessageType.ALLIANCE_BROKEN,
      this.vassal.id(),
      undefined,
      { name: lord.displayName() },
    );
    mg.displayMessage(
      "events_display.vassal_gained",
      MessageType.ALLIANCE_ACCEPTED,
      lord.id(),
      undefined,
      { name: this.vassal.displayName() },
    );
  }

  tick(ticks: number): void {}

  isActive(): boolean {
    return this.active;
  }
}
