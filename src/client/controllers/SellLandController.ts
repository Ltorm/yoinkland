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
  MouseUpEvent,
  SellLandModeEvent,
} from "../InputHandler";
import { OWNER_MASK } from "../render/gl/utils/TileCodec";
import { TransformHandler } from "../TransformHandler";
import { SendProposeLandSaleIntentEvent } from "../Transport";
import { UIState } from "../UIState";
import { GameView, PlayerView } from "../view";

const MAX_PARCEL_TILES = 4000;
const MAX_LASSO_BBOX = 400; // tiles per side — guards the point-in-polygon scan
const GLOW_MS = 7000;

export class SellLandController implements Controller {
  private lasso: Array<{ x: number; y: number }> | null = null; // screen path
  private parcel: TileRef[] = [];
  private parcelSet = new Set<TileRef>();
  private neighbors: PlayerView[] = [];
  private selectedNeighbor: PlayerView | null = null;
  private glow: { tiles: Set<TileRef>; until: number } | null = null;

  private svg: SVGSVGElement | null = null;
  private lassoPath: SVGPathElement | null = null;
  private parcelPath: SVGPathElement | null = null;
  private glowPath: SVGPathElement | null = null;
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
    this.parcel = [];
    this.parcelSet = new Set();
    this.neighbors = [];
    this.selectedNeighbor = null;
    this.hidePanel();
  }

  private exitMode() {
    this.uiState.sellLandMode = false;
    this.reset();
    this.eventBus.emit(new SellLandModeEvent(false));
  }

  private onDown(screenX: number, screenY: number) {
    if (!this.uiState.sellLandMode) return;
    // Restart a fresh lasso (drop any previous selection/panel).
    this.parcel = [];
    this.parcelSet = new Set();
    this.hidePanel();
    this.lasso = [{ x: screenX, y: screenY }];
  }

  private onMove(screenX: number, screenY: number) {
    if (!this.uiState.sellLandMode || this.lasso === null) return;
    const last = this.lasso[this.lasso.length - 1];
    if (Math.hypot(screenX - last.x, screenY - last.y) >= 3) {
      this.lasso.push({ x: screenX, y: screenY });
    }
  }

  private onUp(screenX: number, screenY: number) {
    if (!this.uiState.sellLandMode || this.lasso === null) return;
    this.finalizeLasso();
    this.lasso = null;
  }

  // ── Parcel selection ───────────────────────────────────────────────────
  private finalizeLasso() {
    const smallID = this.mySmallID();
    if (smallID === null || this.lasso === null || this.lasso.length < 3) {
      this.reset();
      return;
    }
    // Lasso path → world polygon.
    const poly = this.lasso.map((p) => {
      const c = this.transformHandler.screenToWorldCoordinates(p.x, p.y);
      return { x: c.x, y: c.y };
    });
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

    const parcel: TileRef[] = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!pointInPolygon(x + 0.5, y + 0.5, poly)) continue;
        const t = this.game.ref(x, y);
        if (!this.game.isLand(t)) continue;
        if ((this.game.tileState(t) & OWNER_MASK) !== smallID) continue;
        parcel.push(t);
        if (parcel.length > MAX_PARCEL_TILES) break;
      }
      if (parcel.length > MAX_PARCEL_TILES) break;
    }
    if (parcel.length === 0 || parcel.length > MAX_PARCEL_TILES) {
      this.reset();
      return;
    }
    this.parcel = parcel;
    this.parcelSet = new Set(parcel);
    this.neighbors = this.borderingNeighbors(smallID);
    this.selectedNeighbor = this.neighbors[0] ?? null;
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

    const title = document.createElement("div");
    title.textContent = `Sell ${this.parcel.length} tiles`;
    title.style.cssText = "font-weight:700;margin-bottom:6px;color:#ffd24a;";
    el.appendChild(title);

    if (this.neighbors.length === 0) {
      const warn = document.createElement("div");
      warn.textContent = "No bordering neighbor to sell to.";
      warn.style.cssText = "color:#ff8a6a;margin-bottom:6px;";
      el.appendChild(warn);
    } else {
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
    priceLbl.textContent = "Price (gold):";
    const price = document.createElement("input");
    price.type = "number";
    price.min = "0";
    price.value = "100000";
    price.id = "sell-land-price";
    price.style.cssText =
      "width:110px;padding:3px 6px;border-radius:6px;border:1px solid rgba(255,255,255,0.25);background:rgba(0,0,0,0.3);color:#fff;";
    priceRow.append(priceLbl, price);
    el.appendChild(priceRow);

    const btns = document.createElement("div");
    btns.style.cssText = "display:flex;gap:6px;justify-content:flex-end;";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.style.cssText =
      "padding:4px 12px;border-radius:6px;cursor:pointer;border:none;background:#555;color:#fff;";
    cancel.onclick = () => this.exitMode();
    const send = document.createElement("button");
    send.textContent = "Send offer";
    send.disabled = this.neighbors.length === 0;
    send.style.cssText = `padding:4px 12px;border-radius:6px;cursor:pointer;border:none;background:${this.neighbors.length === 0 ? "#666" : "#2e8b3d"};color:#fff;`;
    send.onclick = () => this.send();
    btns.append(cancel, send);
    el.appendChild(btns);
  }

  private send() {
    const buyer = this.selectedNeighbor;
    if (buyer === null || this.parcel.length === 0) return;
    const input = document.getElementById(
      "sell-land-price",
    ) as HTMLInputElement | null;
    const price = Math.max(0, Math.floor(Number(input?.value ?? 0)));
    this.eventBus.emit(
      new SendProposeLandSaleIntentEvent(buyer, [...this.parcel], price),
    );
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
      this.glowPath === null
    ) {
      return;
    }

    // Live lasso (screen coords).
    if (this.lasso !== null && this.lasso.length > 1) {
      this.lassoPath.setAttribute(
        "d",
        "M" + this.lasso.map((p) => `${p.x} ${p.y}`).join("L"),
      );
      this.lassoPath.style.display = "block";
    } else {
      this.lassoPath.style.display = "none";
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
