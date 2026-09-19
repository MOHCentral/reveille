# SPDX-License-Identifier: GPL-3.0-only

# Recipes are single commands that read the same under `sh` and under `cmd`, so the same justfile
# serves the Windows machine and the aarch64 Linux one. Two things forced that:
#
#   * `just` runs recipes under `sh` on every platform unless told otherwise, and Windows has no
#     `sh`. Hence `windows-shell` below.
#   * `bash` on a Windows PATH is normally the WSL shim in System32, not Git Bash — a
#     different filesystem with a different toolchain. Pointing at it would be worse than `cmd`.
#
# `cmd` rather than PowerShell because Windows PowerShell 5.1 has neither `&&` nor `||`, which
# `bundle` and `engine-source` rely on.
set windows-shell := ["cmd.exe", "/c"]

# Where to keep the openmohaa checkout used as engine ground truth. Outside the repo by default
# so it never lands in `git status`.
engine_source := "../openmohaa"

# The GitHub Project linked to this repository.
project_owner := "MOHCentral"
project_number := "2"
project_repository := "MOHCentral/reveille"

# List the recipes.
default:
    @just --list

# ---------------------------------------------------------------------------
# Gates. `just check` is the repository gate, and CI runs exactly these recipes — one `ci-*` recipe
# per CI job, and nothing else. A job in `.github/workflows/ci.yml` may contain no check of its
# own: `tools/check-sources.mjs` rejects any `run:` step there that is not `just ci-…`, and
# requires the set of recipes CI names to equal the set `check` depends on. That is what makes
# "`just check` is what CI runs" a fact rather than a comment (issue #8).
#
# To add a check, add it to the relevant `ci-*` recipe below. Never to a workflow step.
# ---------------------------------------------------------------------------

# The whole gate, in the order that fails cheapest first.
check: fmt-check ci-sources ci-portable ci-windows

# --- The three CI jobs ------------------------------------------------------

# Repository-wide source policy and the frontend's own tests. Seconds long, platform-independent.
ci-sources: sources ui-test

# `reveille-core` and `reveille-cli` off Windows. See "Portability" below.
ci-portable: portable-test portable-lint fmt-check

# The whole workspace, including the Tauri shell, plus a real parse of what the webview loads.
ci-windows: test lint js-parse

# --- The legs themselves ----------------------------------------------------

# Apply the canonical formatting.
fmt:
    cargo fmt --all

# Fail if anything is unformatted.
fmt-check:
    cargo fmt --all --check

# The workspace lint gate. `-D warnings` is not negotiable; see CLAUDE.md.
lint:
    cargo clippy --workspace --all-targets --locked -- -D warnings

# The whole workspace, offline.
test:
    cargo test --workspace --locked

# Nothing else catches either of these: the frontend has no build step, so a syntax error there
# first shows up as a blank window, and no compiler enforces the licence header CLAUDE.md
# requires on every source file.

# Check SPDX headers, repository policy, and that every owned script parses.
sources:
    node --disable-warning=ExperimentalWarning tools/check-sources.mjs

# The shell's own unit suite. No npm install, no framework, no bundler: `node --test` over the
# production ES modules, with hand-written fakes for localStorage, the Tauri bridge and the DOM.
# The glob is quoted so Node expands it — `node --test <dir>` treats the path as a module to run.
ui-test:
    cd crates/reveille-app && node --test "ui-tests/**/*.test.js"

# Kept separate from `sources` deliberately: that script parses in-process so it can run in a
# restricted shell, and a policy script is not a parser.

# Node's own parser over each shell module.
js-parse:
    node tools/check-js-parse.mjs

# ---------------------------------------------------------------------------
# Supply-chain checks. These require separately installed tools and may use the network, so they
# are deliberately outside `just check`. CI runs them in the dedicated security workflow.
# ---------------------------------------------------------------------------

# Fetch RustSec and enforce the dependency source, duplicate, and licence baselines. The feature
# flag matches what the security workflow's action passes, so the two cannot disagree about a
# duplicate or licence that only a feature reaches.
dependency-security:
    cargo deny --all-features check advisories bans sources licenses

# Check workflow security plus YAML, expression, and embedded-shell correctness. The ignore is
# temporary: actionlint 1.7.12 predates GitHub's self-repository (`$/...`) syntax.
workflow-security:
    zizmor .
    actionlint -ignore "reusable workflow call.*ci\.yml"

# Run all network/tool-backed security maintenance checks.
security: dependency-security workflow-security

# ---------------------------------------------------------------------------
# Portability. `reveille-core` and `reveille-cli` must keep building and passing off Windows —
# that is what makes the deferred Linux and macOS builds deferred rather than precluded
# (docs/plan.md, "Cross-platform posture"). Running these on Windows will not prove a non-Windows
# target, but it does catch an accidental dependency on `reveille-platform` or on `winreg`.
# ---------------------------------------------------------------------------

# Test only the crates that must build off Windows.
portable-test:
    cargo test -p reveille-core -p reveille-cli --locked

# Lint only the crates that must build off Windows.
portable-lint:
    cargo clippy -p reveille-core -p reveille-cli --all-targets --locked -- -D warnings

# ---------------------------------------------------------------------------
# Live checks. Never part of `just check`: a network call must never reach a default test
# (CLAUDE.md). Each of these talks to a third party and can fail for reasons that are not bugs.
# ---------------------------------------------------------------------------

