// SPDX-License-Identifier: GPL-3.0-only

// `lib/dom.js`: the element builder and the caret-preserving repaint.
//
// Two things here are contracts rather than conveniences.
//
// **Construction, not interpolation.** Nothing in this interface goes through `innerHTML`, so a
// server hostname or a map name — arbitrary bytes from a third party — can never become markup.
// The `String()` coercion in `append` is the escape boundary, and the tests below exercise it with
// a hostname that would be a script tag if it were ever interpolated.
//
// **Re-rendering must not steal the caret** (`docs/ui.md` §7). Replacing a subtree detaches
// whatever had focus, which silently breaks typing and arrow-key navigation. `preserveFocus` is
// the whole of the defence and had no test before this one.
//
// These run against `fakes/dom.js`, whose header says exactly what it models. Nothing here asserts
// layout, event bubbling, or ARIA/tabindex reflection — a fake cannot establish those, and
// pretending otherwise would hand back confidence it had not earned.

import test from "node:test";
import assert from "node:assert/strict";

import { installDom } from "../fakes/dom.js";

const document = installDom();
const dom = await import("../../ui/lib/dom.js");

test.beforeEach(() => {
  document.activeElement = null;
  document.body.replaceChildren();
});

/* The element builder ------------------------------------------------------- */

test("a reflected key becomes a property and an unreflected one becomes an attribute", () => {
  const node = dom.el("button", {
    className: "btn btn--primary",
    "aria-disabled": "true",
    colspan: 3,
  });
  // The `key in node` branch is the subtle part: `className` has to be assigned, or the class
  // would arrive as a literal `className=` attribute the stylesheet never matches.
  assert.equal(node.className, "btn btn--primary");
  assert.equal(node.getAttribute("aria-disabled"), "true");
  assert.equal(node.getAttribute("colspan"), "3");
});

test("a true-valued attribute is set to the empty string, as HTML spells a boolean", () => {
  assert.equal(dom.el("div", { "data-open": true }).getAttribute("data-open"), "");
});

test("null and undefined props are skipped rather than stringified", () => {
  const node = dom.el("div", { title: null, "aria-label": undefined });
  // Otherwise a conditional prop would render `title="null"`, which is a tooltip reading "null".
  assert.equal(node.getAttribute("aria-label"), null);
});

test("a dataset object is merged rather than set as one attribute", () => {
  const node = dom.el("tr", { dataset: { focusKey: "join", address: "10.0.0.1:12203" } });
  assert.equal(node.dataset.focusKey, "join");
  assert.equal(node.dataset.address, "10.0.0.1:12203");
});

test("an on* prop registers a listener instead of setting an attribute", () => {
  let clicks = 0;
  const node = dom.el("button", { onclick: () => (clicks += 1) });
  node.dispatch("click");
  assert.equal(clicks, 1);
  assert.equal(node.getAttribute("onclick"), null, "never an inline handler; the CSP forbids one");
});

test("a hostname from a server becomes text, never markup", () => {
  const hostile = '<img src=x onerror="alert(1)"> &amp; <b>bold</b>';
  const node = dom.el("span", null, hostile);
  // The `String()` coercion in `append` is the escape boundary. A hostname is arbitrary bytes
  // from a third party, and this is the whole reason the interface is constructed rather than
  // interpolated.
  assert.equal(node.children.length, 1);
  assert.equal(node.children[0], hostile, "stored as one text child, verbatim");
  assert.equal(node.text, hostile);
});

test("falsy children are skipped so `condition && el(...)` reads naturally", () => {
  const node = dom.el("div", null, null, undefined, false, "kept", 0);
  // `0` is a value, not an absence: a count of zero must still render.
  assert.deepEqual(node.children, ["kept", "0"]);
});

test("nested arrays of children are flattened", () => {
  const node = dom.el("div", null, ["a", ["b", ["c"]]], "d");
  assert.equal(node.text, "abcd");
});

test("fill replaces every child rather than appending to them", () => {
  const node = dom.el("div", null, "old");
  dom.fill(node, "new");
  assert.equal(node.text, "new");
});

