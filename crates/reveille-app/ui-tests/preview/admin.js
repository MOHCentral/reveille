// SPDX-License-Identifier: GPL-3.0-only

// Two servers the preview's player runs, shaped like the `admin_*` commands' payloads. The first
// is an OpenMoHAA server, so Message and Ban show; the second is an original 1.11 server, so they
// do not. The password "wrong" is refused, as a server would.

import { browsePayload } from "./fixture.js";

const PLAYERS = [
  ["=|LuV|=Hawk", 41, 55],
  ["<[TFC]>Goat", 38, 24],
  ["[FORTE]Raven", 30, 111],
  ["{UK}Tommy", 27, 173],
  ["Unknown Soldier", 22, 142],
  ["Kraut_Sniper", 19, 68],
  ["[DSB]Mika", 17, 31],
  ["Pvt.Ryan", 12, 96],
  ["Le_Boucher", 9, 52],
  ["Iron Mike", 4, null],
];

const SERVERS = [
  {
    name: "harzCore | Stock Maps 24/7",
    map: "dm/mohdm6",
    game_type: "Team-Match",
    capacity: 32,
    players: PLAYERS,
    rotation: ["dm/mohdm6", "dm/mohdm2", "dm/mohdm4", "dm/mohdm1"],
    engine: "open_mohaa",
  },
  {
    name: "[DSB]Clan DM",
    map: "dm/mohdm1",
    game_type: "Free-For-All",
    capacity: 16,
    players: PLAYERS.slice(6, 10),
    rotation: ["dm/mohdm1", "dm/mohdm7"],
    engine: "original",
  },
];

/** The preview's fake `admin_*` commands. `count` servers start added; `failure` is the first one's. */
export function adminCommands({ count, failure }) {
  const addresses = browsePayload().servers.map((row) => row.address);
  const added = SERVERS.slice(0, count).map((server, index) => ({ address: addresses[index], name: server.name }));
  const fixture = (address) => SERVERS[addresses.indexOf(address)] ?? SERVERS[0];
  let failing = failure;

  return {
    admin_servers: () => ({ servers: added, vault: "credential_manager" }),
    add_admin_server: ({ address, password }) => {
      if (password === "wrong") {
        return Promise.reject({ reason: "bad_password", message: "The server did not accept this RCON password." });
      }
      const known = added.find((server) => server.address === address);
      if (known) {
        failing = null;
        return known;
      }
      const row = browsePayload().servers.find((candidate) => candidate.address === address);
      const server = { address, name: row?.server.hostname ?? address };
      added.push(server);
      return server;
    },
    remove_admin_server: ({ address }) => {
      added.splice(added.findIndex((server) => server.address === address), 1);
    },
    admin_status: ({ address }) => {
      if (failing && address === added[0]?.address) {
        const messages = {
          needs_password: "Reveille needs this server's RCON password again.",
          no_answer: "The server did not answer. It may be down, or busy loading a map.",
        };
        return Promise.reject({ reason: failing, message: messages[failing] ?? failing });
      }
      const server = fixture(address);
      return {
        name: server.name,
        map: server.map,
        game_type: server.game_type,
        capacity: server.capacity,
        players: server.players.map(([name, score, ping], slot) => ({ slot, name, score, ping })),
        rotation: server.rotation,
        engine: server.engine,
        can_message: server.engine === "open_mohaa",
        can_ban: server.engine === "open_mohaa",
      };
    },
    admin_action: ({ action }) => {
      switch (action.kind) {
        case "console":
          return action.line === "sv_maplist"
            ? '"sv_maplist" is:"dm/mohdm6 dm/mohdm2 dm/mohdm4 dm/mohdm1^7" default:"^7"\n'
            : action.line === "status"
              ? "map: dm/mohdm6\nnum score ping name            lastmsg address               qport rate\n"
              : "";
        case "say":
          return `console: ${action.text}\n`;
        case "kick":
          return "";
        default:
          return "";
      }
    },
  };
}
