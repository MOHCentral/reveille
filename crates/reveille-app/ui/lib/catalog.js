// SPDX-License-Identifier: GPL-3.0-only

// The games and engines as the Rust side spells and labels them. The object literal must stay
// plain JSON: `src/catalog_contract.rs` parses it and compares it with `TargetGame::ALL`,
// `Product::ALL` and `EngineChoice::ALL`.
export const CATALOG = Object.freeze({
  "games": [
    { "id": "allied_assault", "label": "Allied Assault" },
    { "id": "spearhead", "label": "Spearhead" },
    { "id": "breakthrough", "label": "Breakthrough" }
  ],
  "engines": [
    { "id": "original", "label": "Original game" },
    { "id": "openmohaa", "label": "OpenMoHAA" },
    { "id": "reborn", "label": "Reborn" }
  ]
});

const ids = (entries) => Object.freeze(entries.map((entry) => entry.id));
const labels = (entries) => Object.freeze(Object.fromEntries(entries.map((entry) => [entry.id, entry.label])));

/** The three games, base game first. Also how `Installation.products` spells them. */
export const GAMES = ids(CATALOG.games);
export const GAME_LABELS = labels(CATALOG.games);
export const DEFAULT_GAME = GAMES[0];

/** Every engine choice. Which ones a host offers, and in what order, comes from the Rust side. */
export const ENGINES = ids(CATALOG.engines);
export const ENGINE_LABELS = labels(CATALOG.engines);
