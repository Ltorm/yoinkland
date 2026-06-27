/**
 * TrebuchetFireController — slingshot aim-and-fire for the Trebuchet.
 *
 * Press on your own trebuchet, drag BACK (like a slingshot) to aim — the
 * boulder launches in the OPPOSITE direction, and the pull length sets the
 * distance (capped at the trebuchet's range). Release to fire. A DOM overlay
 * previews the shot line + impact while you aim; map panning is suppressed via
 * `uiState.trebuchetAiming`. All authority is server-side.
 */

import { assetUrl } from "../../core/AssetUrls";
import { EventBus } from "../../core/EventBus";
import { Cell, UnitType } from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";
import { gridCellSize, trebuchetRangeTiles } from "../../core/Grid";
import { Controller } from "../Controller";
import { MouseDownEvent, MouseMoveEvent, MouseUpEvent } from "../InputHandler";
import { TransformHandler } from "../TransformHandler";
import { FireTrebuchetIntentEvent } from "../Transport";
import { UIState } from "../UIState";
import { GameView } from "../view";

const TREB_MAP_ICON = assetUrl("images/TrebuchetMapIcon.svg");
const BOULDER_MAP_ICON = assetUrl("images/BoulderIcon.svg");
const TICK_MS = 100; // sim tick interval, for smoothing boulder flight

const SELECT_RADIUS = 5; // tiles around the click that count as "on the trebuchet"
// Pull distance (cursor→trebuchet, in tiles) is multiplied to set the shot
// distance. Lower = a longer pull-back drag for the same range (more slingshot
// feel) — 5.625 makes the pull ~60% longer than the original 9.
const PULL_TO_DISTANCE = 5.625;

interface Aim {
  target: TileRef;
  dist: number;
  power: number; // 0..1 fraction of max range
  cursorDist: number; // straight-line tiles from trebuchet to cursor
}

export class TrebuchetFireController implements Controller {
  private trebuchetId: number | null = null;
  private originTile: TileRef | null = null;
  private band: HTMLDivElement | null = null;
  private ring: HTMLDivElement | null = null;
  private distLabel: HTMLDivElement | null = null;
  private measuring = false; // spacebar held → show cursor distance
  // Unique map icons (all players), camera-tracked each frame.
  private trebIcons = new Map<number, HTMLImageElement>();
  private rockIcons = new Map<number, HTMLImageElement>();
  // Reload countdown shown below each trebuchet on cooldown.
  private cooldownLabels = new Map<number, HTMLDivElement>();
  // Per-boulder interpolation state so the flying rock isn't choppy.
  private rockLerp = new Map<
    number,
    { px: number; py: number; cx: number; cy: number; t0: number }
  >();

  constructor(
    private game: GameView,
    private eventBus: EventBus,
    private uiState: UIState,
    private transformHandler: TransformHandler,
  ) {}

