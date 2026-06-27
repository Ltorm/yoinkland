import { SAM_CONSTRUCTION_TICKS } from "../src/core/configuration/Config";
import {
  landBridgeCost,
  LandBridgeExecution,
  landBridgeSegmentTiles,
  SEGMENT_LENGTH_TILES,
  SEGMENT_WIDTH_TILES,
} from "../src/core/execution/LandBridgeExecution";
import { NukeExecution } from "../src/core/execution/NukeExecution";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../src/core/game/Game";
import { createGame } from "../src/core/game/GameImpl";
import { genTerrainFromBin } from "../src/core/game/TerrainMapLoader";
import { UserSettings } from "../src/core/game/UserSettings";
import { GameConfig } from "../src/core/Schemas";
import { TestConfig } from "./util/TestConfig";
import { executeTicks } from "./util/utils";

// ─── Terrain byte constants (must match GameMapImpl) ────────────────────
const LAND_PLAINS = 0b10000000; // isLand=1, magnitude=0 (Plains)
const WATER = 0b00000000; // isLand=0 → passable lake water

const MAP_W = 60;
const MAP_H = 60;
const MINI_W = 30;
const MINI_H = 30;

// Land on the left (x < COAST_X), open water to the right.
const COAST_X = 10;

function buildTerrain(
  width: number,
  height: number,
  coastX: number,
): { data: Uint8Array; numLandTiles: number } {
  const data = new Uint8Array(width * height);
  let numLandTiles = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (x < coastX) {
        data[idx] = LAND_PLAINS;
        numLandTiles++;
      } else {
        data[idx] = WATER;
      }
    }
  }
  return { data, numLandTiles };
}

async function setupCoastGame(
  humans: PlayerInfo[],
  extraConfig: Partial<GameConfig> = {},
): Promise<Game> {
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  const full = buildTerrain(MAP_W, MAP_H, COAST_X);
  const mini = buildTerrain(MINI_W, MINI_H, Math.floor(COAST_X / 2));

  const gameMap = await genTerrainFromBin(
    { width: MAP_W, height: MAP_H, num_land_tiles: full.numLandTiles },
    full.data,
  );
  const miniGameMap = await genTerrainFromBin(
    { width: MINI_W, height: MINI_H, num_land_tiles: mini.numLandTiles },
    mini.data,
  );

  const gameConfig: GameConfig = {
    gameMap: GameMapType.Asia,
    gameMapSize: GameMapSize.Normal,
    gameMode: GameMode.FFA,
    gameType: GameType.Singleplayer,
    difficulty: Difficulty.Medium,
    nations: "default",
    donateGold: false,
    donateTroops: false,
    bots: 0,
    infiniteGold: false,
    infiniteTroops: true,
    instantBuild: true,
    randomSpawn: false,
    ...extraConfig,
  };
  const config = new TestConfig(gameConfig, new UserSettings(), false);

  const game = createGame(humans, [], gameMap, miniGameMap, config);
  game.endSpawnPhase();
  return game;
}

