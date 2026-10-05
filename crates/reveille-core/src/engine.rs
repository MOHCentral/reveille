// SPDX-License-Identifier: GPL-3.0-only

//! Engine identity shared by every front end.

use serde::{Deserialize, Serialize};

/// Game program selected for browsing, previewing, and launching.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineChoice {
    /// The executables supplied with the player's game.
    Original,
    /// The modern rebuilt engine.
    Openmohaa,
    /// The classic executable family with community fixes.
    Reborn,
}

impl EngineChoice {
    /// Every engine choice, in declaration order. Host support and display order are platform
    /// policy, not part of this list.
    pub const ALL: [Self; 3] = [Self::Original, Self::Openmohaa, Self::Reborn];

    /// Engine label as a player reads it.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Original => "Original game",
            Self::Openmohaa => "OpenMoHAA",
            Self::Reborn => "Reborn",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::EngineChoice;

    #[test]
    fn all_lists_every_engine_choice_once_in_declaration_order() {
        // Adding a variant breaks this match, which is the prompt to extend `ALL`.
        const fn ordinal(engine: EngineChoice) -> usize {
            match engine {
                EngineChoice::Original => 0,
                EngineChoice::Openmohaa => 1,
                EngineChoice::Reborn => 2,
            }
        }
        assert!(
            EngineChoice::ALL
                .into_iter()
                .map(ordinal)
                .eq(0..EngineChoice::ALL.len())
        );
    }
}