  init() {
    this.eventBus.on(MouseDownEvent, (e) => this.onDown(e.x, e.y));
    this.eventBus.on(MouseMoveEvent, (e) => {
      if (this.uiState.trebuchetAiming) this.onMove(e.x, e.y);
    });
    this.eventBus.on(MouseUpEvent, (e) => this.onUp(e.x, e.y));
    // Spacebar (while aiming) toggles the "measure" readout for the cursor.
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space" && this.uiState.trebuchetAiming) {
        this.measuring = true;
        e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") this.measuring = false;
    });
    const loop = () => {
      this.drawMapIcons();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private poolIcon(
    map: Map<number, HTMLImageElement>,
    id: number,
    url: string,
    z: string,
  ): HTMLImageElement {
    let img = map.get(id);
    if (img === undefined) {
      img = document.createElement("img");
      img.src = url;
      img.draggable = false;
      img.style.position = "fixed";
      img.style.pointerEvents = "none";
      img.style.zIndex = z;
      img.style.transform = "translate(-50%, -50%)";
      img.style.filter = "drop-shadow(0 1px 2px rgba(0,0,0,0.55))";
      document.body.appendChild(img);
      map.set(id, img);
    }
    return img;
  }

  private place(img: HTMLImageElement, wx: number, wy: number, size: number) {
    const s = this.transformHandler.worldToScreenCoordinates(new Cell(wx, wy));
    img.style.left = `${s.x}px`;
    img.style.top = `${s.y}px`;
    img.style.width = `${size}px`;
    img.style.height = `${size}px`;
    img.style.display = "block";
  }

  private poolCooldownLabel(id: number): HTMLDivElement {
    let el = this.cooldownLabels.get(id);
    if (el === undefined) {
      el = document.createElement("div");
      el.style.position = "fixed";
      el.style.pointerEvents = "none";
      el.style.zIndex = "22";
      el.style.transform = "translate(-50%, 0)";
      el.style.padding = "1px 6px";
      el.style.borderRadius = "6px";
      el.style.font = "bold 12px system-ui, sans-serif";
      el.style.color = "#ffd24a";
      el.style.background = "rgba(20,14,8,0.78)";
      el.style.border = "1px solid rgba(255,210,74,0.5)";
      el.style.whiteSpace = "nowrap";
      el.style.display = "none";
      document.body.appendChild(el);
      this.cooldownLabels.set(id, el);
    }
    return el;
  }

  /** Seconds left on a trebuchet's reload, or 0 if ready. */
  private reloadSecondsLeft(u: {
    isInCooldown(): boolean;
    missileTimerQueue(): number[];
  }): number {
    if (!u.isInCooldown()) return 0;
    const q = u.missileTimerQueue();
    if (q.length === 0) return 0;
    const cooldown = this.game.config().trebuchetCooldown();
    const remTicks = cooldown - (this.game.ticks() - q[0]);
    return Math.max(0, Math.ceil(remTicks / 10));
  }

  private drawMapIcons() {
    const ppt = this.pixelsPerTile();

    // Trebuchets — unique catapult badge (static, smooth) + reload countdown.
    const trebSize = Math.max(20, Math.min(64, ppt * 7));
    const me = this.game.myPlayer();
    const seenT = new Set<number>();
    for (const u of this.game.units(UnitType.Trebuchet)) {
      if (!u.isActive()) continue;
      seenT.add(u.id());
      const wx = this.game.x(u.tile());
      const wy = this.game.y(u.tile());
      this.place(
        this.poolIcon(this.trebIcons, u.id(), TREB_MAP_ICON, "20"),
        wx,
        wy,
        trebSize,
      );
      // Reload countdown, below the building, for the player's own trebuchets.
      const secs =
        me !== null && u.owner().smallID() === me.smallID()
          ? this.reloadSecondsLeft(u)
          : 0;
      const label = this.poolCooldownLabel(u.id());
      if (secs > 0) {
        const s = this.transformHandler.worldToScreenCoordinates(
          new Cell(wx, wy),
        );
        label.textContent = `⟳ ${secs}s`;
        label.style.left = `${s.x}px`;
        label.style.top = `${s.y + trebSize / 2 + 4}px`;
        label.style.display = "block";
      } else {
        label.style.display = "none";
      }
    }
    for (const [id, img] of this.trebIcons) {
      if (!seenT.has(id)) {
        img.remove();
        this.trebIcons.delete(id);
        const lbl = this.cooldownLabels.get(id);
        if (lbl) {
          lbl.remove();
          this.cooldownLabels.delete(id);
        }
      }
    }

    // Boulders — big rock (building-icon sized), interpolated for smoothness.
    const rockSize = Math.max(28, Math.min(110, ppt * 11));
    const now = Date.now();
    const seenB = new Set<number>();
    for (const u of this.game.units(UnitType.Boulder)) {
      if (!u.isActive()) continue;
      seenB.add(u.id());
      const tx = this.game.x(u.tile());
      const ty = this.game.y(u.tile());
      let st = this.rockLerp.get(u.id());
      if (st === undefined) {
        st = { px: tx, py: ty, cx: tx, cy: ty, t0: now };
        this.rockLerp.set(u.id(), st);
      } else if (tx !== st.cx || ty !== st.cy) {
        st.px = st.cx;
        st.py = st.cy;
        st.cx = tx;
        st.cy = ty;
        st.t0 = now;
      }
      const a = Math.min(1, (now - st.t0) / TICK_MS);
      this.place(
        this.poolIcon(this.rockIcons, u.id(), BOULDER_MAP_ICON, "21"),
        st.px + (st.cx - st.px) * a,
        st.py + (st.cy - st.py) * a,
        rockSize,
      );
    }
    for (const [id, img] of this.rockIcons) {
      if (!seenB.has(id)) {
        img.remove();
        this.rockIcons.delete(id);
        this.rockLerp.delete(id);
      }
    }
  }

  private onDown(screenX: number, screenY: number) {
    if (
      this.uiState.trebuchetAiming ||
      this.uiState.landBridgeMode ||
      this.uiState.sellLandMode ||
      this.uiState.ghostStructure !== null
    ) {
      return;
    }
    const me = this.game.myPlayer();
    if (me === null) return;
    const c = this.transformHandler.screenToWorldCoordinates(screenX, screenY);
    if (!this.game.isValidCoord(c.x, c.y)) return;
    const clickRef = this.game.ref(c.x, c.y);

    const treb = this.game
      .units(UnitType.Trebuchet)
      .filter((u) => u.isActive() && u.owner().smallID() === me.smallID())
      .sort(
        (a, b) =>
          this.game.manhattanDist(a.tile(), clickRef) -
          this.game.manhattanDist(b.tile(), clickRef),
      )[0];
    if (treb === undefined) return;
    if (this.game.manhattanDist(treb.tile(), clickRef) > SELECT_RADIUS) return;

    this.trebuchetId = treb.id();
    this.originTile = treb.tile();
    this.uiState.trebuchetAiming = true;
    this.onMove(screenX, screenY);
  }

  /** Slingshot: fire OPPOSITE the pull; distance = pull length × multiplier,
   *  capped at range. The exact landing spot is intentionally not shown. */
  private aim(screenX: number, screenY: number): Aim | null {
    if (this.originTile === null) return null;
    const c = this.transformHandler.screenToWorldCoordinates(screenX, screenY);
    const ox = this.game.x(this.originTile);
    const oy = this.game.y(this.originTile);
    const pullX = c.x - ox;
    const pullY = c.y - oy;
    const pullLen = Math.hypot(pullX, pullY);
    const range = trebuchetRangeTiles(this.game.width(), this.game.height());
    if (pullLen < 1)
      return { target: this.originTile, dist: 0, power: 0, cursorDist: 0 };

    const dist = Math.min(pullLen * PULL_TO_DISTANCE, range);
    const tx = Math.round(ox - (pullX / pullLen) * dist);
    const ty = Math.round(oy - (pullY / pullLen) * dist);
    const cx = Math.max(0, Math.min(this.game.width() - 1, tx));
    const cy = Math.max(0, Math.min(this.game.height() - 1, ty));
    if (!this.game.isValidCoord(cx, cy)) return null;
    return {
      target: this.game.ref(cx, cy),
      dist,
      power: dist / range,
      cursorDist: pullLen,
    };
  }

  private onMove(screenX: number, screenY: number) {
    const a = this.aim(screenX, screenY);
    if (a === null) {
      this.hideGhost();
      return;
    }
    this.renderGhost(screenX, screenY, a);
  }

  private onUp(screenX: number, screenY: number) {
    if (!this.uiState.trebuchetAiming) return;
    const a = this.aim(screenX, screenY);
    if (a !== null && a.dist >= 1 && this.trebuchetId !== null) {
      this.eventBus.emit(
        new FireTrebuchetIntentEvent(this.trebuchetId, a.target),
      );
    }
    this.cancelAim();
  }

  private cancelAim() {
    this.uiState.trebuchetAiming = false;
    this.trebuchetId = null;
    this.originTile = null;
    this.hideGhost();
  }

  private isReloading(): boolean {
    if (this.trebuchetId === null) return false;
    const u = this.game
      .units(UnitType.Trebuchet)
      .find((t) => t.id() === this.trebuchetId);
    return u?.isInCooldown() ?? false;
  }

  // ── DOM overlay: a slingshot "tension band" pulled BACK toward the cursor,
  // plus an "engaged" ring on the trebuchet. The landing spot is NOT shown. ──
  private pixelsPerTile(): number {
    const a = this.transformHandler.worldToScreenCoordinates(new Cell(0, 0));
    const b = this.transformHandler.worldToScreenCoordinates(new Cell(1, 0));
    return Math.hypot(b.x - a.x, b.y - a.y) || 1;
  }

  private ensureBand(): HTMLDivElement {
    if (this.band === null) {
      const el = document.createElement("div");
      el.style.position = "fixed";
      el.style.pointerEvents = "none";
      el.style.zIndex = "9998";
      el.style.transformOrigin = "0% 50%";
      el.style.borderRadius = "999px";
      el.style.display = "none";
      document.body.appendChild(el);
      this.band = el;
    }
    return this.band;
  }

  private ensureRing(): HTMLDivElement {
    if (this.ring === null) {
      const el = document.createElement("div");
      el.style.position = "fixed";
      el.style.pointerEvents = "none";
      el.style.zIndex = "9999";
      el.style.borderRadius = "50%";
      el.style.borderStyle = "solid";
      el.style.transform = "translate(-50%, -50%)";
      el.style.display = "none";
      document.body.appendChild(el);
      this.ring = el;
    }
    return this.ring;
  }

  private ensureDistLabel(): HTMLDivElement {
    if (this.distLabel === null) {
      const el = document.createElement("div");
      el.style.position = "fixed";
      el.style.pointerEvents = "none";
      el.style.zIndex = "10000";
      el.style.transform = "translate(-50%, -100%)";
      el.style.padding = "2px 7px";
      el.style.borderRadius = "6px";
      el.style.font = "bold 12px system-ui, sans-serif";
      el.style.textAlign = "center";
      el.style.background = "rgba(20,14,8,0.82)";
      el.style.whiteSpace = "nowrap";
      el.style.display = "none";
      document.body.appendChild(el);
      this.distLabel = el;
    }
    return this.distLabel;
  }

  private hideGhost() {
    if (this.band) this.band.style.display = "none";
    if (this.ring) this.ring.style.display = "none";
    if (this.distLabel) this.distLabel.style.display = "none";
  }

  private renderGhost(screenX: number, screenY: number, a: Aim) {
    if (this.originTile === null) return;
    const o = this.transformHandler.worldToScreenCoordinates(
      new Cell(this.game.x(this.originTile), this.game.y(this.originTile)),
    );
    const reloading = this.isReloading();
    // Hotter (yellow→red) the harder you pull.
    const r = Math.round(232 + (255 - 232) * a.power);
    const g = Math.round(190 - 150 * a.power);
    const bandColor = reloading
      ? "rgba(150,150,150,0.85)"
      : `rgba(${r},${g},40,0.95)`;

    // How far the shot flies, measured in map grid cells.
    const cellSize = gridCellSize(this.game.width(), this.game.height());
    const grids = a.dist / cellSize;

    // Tension band: trebuchet → cursor (the pull-back direction), with a tick
    // mark for every grid cell the boulder will fly.
    const dx = screenX - o.x;
    const dy = screenY - o.y;
    const len = Math.hypot(dx, dy);
    const thick = 4 + a.power * 12;
    const band = this.ensureBand();
    band.style.left = `${o.x}px`;
    band.style.top = `${o.y - thick / 2}px`;
    band.style.width = `${len}px`;
    band.style.height = `${thick}px`;
    // Ticks evenly divide the band, one per whole grid of flight.
    const period = grids > 0.05 ? len / grids : len;
    band.style.background = `repeating-linear-gradient(to right, rgba(255,255,255,0.95) 0 2px, rgba(255,255,255,0) 2px ${period}px), ${bandColor}`;
    band.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
    band.style.boxShadow = reloading
      ? "none"
      : `0 0 ${4 + a.power * 10}px ${bandColor}`;
    band.style.borderRadius = `${thick / 2}px`;
    band.style.display = len > 4 ? "block" : "none";

    // Engaged ring on the trebuchet.
    const ppt = this.pixelsPerTile();
    const rd = Math.max(22, ppt * 6);
    const ring = this.ensureRing();
    ring.style.left = `${o.x}px`;
    ring.style.top = `${o.y}px`;
    ring.style.width = `${rd}px`;
    ring.style.height = `${rd}px`;
    ring.style.borderWidth = "3px";
    ring.style.borderColor = reloading
      ? "rgba(220,60,40,0.95)"
      : "rgba(255,210,70,0.95)";
    ring.style.boxShadow = "0 0 10px rgba(0,0,0,0.5)";
    ring.style.display = "block";

    // Distance readout near the cursor: how far the boulder will fly (grids),
    // plus the cursor's own distance when "measuring" (spacebar held).
    const maxed = a.power >= 0.999;
    const label = this.ensureDistLabel();
    const flies = `${grids.toFixed(1)} grids`;
    const cursorGrids = (a.cursorDist / cellSize).toFixed(1);
    label.textContent = this.measuring
      ? `flies ${flies}  •  cursor ${cursorGrids} grids`
      : reloading
        ? `${flies} — reloading`
        : maxed
          ? `${flies} (max)`
          : flies;
    label.style.color = reloading || maxed ? "#ff7a5c" : "#ffe08a";
    label.style.border = `1px solid ${reloading || maxed ? "rgba(255,90,60,0.6)" : "rgba(255,210,74,0.5)"}`;
    label.style.left = `${screenX}px`;
    label.style.top = `${screenY - 16}px`;
    label.style.display = "block";
  }
}
