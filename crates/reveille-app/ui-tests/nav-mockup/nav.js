// SPDX-License-Identifier: GPL-3.0-only

const params = new URLSearchParams(location.search);
const section = params.get("section") ?? "servers";
const admin = params.get("admin") === "1";

await import("../preview/preview.js");
const sheet = document.createElement("link");
sheet.rel = "stylesheet";
sheet.href = new URL("nav.css", import.meta.url).href;
document.head.append(sheet);
const until = async (test) => { while (!test()) await new Promise((r) => setTimeout(r, 50)); };
await until(() => document.querySelector(".toolbar") && document.querySelector("tbody tr") && document.querySelector(".statusbar"));
await new Promise((r) => setTimeout(r, 300));

const S = (d, fill = false) =>
  `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${d}" ${fill ? 'fill="currentColor" fill-rule="evenodd"' : 'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"'}/></svg>`;
const ICON = {
  servers: S("M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2ZM8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6ZM8 .5v3M8 12.5v3M.5 8h3M12.5 8h3"),
  maps: S("M8 1.5l6 3v7l-6 3-6-3v-7l6-3ZM2 4.5l6 3 6-3M8 7.5v7"),
  admin: S("M2 2.5h12a.5.5 0 0 1 .5.5v10a.5.5 0 0 1-.5.5H2a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5ZM4.5 6l2 2-2 2M8.5 10.5h3"),
  gear: S("M13.11 6.24L15.02 6.38L15.02 9.62L13.11 9.76L12.85 10.37L14.11 11.82L11.82 14.11L10.37 12.85L9.76 13.11L9.62 15.02L6.38 15.02L6.24 13.11L5.63 12.85L4.18 14.11L1.89 11.82L3.15 10.37L2.89 9.76L0.98 9.62L0.98 6.38L2.89 6.24L3.15 5.63L1.89 4.18L4.18 1.89L5.63 3.15L6.24 2.89L6.38 0.98L9.62 0.98L9.76 2.89L10.37 3.15L11.82 1.89L14.11 4.18L12.85 5.63ZM10.4 8a2.4 2.4 0 1 0-4.8 0 2.4 2.4 0 1 0 4.8 0Z", true),
};
const item = (key, label, extra = "") =>
  `<button type="button" class="rail__item" ${key === section ? 'aria-current="page"' : ""} title="${label} (Ctrl+Shift+${{ servers: 1, maps: 2, admin: 3 }[key] ?? ""})">${ICON[key]}<span>${label}</span>${extra}</button>`;

const shell = document.querySelector("#shell");
const top = params.get("nav") === "top";
if (top) {
  const tabs = document.createElement("nav");
  tabs.className = "sections";
  tabs.setAttribute("aria-label", "Sections");
  const tab = (key, label, extra = "") =>
    `<button type="button" class="sections__tab" ${key === section ? 'aria-current="page"' : ""}>${label}${extra}</button>`;
  tabs.innerHTML = tab("servers", "Servers") +
    tab("maps", "Maps &amp; mods", downloadingTop() ? '<span class="sections__dl" title="1 download, 62%"><span></span></span>' : "") +
    (admin ? tab("admin", "Admin") : "");
  document.querySelector(".game-switch").after(tabs);
}
function downloadingTop() { return section !== "servers" || params.has("dl"); }
if (!top) {
shell.classList.add("with-rail");
const rail = document.createElement("nav");
rail.className = "rail";
rail.setAttribute("aria-label", "Sections");
const downloading = section !== "servers" || params.has("dl");
rail.innerHTML = [
  item("servers", "Servers"),
  item("maps", "Maps<br>&amp; mods", downloading ? '<span class="rail__progress"><span></span></span>' : ""),
  admin ? item("admin", "Admin") : "",
  '<span class="rail__spacer"></span>',
  `<button type="button" class="rail__item" title="Settings">${ICON.gear}<span>Settings</span></button>`,
].join("");
shell.insertBefore(rail, shell.children[1]);
document.querySelector("#settings-btn").remove();
}

