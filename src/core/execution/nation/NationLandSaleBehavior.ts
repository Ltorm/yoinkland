import { Game, LandSaleOffer, Player, UnitType } from "../../game/Game";
import { TileRef } from "../../game/GameMap";
import { PseudoRandom } from "../../PseudoRandom";
import { CounterLandSaleExecution } from "../CounterLandSaleExecution";
import { RespondLandSaleExecution } from "../RespondLandSaleExecution";

// Structures a nation won't sell out from under itself.
const PROTECTED_STRUCTURES: UnitType[] = [
  UnitType.City,
  UnitType.Port,
  UnitType.DefensePost,
  UnitType.MissileSilo,
  UnitType.SAMLauncher,
  UnitType.Factory,
];

// Reject all offers for the first 2 minutes of play (10 ticks/sec → 1200).
const REJECT_WINDOW_TICKS = 1200;
// The required gold/land multiplier ramps from 2.0x → 5.0x over this window
// (after the reject window). ×10 so the math stays integer-only.
const RAMP_TICKS = 10800; // ~18 min from the end of the reject window
const MIN_MULT_X10 = 20; // 2.0x
const MAX_MULT_X10 = 50; // 5.0x

/**
 * Bot response to land-sale offers. A nation only ever responds to offers to
 * BUY its land (it never buys land itself). It rejects offers that touch its
 * structures or take more than half its territory; otherwise it accepts when
 * the gold offered relative to its wealth is a high-enough multiple of the
 * land's relative size, and counters at that price if not. The required
 * multiple rises as the game goes on, with a little randomness.
 *
 * All comparisons use integer/bigint math — floats risk desyncs.
 */
export class NationLandSaleBehavior {
  private handled = new Set<number>();

  constructor(
    private random: PseudoRandom,
    private game: Game,
    private player: Player,
  ) {}

  handleLandSaleOffers(): void {
    for (const offer of this.game.pendingLandSaleOffers()) {
      if (offer.recipient !== this.player) continue;
      if (this.handled.has(offer.offerId)) continue;
      this.handled.add(offer.offerId);

      // Nations don't buy land — decline any offer to sell land TO us.
      if (offer.seller !== this.player) {
        this.respond(offer.offerId, false);
        continue;
      }
      this.evaluateBuyOffer(offer);
    }
  }

  private evaluateBuyOffer(offer: LandSaleOffer): void {
    const ticks = this.game.ticks();
    const spawn = this.game.config().numSpawnPhaseTurns();

    // 1. First two minutes: reject everything.
    if (ticks < spawn + REJECT_WINDOW_TICKS) {
      this.respond(offer.offerId, false);
      return;
    }

    // 2. Never sell a parcel containing our own structures.
    if (this.parcelHasStructure(offer.tiles)) {
      this.respond(offer.offerId, false);
      return;
    }

    // 3. Never sell more than half our land in one deal.
    const land = this.player.numTilesOwned();
    if (land <= 0 || offer.tiles.length * 2 > land) {
      this.respond(offer.offerId, false);
      return;
    }

    // 3b. Never sell more than half our coastline (protect naval chokepoints).
    if (this.exceedsHalfCoastline(offer.tiles)) {
      this.respond(offer.offerId, false);
      return;
    }

    // 4. Value test: accept iff  price/gold >= mult * tiles/land
    //    ⇔  price * land * 10 >= multX10 * tiles * gold   (all integers).
    const gold = this.player.gold();
    const multX10 = this.requiredMultX10(ticks, spawn);
    const tiles = BigInt(offer.tiles.length);
    const lhs = offer.price * BigInt(land) * 10n;
    const rhs = BigInt(multX10) * tiles * gold;
    if (lhs >= rhs) {
      this.respond(offer.offerId, true);
      return;
    }

    // 5. Too low: half the time counter at our price, half the time walk away.
    if (this.random.chance(2)) {
      this.respond(offer.offerId, false);
      return;
    }
    // Counter at the price that meets our multiplier:
    //   priceNeeded = multX10 * tiles * gold / (land * 10)
    const needed = (BigInt(multX10) * tiles * gold) / (BigInt(land) * 10n);
    if (needed <= offer.price || needed <= 0n) {
      // Shouldn't happen (offer already failed the test), but guard anyway.
      this.respond(offer.offerId, false);
      return;
    }
    this.game.addExecution(
      new CounterLandSaleExecution(this.player, offer.offerId, Number(needed)),
    );
  }

  /** Required gold/land multiple ×10, ramping 2.0x → 5.0x over time + jitter. */
  private requiredMultX10(ticks: number, spawn: number): number {
    const start = spawn + REJECT_WINDOW_TICKS;
    let pct = 0; // 0..100 through the ramp window
    if (ticks > start) {
      pct = Math.min(100, Math.floor(((ticks - start) * 100) / RAMP_TICKS));
    }
    const base =
      MIN_MULT_X10 + Math.floor((pct * (MAX_MULT_X10 - MIN_MULT_X10)) / 100);
    const jitter = this.random.nextInt(-5, 6); // ±0.5x
    return Math.max(MIN_MULT_X10, Math.min(MAX_MULT_X10, base + jitter));
  }

  /** True if the parcel takes more than half our coastline (water-edge) tiles. */
  private exceedsHalfCoastline(tiles: TileRef[]): boolean {
    const isCoast = (t: TileRef) =>
      this.game.neighbors(t).some((n) => this.game.isWater(n));
    let botCoast = 0;
    for (const t of this.player.borderTiles()) {
      if (isCoast(t)) botCoast++;
    }
    if (botCoast === 0) return false; // landlocked — nothing to protect
    let parcelCoast = 0;
    for (const t of tiles) {
      if (isCoast(t)) parcelCoast++;
    }
    return parcelCoast * 2 > botCoast;
  }

  private parcelHasStructure(tiles: TileRef[]): boolean {
    const parcel = new Set<TileRef>(tiles);
    for (const u of this.player.units(...PROTECTED_STRUCTURES)) {
      if (parcel.has(u.tile())) return true;
    }
    return false;
  }

  private respond(offerId: number, accept: boolean): void {
    this.game.addExecution(
      new RespondLandSaleExecution(this.player, offerId, accept),
    );
  }
}
