// Coordinate-grid geometry, shared by the simulation and the renderer so that
// "grid" distances line up exactly with the on-map A1/B2 coordinate gridlines
// (toggled with M). Mirrors the client CoordinateGridPass.computeCellSize().

const BASE_CELL_COUNT = 10;
const MAX_COLUMNS = 50;
const MIN_ROWS = 2;

/** Size (in tiles) of one coordinate-grid cell for a map of these dimensions. */
export function gridCellSize(mapW: number, mapH: number): number {
  const raw = Math.min(mapW, mapH) / BASE_CELL_COUNT;
  let rows = Math.max(1, Math.round(mapH / raw));
  let cols = Math.max(1, Math.round(mapW / raw));
  if (cols > MAX_COLUMNS) {
    const maxRows = Math.floor((MAX_COLUMNS * mapH) / mapW);
    rows = Math.max(MIN_ROWS, Math.min(rows, maxRows));
    cols = MAX_COLUMNS;
  }
  return Math.min(mapW / cols, mapH / rows);
}

/** A trebuchet can fire this many grid cells. */
export const TREBUCHET_MAX_GRIDS = 5;

/** Trebuchet max range in tiles for a map of these dimensions. */
export function trebuchetRangeTiles(mapW: number, mapH: number): number {
  return TREBUCHET_MAX_GRIDS * gridCellSize(mapW, mapH);
}
