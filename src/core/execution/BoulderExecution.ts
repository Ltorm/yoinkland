import {
  Execution,
  Game,
  Player,
  Structures,
  TrajectoryTile,
  Unit,
  UnitType,
} from "../game/Game";
import { TileRef } from "../game/GameMap";
import { trebuchetRangeTiles } from "../Grid";
import { UniversalPathFinding } from "../pathfinding/PathFinder";
import { ParabolaUniversalPathFinder } from "../pathfinding/PathFinder.Parabola";
import { PathStatus } from "../pathfinding/types";

const SPRITE_RADIUS = 16;

/**
 * A trebuchet boulder: an arcing projectile that, on impact, leaves a FALLOUT
 * crater (never water — unlike a nuke) the same width as an atom bomb, plus a
 * forward "roll" cone whose length scales with how far it was thrown. It
 * relinquishes ownership of every tile it touches (so it shreds land bridges)
 * and destroys structures/ships caught in the crater.
 */
export class BoulderExecution implements Execution {
  private active = true;
  private mg: Game;
  private boulder: Unit | null = null;
  private pathFinder: ParabolaUniversalPathFinder;
  private speed = 0;

  constructor(
    private player: Player,
    private src: TileRef,
    private dst: TileRef,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.speed = mg.config().boulderSpeed();
    this.pathFinder = UniversalPathFinding.Parabola(mg, {
      increment: this.speed,
      distanceBasedHeight: true,
      directionUp: true,
    });
  }

  tick(ticks: number): void {
    if (this.boulder === null) {
      const path = this.pathFinder.findPath(this.src, this.dst) ?? [];
      for (const tile of path) {
        if (this.mg.isImpassable(tile)) {
          this.active = false;
          return;
        }
      }
      this.boulder = this.player.buildUnit(UnitType.Boulder, this.src, {
        targetTile: this.dst,
        trajectory: this.getTrajectory(),
      });
      this.recordMotionPlan(ticks);
      return;
    }

    if (!this.boulder.isActive()) {
      this.active = false;
      return;
    }

    const result = this.pathFinder.next(this.src, this.dst, this.speed);
    if (result.status === PathStatus.COMPLETE) {
      this.detonate();
      return;
    } else if (result.status === PathStatus.NEXT) {
      this.boulder.move(result.node);
      this.boulder.setTrajectoryIndex(this.pathFinder.currentIndex());
    }
  }

  private getTrajectory(): TrajectoryTile[] {
    const tiles = this.pathFinder.findPath(this.src, this.dst) ?? [];
    return tiles.map((tile) => ({ tile, targetable: false }));
  }

  private recordMotionPlan(ticks: number): void {
    if (this.boulder === null) return;
    const pf = UniversalPathFinding.Parabola(this.mg, {
      increment: this.speed,
      distanceBasedHeight: true,
      directionUp: true,
    });
    const path: TileRef[] = [this.src];
    let r = pf.next(this.src, this.dst, this.speed);
    while (r.status === PathStatus.NEXT) {
      path.push(r.node);
      r = pf.next(this.src, this.dst, this.speed);
    }
    this.mg.recordMotionPlan({
      kind: "grid",
      unitId: this.boulder.id(),
      planId: 1,
      startTick: ticks + 1,
      ticksPerStep: 1,
      path,
    });
  }

  private addDisc(out: Set<TileRef>, cx: number, cy: number, r: number): void {
    const mg = this.mg;
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(mg.width() - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(mg.height() - 1, Math.ceil(cy + r));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const dx = px - cx;
        const dy = py - cy;
        if (dx * dx + dy * dy > r2) continue;
        const tile = mg.ref(px, py);
        if (mg.isImpassable(tile)) continue;
        out.add(tile);
      }
    }
  }

  /** Crater = a nuke-width impact disc plus a forward roll cone. */
  private craterTiles(): Set<TileRef> {
    const mg = this.mg;
    const outer = mg.config().nukeMagnitudes(UnitType.Boulder).outer;
    const cx = mg.x(this.dst);
    const cy = mg.y(this.dst);
    const tiles = new Set<TileRef>();
    this.addDisc(tiles, cx, cy, outer);

    const ddx = mg.x(this.dst) - mg.x(this.src);
    const ddy = mg.y(this.dst) - mg.y(this.src);
    const dist = Math.hypot(ddx, ddy);
    if (dist > 0.0001) {
      const dirx = ddx / dist;
      const diry = ddy / dist;
      const range = trebuchetRangeTiles(mg.width(), mg.height());
      const roll = Math.min(1, dist / range) * mg.config().boulderMaxRoll();
      // March forward from the impact, widening from a narrow nose to full
      // nuke width — a cone of fallout the boulder carves as it rolls.
      for (let l = 1; l <= roll; l++) {
        const t = l / roll;
        const halfW = outer * (0.4 + 0.6 * t);
        this.addDisc(tiles, cx + dirx * l, cy + diry * l, halfW);
      }
    }
    return tiles;
  }

  private detonate(): void {
    if (this.boulder === null) return;
    const mg = this.mg;
    const tiles = this.craterTiles();

    // Relinquish ownership and leave fallout (never water). Land-bridge tiles
    // are plain owned land, so this shreds them into irradiated craters.
    for (const tile of tiles) {
      const owner = mg.owner(tile);
      if (owner.isPlayer()) owner.relinquish(tile);
      if (mg.isLand(tile) && !mg.hasOwner(tile)) mg.setFallout(tile, true);
    }

    // Destroy units (structures, ships, …) caught in the crater, but never
    // in-flight projectiles.
    const destroyer = this.player;
    for (const unit of mg.units()) {
      const type = unit.type();
      if (
        type === UnitType.AtomBomb ||
        type === UnitType.HydrogenBomb ||
        type === UnitType.MIRVWarhead ||
        type === UnitType.MIRV ||
        type === UnitType.SAMMissile ||
        type === UnitType.Shell ||
        type === UnitType.Boulder
      ) {
        continue;
      }
      if (tiles.has(unit.tile())) {
        unit.delete(true, destroyer);
      }
    }

    // Refresh nearby building sprites that the crater touched.
    const range =
      mg.config().nukeMagnitudes(UnitType.Boulder).outer +
      mg.config().boulderMaxRoll() +
      SPRITE_RADIUS;
    const r2 = range * range;
    for (const unit of mg.units()) {
      if (
        Structures.has(unit.type()) &&
        mg.euclideanDistSquared(this.dst, unit.tile()) < r2
      ) {
        unit.touch();
      }
    }

    this.boulder.setReachedTarget();
    this.boulder.delete(false);
    this.active = false;
  }

  owner(): Player {
    return this.player;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
