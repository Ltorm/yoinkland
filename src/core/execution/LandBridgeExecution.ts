import { renderNumber } from "../../client/Utils";
import { SAM_CONSTRUCTION_TICKS } from "../configuration/Config";
import { Execution, Game, Gold, MessageType, Player } from "../game/Game";
import { TileRef } from "../game/GameMap";

// ── Tunable land-bridge geometry/balance ────────────────────────────────
// Segment size is expressed relative to a building ("house") icon (width = 2x
// icon, length = 5x icon), then scaled up 33%.
export const HOUSE_ICON_WIDTH_TILES = 4;
const SEGMENT_SIZE_SCALE = 1.33; // +33% (length only)
export const SEGMENT_WIDTH_TILES = 10; // fixed width
export const SEGMENT_LENGTH_TILES = Math.round(
  5 * HOUSE_ICON_WIDTH_TILES * SEGMENT_SIZE_SCALE,
); // 27

// Cost per segment escalates: 100k for the first, +25% for each the player has
// already built, rounded to the nearest 25k and CAPPED at 400k.
// → 100k, 125k, 150k, 200k, 250k, 300k, 375k, 400k (cap), 400k, ...
export const LAND_BRIDGE_BASE_COST = 100_000;
export const LAND_BRIDGE_MAX_COST = 400_000;
const LAND_BRIDGE_COST_STEP = 1.25;
const LAND_BRIDGE_COST_ROUNDING = 25_000;

export function landBridgeCost(segmentsBuilt: number): Gold {
  const raw =
    LAND_BRIDGE_BASE_COST *
    Math.pow(LAND_BRIDGE_COST_STEP, Math.max(0, segmentsBuilt));
  const rounded =
    Math.round(raw / LAND_BRIDGE_COST_ROUNDING) * LAND_BRIDGE_COST_ROUNDING;
  return BigInt(Math.min(rounded, LAND_BRIDGE_MAX_COST));
}

// How long a segment takes to build out — ~35% faster than a SAM Launcher.
export const LAND_BRIDGE_BUILD_TICKS = Math.round(
  SAM_CONSTRUCTION_TICKS * 0.65,
);

// Maximum angle a segment may deviate from the segment it grows off of.
export const MAX_TURN_RADIANS = Math.PI / 4; // 45°

// Per-game count of how many land-bridge segments each player has built, so the
// cost can escalate. Keyed by Game (WeakMap → released with the Game).
const segmentsBuiltByGame = new WeakMap<Game, Map<number, number>>();

export function landBridgeSegmentsBuilt(mg: Game, smallID: number): number {
  return segmentsBuiltByGame.get(mg)?.get(smallID) ?? 0;
}

function incrementSegmentsBuilt(mg: Game, smallID: number): void {
  let m = segmentsBuiltByGame.get(mg);
  if (m === undefined) {
    m = new Map<number, number>();
    segmentsBuiltByGame.set(mg, m);
  }
  m.set(smallID, (m.get(smallID) ?? 0) + 1);
}

// Per-game record of the heading (radians) baked into each built bridge tile,
// so a follow-on segment anchored on a bridge tip can be clamped to within
// MAX_TURN_RADIANS of its parent. Keyed by Game so replays start clean and
// concurrent games don't interfere. WeakMap → released with the Game.
const bridgeAngleByGame = new WeakMap<Game, Map<TileRef, number>>();

function angleMap(mg: Game): Map<TileRef, number> {
  let m = bridgeAngleByGame.get(mg);
  if (m === undefined) {
    m = new Map<TileRef, number>();
    bridgeAngleByGame.set(mg, m);
  }
  return m;
}

function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * The heading (radians) a follow-on segment must stay within MAX_TURN_RADIANS
 * of when anchored on `tile`, or undefined if `tile` is natural coastline (no
 * constraint — the first segment may point anywhere seaward).
 */
export function parentBridgeAngle(mg: Game, tile: TileRef): number | undefined {
  return angleMap(mg).get(tile);
}

/**
 * Tiles of a land-bridge segment: a `width` x `length` rectangle starting at
 * `startTile` and extending along `angle`, returned in build order (nearest the
 * anchor first) so progressive construction grows outward. Includes every tile
 * the rectangle covers, valid or not — the caller filters to buildable water.
 */
export function landBridgeSegmentTiles(
  mg: Game,
  startTile: TileRef,
  angle: number,
  width: number,
  length: number,
): TileRef[] {
  const sx = mg.x(startTile);
  const sy = mg.y(startTile);
  const ax = Math.cos(angle);
  const ay = Math.sin(angle);
  const px = -Math.sin(angle); // perpendicular (across the width)
  const py = Math.cos(angle);
  const halfW = (width - 1) / 2;

  const seen = new Set<TileRef>();
  const ordered: TileRef[] = [];
  // Step finely so a diagonal rectangle has no gaps; dedupe by TileRef.
  for (let l = 0.5; l <= length; l += 0.5) {
    for (let o = -halfW; o <= halfW; o += 0.5) {
      const wx = Math.round(sx + ax * l + px * o);
      const wy = Math.round(sy + ay * l + py * o);
      if (!mg.isValidCoord(wx, wy)) continue;
      const tile = mg.ref(wx, wy);
      if (seen.has(tile)) continue;
      seen.add(tile);
      ordered.push(tile);
    }
  }
  return ordered;
}

/**
 * Disc of tiles within `radius` of `center` — a rounded cap used to smooth the
 * corner where two angled segments meet. Returns all covered tiles (caller
 * filters to buildable water).
 */
