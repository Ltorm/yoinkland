import { Execution, Game, MessageType, Player, PlayerID } from "../game/Game";

/**
 * A lord releases one of their vassals, ending the vassalage. The former vassal
 * regains the right to attack/nuke the former lord (and the lord's allies).
 * One-shot.
 */
export class ReleaseVassalExecution implements Execution {
  private active = true;

  constructor(
    private lord: Player,
    private vassalID: PlayerID,
  ) {}

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game, ticks: number): void {
    this.active = false; // one-shot
    if (!mg.hasPlayer(this.vassalID)) {
      console.warn(`ReleaseVassal: vassal ${this.vassalID} not found`);
      return;
    }
    const vassal = mg.player(this.vassalID);
    if (!this.lord.canReleaseVassal(vassal)) {
      console.warn(
        `ReleaseVassal: ${vassal.displayName()} is not ${this.lord.displayName()}'s vassal`,
      );
      return;
    }

    this.lord.releaseVassal(vassal);
    mg.displayMessage(
      "events_display.vassal_released_you",
      MessageType.ALLIANCE_ACCEPTED,
      vassal.id(),
      undefined,
      { name: this.lord.displayName() },
    );
    mg.displayMessage(
      "events_display.released_vassal",
      MessageType.ALLIANCE_BROKEN,
      this.lord.id(),
      undefined,
      { name: vassal.displayName() },
    );
  }

  tick(ticks: number): void {}

  isActive(): boolean {
    return this.active;
  }
}