if (params.has("select")) {
  document.querySelectorAll("table.servers tbody tr")[Number(params.get("select"))].click();
}

const toolbar = document.querySelector(".toolbar");
const list = document.querySelector(".split > :first-child");
const detail = document.querySelector("#detail-slot");
const status = document.querySelector(".statusbar");
const scope = (items) =>
  `<div class="scope" role="group">${items
    .map(([label, count, on]) => `<button type="button" class="scope__option" aria-pressed="${!!on}"><span class="scope__label">${label}</span><span class="scope__count data">${count ?? ""}</span></button>`)
    .join("")}</div>`;
const search = (text) =>
  `<label class="field toolbar__search"><span class="field__icon" aria-hidden="true">⌕</span><input type="search" placeholder="${text}"></label>`;
const pane = `<div class="toolbar__action"><button type="button" class="btn btn--icon toolbar__pane" aria-pressed="true"><span class="toolbar__pane-glyph"></span></button></div>`;

const grid = params.get("view") === "grid";
const LAYOUT = {
  list: "M2 3h12v2H2Zm0 4h12v2H2Zm0 4h12v2H2Z",
  grid: "M2 2h5v5H2Zm7 0h5v5H9ZM2 9h5v5H2Zm7 0h5v5H9Z",
};
const layoutSwitch = `<div class="scope layout-switch" role="group" aria-label="Layout">${["list", "grid"]
  .map((k) => `<button type="button" class="scope__option" aria-pressed="${(k === "grid") === grid}" title="${k === "list" ? "List" : "Cards"}"><svg viewBox="0 0 16 16" class="icon scope__icon" aria-hidden="true"><path d="${LAYOUT[k]}" fill="currentColor"/></svg></button>`)
  .join("")}</div>`;
