import { Execution, Game, MessageType, Player, PlayerID } from "../game/Game";
import { TileRef } from "../game/GameMap";

// Bound the parcel so the offer intent stays under the wire size limit
// (tiles are sent explicitly; see ClientMsgRateLimiter.MAX_INTENT_SIZE).
const MAX_PARCEL_TILES = 1500;

/**
 * A land-sale offer between a seller (who owns the parcel) and a bordering
 * buyer. The proposer may be EITHER party: a seller offering to sell, or a
 * buyer offering to buy. The non-proposer becomes the recipient who must
 * respond. Validates ownership + adjacency, then registers a pending offer.
 */
export class ProposeLandSaleExecution implements Execution {
  private mg: Game;
  private active = true;

  constructor(
    private proposer: Player,
    private sellerId: PlayerID,
    private buyerId: PlayerID,
    private tiles: TileRef[],
    private price: number,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    this.active = false;
    if (!this.mg.hasPlayer(this.sellerId) || !this.mg.hasPlayer(this.buyerId)) {
      return;
    }
    const seller = this.mg.player(this.sellerId);
    const buyer = this.mg.player(this.buyerId);
    if (seller === buyer || !seller.isAlive() || !buyer.isAlive()) return;
    // The proposer must be one of the two parties.
    if (this.proposer !== seller && this.proposer !== buyer) return;

    // Only the seller's own land, capped.
    const parcel = this.tiles.filter(
      (t) => this.mg.isValidRef(t) && this.mg.owner(t) === seller,
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
        this.proposer.id(),
      );
      return;
    }

    const recipient = this.proposer === seller ? buyer : seller;
    const price = BigInt(Math.max(0, Math.floor(this.price)));
    this.mg.createLandSaleOffer(seller, buyer, recipient, parcel, price);
    this.mg.displayMessage(
      "events_display.land_sale_offer_sent",
      MessageType.DONATION_SENT,
      this.proposer.id(),
      undefined,
      { name: recipient.displayName() },
    );
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
