// SPDX-License-Identifier: GPL-3.0-only

// Inline SVG icons. Drawn on a 16-unit grid in `currentColor`, so each takes the colour and size
// of the text around it; emoji and font glyphs render differently on every Windows build.

const SVG = "http://www.w3.org/2000/svg";

const PATHS = {
  bot: "M8 1.5a.9.9 0 0 1 .9.9V4h2.6A2.5 2.5 0 0 1 14 6.5v5a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 2 11.5v-5A2.5 2.5 0 0 1 4.5 4h2.6V2.4a.9.9 0 0 1 .9-.9ZM5.8 7.2a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Zm4.4 0a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2ZM5.5 11h5v1h-5z",
  star: "M8 1.2l2.1 4.3 4.7.7-3.4 3.3.8 4.7L8 12l-4.2 2.2.8-4.7L1.2 6.2l4.7-.7Z",
  bell: "M8 1.5a1 1 0 0 1 1 1v.6A4.5 4.5 0 0 1 12.5 7.5v2.8l1.3 1.9a.6.6 0 0 1-.5.9H2.7a.6.6 0 0 1-.5-.9l1.3-1.9V7.5A4.5 4.5 0 0 1 7 3.1v-.6a1 1 0 0 1 1-1ZM6.3 14h3.4a1.7 1.7 0 0 1-3.4 0Z",
  list: "M2 3.2h12v1.6H2Zm0 4h12v1.6H2Zm0 4h12v1.6H2Z",
  clock: "M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Zm0 1.6a4.9 4.9 0 1 0 0 9.8 4.9 4.9 0 0 0 0-9.8Zm-.8 1.4h1.6v3.2l2.3 1.4-.8 1.4-3.1-1.9Z",
  gear: "M13.11 6.24L15.02 6.38L15.02 9.62L13.11 9.76L12.85 10.37L14.11 11.82L11.82 14.11L10.37 12.85L9.76 13.11L9.62 15.02L6.38 15.02L6.24 13.11L5.63 12.85L4.18 14.11L1.89 11.82L3.15 10.37L2.89 9.76L0.98 9.62L0.98 6.38L2.89 6.24L3.15 5.63L1.89 4.18L4.18 1.89L5.63 3.15L6.24 2.89L6.38 0.98L9.62 0.98L9.76 2.89L10.37 3.15L11.82 1.89L14.11 4.18L12.85 5.63ZM10.4 8a2.4 2.4 0 1 0-4.8 0 2.4 2.4 0 1 0 4.8 0Z",
  dots: "M3 6.6a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8Zm5 0a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8Zm5 0a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8Z",
  download: "M8 1.5a.9.9 0 0 1 .9.9v6.4l2.1-2.1a.9.9 0 1 1 1.3 1.3L8.6 11.7a.9.9 0 0 1-1.2 0L3.7 8a.9.9 0 1 1 1.3-1.3l2.1 2.1V2.4a.9.9 0 0 1 .9-.9ZM2.5 13h11a.8.8 0 0 1 0 1.6h-11a.8.8 0 0 1 0-1.6Z",
};

/**
 * One icon. `outline` draws the shape as a stroke instead of a fill, which is how an unset star
 * or bell reads as "off" without a second glyph. Always `aria-hidden`: the control or cell that
 * holds it carries the accessible name.
 */
export function icon(name, { outline = false, className = null } = {}) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", ["icon", `icon--${name}`, className].filter(Boolean).join(" "));
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", PATHS[name]);
  if (outline) {
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.3");
    path.setAttribute("stroke-linejoin", "round");
  } else {
    path.setAttribute("fill", "currentColor");
    // Holes — the gear's hub, the bot's eyes, the clock's face — are cut by inner subpaths.
    path.setAttribute("fill-rule", "evenodd");
  }
  svg.append(path);
  return svg;
}
