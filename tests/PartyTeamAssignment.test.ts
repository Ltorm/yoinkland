import { PlayerInfo, PlayerType, Team } from "../src/core/game/Game";
import { assignTeams } from "../src/core/game/TeamAssignment";

function human(id: string, party: string | null): PlayerInfo {
  return new PlayerInfo(
    id, // name
    PlayerType.Human,
    id, // clientID
    id, // id
    false, // isLobbyCreator
    null, // clanTag
    [], // friends
    party,
  );
}

describe("party team assignment", () => {
  test("each party of 3 lands together on its own team (Trios, 3 teams)", () => {
    const teams: Team[] = ["Red", "Blue", "Yellow"];
    const players = [
      human("a1", "P1"),
      human("a2", "P1"),
      human("a3", "P1"),
      human("b1", "P2"),
      human("b2", "P2"),
      human("b3", "P2"),
      human("c1", "P3"),
      human("c2", "P3"),
      human("c3", "P3"),
    ];
    const result = assignTeams(players, teams, 3);

    for (const party of ["P1", "P2", "P3"]) {
      const members = players.filter((p) => p.party === party);
      const teamsForParty = new Set(members.map((p) => result.get(p)));
      expect(teamsForParty.size).toBe(1); // all on one team
      expect([...teamsForParty][0]).not.toBe("kicked");
    }
    // The three parties end up on three different teams.
    const teamOf = (party: string) =>
      result.get(players.find((p) => p.party === party)!);
    expect(new Set([teamOf("P1"), teamOf("P2"), teamOf("P3")]).size).toBe(3);
  });

  test("a party member that overflows the team size is kicked", () => {
    const teams: Team[] = ["Red", "Blue"];
    const players = [human("a1", "P1"), human("a2", "P1"), human("a3", "P1")];
    const result = assignTeams(players, teams, 2); // party of 3, team cap 2
    const kicked = players.filter((p) => result.get(p) === "kicked").length;
    expect(kicked).toBe(1);
  });

  test("parties take precedence over clan tags for grouping", () => {
    const teams: Team[] = ["Red", "Blue"];
    // Two players share a clan but are in different parties → split by party.
    const p1 = new PlayerInfo(
      "x",
      PlayerType.Human,
      "x",
      "x",
      false,
      "CLAN",
      [],
      "PA",
    );
    const p2 = new PlayerInfo(
      "y",
      PlayerType.Human,
      "y",
      "y",
      false,
      "CLAN",
      [],
      "PB",
    );
    const a2 = human("a2", "PA");
    const b2 = human("b2", "PB");
    const result = assignTeams([p1, p2, a2, b2], teams, 2);
    expect(result.get(p1)).toBe(result.get(a2)); // PA together
    expect(result.get(p2)).toBe(result.get(b2)); // PB together
    expect(result.get(p1)).not.toBe(result.get(p2)); // different parties split
  });
});
