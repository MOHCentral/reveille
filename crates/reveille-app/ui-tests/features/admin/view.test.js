// SPDX-License-Identifier: GPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";

import { installDom } from "../../fakes/dom.js";
import { installStorage } from "../../fakes/storage.js";

installDom();
installStorage();
const { withoutColours } = await import("../../../ui/features/admin/view.js");

test("the console drops the game's colour codes and keeps every other caret", () => {
  assert.equal(withoutColours('"sv_hostname" is:"^1Red^7 Base^7"'), '"sv_hostname" is:"Red Base"');
  assert.equal(withoutColours("2^x stays"), "2^x stays");
});
