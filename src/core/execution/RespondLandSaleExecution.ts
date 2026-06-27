import {
  Execution,
  Game,
  LandSaleOffer,
  MessageType,
  Player,
} from "../game/Game";
import { GameUpdateType } from "../game/GameUpdates";

/**
 * The buyer accepts or declines a pending land-sale offer. On accept (and only
 * if the seller still owns the tiles and the buyer can afford it), gold moves
 * buyer→seller and the parcel transfers to the buyer.
 */
export class RespondLandSaleExecution implements Execution {
  private mg: Game;
  private active = true;

  constructor(
    private responder: Player,
    private offerId: number,
    private accept: boolean,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    this.active = false;
    const offer = this.mg.landSaleOffer(this.offerId);
    if (offer === undefined) return;
    // Only the party the offer is currently waiting on may respond.
    if (offer.recipient !== this.responder) return;

    const { seller, buyer, price } = offer;

    if (this.accept) {
      // Only tiles the seller STILL owns are transferable.
      const owned = offer.tiles.filter(
        (t) => this.mg.isValidRef(t) && this.mg.owner(t) === seller,
      );
      if (owned.length === 0) {
        this.finish(offer, false);
        return;
      }
      if (buyer.gold() < price) {
        this.mg.displayMessage(
          "events_display.land_sale_no_gold",
          MessageType.ATTACK_FAILED,
          buyer.id(),
        );
        this.finish(offer, false);
        return;
      }
      if (price > 0n) buyer.donateGold(seller, price);
      for (const t of owned) {
        if (this.mg.owner(t) === seller) buyer.conquer(t);
      }
      this.mg.displayMessage(
        "events_display.land_sale_accepted",
        MessageType.DONATION_RECEIVED,
        seller.id(),
        undefined,
        { name: buyer.displayName() },
      );
      this.finish(offer, true);
    } else {
      this.mg.displayMessage(
        "events_display.land_sale_declined",
        MessageType.DONATION_SENT,
        seller.id(),
        undefined,
        { name: buyer.displayName() },
      );
      this.finish(offer, false);
    }
  }

  private finish(offer: LandSaleOffer, accepted: boolean): void {
    this.mg.addUpdate({
      type: GameUpdateType.LandSaleOfferReply,
      offerId: offer.offerId,
      sellerID: offer.seller.smallID(),
      buyerID: offer.buyer.smallID(),
      accepted,
    });
    this.mg.removeLandSaleOffer(offer.offerId);
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