if (section === "maps") {
  toolbar.innerHTML = `${scope([["Maps", "1,240", 1], ["Mods", "86"], ["Installed", "37"]])}
    ${search("Search maps and mods on moh-db")}
    <div class="filters"><button class="filter-chip">Mode ▾</button><button class="filter-chip filter-chip--on">Played now</button><button class="filter-chip">Most played ▾</button></div>
    <span class="toolbar__spacer"></span>${layoutSwitch}${pane}`;
  const rows = [
    ["Snipertown", "dm/snipertown · 2 files", "14.2 MB", [1, 6], "install", "linear-gradient(160deg,#a59a7c 0 40%,#6a5d44 41%)", true],
    ["Rock Bound", "dm/dm_rockbound · 4 files", "31.8 MB", [1, 1], "progress", "linear-gradient(160deg,#7c8c99 0 45%,#3f4a3a 46%)"],
    ["Freeze Tag", "Mod · freezetag", "3.1 MB", [2, 26], "installed", "linear-gradient(160deg,#c8d6e0 0 50%,#7d95a8 51%)", false, true],
    ["V2 Rocket Facility", "obj/m5l1a · 1 file", "22.5 MB", [1, 1], "install", "linear-gradient(160deg,#5b5f63 0 35%,#2e3236 36%)"],
    ["Zombie Bridge", "dm/zombie_bridge · 1 file", "9.6 MB", [1, 5], "install", "linear-gradient(160deg,#4d5a3d 0 55%,#262b1f 56%)"],
    ["Stalingrad Winter", "obj/obj_stalingrad_w · 3 files", "18.4 MB", null, "install", "linear-gradient(160deg,#dfe3e6 0 42%,#8b8f8f 43%)"],
    ["Bridge Assault", "dm/bridge_assault · 1 file", "9.7 MB", null, "installed", "linear-gradient(160deg,#9aa8b0 0 38%,#55603f 39%)"],
    ["Destroyed Village Night", "obj/obj_village_n · 2 files", "12.0 MB", null, "install", "linear-gradient(160deg,#1f2a3a 0 50%,#141a22 51%)"],
    ["Realism Pack", "Mod · realism", "41.0 MB", null, "install", "linear-gradient(160deg,#6b5a3a 0 50%,#3b3020 51%)", false, true],
  ];
  const action = (kind) =>
    kind === "install" ? '<button class="btn btn--sm">Install</button>'
    : kind === "installed" ? '<span class="state-installed">✓ Installed</span>'
    : '<span class="row-progress"><span>19.7 of 31.8 MB</span><span class="meter"><span class="meter__fill" style="width:62%"></span></span></span>';
  const liveText = (live) => live ? `<span class="live"><span class="ping-dot ping-dot--good"></span>${live[0]} server${live[0] > 1 ? "s" : ""} · ${live[1]} player${live[1] > 1 ? "s" : ""}</span>` : '<span class="quiet">Not on a server now</span>';
  if (grid) list.innerHTML = `<div class="list-pane"><div class="cards">${rows
    .map(([name, sub, size, live, kind, g, sel, mod]) => `<div class="card" ${sel ? 'aria-selected="true"' : ""}>
      <span class="card__thumb" style="--g:${g}">${mod ? '<span class="kind-tag">MOD</span>' : ""}</span>
      <div class="card__body"><span class="item-name">${name}</span><span class="item-sub">${sub}</span>
      <div class="card__live">${liveText(live)}</div>
      <div class="card__foot"><span class="data quiet">${size}</span>${action(kind)}</div></div></div>`)
    .join("")}</div></div>`;
  else list.innerHTML = `<div class="list-pane"><table class="catalog"><thead><tr><th></th><th>Name</th><th class="num">Size</th><th>On servers now</th><th></th></tr></thead><tbody>${rows
    .map(([name, sub, size, live, kind, g, sel, mod]) => `<tr ${sel ? 'aria-selected="true"' : ""}>
      <td class="c-thumb"><span class="thumb" style="--g:${g}"></span></td>
      <td><span class="item-name">${name}</span>${mod ? '<span class="kind-tag">MOD</span>' : ""}<span class="item-sub">${sub}</span></td>
      <td class="num data">${size}</td>
      <td>${live ? `<span class="live"><span class="ping-dot ping-dot--good"></span>${live[0]} server${live[0] > 1 ? "s" : ""} · ${live[1]} player${live[1] > 1 ? "s" : ""}</span>` : '<span class="quiet">—</span>'}</td>
      <td class="c-action">${action(kind)}</td></tr>`)
    .join("")}</tbody></table></div>`;
  detail.innerHTML = `<div class="detail-pane__scroll">
    <div class="pane-block"><div class="preview"><span>1 of 6 screenshots</span></div>
      <h2 class="display pane-title">Snipertown</h2>
      <div class="pane-sub">Custom map by <a class="ext-link" href="#">Dr. Fragg</a> · dm/snipertown</div>
      <a class="ext-link moh-db-more" href="#" title="Opens moh-db.com in your browser">More screenshots, versions and comments on moh-db ↗</a></div>
    <dl class="facts" style="padding:var(--space-4) var(--space-5)">
      <div class="fact"><dt>Size</dt><dd>14.2 MB</dd></div>
      <div class="fact"><dt>Files</dt><dd>2 .pk3</dd></div>
      <div class="fact"><dt>Mode</dt><dd>Deathmatch</dd></div></dl>
    <div class="actions"><div class="actions__row"><button class="btn btn--primary">Install · 14.2 MB</button></div>
      <p class="quiet" style="margin:8px 0 0">Goes into main/ in your game folder. Remove it any time from Installed.</p></div>
    <div class="pane-block"><h3 class="display heading-sm" style="margin:0">Running now</h3>
      <div class="mini-list"><div class="mini-row"><span class="truncate">&lt;[TFC]&gt; The Fallen Company</span><span class="data">6/20 · 38 ms</span><button class="btn btn--sm">Install and join</button></div></div></div>
    <div class="pane-block"><p class="pane-text">A sniper town in the hills: rooftops, a bell tower and one long main street. Built for 8 to 20 players.</p></div>
  </div>`;
  status.innerHTML = `<a class="ext-link statusbar__source" href="#" title="Opens moh-db.com in your browser">Maps and mods from moh-db.com ↗</a><span><strong>1,326</strong> available</span><span><strong>37</strong> installed</span><span><strong>1</strong> downloading</span><span class="statusbar__spacer"></span><span>412 MB used by custom maps</span>`;
}