export function anchorCapTiles(
  mg: Game,
  center: TileRef,
  radius: number,
): TileRef[] {
  const cx = mg.x(center);
  const cy = mg.y(center);
  const r2 = radius * radius;
  const R = Math.ceil(radius);
  const out: TileRef[] = [];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (!mg.isValidCoord(x, y)) continue;
      out.push(mg.ref(x, y));
    }
  }
  return out;
}

/**
 * Builds one land-bridge segment: an angled rectangular strip of water turned
 * into owned land, growing outward from an owned shoreline/bridge-tip anchor.
 *
 * - Direction is start→target, clamped to within 45° of the parent segment when
 *   chaining off an existing bridge tip.
 * - Tiles convert progressively over SAM_CONSTRUCTION_TICKS so troops spread
 *   across the bridge as it extends (each tile becomes owned land).
 * - Bridge tiles are ordinary owned land, so nukes destroy them for free.
 */
export class LandBridgeExecution implements Execution {
  private active = true;
  private mg: Game;
  private tiles: TileRef[] = [];
  private placed = 0;
  private startTick = 0;
  private duration = 0;
  private angle = 0;

  constructor(
    private player: Player,
    private startTile: TileRef,
    private targetTile: TileRef,
  ) {}

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;

    if (!mg.isValidRef(this.startTile) || !mg.isValidRef(this.targetTile)) {
      console.warn(`LandBridge: invalid tile(s)`);
      this.active = false;
      return;
    }
    // Anchor must be the player's own land that touches water — i.e. a natural
    // coastline tile or the tip of an existing bridge. (Checked via a water
    // neighbour rather than the shoreline bit so it holds for freshly-built
    // bridge tips too.)
    const anchorOwner = mg.owner(this.startTile);
    const touchesWater = mg
      .neighbors(this.startTile)
      .some((n) => mg.isWater(n));
    if (
      !anchorOwner.isPlayer() ||
      anchorOwner.id() !== this.player.id() ||
      !mg.isLand(this.startTile) ||
      !touchesWater
    ) {
      this.fail("events_display.land_bridge_blocked");
      return;
    }

    // Direction toward the target, clamped to ±45° of the parent segment.
    const desired = Math.atan2(
      mg.y(this.targetTile) - mg.y(this.startTile),
      mg.x(this.targetTile) - mg.x(this.startTile),
    );
    const parent = parentBridgeAngle(mg, this.startTile);
    if (parent === undefined) {
      this.angle = desired;
    } else {
      const delta = normalizeAngle(desired - parent);
      const clamped = Math.max(
        -MAX_TURN_RADIANS,
        Math.min(MAX_TURN_RADIANS, delta),
      );
      this.angle = normalizeAngle(parent + clamped);
    }

    // Buildable tiles only: passable water not already owned. A rounded cap at
    // the anchor (built first) fills the inner notch so chained segments meet at
    // smooth corners instead of a hard V.
    const buildable = (t: TileRef) =>
      mg.isWater(t) && !mg.isImpassable(t) && !mg.hasOwner(t);
    const rect = landBridgeSegmentTiles(
      mg,
      this.startTile,
      this.angle,
      SEGMENT_WIDTH_TILES,
      SEGMENT_LENGTH_TILES,
    ).filter(buildable);
    const cap = anchorCapTiles(
      mg,
      this.startTile,
      SEGMENT_WIDTH_TILES / 2,
    ).filter(buildable);
    const seen = new Set(cap);
    this.tiles = [...cap, ...rect.filter((t) => !seen.has(t))];
    if (this.tiles.length === 0) {
      this.fail("events_display.land_bridge_blocked");
      return;
    }

    const cost = landBridgeCost(
      landBridgeSegmentsBuilt(mg, this.player.smallID()),
    );
    if (this.player.gold() < cost) {
      mg.displayMessage(
        "events_display.land_bridge_no_gold",
        MessageType.ATTACK_FAILED,
        this.player.id(),
        cost,
        { gold: renderNumber(cost) },
      );
      this.active = false;
      return;
    }

    this.player.removeGold(cost);
    incrementSegmentsBuilt(mg, this.player.smallID());
    this.startTick = ticks;
    this.duration = mg.config().instantBuild() ? 0 : LAND_BRIDGE_BUILD_TICKS;
    this.placed = 0;
  }

  private fail(messageKey: string): void {
    this.mg.displayMessage(
      messageKey,
      MessageType.ATTACK_FAILED,
      this.player.id(),
    );
    this.active = false;
  }

  tick(ticks: number): void {
    if (!this.active) return;

    const total = this.tiles.length;
    let targetCount: number;
    if (this.duration <= 0) {
      targetCount = total;
    } else {
      const elapsed = ticks - this.startTick + 1;
      targetCount = Math.min(
        total,
        Math.ceil((total * elapsed) / this.duration),
      );
    }

    const angles = angleMap(this.mg);
    while (this.placed < targetCount) {
      const tile = this.tiles[this.placed];
      this.placed++;
      // Re-validate: the tile may have been claimed or nuked since init.
      if (
        !this.mg.isWater(tile) ||
        this.mg.isImpassable(tile) ||
        this.mg.hasOwner(tile)
      ) {
        continue;
      }
      if (!this.mg.convertToLand(tile)) continue;
      this.player.conquer(tile);
      angles.set(tile, this.angle);
    }

    if (this.placed >= total) {
      this.active = false;
    }
  }

  isActive(): boolean {
    return this.active;
  }
}
