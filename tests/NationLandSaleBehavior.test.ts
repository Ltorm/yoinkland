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

  test("a too-low offer is countered or rejected (50/50), never accepted", () => {
    executeTicks(game, PAST_WINDOW);
    let sawCounter = false;
    let sawReject = false;
    // Different seeds exercise the 50/50 counter-vs-reject roll.
    for (let seed = 0; seed < 40 && !(sawCounter && sawReject); seed++) {
      const id = game.createLandSaleOffer(bot, buyer, bot, parcel, 5_000n);
      const b = new NationLandSaleBehavior(new PseudoRandom(seed), game, bot);
      b.handleLandSaleOffers();
      executeTicks(game, 3);
      for (const t of parcel) expect(game.owner(t)).toBe(bot); // never sold
      expect(game.landSaleOffer(id)).toBeUndefined(); // original resolved
      const counter = game.landSaleOffer(id + 1);
      if (counter !== undefined && counter.recipient === buyer) {
        expect(counter.price).toBeGreaterThan(5_000n);
        sawCounter = true;
      } else {
        sawReject = true;
      }
    }
    expect(sawCounter).toBe(true);
    expect(sawReject).toBe(true);
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

  test("refuses to sell more than half its coastline (naval chokepoint)", async () => {
    // Build a map where x<10 is water, so the bot's x=10 column is coastline.
    const data = new Uint8Array(MAP_W * MAP_H).fill(LAND_PLAINS);
    let landTiles = MAP_W * MAP_H;
    for (let x = 0; x < 10; x++) {
      for (let y = 0; y < MAP_H; y++) {
        data[y * MAP_W + x] = 0; // water
        landTiles--;
      }
    }
    const gm = await genTerrainFromBin(
      { width: MAP_W, height: MAP_H, num_land_tiles: landTiles },
      data,
    );
    const mini = await genTerrainFromBin(
      { width: MAP_W / 2, height: MAP_H / 2, num_land_tiles: 1 },
      new Uint8Array((MAP_W / 2) * (MAP_H / 2)).fill(LAND_PLAINS),
    );
    const cfg = new TestConfig(
      {
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
      },
      new UserSettings(),
      false,
    );
    const g = createGame(
      [
        new PlayerInfo("bot", PlayerType.Human, "c1", "bot_id"),
        new PlayerInfo("buy", PlayerType.Human, "c2", "buy_id"),
      ],
      [],
      gm,
      mini,
      cfg,
    );
    g.endSpawnPhase();
    const coastBot = g.player("bot_id");
    for (let x = 10; x <= 20; x++) {
      for (let y = 20; y <= 40; y++) coastBot.conquer(g.ref(x, y));
    }
    coastBot.addGold(1_000_000n);
    const coastBuyer = g.player("buy_id");
    coastBuyer.addGold(5_000_000n);
    // x=10 column (shore) is the coastline; selling >50% of it = chokepoint.
    const shoreParcel: number[] = [];
    for (let y = 20; y <= 31; y++) shoreParcel.push(g.ref(10, y)); // 12 of 21 shore
    executeTicks(g, PAST_WINDOW);
    const id = g.createLandSaleOffer(
      coastBot,
      coastBuyer,
      coastBot,
      shoreParcel,
      900_000n, // generous — only the coastline rule should block it
    );
    new NationLandSaleBehavior(
      new PseudoRandom(7),
      g,
      coastBot,
    ).handleLandSaleOffers();
    executeTicks(g, 3);
    expect(g.landSaleOffer(id)).toBeUndefined();
    for (const t of shoreParcel) expect(g.owner(t)).toBe(coastBot); // not sold
  });
});