if (section === "admin") {
  toolbar.innerHTML = `${scope([["harzCore | Stock Maps", "32/32", 1], ["[DSB]Clan DM", "4/16"]])}
    <button class="btn btn--sm btn--ghost">+ Add server</button>
    <span class="toolbar__spacer"></span>${pane}`;
  const players = [
    ["=|LuV|=Hawk", 41, 12, 55], ["<[TFC]>Goat", 38, 9, 24], ["[FORTE]Raven", 30, 14, 111], ["{UK}Tommy", 27, 15, 173],
    ["Unknown Soldier", 22, 20, 142], ["Kraut_Sniper", 19, 11, 68], ["[DSB]Mika", 17, 18, 31], ["Pvt. Ryan", 12, 21, 96],
    ["xX_Garand_Xx", 9, 16, 210],
  ];
  list.innerHTML = `<div class="admin">
    <div class="admin__head"><h2 class="display">harzCore | Stock Maps 24/7</h2><span class="status-ok">● Connected</span><span class="quiet data">dm/mohdm6 · Team-Match · 32/32</span></div>
    <div class="admin__players"><table class="catalog"><thead><tr><th>Player</th><th class="num">Kills</th><th class="num">Deaths</th><th class="num">Ping</th><th></th></tr></thead><tbody>${players
      .map(([n, k, d, p], i) => `<tr ${i === 2 ? 'aria-selected="true"' : ""}><td class="item-name" style="font-size:var(--text-base)">${n.replace(/</g, "&lt;")}</td><td class="num data">${k}</td><td class="num data">${d}</td><td class="num data">${p}</td>
        <td class="num"><span class="row-actions"><button class="btn btn--sm btn--ghost">Message</button><button class="btn btn--sm btn--ghost">Kick</button><button class="btn btn--sm btn--ghost">Ban…</button></span></td></tr>`)
      .join("")}</tbody></table></div>
    <div class="console"><div class="console__head label">Console</div>
<pre class="console__log"><i>&gt; status</i>
map: dm/mohdm6   players: 32/32
<i>&gt; say Next map in 5 minutes</i>
<b>console: Next map in 5 minutes</b>
<i>&gt; sv_maplist</i>
dm/mohdm6 dm/mohdm2 dm/mohdm4 dm/mohdm1</pre>
      <div class="console__input"><label class="field"><span class="field__icon" aria-hidden="true">&gt;</span><input placeholder="Type an RCON command"></label><button class="btn btn--sm">Send</button></div></div>
  </div>`;
  detail.innerHTML = `<div class="detail-pane__scroll">
    <div class="pane-block stack-sm"><h3 class="display heading-sm" style="margin:0">Map</h3>
      <div class="select-like">dm/mohdm2 <span>▾</span></div>
      <div style="display:flex;gap:8px"><button class="btn btn--sm">Change map</button><button class="btn btn--sm btn--ghost">Restart round</button></div></div>
    <div class="pane-block"><h3 class="display heading-sm" style="margin:0">Rotation</h3>
      <ul class="rotation"><li class="now">dm/mohdm6</li><li>dm/mohdm2</li><li>dm/mohdm4</li><li>dm/mohdm1</li></ul>
      <button class="btn btn--sm btn--ghost" style="margin-top:10px">Edit rotation</button></div>
    <div class="pane-block stack-sm"><h3 class="display heading-sm" style="margin:0">Message everyone</h3>
      <label class="field"><input placeholder="Shown in the chat of every player"></label>
      <div><button class="btn btn--sm">Send</button></div></div>
    <div class="pane-block"><button class="filter-clear" style="padding:0">Remove this server from Admin</button></div>
  </div>`;
  status.innerHTML = `<span><strong>2</strong> servers</span><span><strong>2</strong> connected</span><span class="statusbar__spacer"></span><span>RCON password kept in Windows Credential Manager</span>`;
}
document.body.dataset.ready = "1";
