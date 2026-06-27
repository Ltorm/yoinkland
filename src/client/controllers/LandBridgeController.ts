/**
 * LandBridgeController — drives the "Land Bridge" build mode (toggle with B).
 *
 * While the mode is active, the player right-clicks to queue an angled
 * rectangular land-bridge segment growing from their nearest owned coastline
 * (or the tip of the segment they just placed, for chaining) toward the cursor.
 * A DOM overlay previews the segment as you aim; segments are clamped to within
 * 45° of their parent. All authority is server-side (LandBridgeExecution) — this
 * controller only computes the anchor/aim and emits the intent.
 */

import { EventBus } from "../../core/EventBus";
import {
  landBridgeCost,
  MAX_TURN_RADIANS,
  SEGMENT_LENGTH_TILES,
  SEGMENT_WIDTH_TILES,
} from "../../core/execution/LandBridgeExecution";
import { Cell } from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";
import { Controller } from "../Controller";
import {
  LandBridgeModeEvent,
  MouseMoveEvent,
  MouseUpEvent,
} from "../InputHandler";
import { OWNER_MASK } from "../render/gl/utils/TileCodec";
import { TransformHandler } from "../TransformHandler";
import { BuildLandBridgeIntentEvent } from "../Transport";
import { UIState } from "../UIState";
import { renderNumber } from "../Utils";
import { GameView } from "../view";

const ANCHOR_SEARCH_RADIUS = 40; // tiles to search around the cursor for a coast

export class LandBridgeController implements Controller {
  private ghost: HTMLDivElement | null = null;
  private label: HTMLDivElement | null = null;
  private lastMouse: { x: number; y: number } | null = null;
  // Chaining: tip + heading of the segment we just queued, so the next segment
  // can anchor on it and be clamped to within 45°.
  private chainTip: TileRef | null = null;
  private chainAngle: number | null = null;
  // Predicted tip tile → heading for every segment placed this game, so a new
  // segment that snaps onto an existing tip is clamped to ≤45° in the preview
  // (the server enforces this authoritatively regardless).
  private tipAngles = new Map<TileRef, number>();
  // Optimistic count of segments this player has queued this game, used to show
  // the escalating cost on the ghost. The server is authoritative.
  private segmentsBuilt = 0;
  // A dark border drawn along the two long sides of a segment WHILE it builds,
  // tracked to the camera each frame. It's only a construction indicator —
  // removed once the far tip becomes owned land (segment finished), with a time
  // fallback so a clipped segment never leaves a stray outline.
  private segments: Array<{
    center: TileRef;
    tip: TileRef;
    angle: number;
    placedAt: number;
    el: HTMLDivElement;
  }> = [];
  private overlayRaf: number | null = null;

  constructor(
    private game: GameView,
    private eventBus: EventBus,
    private uiState: UIState,
    private transformHandler: TransformHandler,
  ) {}

  init() {
    this.eventBus.on(LandBridgeModeEvent, (e) => this.onModeChange(e.enabled));
    this.eventBus.on(MouseMoveEvent, (e) => {
      this.lastMouse = { x: e.x, y: e.y };
      if (this.uiState.landBridgeMode) this.renderGhost();
    });
    // Left-click places one segment (like building a structure), then mode ends.
    this.eventBus.on(MouseUpEvent, (e) => this.onBuild(e.x, e.y));
    // Keep the built-bridge borders pinned to the map as the camera moves.
    const loop = () => {
      this.updateSegments();
      this.overlayRaf = requestAnimationFrame(loop);
    };
    this.overlayRaf = requestAnimationFrame(loop);
  }

  private exitMode() {
    this.uiState.landBridgeMode = false;
    this.chainTip = null;
    this.chainAngle = null;
    this.hideGhost();
    this.eventBus.emit(new LandBridgeModeEvent(false));
  }

