/**
 * SellLandController — "Sell Land" lasso + offer flow, and the buyer's focus
 * glow.
 *
 * Seller: enter sell mode (radial) → drag a freeform lasso over your own land →
 * the tiles inside that you own become the parcel (outlined) → a panel lets you
 * pick a bordering neighbor + a price and send the offer. Buyer: when they hit
 * "Focus" on the offer, this controller glows the parcel outline. Authority is
 * server-side (Propose/RespondLandSaleExecution).
 */

import { EventBus } from "../../core/EventBus";
import { Cell } from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";
import { Controller } from "../Controller";
import {
  LandSaleFocusEvent,
  MouseDownEvent,
  MouseMoveEvent,
  MouseOverEvent,
  MouseUpEvent,
  SellLandModeEvent,
} from "../InputHandler";
import { OWNER_MASK } from "../render/gl/utils/TileCodec";
import { PlaySoundEffectEvent } from "../sound/Sounds";
import { TransformHandler } from "../TransformHandler";
import { SendProposeLandSaleIntentEvent } from "../Transport";
import { UIState } from "../UIState";
import { GameView, PlayerView } from "../view";

// Keep in sync with ProposeLandSaleExecution — bounds the offer intent size.
const MAX_PARCEL_TILES = 1500;
const MAX_LASSO_BBOX = 400; // tiles per side — guards the point-in-polygon scan
const GLOW_MS = 7000;
const DRAG_THRESHOLD = 8; // screen px — beyond this a press counts as a freeform drag
const CLOSE_RADIUS = 28; // screen px — clicking within this of the start point closes
const MIN_VERTICES = 3;

export class SellLandController implements Controller {
  private lasso: Array<{ x: number; y: number }> | null = null; // WORLD vertices
  private cursor: { x: number; y: number } | null = null; // WORLD cursor pos
  private pressStartScreen: { x: number; y: number } | null = null;
  private dragging = false;
  private lastPushScreen: { x: number; y: number } | null = null;
  private parcel: TileRef[] = [];
  private parcelSet = new Set<TileRef>();
  // sell = my land → pick a neighbor buyer; buy = a neighbor's land → I buy it.
  private sellMode = true;
  private neighbors: PlayerView[] = []; // sell: candidate buyers; buy: [owner]
  private selectedNeighbor: PlayerView | null = null; // the counterparty
  private canTransact = false;
  private glow: { tiles: Set<TileRef>; until: number } | null = null;

  private svg: SVGSVGElement | null = null;
  private lassoPath: SVGPathElement | null = null;
  private parcelPath: SVGPathElement | null = null;
  private glowPath: SVGPathElement | null = null;
  private endpointRing: SVGCircleElement | null = null;
  private endpointDot: SVGCircleElement | null = null;
  private panel: HTMLDivElement | null = null;

  constructor(
    private game: GameView,
    private eventBus: EventBus,
    private uiState: UIState,
    private transformHandler: TransformHandler,
  ) {}

