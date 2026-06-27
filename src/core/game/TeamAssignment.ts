import { PseudoRandom } from "../PseudoRandom";
import { ClientID } from "../Schemas";
import { simpleHash } from "../Util";
import { PlayerInfo, PlayerType, Team } from "./Game";

// Place a group that must stay together onto the emptiest team, kicking any
// members that overflow maxTeamSize. Used for both matchmaking parties and
// clans (both are strict "all on one team" groups).
function placeStrictGroup(
  group: PlayerInfo[],
  teams: Team[],
  teamPlayerCount: Map<Team, number>,
  result: Map<PlayerInfo, Team | "kicked">,
  maxTeamSize: number,
): void {
  let team: Team | null = null;
  let teamSize = 0;
  for (const t of teams) {
    const p = teamPlayerCount.get(t) ?? 0;
    if (team !== null && teamSize <= p) continue;
    teamSize = p;
    team = t;
  }
  if (team === null) return;
  for (const player of group) {
    if (teamSize < maxTeamSize) {
      teamSize++;
      result.set(player, team);
    } else {
      result.set(player, "kicked");
    }
  }
  teamPlayerCount.set(team, teamSize);
}

export function assignTeams(
  players: PlayerInfo[],
  teams: Team[],
  maxTeamSize: number = getMaxTeamSize(players.length, teams.length),
): Map<PlayerInfo, Team | "kicked"> {
  const result = new Map<PlayerInfo, Team | "kicked">();
  const teamPlayerCount = new Map<Team, number>();

  // Matchmaking parties and clans are both strict: the whole group goes to one
  // team together (overflow is kicked). Parties take precedence — a queued
  // party is the explicit "play together" group — so members of a party are
  // grouped by party even if they also share a clan tag.
  const partyGroups = new Map<string, PlayerInfo[]>();
  const clanGroups = new Map<string, PlayerInfo[]>();
  const nonClanPlayers: PlayerInfo[] = [];
  for (const p of players) {
    if (p.party) {
      if (!partyGroups.has(p.party)) partyGroups.set(p.party, []);
      partyGroups.get(p.party)!.push(p);
    } else if (p.clanTag) {
      if (!clanGroups.has(p.clanTag)) clanGroups.set(p.clanTag, []);
      clanGroups.get(p.clanTag)!.push(p);
    } else {
      nonClanPlayers.push(p);
    }
  }

  // Largest groups first so they claim the emptiest teams.
  const strictGroups = [
    ...Array.from(partyGroups.values()),
    ...Array.from(clanGroups.values()),
  ].sort((a, b) => b.length - a.length);
  for (const group of strictGroups) {
    placeStrictGroup(group, teams, teamPlayerCount, result, maxTeamSize);
  }

  // Friend edges are a soft preference: when placing a player, prefer the
  // team where the most of their friends already are. If that team is full
  // we spill onto the next-emptiest non-full team rather than kicking — you
  // didn't opt into being grouped with friend-of-friend, so a chain that
  // doesn't fit shouldn't bench anyone.
  const presentClientIDs = new Set<ClientID>();
  for (const p of players) {
    if (p.clientID !== null) presentClientIDs.add(p.clientID);
  }
  const friendGraph = new Map<ClientID, Set<ClientID>>();
  const addEdge = (a: ClientID, b: ClientID) => {
    let s = friendGraph.get(a);
    if (s === undefined) {
      s = new Set();
      friendGraph.set(a, s);
    }
    s.add(b);
  };
  for (const p of players) {
    if (p.clientID === null) continue;
    for (const friendID of p.friends) {
      if (!presentClientIDs.has(friendID)) continue;
      addEdge(p.clientID, friendID);
      addEdge(friendID, p.clientID);
    }
  }

  const teamByClientID = new Map<ClientID, Team>();
  for (const [player, team] of result.entries()) {
    if (player.clientID !== null && team !== "kicked") {
      teamByClientID.set(player.clientID, team);
    }
  }

  const placePlayer = (p: PlayerInfo) => {
    const myFriends =
      p.clientID !== null ? friendGraph.get(p.clientID) : undefined;
    let bestTeam: Team | null = null;
    let bestFriendCount = -1;
    let bestSize = Infinity;
    for (const t of teams) {
      const size = teamPlayerCount.get(t) ?? 0;
      if (size >= maxTeamSize) continue;
      let friendsOnTeam = 0;
      if (myFriends !== undefined) {
        for (const friendID of myFriends) {
          if (teamByClientID.get(friendID) === t) friendsOnTeam++;
        }
      }
      if (
        friendsOnTeam > bestFriendCount ||
        (friendsOnTeam === bestFriendCount && size < bestSize)
      ) {
        bestFriendCount = friendsOnTeam;
        bestSize = size;
        bestTeam = t;
      }
    }
    if (bestTeam === null) {
      result.set(p, "kicked");
      return;
    }
    teamPlayerCount.set(bestTeam, (teamPlayerCount.get(bestTeam) ?? 0) + 1);
    result.set(p, bestTeam);
    if (p.clientID !== null) teamByClientID.set(p.clientID, bestTeam);
  };

  let nationPlayers = nonClanPlayers.filter(
    (p) => p.playerType === PlayerType.Nation,
  );
  if (nationPlayers.length > 0) {
    const random = new PseudoRandom(simpleHash(nationPlayers[0].id));
    nationPlayers = random.shuffleArray(nationPlayers);
  }
  const otherPlayers = nonClanPlayers.filter(
    (p) => p.playerType !== PlayerType.Nation,
  );
  for (const p of otherPlayers.concat(nationPlayers)) {
    placePlayer(p);
  }

  return result;
}

export function assignTeamsLobbyPreview(
  players: PlayerInfo[],
  teams: Team[],
  nationCount: number,
): Map<PlayerInfo, Team | "kicked"> {
  const maxTeamSize = getMaxTeamSize(
    players.length + nationCount,
    teams.length,
  );
  return assignTeams(players, teams, maxTeamSize);
}

export function getMaxTeamSize(numPlayers: number, numTeams: number): number {
  return Math.ceil(numPlayers / numTeams);
}
