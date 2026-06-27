import { AllianceRequestExecution } from "../src/core/execution/alliance/AllianceRequestExecution";
import { ReleaseVassalExecution } from "../src/core/execution/ReleaseVassalExecution";
import { SurrenderExecution } from "../src/core/execution/SurrenderExecution";
import { Game, Player, PlayerType } from "../src/core/game/Game";
import { playerInfo, setup } from "./util/Setup";
import { TestConfig } from "./util/TestConfig";

let game: Game;
let vassal: Player;
let lord: Player;
let other: Player;
let lordAlly: Player;

describe("SurrenderExecution / vassalage", () => {
  beforeEach(async () => {
    game = await setup(
      "plains",
      { infiniteGold: true, instantBuild: true, infiniteTroops: true },
      [
        playerInfo("vassal", PlayerType.Human),
        playerInfo("lord", PlayerType.Human),
        playerInfo("other", PlayerType.Human),
        playerInfo("ally", PlayerType.Human),
      ],
    );
    // No spawn immunity, so the lord can immediately attack the vassal.
    (game.config() as TestConfig).spawnImmunityDuration = () => 0;

    vassal = game.player("vassal");
    lord = game.player("lord");
    other = game.player("other");
    lordAlly = game.player("ally");
    vassal.conquer(game.ref(0, 0));
    lord.conquer(game.ref(0, 1));
    other.conquer(game.ref(0, 2));
    lordAlly.conquer(game.ref(0, 3));
  });

  const surrender = () => {
    game.addExecution(new SurrenderExecution(vassal, lord.id()));
    game.executeNextTick();
  };

  const ally = (a: Player, b: Player) => {
    game.addExecution(new AllianceRequestExecution(a, b.id()));
    game.executeNextTick();
    game.addExecution(new AllianceRequestExecution(b, a.id()));
    game.executeNextTick();
  };

  test("surrender establishes the vassal relationship", () => {
    surrender();
    expect(vassal.isVassalOf(lord)).toBe(true);
    expect(vassal.vassalLord()).toBe(lord);
    expect(lord.vassals().map((v) => v.id())).toContain(vassal.id());
  });

  test("vassal cannot attack its lord, but the lord can attack the vassal", () => {
    surrender();
    expect(vassal.canAttackPlayer(lord)).toBe(false);
    expect(lord.canAttackPlayer(vassal)).toBe(true);
  });

  test("vassal can still attack a third party", () => {
    surrender();
    expect(vassal.canAttackPlayer(other)).toBe(true);
  });

  test("vassal cannot attack the lord's allies", () => {
    ally(lord, lordAlly);
    surrender();
    expect(vassal.canAttackPlayer(lordAlly)).toBe(false);
    expect(vassal.canAttackPlayer(other)).toBe(true);
  });

  test("cannot surrender to self, to a current vassal, or twice", () => {
    surrender();
    expect(vassal.canSurrenderTo(lord)).toBe(false); // already their vassal
    expect(lord.canSurrenderTo(vassal)).toBe(false); // would create a cycle
    expect(vassal.canSurrenderTo(vassal)).toBe(false);
  });

  test("a lord can release a vassal, restoring its ability to attack", () => {
    surrender();
    expect(vassal.canAttackPlayer(lord)).toBe(false);
    expect(lord.canReleaseVassal(vassal)).toBe(true);

    game.addExecution(new ReleaseVassalExecution(lord, vassal.id()));
    game.executeNextTick();

    expect(vassal.isVassalOf(lord)).toBe(false);
    expect(lord.vassals()).toHaveLength(0);
    expect(vassal.canAttackPlayer(lord)).toBe(true);
  });

  test("surrender drops any alliance so the lord takes land with no debuff", () => {
    ally(vassal, lord);
    expect(vassal.isAlliedWith(lord)).toBe(true);
    surrender();
    expect(vassal.isAlliedWith(lord)).toBe(false);
    expect(lord.canAttackPlayer(vassal)).toBe(true);
    expect(lord.isTraitor()).toBe(false);
  });
});