test("frag returns siblings without a wrapper element", () => {
  const node = dom.el("div", null, dom.frag("a", dom.el("span", null, "b")));
  assert.equal(node.children.length, 2, "the fragment itself is not a child");
  assert.equal(node.text, "ab");
});

/* Re-rendering must not steal the caret (docs/ui.md §7) --------------------- */

/** A region holding one focusable control, as a repaint would rebuild it. */
function region(focusKey) {
  const parent = dom.el("div");
  const input = dom.el("input", { dataset: { focusKey } });
  parent.append(input);
  document.body.append(parent);
  return { parent, input };
}

test("focus and the text selection survive a repaint", () => {
  const { parent, input } = region("search");
  input.focus();
  input.selectionStart = 3;
  input.selectionEnd = 7;

  dom.preserveFocus(parent, () => {
    // What a repaint actually does: the old node is gone and a new one takes its place.
    dom.fill(parent, dom.el("input", { dataset: { focusKey: "search" } }));
  });

  const rebuilt = parent.children[0];
  assert.equal(document.activeElement, rebuilt, "the caret came back to the rebuilt control");
  assert.notEqual(rebuilt, input, "and it is genuinely a different element");
  // Restoring focus without the range would put the caret at the end and silently lose a
  // selection mid-edit, which is the half a regression would drop.
  assert.deepEqual(rebuilt.selectionRanges, [[3, 7]]);
});

test("a repaint with nothing focused inside the region touches no focus", () => {
  const { parent } = region("search");
  const outside = dom.el("input", { dataset: { focusKey: "elsewhere" } });
  document.body.append(outside);
  outside.focus();

  dom.preserveFocus(parent, () => dom.fill(parent, dom.el("input", { dataset: { focusKey: "search" } })));

  // Stealing focus *into* the repainted region would be as bad as losing it.
  assert.equal(document.activeElement, outside);
});

test("a control that opted out of preservation does not get the caret back", () => {
  const parent = dom.el("div");
  const plain = dom.el("input");
  parent.append(plain);
  document.body.append(parent);
  plain.focus();

  dom.preserveFocus(parent, () => dom.fill(parent, dom.el("input")));

  // Preservation is opt-in through `data-focus-key`, because an element with no stable identity
  // across a repaint has nothing to be matched back to.
  assert.equal(parent.children[0].focusCount, 0);
});

test("a control that did not come back is not resurrected", () => {
  const { parent, input } = region("detail-recheck");
  input.focus();
  // The control genuinely disappeared — a Check button on a row the repaint dropped. There is
  // nothing to restore to, and `preserveFocus` must not throw trying.
  assert.doesNotThrow(() =>
    dom.preserveFocus(parent, () => dom.fill(parent, dom.el("p", null, "gone"))),
  );
});

test("an input whose type forbids a selection range still gets the focus", () => {
  const { parent, input } = region("choice");
  input.focus();
  input.selectionStart = 0;
  input.selectionEnd = 0;

  dom.preserveFocus(parent, () => {
    const rebuilt = dom.el("input", { dataset: { focusKey: "choice" } });
    // A radio or a checkbox throws on `setSelectionRange`. Losing the focus over that would be a
    // keyboard trap on the one control the player is being asked to use (the map-source radios).
    rebuilt.selectionForbidden = true;
    dom.fill(parent, rebuilt);
  });

  assert.equal(document.activeElement, parent.children[0]);
});

test("a focus key carrying selector punctuation is escaped, not injected", () => {
  // Focus keys are built from data: `choice-${mapName}-${candidateId}`, and a map name is a
  // third-party string. Without escaping, one containing a quote would break out of the attribute
  // selector — the same class of bug as interpolating markup.
  const { parent, input } = region('choice-dm/a"b-7');
  input.focus();
  dom.preserveFocus(parent, () =>
    dom.fill(parent, dom.el("input", { dataset: { focusKey: 'choice-dm/a"b-7' } })),
  );
  assert.equal(document.activeElement, parent.children[0]);
});
