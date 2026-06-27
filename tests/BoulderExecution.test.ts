import { BoulderExecution } from "../src/core/execution/BoulderExecution";
import { FireTrebuchetExecution } from "../src/core/execution/FireTrebuchetExecution";
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
  Unit,
  UnitType,
} from "../src/core/game/Game";
import { createGame } from "../src/core/game/GameImpl";
import { genTerrainFromBin } from "../src/core/game/TerrainMapLoader";
import { UserSettings } from "../src/core/game/UserSettings";
import { GameConfig } from "../src/core/Schemas";
import { TestConfig } from "./util/TestConfig";
import { executeTicks } from "./util/utils";

const LAND_PLAINS = 0b10000000;
const MAP_W = 60;
const MAP_H = 60;

function allLand(width: number, height: number) {
  const data = new Uint8Array(width * height).fill(LAND_PLAINS);
  return { data, numLandTiles: width * height };
}

async function setupLandGame(humans: PlayerInfo[]): Promise<Game> {
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  const full = allLand(MAP_W, MAP_H);
  const mini = allLand(MAP_W / 2, MAP_H / 2);
  const gameMap = await genTerrainFromBin(
    { width: MAP_W, height: MAP_H, num_land_tiles: full.numLandTiles },
    full.data,
  );
  const miniGameMap = await genTerrainFromBin(
    { width: MAP_W / 2, height: MAP_H / 2, num_land_tiles: mini.numLandTiles },
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
    infiniteGold: true,
    infiniteTroops: true,
    instantBuild: true,
    randomSpawn: false,
  };
  const config = new TestConfig(gameConfig, new UserSettings(), false);
  const game = createGame(humans, [], gameMap, miniGameMap, config);
  game.endSpawnPhase();
  return game;
}

describe("Trebuchet boulder", () => {
  let game: Game;
  let attacker: Player;
  let victim: Player;

  afterEach(() => vi.restoreAllMocks());

  beforeEach(async () => {
    game = await setupLandGame([
      new PlayerInfo("att", PlayerType.Human, "c1", "att_id"),
      new PlayerInfo("vic", PlayerType.Human, "c2", "vic_id"),
    ]);
    (game.config() as TestConfig).setSpawnImmunityDuration(0);
    attacker = game.player("att_id");
    victim = game.player("vic_id");
    attacker.addGold(50_000_000n); // cover the per-shot cost
    // Attacker holds the launch column; victim holds a target block.
    for (let y = 0; y < MAP_H; y++) attacker.conquer(game.ref(5, y));
    for (let x = 20; x <= 40; x++) {
      for (let y = 22; y <= 38; y++) victim.conquer(game.ref(x, y));
    }
  });

  test("boulder leaves a fallout crater (not water) and relinquishes land", () => {
    const dst = game.ref(28, 30);
    expect(game.owner(dst)).toBe(victim);

    game.addExecution(new BoulderExecution(attacker, game.ref(5, 30), dst));
    executeTicks(game, 40);

    expect(game.hasFallout(dst)).toBe(true);
    expect(game.isLand(dst)).toBe(true); // crater, NOT water
    expect(game.isWater(dst)).toBe(false);
    expect(game.owner(dst).isPlayer()).toBe(false); // relinquished
    // A distant tile is untouched.
    expect(game.hasFallout(game.ref(50, 50))).toBe(false);
  });

  test("boulder destroys a structure in the blast", () => {
    const dst = game.ref(28, 30);
    const city: Unit = victim.buildUnit(UnitType.City, dst, {});
    expect(city.isActive()).toBe(true);

    game.addExecution(new BoulderExecution(attacker, game.ref(5, 30), dst));
    executeTicks(game, 40);

    expect(city.isActive()).toBe(false);
  });

  test("boulder rolls forward in a cone past the impact", () => {
    // Shot left→right, so the crater rolls toward +x beyond the impact.
    const dst = game.ref(28, 30);
    game.addExecution(new BoulderExecution(attacker, game.ref(5, 30), dst));
    executeTicks(game, 40);

    // A tile past the impact (in the travel direction, beyond the radius-1
    // crater) is cratered by the forward roll…
    expect(game.hasFallout(game.ref(30, 30))).toBe(true);
    // …but a tile the same distance BEHIND the impact is not.
    expect(game.hasFallout(game.ref(25, 30))).toBe(false);
  });

  test("firing a trebuchet within range puts it on reload cooldown", () => {
    const treb = attacker.buildUnit(UnitType.Trebuchet, game.ref(5, 30), {});
    expect(treb.isInCooldown()).toBe(false);
    game.addExecution(
      new FireTrebuchetExecution(attacker, treb, game.ref(15, 30)),
    );
    executeTicks(game, 3);
    expect(treb.isInCooldown()).toBe(true);
  });
});
