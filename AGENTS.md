# Repository Guidelines

Do not create markdown documents unless requested.

## Project Structure & Module Organization

This Rust 2024 workspace contains reusable logic (`reveille-core`), Windows policy (`reveille-platform`), the CLI (`reveille-cli`), and Tauri shell (`reveille-app`). Frontend code and tests live in the app's `ui/` and `ui-tests/`; core integration tests and fixtures live in `crates/reveille-core/tests/`. Automation is in `tools/`, CI in `.github/workflows/`, and the site in `website/`.

## Build, Test, and Development Commands

- `just check`: run the complete local gate used by CI.
- `just fmt`: apply canonical Rust formatting.
- `just test`: run all offline workspace tests with locked dependencies.
- `just ui-test`: run frontend unit tests with Node's built-in test runner.
- `just app`: launch the Tauri development build on Windows.
- `just cli --help`: inspect CLI commands; for example, `just scan "C:\Games\MOHAA"`.
- `just live`: run ignored, network-dependent tests; never add live calls to the default suite.

Use versions pinned in `rust-toolchain.toml` and `.node-version`. Installer builds require `npm install` in `crates/reveille-app`.

## Coding Style & Naming Conventions

Use `cargo fmt` defaults (four-space Rust indentation) and keep Clippy warning-free. Modules, functions, and test names use `snake_case`; types use `UpperCamelCase`; constants use `SCREAMING_SNAKE_CASE`. Prefer newtypes where primitive values could be confused. Model library failures with `thiserror`; avoid `unwrap` and `expect` outside tests and executable boundaries. Add `SPDX-License-Identifier: GPL-3.0-only` to new source files. Cite the OpenMoHAA source beside protocol constants.

Comments explain only why a non-obvious choice or constraint exists. Never restate the code, narrate changes, preserve history, or leave essay-length commentary.

## Testing Guidelines

Place focused unit tests beside Rust modules and cross-module scenarios in `tests/*.rs`; name cases by observable behavior. Put UI tests in `ui-tests/**/*.test.js`. Fixtures must be deterministic and live under `tests/fixtures/`. Run `just check` before pushing; it includes formatting, source-policy, portability, lint, Rust, and JavaScript checks.

## Project Management

Run `just project-status` to get an overview of all issues and their status. Update issues with `just project-start ISSUE`, `just project-block ISSUE "NEXT ACTION"`, or `just project-next ISSUE "NEXT ACTION"`. Closing issues automatically sets **Done**; never set it manually.
Codex: Always run `just project-*` commands outside the sandbox.

## Commit & Pull Request Guidelines

History favors short imperative subjects, optionally Conventional Commit prefixes such as `feat:`, `fix:`, or `chore:`. Keep commits narrowly scoped. Pull requests should explain user-visible behavior, link relevant issues, list verification performed, and include screenshots for UI changes. Do not add checks directly to `ci.yml`; add them to the appropriate `ci-*` recipe in `justfile` so local and CI gates remain identical.