# Every #[ignore]d test at once.
live:
    cargo test --workspace --locked -- --ignored --nocapture

# Does the latest release still publish a digest-bearing archive for this host? Run it after any
# change to the asset selector or to the frozen release fixture.

# Live check against the official GitHub Releases API.
live-release:
    cargo test -p reveille-core --test live_openmohaa_release --locked -- --ignored --nocapture

# The GameSpy master and public UDP servers.
live-discovery:
    cargo test -p reveille-core --test live_discovery --locked -- --ignored --nocapture

# The third-party moh-db catalogue.
live-catalogue:
    cargo test -p reveille-core --test live_catalogue --locked -- --ignored --nocapture

# ---------------------------------------------------------------------------
# Project management.
# ---------------------------------------------------------------------------

# Requires `gh auth refresh -s project` once for the active GitHub CLI account.
# List every project item with the fields used to plan and sequence the work.
project-status:
    gh project item-list {{ project_number }} --owner {{ project_owner }} --limit 1000 --field Status --field Priority --field Size --field Area --field "Next action"

# Make active work visible before changing code.
project-start ISSUE:
    gh project item-edit {{ project_number }} --owner {{ project_owner }} --url "https://github.com/{{ project_repository }}/issues/{{ ISSUE }}" --field Status --value "In Progress"

# Keep the board's handoff instruction current.
project-next ISSUE NEXT_ACTION:
    gh project item-edit {{ project_number }} --owner {{ project_owner }} --url "https://github.com/{{ project_repository }}/issues/{{ ISSUE }}" --field "Next action" --text "{{ NEXT_ACTION }}"

# Preserve the next actionable step whenever work cannot continue.
project-block ISSUE NEXT_ACTION:
    gh project item-edit {{ project_number }} --owner {{ project_owner }} --url "https://github.com/{{ project_repository }}/issues/{{ ISSUE }}" --field "Next action" --text "{{ NEXT_ACTION }}"
    gh project item-edit {{ project_number }} --owner {{ project_owner }} --url "https://github.com/{{ project_repository }}/issues/{{ ISSUE }}" --field Status --value Blocked

# ---------------------------------------------------------------------------
# Running the thing.
# ---------------------------------------------------------------------------

# `frontendDist` is a static directory, so there is no dev server to start and no frontend build
# step: edit `crates/reveille-app/ui` and re-run.

# Run the Tauri shell.
app:
    cargo run -p reveille-app

# The shell as players get it. Slow to build; use it to check real timing and window behaviour.
app-release:
    cargo run -p reveille-app --release

# Produce the installer. Needs the npm dev dependency: `cd crates/reveille-app && npm install`.
bundle: notices
    cd crates/reveille-app && npm run tauri build -- --config notices.conf.json

# Write the attribution file the installer ships, and the packaging config that adds it to the
# bundle. Offline: it reads the locked graph and the licence files already in the cargo registry.
notices:
    node tools/third-party-notices.mjs

# Generate the updater key once; an empty password is valid, and the private key needs backup.
updater-key-generate KEY:
    cd crates/reveille-app && npm run tauri signer generate -- -w "{{ KEY }}"

# Build signed updater artifacts from KEY and its `.pub` sibling; set the password env var if used.
bundle-updater KEY:
    node tools/build-updater.mjs "{{ KEY }}"

# Update Cargo, Tauri and npm release identities together; VERSION must be newer SemVer.
bump-version VERSION *ARGS:
    node tools/bump-version.mjs "{{ VERSION }}" {{ ARGS }}

# Bump, gate, commit and tag a release in one step. Pushing the tag stays manual; that push is
# what starts the installer build. Add `--dry-run` to stop after validating, `--no-check` to skip
# the gate.
release VERSION *ARGS:
    node tools/release.mjs "{{ VERSION }}" {{ ARGS }}

# The headless pipeline. `just cli --help` lists the subcommands.
cli *ARGS:
    cargo run -p reveille-cli -- {{ ARGS }}

# Installations from the live Windows registry.
discover:
    cargo run -p reveille-cli -- discover

# Identify an install and index its maps. Add `--game spearhead` or `--game breakthrough` for an
# expansion's search path, which is its own directory over `main` rather than in place of it.
scan PATH *ARGS:
    cargo run -p reveille-cli -- scan "{{ PATH }}" {{ ARGS }}

# The whole journey against one server, stopping short of launching it. Add `--execute` to launch.
journey SERVER *ARGS:
    cargo run -p reveille-cli -- journey {{ SERVER }} {{ ARGS }}

# ---------------------------------------------------------------------------
# Engine ground truth. Every protocol constant in docs/engine-facts.md cites a line in this
# source; re-verify against it rather than against a previous claim (CLAUDE.md).
# ---------------------------------------------------------------------------

# Clone openmohaa, or fast-forward an existing checkout.
engine-source:
    git clone --depth 1 https://github.com/openmoh/openmohaa "{{ engine_source }}" || git -C "{{ engine_source }}" pull --ff-only

# Find where a constant or function actually comes from, with file:line to cite.
engine-grep PATTERN:
    git -C "{{ engine_source }}" grep -n -- "{{ PATTERN }}"