  init() {
    this.eventBus.on(SellLandModeEvent, (e) => this.onModeChange(e.enabled));
    this.eventBus.on(MouseDownEvent, (e) => this.onDown(e.x, e.y));
    this.eventBus.on(MouseMoveEvent, (e) => this.onMove(e.x, e.y));
    this.eventBus.on(MouseUpEvent, (e) => this.onUp(e.x, e.y));
    // Hover moves arrive as MouseOver (no button) — track them for the
    // rubber-band line to the cursor while placing vertices.
    this.eventBus.on(MouseOverEvent, (e) => {
      if (this.uiState.sellLandMode) this.cursor = this.toWorld(e.x, e.y);
    });
    this.eventBus.on(LandSaleFocusEvent, (e) => {
      this.glow = { tiles: new Set(e.tiles), until: Date.now() + GLOW_MS };
    });
    const loop = () => {
      this.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private mySmallID(): number | null {
    const me = this.game.myPlayer();
    return me ? me.smallID() : null;
  }

  private onModeChange(enabled: boolean) {
    if (!enabled) this.reset();
  }

  private reset() {
    this.lasso = null;
    this.cursor = null;
    this.pressStartScreen = null;
    this.dragging = false;
    this.lastPushScreen = null;
    this.parcel = [];
    this.parcelSet = new Set();
    this.neighbors = [];
    this.selectedNeighbor = null;
    this.canTransact = false;
    this.sellMode = true;
    this.hidePanel();
  }

  private exitMode() {
    this.uiState.sellLandMode = false;
    this.reset();
    this.eventBus.emit(new SellLandModeEvent(false));
  }

  private toWorld(sx: number, sy: number): { x: number; y: number } {
    const c = this.transformHandler.screenToWorldCoordinates(sx, sy);
    return { x: c.x, y: c.y };
  }

  private startFreshLasso() {
    this.parcel = [];
    this.parcelSet = new Set();
    this.hidePanel();
    this.lasso = [];
  }

  private clearDrawing() {
    this.lasso = null;
    this.lastPushScreen = null;
    this.dragging = false;
  }

  private onDown(screenX: number, screenY: number) {
    if (!this.uiState.sellLandMode) return;
    this.pressStartScreen = { x: screenX, y: screenY };
    this.dragging = false;
  }

  private onMove(screenX: number, screenY: number) {
    if (!this.uiState.sellLandMode) return;
    this.cursor = this.toWorld(screenX, screenY);
    if (this.pressStartScreen === null) return; // not pressing → just hover
    const moved = Math.hypot(
      screenX - this.pressStartScreen.x,
      screenY - this.pressStartScreen.y,
    );
    if (moved > DRAG_THRESHOLD) this.dragging = true;
    if (!this.dragging) return;
    // Freeform drag: append points (sparsely) into the polygon.
    if (this.lasso === null) {
      this.startFreshLasso();
      this.lasso!.push(
        this.toWorld(this.pressStartScreen.x, this.pressStartScreen.y),
      );
      this.lastPushScreen = { ...this.pressStartScreen };
    }
    if (
      this.lastPushScreen === null ||
      Math.hypot(
        screenX - this.lastPushScreen.x,
        screenY - this.lastPushScreen.y,
      ) >= 4
    ) {
      this.lasso!.push(this.toWorld(screenX, screenY));
      this.lastPushScreen = { x: screenX, y: screenY };
    }
  }

  private onUp(screenX: number, screenY: number) {
    if (!this.uiState.sellLandMode) return;
    const wasDrag = this.dragging;
    const press = this.pressStartScreen;
    this.pressStartScreen = null;
    this.dragging = false;
    this.lastPushScreen = null;

    // pointerup is bound to window, so panel-button clicks land here too —
    // but those have no matching map pointerdown (press === null). Ignore them
    // so clicking Send/Cancel/neighbor doesn't place a vertex or hide the panel.
    if (press === null) return;

    if (wasDrag) {
      // A freeform drag-lasso finishes on release.
      if (this.lasso !== null && this.lasso.length >= MIN_VERTICES) {
        this.finalizeLasso();
      } else {
        this.clearDrawing();
      }
      return;
    }

    // A click. Ignore if the pointer actually moved a bit (jittery click).
    if (
      press !== null &&
      Math.hypot(screenX - press.x, screenY - press.y) > DRAG_THRESHOLD
    ) {
      return;
    }

    // Clicking the big start-point box closes the loop.
    if (this.lasso !== null && this.lasso.length >= MIN_VERTICES) {
      const start = this.transformHandler.worldToScreenCoordinates(
        new Cell(this.lasso[0].x, this.lasso[0].y),
      );
      if (Math.hypot(screenX - start.x, screenY - start.y) <= CLOSE_RADIUS) {
        this.finalizeLasso();
        return;
      }
    }

    // Otherwise place a vertex.
    if (this.lasso === null) this.startFreshLasso();
    this.lasso!.push(this.toWorld(screenX, screenY));
  }

  // ── Parcel selection ───────────────────────────────────────────────────
  private finalizeLasso() {
    const smallID = this.mySmallID();
    if (
      smallID === null ||
      this.lasso === null ||
      this.lasso.length < MIN_VERTICES
    ) {
      this.reset();
      return;
    }
    // The polygon vertices are already in world space.
    const poly = this.lasso;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const p of poly) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    minX = Math.max(0, Math.floor(minX));
    minY = Math.max(0, Math.floor(minY));
    maxX = Math.min(this.game.width() - 1, Math.ceil(maxX));
    maxY = Math.min(this.game.height() - 1, Math.ceil(maxY));
    if (maxX - minX > MAX_LASSO_BBOX || maxY - minY > MAX_LASSO_BBOX) {
      this.reset();
      return;
    }

    // Collect owned land inside the lasso, grouped by owner.
    const byOwner = new Map<number, TileRef[]>();
    let total = 0;
    for (let y = minY; y <= maxY && total <= MAX_PARCEL_TILES; y++) {
      for (let x = minX; x <= maxX && total <= MAX_PARCEL_TILES; x++) {
        if (!pointInPolygon(x + 0.5, y + 0.5, poly)) continue;
        const t = this.game.ref(x, y);
        if (!this.game.isLand(t)) continue;
        const oid = this.game.tileState(t) & OWNER_MASK;
        if (oid === 0) continue;
        const arr = byOwner.get(oid) ?? [];
        arr.push(t);
        byOwner.set(oid, arr);
        total++;
      }
    }
    // The parcel is the dominant single owner's tiles.
    let bestId = -1;
    let bestCount = 0;
    for (const [id, ts] of byOwner) {
      if (ts.length > bestCount) {
        bestId = id;
        bestCount = ts.length;
      }
    }
    if (bestId < 0) {
      this.reset();
      return;
    }
    const parcel = (byOwner.get(bestId) as TileRef[]).slice(
      0,
      MAX_PARCEL_TILES,
    );
    this.parcel = parcel;
    this.parcelSet = new Set(parcel);

    if (bestId === smallID) {
      // SELL my own land → choose a bordering neighbor to offer it to.
      this.sellMode = true;
      this.neighbors = this.borderingNeighbors(smallID);
      this.selectedNeighbor = this.neighbors[0] ?? null;
      this.canTransact = this.neighbors.length > 0;
    } else {
      // BUY a neighbor's land → I'm the buyer (must border the parcel).
      this.sellMode = false;
      const owner = this.game.playerBySmallID(bestId);
      this.neighbors = owner.isPlayer() ? [owner as PlayerView] : [];
      this.selectedNeighbor = this.neighbors[0] ?? null;
      this.canTransact =
        this.neighbors.length > 0 &&
        parcel.some((t) =>
          this.game
            .neighbors(t)
            .some((n) => (this.game.tileState(n) & OWNER_MASK) === smallID),
        );
    }
    // Parcel locked in — clear the in-progress polygon (the parcel boundary
    // now shows instead).
    this.lasso = null;
    this.lastPushScreen = null;
    this.showPanel();
  }

  /** Distinct players (not me) who own a tile adjacent to the parcel. */
  private borderingNeighbors(smallID: number): PlayerView[] {
    const ids = new Set<number>();
    for (const t of this.parcel) {
      for (const n of this.game.neighbors(t)) {
        const oid = this.game.tileState(n) & OWNER_MASK;
        if (oid !== 0 && oid !== smallID) ids.add(oid);
      }
    }
    const out: PlayerView[] = [];
    for (const id of ids) {
      const p = this.game.playerBySmallID(id);
      if (p.isPlayer()) out.push(p as PlayerView);
    }
    return out;
  }

  // ── Panel (neighbor + price) ───────────────────────────────────────────
  private showPanel() {
    this.hidePanel();
    const el = document.createElement("div");
    el.style.cssText = [
      "position:fixed",
      "left:50%",
      "bottom:90px",
      "transform:translateX(-50%)",
      "z-index:10001",
      "background:rgba(24,18,10,0.95)",
      "border:1px solid rgba(255,210,74,0.45)",
      "border-radius:10px",
      "padding:10px 12px",
      "color:#fde8b0",
      "font:13px system-ui, sans-serif",
      "box-shadow:0 4px 16px rgba(0,0,0,0.5)",
      "min-width:240px",
    ].join(";");
    document.body.appendChild(el);
    this.panel = el;
    this.renderPanel();
  }

  private renderPanel() {
    const el = this.panel;
    if (el === null) return;
    el.replaceChildren();

    const owner = this.selectedNeighbor;
    const title = document.createElement("div");
    title.textContent = this.sellMode
      ? `Sell ${this.parcel.length} tiles`
      : `Buy ${this.parcel.length} tiles from ${owner?.displayName() ?? "?"}`;
    title.style.cssText = "font-weight:700;margin-bottom:6px;color:#ffd24a;";
    el.appendChild(title);

    if (!this.canTransact) {
      const warn = document.createElement("div");
      warn.textContent = this.sellMode
        ? "No bordering neighbor to sell to."
        : "Your own land must border this parcel to buy it.";
      warn.style.cssText = "color:#ff8a6a;margin-bottom:6px;";
      el.appendChild(warn);
    } else if (this.sellMode && this.neighbors.length > 1) {
      // Let the seller pick which bordering neighbor to offer to.
      const label = document.createElement("div");
      label.textContent = "Offer to:";
      label.style.marginBottom = "4px";
      el.appendChild(label);
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;";
      for (const n of this.neighbors) {
        const b = document.createElement("button");
        b.textContent = n.displayName();
        const selected = n === this.selectedNeighbor;
        b.style.cssText = [
          "padding:3px 8px",
          "border-radius:6px",
          "cursor:pointer",
          "font:12px system-ui",
          `border:1px solid ${selected ? "#ffd24a" : "rgba(255,255,255,0.25)"}`,
          `background:${selected ? "rgba(255,210,74,0.25)" : "rgba(255,255,255,0.06)"}`,
          "color:#fde8b0",
        ].join(";");
        b.onclick = () => {
          this.selectedNeighbor = n;
          this.renderPanel();
        };
        row.appendChild(b);
      }
      el.appendChild(row);
    }

    const priceRow = document.createElement("div");
    priceRow.style.cssText =
      "display:flex;align-items:center;gap:6px;margin-bottom:8px;";
    const priceLbl = document.createElement("span");
    priceLbl.textContent = "Price:";
    const price = document.createElement("input");
    price.type = "number";
    price.min = "0";
    price.value = "100";
    price.id = "sell-land-price";
    price.style.cssText =
      "width:90px;padding:3px 6px;border-radius:6px;border:1px solid rgba(255,255,255,0.25);background:rgba(0,0,0,0.3);color:#fff;";
    const k = document.createElement("span");
    k.textContent = "K gold";
    k.style.color = "#ffd24a";
    priceRow.append(priceLbl, price, k);
    el.appendChild(priceRow);

    const btns = document.createElement("div");
    btns.style.cssText = "display:flex;gap:6px;justify-content:flex-end;";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.style.cssText =
      "padding:4px 12px;border-radius:6px;cursor:pointer;border:none;background:#555;color:#fff;";
    cancel.onclick = () => this.exitMode();
    const send = document.createElement("button");
    send.textContent = this.sellMode ? "Send offer" : "Send buy offer";
    send.disabled = !this.canTransact;
    send.style.cssText = `padding:4px 12px;border-radius:6px;cursor:pointer;border:none;background:${this.canTransact ? "#2e8b3d" : "#666"};color:#fff;`;
    send.onclick = () => this.send();
    btns.append(cancel, send);
    el.appendChild(btns);
  }

  private send() {
    const me = this.game.myPlayer();
    const other = this.selectedNeighbor;
    if (me === null || other === null || !this.canTransact) return;
    const input = document.getElementById(
      "sell-land-price",
    ) as HTMLInputElement | null;
    // Input is in thousands.
    const price = Math.max(0, Math.floor(Number(input?.value ?? 0))) * 1000;
    const seller = this.sellMode ? me : other;
    const buyer = this.sellMode ? other : me;
    this.eventBus.emit(
      new SendProposeLandSaleIntentEvent(
        seller,
        buyer,
        [...this.parcel],
        price,
      ),
    );
    // Outgoing offer cue ("why don't I own this?").
    this.eventBus.emit(new PlaySoundEffectEvent("land-offer"));
    this.exitMode();
  }

  private hidePanel() {
    if (this.panel) {
      this.panel.remove();
      this.panel = null;
    }
  }

  // ── Rendering (SVG outlines) ───────────────────────────────────────────
  private ensureSvg() {
    if (this.svg !== null) return;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.style.cssText =
      "position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:9997;";
    const mk = (stroke: string, width: string, dash: string, glow: string) => {
      const p = document.createElementNS(ns, "path");
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", stroke);
      p.setAttribute("stroke-width", width);
      p.setAttribute("stroke-linejoin", "round");
      if (dash) p.setAttribute("stroke-dasharray", dash);
      if (glow) p.style.filter = glow;
      svg.appendChild(p);
      return p;
    };
    this.lassoPath = mk("rgba(255,210,74,0.95)", "2", "6 5", "");
    this.parcelPath = mk(
      "rgba(255,210,74,0.95)",
      "3",
      "",
      "drop-shadow(0 0 3px rgba(255,210,74,0.7))",
    );
    this.glowPath = mk(
      "rgba(120,220,255,0.95)",
      "3.5",
      "",
      "drop-shadow(0 0 6px rgba(120,220,255,0.9))",
    );
    // Big "click to close" box at the start vertex.
    const mkCircle = (r: number, stroke: string, fill: string, sw: number) => {
      const c = document.createElementNS(ns, "circle");
      c.setAttribute("r", String(r));
      c.setAttribute("stroke", stroke);
      c.setAttribute("fill", fill);
      c.setAttribute("stroke-width", String(sw));
      c.style.display = "none";
      c.style.filter = "drop-shadow(0 0 4px rgba(0,0,0,0.6))";
      svg.appendChild(c);
      return c;
    };
    this.endpointRing = mkCircle(16, "rgba(255,210,74,0.95)", "none", 4);
    this.endpointDot = mkCircle(6, "none", "rgba(255,210,74,0.9)", 0);
    document.body.appendChild(svg);
    this.svg = svg;
  }

  private boundaryPathD(tiles: Set<TileRef>): string {
    let d = "";
    const w2s = (wx: number, wy: number) =>
      this.transformHandler.worldToScreenCoordinates(new Cell(wx, wy));
    const inSet = (x: number, y: number) =>
      this.game.isValidCoord(x, y) && tiles.has(this.game.ref(x, y));
    const seg = (x1: number, y1: number, x2: number, y2: number) => {
      const a = w2s(x1, y1);
      const b = w2s(x2, y2);
      d += `M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
    };
    for (const t of tiles) {
      const x = this.game.x(t);
      const y = this.game.y(t);
      if (!inSet(x, y - 1)) seg(x - 0.5, y - 0.5, x + 0.5, y - 0.5);
      if (!inSet(x, y + 1)) seg(x - 0.5, y + 0.5, x + 0.5, y + 0.5);
      if (!inSet(x - 1, y)) seg(x - 0.5, y - 0.5, x - 0.5, y + 0.5);
      if (!inSet(x + 1, y)) seg(x + 0.5, y - 0.5, x + 0.5, y + 0.5);
    }
    return d;
  }

  private render() {
    this.ensureSvg();
    if (
      this.lassoPath === null ||
      this.parcelPath === null ||
      this.glowPath === null ||
      this.endpointRing === null ||
      this.endpointDot === null
    ) {
      return;
    }

    const w2s = (p: { x: number; y: number }) =>
      this.transformHandler.worldToScreenCoordinates(new Cell(p.x, p.y));

    // Live polygon being drawn (world → screen), with a rubber-band to cursor.
    if (this.lasso !== null && this.lasso.length > 0) {
      const pts = this.lasso.map(w2s);
      let d =
        "M" + pts.map((s) => `${s.x.toFixed(1)} ${s.y.toFixed(1)}`).join("L");
      if (!this.dragging && this.cursor !== null && pts.length >= 1) {
        const cs = w2s(this.cursor);
        d += `L${cs.x.toFixed(1)} ${cs.y.toFixed(1)}`;
      }
      this.lassoPath.setAttribute("d", d);
      this.lassoPath.style.display = "block";

      // Endpoint "close" box at the first vertex once there's a loop to close.
      if (this.lasso.length >= 2) {
        const s0 = pts[0];
        const closable = this.lasso.length >= MIN_VERTICES;
        const near =
          this.cursor !== null &&
          (() => {
            const cs = w2s(this.cursor);
            return Math.hypot(cs.x - s0.x, cs.y - s0.y) <= CLOSE_RADIUS;
          })();
        const color =
          closable && near ? "rgba(120,255,150,0.95)" : "rgba(255,210,74,0.95)";
        this.endpointRing.setAttribute("cx", s0.x.toFixed(1));
        this.endpointRing.setAttribute("cy", s0.y.toFixed(1));
        this.endpointRing.setAttribute("r", near && closable ? "20" : "16");
        this.endpointRing.setAttribute("stroke", color);
        this.endpointRing.style.display = "block";
        this.endpointDot.setAttribute("cx", s0.x.toFixed(1));
        this.endpointDot.setAttribute("cy", s0.y.toFixed(1));
        this.endpointDot.setAttribute(
          "fill",
          closable ? color : "rgba(255,255,255,0.6)",
        );
        this.endpointDot.style.display = "block";
      } else {
        this.endpointRing.style.display = "none";
        this.endpointDot.style.display = "none";
      }
    } else {
      this.lassoPath.style.display = "none";
      this.endpointRing.style.display = "none";
      this.endpointDot.style.display = "none";
    }

    // Parcel boundary (while the panel is open).
    if (this.parcelSet.size > 0) {
      this.parcelPath.setAttribute("d", this.boundaryPathD(this.parcelSet));
      this.parcelPath.style.display = "block";
    } else {
      this.parcelPath.style.display = "none";
    }

    // Buyer focus glow (pulses, then fades out).
    if (this.glow !== null && Date.now() < this.glow.until) {
      const remaining = (this.glow.until - Date.now()) / GLOW_MS;
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 200);
      this.glowPath.setAttribute("d", this.boundaryPathD(this.glow.tiles));
      this.glowPath.style.opacity = `${(0.4 + 0.6 * pulse) * Math.min(1, remaining * 3)}`;
      this.glowPath.style.display = "block";
    } else {
      this.glow = null;
      this.glowPath.style.display = "none";
    }
  }
}

/** Ray-casting point-in-polygon. */
function pointInPolygon(
  x: number,
  y: number,
  poly: Array<{ x: number; y: number }>,
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
      yi = poly[i].y,
      xj = poly[j].x,
      yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
