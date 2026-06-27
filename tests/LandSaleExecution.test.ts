import { ProposeLandSaleExecution } from "../src/core/execution/ProposeLandSaleExecution";
import { RespondLandSaleExecution } from "../src/core/execution/RespondLandSaleExecution";
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

describe("Land sale", () => {
  let game: Game;
  let seller: Player;
  let buyer: Player;
  let parcel: number[];

  afterEach(() => vi.restoreAllMocks());

  beforeEach(async () => {
    game = await setupGame([
      new PlayerInfo("sell", PlayerType.Human, "c1", "sell_id"),
      new PlayerInfo("buy", PlayerType.Human, "c2", "buy_id"),
    ]);
    seller = game.player("sell_id");
    buyer = game.player("buy_id");
    // Seller owns the left block, buyer the adjacent right block.
    for (let x = 10; x <= 20; x++) {
      for (let y = 20; y <= 40; y++) seller.conquer(game.ref(x, y));
    }
    for (let x = 21; x <= 30; x++) {
      for (let y = 20; y <= 40; y++) buyer.conquer(game.ref(x, y));
    }
    // Parcel = seller's two border columns (they touch the buyer at x=21).
    parcel = [];
    for (let x = 19; x <= 20; x++) {
      for (let y = 25; y <= 30; y++) parcel.push(game.ref(x, y));
    }
  });

  test("accepted offer transfers gold and the parcel", () => {
    buyer.addGold(1_000_000n);
    const sellerGold = seller.gold();
    const buyerGold = buyer.gold();
    const price = 100_000n;

    game.addExecution(
      new ProposeLandSaleExecution(seller, buyer.id(), parcel, Number(price)),
    );
    executeTicks(game, 3);
    expect(game.landSaleOffer(1)).toBeDefined();

    game.addExecution(new RespondLandSaleExecution(buyer, 1, true));
    executeTicks(game, 3);

    // Tiles transferred.
    for (const t of parcel) expect(game.owner(t)).toBe(buyer);
    // Gold moved.
    expect(buyer.gold()).toBe(buyerGold - price);
    expect(seller.gold()).toBe(sellerGold + price);
    // Offer cleared.
    expect(game.landSaleOffer(1)).toBeUndefined();
  });

  test("declined offer transfers nothing", () => {
    buyer.addGold(1_000_000n);
    const sellerGold = seller.gold();
    const buyerGold = buyer.gold();

    game.addExecution(
      new ProposeLandSaleExecution(seller, buyer.id(), parcel, 100_000),
    );
    executeTicks(game, 3);
    game.addExecution(new RespondLandSaleExecution(buyer, 1, false));
    executeTicks(game, 3);

    for (const t of parcel) expect(game.owner(t)).toBe(seller);
    expect(buyer.gold()).toBe(buyerGold);
    expect(seller.gold()).toBe(sellerGold);
    expect(game.landSaleOffer(1)).toBeUndefined();
  });

  test("offer to a non-bordering player is rejected (no offer created)", () => {
    // A far-away parcel the buyer does not touch.
    const farParcel: number[] = [];
    for (let y = 25; y <= 30; y++) farParcel.push(game.ref(11, y));
    game.addExecution(
      new ProposeLandSaleExecution(seller, buyer.id(), farParcel, 100_000),
    );
    executeTicks(game, 3);
    expect(game.landSaleOffer(1)).toBeUndefined();
  });

  test("accept fails when the buyer can't afford it", () => {
    // buyer has only starting gold; ask an absurd price.
    const buyerGold = buyer.gold();
    game.addExecution(
      new ProposeLandSaleExecution(seller, buyer.id(), parcel, 999_999_999),
    );
    executeTicks(game, 3);
    game.addExecution(new RespondLandSaleExecution(buyer, 1, true));
    executeTicks(game, 3);

    for (const t of parcel) expect(game.owner(t)).toBe(seller); // unchanged
    expect(buyer.gold()).toBe(buyerGold);
    expect(game.landSaleOffer(1)).toBeUndefined(); // offer consumed
  });
});
