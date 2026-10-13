// SPDX-License-Identifier: GPL-3.0-only

// The screenshot viewer: one entry's screenshots over the whole window, uncropped.
//
// It never enlarges a screenshot past its own pixels: moh-db's are mostly 800×600 or 1024×768, and
// stretching them only blurs. Actual size is offered only while the window shows one smaller.
// Which screenshot is shown lives in `state.content.shown`, so the detail pane follows the viewer.

import { el, fill, preserveFocus } from "../../lib/dom.js";
import { icon } from "../../lib/icons.js";
import { state } from "../../lib/store.js";

/** How far a press may travel and still be a click rather than a drag, in CSS pixels. */
const CLICK_SLOP = 4;

/**
 * The scroll offset along one axis that keeps the point under the pointer still when an image
 * goes from fitted to actual size: `fraction` is where the pointer was across the fitted image,
 * `start` where the actual-size image begins in the unscrolled stage, `size` its length, and
 * `pointer` the pointer's offset from the stage's edge.
 */
export function scrollToKeep(fraction, start, size, pointer) {
  return Math.max(0, start + fraction * size - pointer);
}

export function screenshotViewer({ controller }) {
  /** The entry shown, or null while closed. */
  let openId = null;
  let actual = false;
  let paintedShot = null;
  let paintedStrip = null;
  let drag = null;
  let dragged = false;

  const title = el("h2", { className: "display heading-sm viewer__title", id: "viewer-title" });
  const count = el("span", { className: "viewer__count data" });
  const zoom = el("button", { type: "button", className: "btn viewer__zoom", onclick: () => toggleZoom() });
  const close = el(
    "button",
    { type: "button", className: "btn btn--icon viewer__close", "aria-label": "Close", title: "Close (Esc)", onclick: () => dialog.close() },
    icon("close", { outline: true }),
  );
  const stage = el("div", {
    className: "viewer__stage",
    onclick: onStageClick,
    onpointerdown: onPointerDown,
    onpointermove: onPointerMove,
    onpointerup: endDrag,
    onpointercancel: endDrag,
    onpointerleave: endDrag,
  });
  const previous = el(
    "button",
    { type: "button", className: "viewer__step viewer__step--previous", "aria-label": "Previous screenshot", title: "Previous (←)", onclick: () => step(-1) },
    "‹",
  );
  const next = el(
    "button",
    { type: "button", className: "viewer__step viewer__step--next", "aria-label": "Next screenshot", title: "Next (→)", onclick: () => step(1) },
    "›",
  );
  const strip = el("div", { className: "viewer__strip", role: "group", "aria-label": "Screenshots" });
  const dialog = el(
    "dialog",
    {
      className: "viewer",
      "aria-labelledby": "viewer-title",
      onkeydown: onKey,
      onclose: () => {
        openId = null;
        paintedShot = null;
        paintedStrip = null;
        fill(stage);
        fill(strip);
      },
    },
    el("div", { className: "viewer__head" }, title, count, el("span", { className: "viewer__tools" }, zoom, close)),
    el("div", { className: "viewer__body" }, stage, previous, next),
    strip,
  );
  document.body.append(dialog);
  window.addEventListener("resize", () => {
    if (openId !== null) paintZoom();
  });

  function shownItem() {
    return openId === null ? null : (state.content.items.find((item) => item.id === openId) ?? null);
  }

  function shownIndex(item) {
    return Math.min(state.content.shown.get(item.id) ?? 0, Math.max(0, item.image_count - 1));
  }

  /** Open on the screenshot the detail pane shows. Does nothing for an entry with none. */
  function open(item) {
    if (!item?.image_count) return;
    openId = item.id;
    actual = false;
    paintedShot = null;
    paintedStrip = null;
    for (let index = 0; index < item.image_count; index += 1) controller.requestImage(item, index);
    render();
    if (!dialog.open) dialog.showModal();
    close.focus();
  }

  function step(delta) {
    const item = shownItem();
    if (!item) return;
    actual = false;
    controller.showImage(item, delta);
  }

  function render() {
    if (!dialog.open && openId === null) return;
    const item = shownItem();
    if (!item) {
      // A new search or tab replaced the entry under the viewer.
      if (dialog.open) dialog.close();
      return;
    }
    const index = shownIndex(item);
    const images = Array.from({ length: item.image_count }, (_, at) => state.content.images.get(`${item.id}:${at}`));
    // The shot and the strip repaint apart: the strip's previews landing must not undo a zoom.
    const shot = JSON.stringify([item.id, index, imageState(images[index])]);
    if (shot !== paintedShot) {
      paintedShot = shot;
      paintShot(item, index, images[index]);
    }
    const picks = JSON.stringify([item.id, index, images.map(imageState)]);
    if (picks !== paintedStrip) {
      paintedStrip = picks;
      paintStrip(item, index, images);
    }
  }

  function paintShot(item, index, image) {
    title.textContent = item.title;
    count.textContent = `${index + 1} of ${item.image_count}`;
    const several = item.image_count > 1;
    for (const part of [previous, next, strip]) part.classList.toggle("hidden", !several);

    actual = false;
    if (ready(image)) {
      const img = el("img", { className: "viewer__image", src: image, alt: `${item.title}, screenshot ${index + 1} of ${item.image_count}`, draggable: false });
      img.addEventListener("load", paintZoom);
      fill(stage, img);
    } else {
      fill(stage, el("p", { className: "viewer__note" }, image === "failed" ? "This screenshot did not load." : "Loading the screenshot…"));
    }
    paintZoom();
  }

  function paintStrip(item, index, images) {
    if (item.image_count < 2) return;
    preserveFocus(strip, () =>
      fill(
        strip,
        images.map((shot, at) =>
          el(
            "button",
            {
              type: "button",
              className: "viewer__pick thumb",
              "aria-label": `Screenshot ${at + 1}`,
              "aria-current": at === index ? "true" : null,
              dataset: { focusKey: `shot-${at}` },
              onclick: () => {
                actual = false;
                controller.showImageAt(item, at);
              },
            },
            ready(shot) ? el("img", { src: shot, alt: "", draggable: false }) : null,
          ),
        ),
      ),
    );
  }

  /** Whether the shown screenshot is drawn smaller than its own pixels when fitted. */
  function zoomable() {
    const img = stage.querySelector("img");
    if (!img?.complete || !img.naturalWidth) return false;
    if (actual) return true;
    return img.clientWidth < img.naturalWidth || img.clientHeight < img.naturalHeight;
  }

  function paintZoom() {
    // The class first: whether a zoom is possible is measured on the fitted layout.
    dialog.classList.toggle("viewer--actual", actual);
    const can = zoomable();
    stage.classList.toggle("viewer__stage--zoomable", can);
    zoom.disabled = !can;
    zoom.textContent = actual ? "Fit to window" : "Actual size";
    zoom.title = can ? "Or click the screenshot" : "The screenshot already shows at its actual size";
  }

  /** Switch between fitted and actual size, keeping the point at (`x`, `y`) under the pointer. */
  function toggleZoom(x = null, y = null) {
    const img = stage.querySelector("img");
    if (!img || !zoomable()) return;
    const before = img.getBoundingClientRect();
    const box = stage.getBoundingClientRect();
    const pointX = x ?? box.left + box.width / 2;
    const pointY = y ?? box.top + box.height / 2;
    const fractionX = (pointX - before.left) / before.width;
    const fractionY = (pointY - before.top) / before.height;
    actual = !actual;
    paintZoom();
    if (!actual) return;
    stage.scrollLeft = 0;
    stage.scrollTop = 0;
    const after = img.getBoundingClientRect();
    stage.scrollLeft = scrollToKeep(clamp(fractionX), after.left - box.left, after.width, pointX - box.left);
    stage.scrollTop = scrollToKeep(clamp(fractionY), after.top - box.top, after.height, pointY - box.top);
  }

  function onStageClick(event) {
    if (dragged) {
      dragged = false;
      return;
    }
    // A click beside the screenshot closes, as a click on a backdrop does.
    if (event.target === stage) dialog.close();
    else if (event.target.matches?.("img")) toggleZoom(event.clientX, event.clientY);
  }

  function onPointerDown(event) {
    if (!actual || event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    dragged = false;
  }

  function onPointerMove(event) {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!dragged && Math.hypot(dx, dy) < CLICK_SLOP) return;
    dragged = true;
    stage.classList.add("viewer__stage--dragging");
    stage.scrollLeft = drag.left - dx;
    stage.scrollTop = drag.top - dy;
  }

  function endDrag() {
    drag = null;
    stage.classList.remove("viewer__stage--dragging");
  }

  function onKey(event) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      step(event.key === "ArrowLeft" ? -1 : 1);
    }
  }

  return { open, render };
}

function ready(image) {
  return typeof image === "string" && image.startsWith("data:");
}

function imageState(image) {
  return ready(image) ? "ready" : (image ?? "none");
}

function clamp(fraction) {
  return Math.min(1, Math.max(0, fraction));
}
