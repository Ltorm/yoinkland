import { Execution, Game, MessageType, Player, PlayerID } from "../game/Game";
import { TileRef } from "../game/GameMap";

// Bound the parcel so a single offer can't carry an enormous tile list.
const MAX_PARCEL_TILES = 4000;

/**
 * A seller offers a parcel of their own land to a bordering neighbor for gold.
 * Validates ownership + adjacency, then registers a pending offer (surfaced to
 * the buyer via a LandSaleOffer game update).
 */
export class ProposeLandSaleExecution implements Execution {
  private mg: Game;
  private active = true;

  constructor(
    private seller: Player,
    private buyerId: PlayerID,
    private tiles: TileRef[],
    private price: number,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    this.active = false;
    if (!this.mg.hasPlayer(this.buyerId)) return;
    const buyer = this.mg.player(this.buyerId);
    if (buyer === this.seller || !buyer.isAlive()) return;

    // Only the seller's own land, capped.
    const parcel = this.tiles.filter(
      (t) => this.mg.isValidRef(t) && this.mg.owner(t) === this.seller,
    );
    if (parcel.length === 0 || parcel.length > MAX_PARCEL_TILES) return;

    // The buyer must border the parcel.
    const touches = parcel.some((t) =>
      this.mg.neighbors(t).some((n) => this.mg.owner(n) === buyer),
    );
    if (!touches) {
      this.mg.displayMessage(
        "events_display.land_sale_not_neighbor",
        MessageType.ATTACK_FAILED,
        this.seller.id(),
      );
      return;
    }

    const price = BigInt(Math.max(0, Math.floor(this.price)));
    this.mg.createLandSaleOffer(this.seller, buyer, parcel, price);
    this.mg.displayMessage(
      "events_display.land_sale_offer_sent",
      MessageType.DONATION_SENT,
      this.seller.id(),
      undefined,
      { name: buyer.displayName() },
    );
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