describe("Land bridge segments", () => {
  let game: Game;
  let player: Player;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    game = await setupCoastGame([
      new PlayerInfo("player", PlayerType.Human, "c1", "player_id"),
    ]);
    player = game.player("player_id");
    // Own the coast column so we have a shoreline anchor at (COAST_X-1, 30).
    for (let y = 0; y < MAP_H; y++) {
      player.conquer(game.ref(COAST_X - 1, y));
    }
    player.addGold(10_000_000n);
  });

  test("cost escalates 100k, 125k, 150k, 200k, 250k, 300k, 375k", () => {
    const expected = [
      100_000n,
      125_000n,
      150_000n,
      200_000n,
      250_000n,
      300_000n,
      375_000n,
    ];
    expected.forEach((want, n) => expect(landBridgeCost(n)).toBe(want));
    // Beyond the sequence it is capped at 400k.
    expect(landBridgeCost(7)).toBe(400_000n);
    expect(landBridgeCost(20)).toBe(400_000n);
  });

  test("segment geometry is a rectangle of the configured size", () => {
    const start = game.ref(COAST_X - 1, 30);
    const tiles = landBridgeSegmentTiles(
      game,
      start,
      0, // due east
      SEGMENT_WIDTH_TILES,
      SEGMENT_LENGTH_TILES,
    );
    expect(tiles.length).toBeGreaterThan(0);
    // All tiles fall within the expected bounding box of the strip.
    const halfW = (SEGMENT_WIDTH_TILES - 1) / 2;
    for (const t of tiles) {
      const dx = game.x(t) - game.x(start);
      const dy = game.y(t) - game.y(start);
      expect(dx).toBeGreaterThanOrEqual(0);
      expect(dx).toBeLessThanOrEqual(SEGMENT_LENGTH_TILES);
      expect(Math.abs(dy)).toBeLessThanOrEqual(Math.ceil(halfW));
    }
  });

  test("building a segment converts a strip of water to owned land and charges once", () => {
    const start = game.ref(COAST_X - 1, 30);
    const target = game.ref(COAST_X + SEGMENT_LENGTH_TILES, 30); // due east
    const goldBefore = player.gold();

    game.addExecution(new LandBridgeExecution(player, start, target));
    executeTicks(game, 2); // instantBuild → one pass

    // A tile a few rows into the water is now owned land.
    const mid = game.ref(COAST_X + 5, 30);
    expect(game.isLand(mid)).toBe(true);
    expect(game.ownerID(mid)).toBe(player.smallID());
    // Charged exactly one segment cost.
    // First segment costs the base 100k.
    expect(player.gold()).toBe(goldBefore - landBridgeCost(0));
  });

  test("cannot build from an anchor the player does not own", () => {
    const start = game.ref(COAST_X + 3, 30); // open water, unowned
    const target = game.ref(COAST_X + SEGMENT_LENGTH_TILES, 30);
    const goldBefore = player.gold();

    game.addExecution(new LandBridgeExecution(player, start, target));
    executeTicks(game, 2);

    expect(game.isWater(game.ref(COAST_X + 5, 30))).toBe(true);
    expect(player.gold()).toBe(goldBefore); // not charged
  });

  test("builds progressively over the SAM construction duration", async () => {
    game = await setupCoastGame(
      [new PlayerInfo("player", PlayerType.Human, "c1", "player_id")],
      { instantBuild: false },
    );
    player = game.player("player_id");
    for (let y = 0; y < MAP_H; y++) {
      player.conquer(game.ref(COAST_X - 1, y));
    }
    player.addGold(10_000_000n);

    const start = game.ref(COAST_X - 1, 30);
    const target = game.ref(COAST_X + SEGMENT_LENGTH_TILES, 30);
    const coastOwned = player.numTilesOwned();
    game.addExecution(new LandBridgeExecution(player, start, target));

    // Early: construction has begun but the far tip is not built yet.
    executeTicks(game, 3);
    const tipTile = game.ref(COAST_X + SEGMENT_LENGTH_TILES - 1, 30);
    expect(game.isWater(tipTile)).toBe(true);
    expect(player.numTilesOwned()).toBeGreaterThan(coastOwned); // started
    expect(player.numTilesOwned()).toBeLessThan(coastOwned + 50); // not done

    // After the full duration the whole segment is land.
    executeTicks(game, SAM_CONSTRUCTION_TICKS);
    expect(game.isLand(tipTile)).toBe(true);
    expect(game.ownerID(tipTile)).toBe(player.smallID());
    expect(player.numTilesOwned()).toBeGreaterThan(coastOwned + 50); // mostly built
  });

  test("a chained segment is clamped to within 45° of its parent", () => {
    // Segment 1: due east from the coast.
    const start1 = game.ref(COAST_X - 1, 30);
    game.addExecution(
      new LandBridgeExecution(
        player,
        start1,
        game.ref(COAST_X + SEGMENT_LENGTH_TILES, 30),
      ),
    );
    executeTicks(game, 2);

    // Anchor on the east tip and aim due NORTH (−90° from east). The 45° clamp
    // should bend it to only −45° (up-and-to-the-right).
    const tip = game.ref(COAST_X - 1 + SEGMENT_LENGTH_TILES, 30);
    expect(game.isLand(tip)).toBe(true);
    expect(game.isShore(tip)).toBe(true);
    game.addExecution(
      new LandBridgeExecution(player, tip, game.ref(game.x(tip), 0)),
    );
    executeTicks(game, 2);

    // A tile along the clamped −45° heading is land...
    const upRight = game.ref(game.x(tip) + 8, 30 - 8);
    expect(game.isLand(upRight)).toBe(true);
    // ...but a tile straight north (would need an unclamped −90°) stays water.
    const straightNorth = game.ref(game.x(tip), 30 - 16);
    expect(game.isWater(straightNorth)).toBe(true);
  });

  test("a nuke destroys land-bridge tiles (back to water)", async () => {
    game = await setupCoastGame(
      [new PlayerInfo("player", PlayerType.Human, "c1", "player_id")],
      { waterNukes: true },
    );
    player = game.player("player_id");
    for (let y = 0; y < MAP_H; y++) {
      player.conquer(game.ref(COAST_X - 1, y));
    }
    player.addGold(10_000_000n);
    (game.config() as TestConfig).nukeMagnitudes = vi.fn(() => ({
      inner: 4,
      outer: 4,
    }));
    (game.config() as TestConfig).nukeAllianceBreakThreshold = vi.fn(() => 999);
    (game.config() as TestConfig).setDefaultNukeSpeed(50);

    const start = game.ref(COAST_X - 1, 30);
    game.addExecution(
      new LandBridgeExecution(
        player,
        start,
        game.ref(COAST_X + SEGMENT_LENGTH_TILES, 30),
      ),
    );
    executeTicks(game, 2);
    const bridgeTile = game.ref(COAST_X + 5, 30);
    expect(game.isLand(bridgeTile)).toBe(true);

    // Silo on land, nuke the bridge.
    player.buildUnit(UnitType.MissileSilo, game.ref(2, 30), {});
    game.addExecution(
      new NukeExecution(UnitType.AtomBomb, player, bridgeTile, game.ref(2, 30)),
    );
    executeTicks(game, 60);

    expect(game.isWater(bridgeTile)).toBe(true);
    expect(game.hasOwner(bridgeTile)).toBe(false);
  });
});
