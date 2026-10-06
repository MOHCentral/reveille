// SPDX-License-Identifier: GPL-3.0-only

//! The shell's game and engine catalogue must match what the core serializes and labels.

use reveille_core::discovery::TargetGame;
use reveille_core::engine::EngineChoice;
use reveille_core::install::Product;
use serde::Serialize;
use serde_json::{Value, json};

const CATALOG_JS: &str = include_str!("../ui/lib/catalog.js");

/// The JSON object passed to `Object.freeze` in `catalog.js`.
fn shell_catalog() -> Value {
    let (_, literal) = CATALOG_JS
        .split_once("export const CATALOG = Object.freeze(")
        .expect("catalog.js freezes a CATALOG literal");
    let (literal, _) = literal
        .split_once("\n});")
        .expect("the CATALOG literal closes at the start of a line");
    serde_json::from_str(&format!("{literal}\n}}")).expect("the CATALOG literal is JSON")
}

fn id(value: impl Serialize) -> Value {
    serde_json::to_value(value).expect("catalogue ids serialize")
}

#[test]
fn the_shell_catalog_matches_the_core_games_and_engines() {
    let games = TargetGame::ALL
        .into_iter()
        .map(|game| json!({ "id": id(game), "label": game.label() }))
        .collect::<Vec<_>>();
    let engines = EngineChoice::ALL
        .into_iter()
        .map(|engine| json!({ "id": id(engine), "label": engine.label() }))
        .collect::<Vec<_>>();

    assert_eq!(
        shell_catalog(),
        json!({ "games": games, "engines": engines })
    );
}

#[test]
fn installed_products_are_spelled_like_the_games_the_shell_labels() {
    // The shell labels `Installation.products` with the game labels.
    let products = Product::ALL.map(id);
    let games = TargetGame::ALL.map(id);
    assert_eq!(products, games);
}
