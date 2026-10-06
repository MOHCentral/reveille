// SPDX-License-Identifier: GPL-3.0-only

// `lib/store.js`: one state object, and one notification per update.

import test from "node:test";
import assert from "node:assert/strict";

const store = await import("../../ui/lib/store.js");

test("update mutates and then notifies exactly once", () => {
  let notified = 0;
  const unsubscribe = store.subscribe(() => (notified += 1));
  store.update((next) => {
    next.selected = "a:1";
    next.joining = true;
  });
  assert.equal(notified, 1);
  assert.equal(store.state.selected, "a:1");
  unsubscribe();
  store.update(() => {});
  assert.equal(notified, 1, "an unsubscribed handler is not called again");
});
