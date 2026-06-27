import { Execution, Game, MessageType, Player } from "../game/Game";
import { GameUpdateType } from "../game/GameUpdates";

/**
 * The recipient of a land-sale offer counters with a different price. The old
 * offer is dropped and a fresh one is created at the new price, with the OTHER
 * party now on the hook to respond. Seller/buyer roles and the parcel are
 * unchanged — only the price and who-must-respond flip.
 */
export class CounterLandSaleExecution implements Execution {
  private mg: Game;
  private active = true;

  constructor(
    private responder: Player,
    private offerId: number,
    private price: number,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    this.active = false;
    const offer = this.mg.landSaleOffer(this.offerId);
    if (offer === undefined) return;
    if (offer.recipient !== this.responder) return;

    const newRecipient =
      offer.recipient === offer.buyer ? offer.seller : offer.buyer;
    const price = BigInt(Math.max(0, Math.floor(this.price)));

    // Clear the old card, open a fresh one for the other party.
    this.mg.addUpdate({
      type: GameUpdateType.LandSaleOfferReply,
      offerId: offer.offerId,
      sellerID: offer.seller.smallID(),
      buyerID: offer.buyer.smallID(),
      accepted: false,
    });
    this.mg.removeLandSaleOffer(offer.offerId);
    this.mg.createLandSaleOffer(
      offer.seller,
      offer.buyer,
      newRecipient,
      offer.tiles,
      price,
    );
    this.mg.displayMessage(
      "events_display.land_sale_countered",
      MessageType.DONATION_SENT,
      this.responder.id(),
      undefined,
      { name: newRecipient.displayName() },
    );
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
