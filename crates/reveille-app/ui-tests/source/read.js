// SPDX-License-Identifier: GPL-3.0-only

import { readFileSync } from "node:fs";

const CRATE = new URL("../../", import.meta.url);

/** The text of a file, by its path from `crates/reveille-app`. */
export function read(path) {
  return readFileSync(new URL(path, CRATE), "utf8");
}
