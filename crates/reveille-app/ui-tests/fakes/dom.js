// SPDX-License-Identifier: GPL-3.0-only

// A small, honest DOM — enough to run `lib/dom.js`, and no more.
//
// **Why not jsdom.** This repository's entire npm surface is one devDependency (`@tauri-apps/cli`,
// which builds the installer). jsdom is roughly a hundred transitive packages, and it would
// immediately become a supply-chain question for issue #10 — a large answer to a small problem.
// `dom.js` is 88 lines and touches a countable set of DOM features, listed below.
//
// **What this models.** `createElement`, `createDocumentFragment`, `activeElement`, `Node`,
// `CSS.escape`, and per element: `append`, `replaceChildren`, `setAttribute`, `addEventListener`,
// `dataset`, `classList`, `querySelector`, `contains`, `focus`, `setSelectionRange`, `textContent`, and the
// reflected properties `el()` distinguishes by `key in node`.
//
// **What it does not model, and therefore what must not be tested against it.** Layout, styles,
// event dispatch and bubbling, real focus semantics, and — importantly — the ARIA and tabindex
// reflection that `views/servers.js`'s one-tab-stop behaviour depends on. A fake that approximated
// those would hand back confidence it had not earned, so those behaviours stay guarded by the
// source-text tests in `main.rs` (see `docs/rules.md`, "Known gaps").
//
// The `key in node` branch in `el()` is the subtle one: `className` must be a property and
// `aria-label` must not, or the builder would put the wrong things in the wrong place. REFLECTED
// below is that boundary, written down.

/** Properties a real `HTMLElement` reflects, which `el()` therefore assigns rather than sets. */
const REFLECTED = [
  "className",
  "textContent",
  "value",
  "checked",
  "disabled",
  "id",
  "title",
  "type",
  "name",
  "tabIndex",
  "selectionStart",
  "selectionEnd",
];

class FakeNode {}

class FakeElement extends FakeNode {
  constructor(tag, ownerDocument) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.focusCount = 0;
    this.selectionRanges = [];
    for (const key of REFLECTED) this[key] = undefined;
    this.textContent = "";
    this.classList = {
      add: (...names) => this.#setClasses(names, true),
      remove: (...names) => this.#setClasses(names, false),
      contains: (name) => this.#classes().has(name),
      toggle: (name, force) => {
        const enabled = force === undefined ? !this.#classes().has(name) : Boolean(force);
        this.#setClasses([name], enabled);
        return enabled;
      },
    };
  }

  #classes() {
    return new Set(String(this.className ?? "").split(/\s+/u).filter(Boolean));
  }

  #setClasses(names, enabled) {
    const classes = this.#classes();
    for (const name of names) {
      if (enabled) classes.add(name);
      else classes.delete(name);
    }
    this.className = [...classes].join(" ");
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof FakeFragment) {
        this.append(...node.drain());
        continue;
      }
      if (node instanceof FakeNode) node.parentNode = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    for (const child of this.children) {
      if (child instanceof FakeNode) child.parentNode = null;
    }
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  /** Call the handlers registered for `type`. No bubbling — see the header. */
  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  contains(node) {
    for (let at = node; at; at = at.parentNode) {
      if (at === this) return true;
    }
    return false;
  }

  focus() {
    this.focusCount += 1;
    this.ownerDocument.activeElement = this;
  }

  setSelectionRange(start, end) {
    if (this.selectionForbidden) throw new Error("selection is not supported on this input");
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionRanges.push([start, end]);
  }

  /**
   * Only the one selector shape `dom.js` uses: `[data-focus-key="…"]`.
   *
   * Anything else throws rather than silently returning null, so a test that outgrows this fake
   * says so instead of quietly passing.
   *
   * The quoted value is scanned rather than matched with a lazy regex, because the escaping is
   * the point. A real `querySelector` throws `SyntaxError` on a selector whose quoted value
   * contains an unescaped quote — so a caller that stopped escaping its key would break the
   * repaint outright, and a fake that quietly matched anyway would hide that.
   */
  querySelector(selector) {
    const prefix = '[data-focus-key="';
    if (!selector.startsWith(prefix)) {
      throw new Error(`fakes/dom.js models only [data-focus-key="…"], not ${selector}`);
    }
    let wanted = "";
    let at = prefix.length;
    for (; at < selector.length; at += 1) {
      const c = selector[at];
      if (c === "\\") {
        at += 1;
        wanted += selector[at];
      } else if (c === '"') {
        break;
      } else {
        wanted += c;
      }
    }
    if (selector.slice(at) !== '"]') {
      throw new SyntaxError(`'${selector}' is not a valid selector`);
    }
    const walk = (node) => {
      for (const child of node.children) {
        if (!(child instanceof FakeElement)) continue;
        if (child.dataset.focusKey === wanted) return child;
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }

  /** Test-side: the element's text, descendants included. */
  get text() {
    return this.children
      .map((child) => (child instanceof FakeElement ? child.text : String(child)))
      .join("");
  }
}

class FakeFragment extends FakeNode {
  constructor() {
    super();
    this.children = [];
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof FakeFragment) this.append(...node.drain());
      else this.children.push(node);
    }
  }

  drain() {
    const nodes = this.children;
    this.children = [];
    return nodes;
  }
}

/**
 * Install a fresh document on `globalThis` and return it.
 *
 * The returned object carries `activeElement`, which `preserveFocus` reads, and `body`, a plain
 * element tests can build regions inside.
 */
export function installDom() {
  const document = {
    activeElement: null,
    createElement(tag) {
      return new FakeElement(tag, document);
    },
    createDocumentFragment() {
      return new FakeFragment();
    },
    querySelector() {
      throw new Error("fakes/dom.js does not model document-level queries");
    },
  };
  document.body = new FakeElement("body", document);
  globalThis.document = document;
  globalThis.Node = FakeNode;
  // `preserveFocus` escapes the focus key before putting it in a selector. The real `CSS.escape`
  // is specified; this covers what a focus key can contain in this interface.
  const NEEDS_ESCAPE = new Set(['"', "\\", "]"]);
  globalThis.CSS = {
    escape: (value) =>
      [...String(value)].map((c) => (NEEDS_ESCAPE.has(c) ? "\\" + c : c)).join(""),
  };
  return document;
}

export { FakeElement, FakeFragment };
