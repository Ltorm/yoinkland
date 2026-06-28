import { NationLandSaleBehavior } from "../src/core/execution/nation/NationLandSaleBehavior";
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
} from "../src/core/game/Game";
import { createGame } from "../src/core/game/GameImpl";
import { genTerrainFromBin } from "../src/core/game/TerrainMapLoader";
import { UserSettings } from "../src/core/game/UserSettings";
import { PseudoRandom } from "../src/core/PseudoRandom";
import { GameConfig } from "../src/core/Schemas";
import { TestConfig } from "./util/TestConfig";
import { executeTicks } from "./util/utils";

const LAND_PLAINS = 0b10000000;
const MAP_W = 60;
const MAP_H = 60;
// Past the 2-minute (1200-tick) reject window plus the spawn phase.
const PAST_WINDOW = 1400;

function allLand(width: number, height: number) {
  const data = new Uint8Array(width * height).fill(LAND_PLAINS);
  return { data, numLandTiles: width * height };
}

async function setupGame(humans: PlayerInfo[]): Promise<Game> {
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
    infiniteGold: false,
    infiniteTroops: true,
    instantBuild: true,
    randomSpawn: false,
  };
  const config = new TestConfig(gameConfig, new UserSettings(), false);
  const game = createGame(humans, [], gameMap, miniGameMap, config);
  game.endSpawnPhase();
  return game;
}

describe("Nation land-sale behavior (bots responding to buy offers)", () => {
  let game: Game;
  let bot: Player; // the "nation" being asked to sell its land
  let buyer: Player; // the player trying to buy
  let parcel: number[];
  let behavior: NationLandSaleBehavior;

  afterEach(() => vi.restoreAllMocks());

  beforeEach(async () => {
    game = await setupGame([
      new PlayerInfo("bot", PlayerType.Human, "c1", "bot_id"),
      new PlayerInfo("buy", PlayerType.Human, "c2", "buy_id"),
    ]);
    bot = game.player("bot_id");
    buyer = game.player("buy_id");
    for (let x = 10; x <= 20; x++) {
      for (let y = 20; y <= 40; y++) bot.conquer(game.ref(x, y));
    }
    for (let x = 21; x <= 30; x++) {
      for (let y = 20; y <= 40; y++) buyer.conquer(game.ref(x, y));
    }
    // A small parcel of the bot's border columns.
    parcel = [];
    for (let x = 19; x <= 20; x++) {
      for (let y = 25; y <= 30; y++) parcel.push(game.ref(x, y));
    }
    bot.addGold(1_000_000n);
    buyer.addGold(5_000_000n);
    behavior = new NationLandSaleBehavior(new PseudoRandom(12345), game, bot);
  });

  // A buy offer: buyer wants to buy the bot's parcel; the bot is the recipient.
  function makeBuyOffer(price: bigint): number {
    return game.createLandSaleOffer(bot, buyer, bot, parcel, price);
  }

  test("rejects every offer during the first two minutes", () => {
    const id = makeBuyOffer(900_000n); // very generous, but too early
    behavior.handleLandSaleOffers();
    executeTicks(game, 3);
    expect(game.landSaleOffer(id)).toBeUndefined();
    for (const t of parcel) expect(game.owner(t)).toBe(bot); // not sold
  });

  test("accepts a generous offer after the window", () => {
    executeTicks(game, PAST_WINDOW);
    const id = makeBuyOffer(900_000n); // ≈ bot's whole wealth for 12 tiles
    behavior.handleLandSaleOffers();
    executeTicks(game, 3);
    expect(game.landSaleOffer(id)).toBeUndefined();
    for (const t of parcel) expect(game.owner(t)).toBe(buyer); // sold
  });

  test("counters a low offer instead of accepting", () => {
    executeTicks(game, PAST_WINDOW);
    makeBuyOffer(5_000n); // far too cheap
    behavior.handleLandSaleOffers();
    executeTicks(game, 3);
    // Original offer (id 1) replaced by a counter (id 2) for the buyer.
    expect(game.landSaleOffer(1)).toBeUndefined();
    const counter = game.landSaleOffer(2);
    expect(counter).toBeDefined();
    expect(counter!.recipient).toBe(buyer);
    expect(counter!.price).toBeGreaterThan(5_000n);
    for (const t of parcel) expect(game.owner(t)).toBe(bot); // not sold yet
  });

  test("refuses to sell more than half its land", () => {
    executeTicks(game, PAST_WINDOW);
    // The whole territory (231 tiles) — way over 50%.
    const big: number[] = [];
    for (let x = 10; x <= 20; x++) {
      for (let y = 20; y <= 40; y++) big.push(game.ref(x, y));
    }
    const id = game.createLandSaleOffer(bot, buyer, bot, big, 9_000_000n);
    behavior.handleLandSaleOffers();
    executeTicks(game, 3);
    expect(game.landSaleOffer(id)).toBeUndefined();
    for (const t of parcel) expect(game.owner(t)).toBe(bot); // not sold
  });
});
