# Dependency security and licence policy

The locked dependency graph is checked separately from the offline default test gate. Pull
requests and a weekly schedule run `cargo deny check advisories bans sources licenses`; the
schedule is what catches a newly published RustSec advisory when no source file changed. Unknown
registries, all Git dependencies, yanked crates, duplicate versions not recorded in `deny.toml`,
and licences outside the allowlist fail that check. Path-only requirements between workspace
crates are allowed. `just dependency-security` runs the same four checks locally.

The duplicate exceptions are an audited baseline, not a general permission for duplicates. They
are exact older versions retained by Tauri's cross-platform dependency graph. The newest resolved
version is deliberately not skipped, so adding another generation fails. A dependency update that
removes an exception must remove the now-unused entry from `deny.toml`.

## Licence decision

**Decided 19 September 2026: Reveille is GPL-3.0-only.** It was GPL-2.0-only until that date.

The 19 September 2026 audit used Cargo.lock and cargo-deny 0.20.2. Its 550 packages declare 32
distinct SPDX expressions and none lack licence metadata. Most offer MIT, BSD, ISC, Zlib,
Unicode-3.0, or another permissive choice, but five crates offer only Apache-2.0 terms:

| Expression | Packages |
| --- | --- |
| `Apache-2.0` | `sync_wrapper 1.0.2`, `tao 0.35.3`, `zopfli 0.8.3` |
| `Apache-2.0 AND ISC` | `ring 0.17.14` |
| `Apache-2.0 AND MIT` | `dpi 0.1.2` |

Apache-2.0 imposes patent-termination and indemnity conditions that GPL-2.0-only cannot accept,
and the FSF records the two as incompatible. This was not avoidable by swapping a dependency:
`tao` is the windowing layer beneath Tauri, `ring` is the TLS backend, and `zopfli` compresses
what the installer writes. `cargo tree -i` confirmed all five are compiled into the shipped
application rather than used only at build time. Apache-2.0 is, however, compatible in one
direction with GPL-3.0, so the licence of Reveille's own code is what had to move.

Relicensing was available because Reveille's code is the project owner's own. The OpenMoHAA
sources cited beside protocol constants are GPL-2.0-or-later, which permits GPLv3, and no
OpenMoHAA file is bundled or linked: Reveille starts the engine as a separate program.

The other expressions that needed review are compatible as they stand. MPL-2.0 (`cssparser`,
`selectors`, `dtoa-short`, `option-ext`) allows the larger work to be distributed under this
project's licence while those files remain under MPL-2.0. `CDLA-Permissive-2.0` (`webpki-roots`)
is permissive and covers certificate data rather than code. `Apache-2.0 WITH LLVM-exception`
(`target-lexicon`) carries an exception written for exactly this kind of combination.

`deny.toml` now enforces that decision as an allowlist of the licences the combined application
may distribute. It lists the minimum the current graph needs, so a licence that is merely one
option among several a crate offers is absent, and `unused-allowed-license = "deny"` fails the
check when an allowance stops being needed. Widening the list is a change to the decision above
and belongs in this document first.

## Attribution

The permissive licences require their notices to travel with the binary. `just notices` writes
`crates/reveille-app/THIRD-PARTY-NOTICES.md` from the locked graph — the 285 components the
Windows application actually links, not the build-time tooling — and `bundle.resources` installs
it beside the executable. The bundler fails when the file is absent, so a release cannot ship
without it.

This document records technical inventory and policy state, not legal advice.