  private onModeChange(enabled: boolean) {
    if (!enabled) {
      this.chainTip = null;
      this.chainAngle = null;
      this.hideGhost();
    } else {
      this.renderGhost();
    }
  }

  private mySmallID(): number | null {
    const me = this.game.myPlayer();
    return me ? me.smallID() : null;
  }

  private ownsTile(tile: TileRef, smallID: number): boolean {
    return (this.game.tileState(tile) & OWNER_MASK) === smallID;
  }

  private touchesWater(tile: TileRef): boolean {
    return this.game.neighbors(tile).some((n) => this.game.isWater(n));
  }

  /** Nearest owned coastline/bridge-tip tile to the cursor, or null. */
  private findAnchor(cursorTile: TileRef): TileRef | null {
    const smallID = this.mySmallID();
    if (smallID === null) return null;
    // Prefer the active chain tip while it's still ours and on the coast.
    if (
      this.chainTip !== null &&
      this.game.isValidRef(this.chainTip) &&
      this.ownsTile(this.chainTip, smallID) &&
      this.touchesWater(this.chainTip)
    ) {
      return this.chainTip;
    }
    const cx = this.game.x(cursorTile);
    const cy = this.game.y(cursorTile);

    // Strong snap: if a previously-built bridge tip is near the cursor, anchor
    // exactly on it so segments chain cleanly (and the ≤45° clamp applies).
    const SNAP_RADIUS = 16;
    let snapBest: TileRef | null = null;
    let snapD2 = SNAP_RADIUS * SNAP_RADIUS + 1;
    for (const tip of this.tipAngles.keys()) {
      if (
        !this.game.isValidRef(tip) ||
        !this.game.isLand(tip) ||
        !this.ownsTile(tip, smallID) ||
        !this.touchesWater(tip)
      ) {
        continue;
      }
      const d2 = (this.game.x(tip) - cx) ** 2 + (this.game.y(tip) - cy) ** 2;
      if (d2 < snapD2) {
        snapD2 = d2;
        snapBest = tip;
      }
    }
    if (snapBest !== null) return snapBest;

    let best: TileRef | null = null;
    let bestD2 = Infinity;
    for (let dy = -ANCHOR_SEARCH_RADIUS; dy <= ANCHOR_SEARCH_RADIUS; dy++) {
      for (let dx = -ANCHOR_SEARCH_RADIUS; dx <= ANCHOR_SEARCH_RADIUS; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!this.game.isValidCoord(x, y)) continue;
        const t = this.game.ref(x, y);
        if (!this.game.isLand(t)) continue;
        if (!this.ownsTile(t, smallID)) continue;
        if (!this.touchesWater(t)) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = t;
        }
      }
    }
    return best;
  }

  /** Heading anchor→cursor, clamped to ±45° of the parent when chaining. */
  private aimAngle(anchor: TileRef, cursorTile: TileRef): number {
    let desired = Math.atan2(
      this.game.y(cursorTile) - this.game.y(anchor),
      this.game.x(cursorTile) - this.game.x(anchor),
    );
    const parent =
      anchor === this.chainTip && this.chainAngle !== null
        ? this.chainAngle
        : this.tipAngles.get(anchor);
    if (parent !== undefined) {
      let delta = desired - parent;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      delta = Math.max(-MAX_TURN_RADIANS, Math.min(MAX_TURN_RADIANS, delta));
      desired = parent + delta;
    }
    return desired;
  }

  private cursorTile(): TileRef | null {
    if (!this.lastMouse) return null;
    const c = this.transformHandler.screenToWorldCoordinates(
      this.lastMouse.x,
      this.lastMouse.y,
    );
    if (!this.game.isValidCoord(c.x, c.y)) return null;
    return this.game.ref(c.x, c.y);
  }

  private onBuild(screenX: number, screenY: number) {
    if (!this.uiState.landBridgeMode) return;
    const c = this.transformHandler.screenToWorldCoordinates(screenX, screenY);
    if (!this.game.isValidCoord(c.x, c.y)) return;
    const cursorTile = this.game.ref(c.x, c.y);
    const anchor = this.findAnchor(cursorTile);
    if (anchor === null) return;

    // Only charge / count when the player can actually afford it, so the price
    // (and the displayed cost) rises only when a bridge is really built.
    const me = this.game.myPlayer();
    const cost = landBridgeCost(this.segmentsBuilt);
    if (me === null || me.gold() < cost) {
      this.renderGhost(); // keep the red "can't afford" ghost; no build
      return;
    }

    const angle = this.aimAngle(anchor, cursorTile);
    this.eventBus.emit(new BuildLandBridgeIntentEvent(anchor, cursorTile));
    this.segmentsBuilt++;
    // Record the predicted far-end tip + heading so a later segment can snap
    // onto it (clamped to ≤45°) when re-selected.
    const tx = Math.round(
      this.game.x(anchor) + Math.cos(angle) * SEGMENT_LENGTH_TILES,
    );
    const ty = Math.round(
      this.game.y(anchor) + Math.sin(angle) * SEGMENT_LENGTH_TILES,
    );
    const tip = this.game.isValidCoord(tx, ty) ? this.game.ref(tx, ty) : anchor;
    if (this.game.isValidCoord(tx, ty)) {
      this.tipAngles.set(tip, angle);
    }
    // Outline the segment's two long sides while it builds.
    const cx = Math.round(
      this.game.x(anchor) + (Math.cos(angle) * SEGMENT_LENGTH_TILES) / 2,
    );
    const cy = Math.round(
      this.game.y(anchor) + (Math.sin(angle) * SEGMENT_LENGTH_TILES) / 2,
    );
    if (this.game.isValidCoord(cx, cy)) {
      this.addSegmentBorder(this.game.ref(cx, cy), tip, angle);
    }
    // One placement per selection — return the cursor to normal, like a build.
    this.exitMode();
  }

  // ── In-progress segment outline (long sides; removed once built) ───────
  private addSegmentBorder(center: TileRef, tip: TileRef, angle: number) {
    const el = document.createElement("div");
    el.style.position = "fixed";
    el.style.pointerEvents = "none";
    el.style.zIndex = "25";
    el.style.boxSizing = "border-box";
    el.style.borderStyle = "solid none"; // long sides only
    el.style.borderColor = "rgba(34,20,4,0.85)";
    el.style.display = "none";
    document.body.appendChild(el);
    this.segments.push({ center, tip, angle, placedAt: Date.now(), el });
  }

  // Generous fallback (~25s > the ~19.5s build) so a clipped segment whose tip
  // never becomes owned still drops its outline.
  private static readonly OUTLINE_MAX_AGE_MS = 25_000;

  private updateSegments() {
    if (this.segments.length === 0) return;
    const smallID = this.mySmallID();
    const ppt = this.pixelsPerTile();
    const lenPx = SEGMENT_LENGTH_TILES * ppt;
    const widPx = SEGMENT_WIDTH_TILES * ppt;
    const bw = Math.max(1.5, ppt * 0.3);
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const seg = this.segments[i];
      // Drop the outline once the segment has finished building (far tip is now
      // owned land), or after the time fallback.
      const done =
        smallID !== null &&
        this.game.isValidRef(seg.tip) &&
        this.game.isLand(seg.tip) &&
        this.ownsTile(seg.tip, smallID);
      if (
        done ||
        Date.now() - seg.placedAt > LandBridgeController.OUTLINE_MAX_AGE_MS
      ) {
        seg.el.remove();
        this.segments.splice(i, 1);
        continue;
      }
      const s = this.transformHandler.worldToScreenCoordinates(
        new Cell(this.game.x(seg.center), this.game.y(seg.center)),
      );
      seg.el.style.width = `${lenPx}px`;
      seg.el.style.height = `${widPx}px`;
      seg.el.style.left = `${s.x}px`;
      seg.el.style.top = `${s.y}px`;
      seg.el.style.borderTopWidth = `${bw}px`;
      seg.el.style.borderBottomWidth = `${bw}px`;
      seg.el.style.transform = `translate(-50%, -50%) rotate(${seg.angle}rad)`;
      seg.el.style.display = "block";
    }
  }

  // ── Ghost overlay (plain DOM, no WebGL) ────────────────────────────────
  private ensureGhost(): HTMLDivElement {
    if (this.ghost === null) {
      const el = document.createElement("div");
      el.style.position = "fixed";
      el.style.pointerEvents = "none";
      el.style.zIndex = "9999";
      el.style.transformOrigin = "0% 50%";
      el.style.border = "2px solid rgba(255,255,255,0.85)";
      el.style.borderRadius = "2px";
      el.style.display = "none";
      document.body.appendChild(el);
      this.ghost = el;
    }
    return this.ghost;
  }

  private ensureLabel(): HTMLDivElement {
    if (this.label === null) {
      const el = document.createElement("div");
      el.style.position = "fixed";
      el.style.pointerEvents = "none";
      el.style.zIndex = "10000";
      el.style.padding = "2px 6px";
      el.style.borderRadius = "4px";
      el.style.font = "bold 12px system-ui, sans-serif";
      el.style.whiteSpace = "nowrap";
      el.style.transform = "translate(-50%, -150%)";
      el.style.display = "none";
      document.body.appendChild(el);
      this.label = el;
    }
    return this.label;
  }

  private hideGhost() {
    if (this.ghost) this.ghost.style.display = "none";
    if (this.label) this.label.style.display = "none";
  }

  private pixelsPerTile(): number {
    const a = this.transformHandler.worldToScreenCoordinates(new Cell(0, 0));
    const b = this.transformHandler.worldToScreenCoordinates(new Cell(1, 0));
    return Math.hypot(b.x - a.x, b.y - a.y) || 1;
  }

  private renderGhost() {
    if (!this.uiState.landBridgeMode) {
      this.hideGhost();
      return;
    }
    const cursorTile = this.cursorTile();
    if (cursorTile === null) {
      this.hideGhost();
      return;
    }
    const anchor = this.findAnchor(cursorTile);
    if (anchor === null) {
      this.hideGhost();
      return;
    }
    const angle = this.aimAngle(anchor, cursorTile);
    const ppt = this.pixelsPerTile();
    const anchorScreen = this.transformHandler.worldToScreenCoordinates(
      new Cell(this.game.x(anchor), this.game.y(anchor)),
    );
    const lengthPx = SEGMENT_LENGTH_TILES * ppt;
    const widthPx = SEGMENT_WIDTH_TILES * ppt;
    const me = this.game.myPlayer();
    const cost = landBridgeCost(this.segmentsBuilt);
    const affordable = me !== null && me.gold() >= cost;

    const el = this.ensureGhost();
    el.style.display = "block";
    el.style.left = `${anchorScreen.x}px`;
    el.style.top = `${anchorScreen.y - widthPx / 2}px`;
    el.style.width = `${lengthPx}px`;
    el.style.height = `${widthPx}px`;
    el.style.transform = `rotate(${angle}rad)`;
    el.style.background = affordable
      ? "rgba(245,166,35,0.35)"
      : "rgba(220,40,40,0.35)";

    // Cost label near the cursor (upright, not rotated).
    if (this.lastMouse) {
      const label = this.ensureLabel();
      label.style.display = "block";
      label.style.left = `${this.lastMouse.x}px`;
      label.style.top = `${this.lastMouse.y}px`;
      label.textContent = `${renderNumber(cost)} gold`;
      label.style.color = affordable ? "#fff3c4" : "#ffd0d0";
      label.style.background = affordable
        ? "rgba(60,40,5,0.85)"
        : "rgba(90,15,15,0.9)";
    }
  }
}
