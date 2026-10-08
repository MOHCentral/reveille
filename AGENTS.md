# Repository Guidelines

Do not create markdown documents unless requested.

## Project Structure

- `crates/reveille-core`: platform-neutral pipeline (discovery, content, join, preflight). No Tauri.
- `crates/reveille-platform`: launcher, host-capability, and content-path policy shared by the front ends.
- `crates/reveille-cli`: the command-line front end.
- `crates/reveille-app`: the Tauri shell (`src/`) and its webview (`ui/`), organized as vertical slices: `installation`, `engines`, `servers`, `join`, `alerts`, `self-update`, and so on.

### Rust slices (`crates/reveille-app/src`)

A slice is a module (`servers/`, `join/`, …) that owns its commands, payload types, and state:

- Commands and the types they exchange are `pub`; `main.rs` lists each command in `generate_handler!` under its slice's comment.
- A slice with state defines its own state type and a `pub fn register(app: &mut tauri::App)` that calls `app.manage`; `main.rs` calls `register` from `setup`. There is no shared `AppState`; only shell modules (`tray`, `popup`, `telemetry`) are managed in `setup` directly. A missing `manage` compiles and panics only when the command runs, so smoke every command a PR moves or adds.
- A slice that emits progress declares `pub const EVENT: &str = "reveille://…"` beside the emitter and adds it to the event-name test in `main.rs`.
- `main.rs` composes slices and holds no command logic.

### UI modules (`crates/reveille-app/ui`)

Gate 7 (`tools/ui-imports.mjs`, run by `just sources`) enforces this layout:

- `lib/` is the kernel: bridge, store, session, preferences, DOM and formatting helpers. It never imports a feature.
- `features/<name>/` owns one feature. `api.js` holds its Tauri commands, `state.js` exports its `initial()` state keys, `index.js` is the only module other features may import, and optional `view.js`, `controller.js`, `settings-section.js`, and `<name>.css` hold the rest.
- Only `lib/` and `features/*/api.js` may import `lib/bridge.js`; only `lib/bridge.js` reads `window.__TAURI__`.
- Any other module must be an entry point listed in `ENTRY_POINTS`: `app.js` (the composition root) and `features/alerts/popup/main.js`.
- Features ask the shell for cross-feature actions through the fixed table in `lib/intents.js`, not by importing each other's controllers.
- Shared styles live in `styles/`; `styles/responsive.css` loads last in `index.html` so narrow-window rules keep their cascade order.

## Build, Test, and Development Commands

- `just check`: run the complete local gate used by CI.
- `just fmt`: apply canonical Rust formatting.
- `just test`: run all offline workspace tests with locked dependencies.
- `just ui-test`: run frontend unit tests with Node's built-in test runner.
- `just app`: launch the Tauri development build on Windows.
- `just cli --help`: inspect CLI commands; for example, `just scan "C:\Games\MOHAA"`.
- `just live`: run ignored, network-dependent tests; never add live calls to the default suite.
- `just inventory [REF]`: list every Rust and UI test; with a git ref, list only tests added, removed, or moved since it.

Use versions pinned in `rust-toolchain.toml` and `.node-version`. Installer builds require `npm install` in `crates/reveille-app`.

## Coding Style & Naming Conventions

Use `cargo fmt` defaults (four-space Rust indentation) and keep Clippy warning-free. Modules, functions, and test names use `snake_case`; types use `UpperCamelCase`; constants use `SCREAMING_SNAKE_CASE`. Prefer newtypes where primitive values could be confused. Model library failures with `thiserror`; avoid `unwrap` and `expect` outside tests and executable boundaries. Add `SPDX-License-Identifier: GPL-3.0-only` to new source files. Cite the OpenMoHAA source beside protocol constants.

Comments explain only why a non-obvious choice or constraint exists. Never restate the code, narrate changes, preserve history, or leave essay-length commentary.

## Testing Guidelines

Place focused unit tests beside Rust modules and cross-module scenarios in `tests/*.rs`; name cases by observable behavior. Put UI tests in `ui-tests/**/*.test.js`, mirroring `ui/` (`ui-tests/lib/`, `ui-tests/features/<name>/`); keep `ui-tests/fakes/` and the `ui-tests/preview/` harness in step with any command a PR renames or adds. Fixtures must be deterministic and live under `tests/fixtures/`. Run `just check` before pushing; it includes formatting, source-policy, portability, lint, Rust, and JavaScript checks.

## Project Management

Run `just project-status` to get an overview of all issues and their status. Update issues with `just project-start ISSUE`, `just project-block ISSUE "NEXT ACTION"`, or `just project-next ISSUE "NEXT ACTION"`. Closing issues automatically sets **Done**; never set it manually.
Codex: Always run `just project-*` commands outside the sandbox.

## Commit & Pull Request Guidelines

History favors short imperative subjects, optionally Conventional Commit prefixes such as `feat:`, `fix:`, or `chore:`. Keep commits narrowly scoped. Pull requests should explain user-visible behavior, link relevant issues, list verification performed, and include screenshots for UI changes. A PR that removes, renames, or moves tests lists them from `just inventory origin/main`, each with its replacement. Do not add checks directly to `ci.yml`; add them to the appropriate `ci-*` recipe in `justfile` so local and CI gates remain identical.
