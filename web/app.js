// 19109M Scout: events, teams, match predictions, scouting notes, autos, checklists and a match scorer.
import { db, h, requireMember, signOut, auth, splash, hideSplash, rememberMember } from "./fb.js";
import { createBoard } from "./board.js";
import {
  doc, getDoc, onSnapshot, collection, query, where, addDoc, setDoc, updateDoc, deleteDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { EmailAuthProvider, reauthenticateWithCredential } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

const root = document.getElementById("app");
// Which game the app shows: this season's (Override) or last season's (Push Back). Each has its
// own season data from the sync, scoring rules, field and whiteboard. Chosen in Settings.
const GAMES = {
  override: { key: "override", name: "Override", years: "2026–27", status: "status", index: "", suffix: "", field: "field.webp" },
  pushback: { key: "pushback", name: "Push Back", years: "2025–26", status: "status-pushback", index: "pushback-", suffix: "__pushback", field: "field-pushback.svg" },
};
const G = GAMES[(() => { try { return JSON.parse(localStorage.getItem("19109m.game")); } catch { return null; } })()] || GAMES.override;
const { user, member } = await requireMember(root);
splash("Loading your events…");

// ---------------------------------------------------------------- state

const S = {
  nickname: member.nickname,
  status: undefined, // undefined = still loading, null = no sync yet
  events: {},      // event id -> event doc (null = no doc yet)
  notes: {},       // team number -> notes doc
  stats: {},       // team number -> teamstats doc
  scouting: {},    // team number -> [entries]
  index: {},       // "teams" | "events" -> array
  autos: undefined,
  lists: undefined, // checklists
  requested: new Set(),
};
const subs = new Map();
const us = () => S.status?.team?.number || "19109M";

function watch(key, ref, set) {
  if (subs.has(key)) return;
  subs.set(key, onSnapshot(ref, snap => { set(snap); refresh(); }, err => console.warn(key, err.code)));
}
const watchEvent = id => watch(`e${id}`, doc(db, "events", String(id)), s => { S.events[id] = s.exists() ? s.data() : null; });
const watchTeam = n => {
  watch(`n${n}`, doc(db, "notes", n + G.suffix), s => { S.notes[n] = s.exists() ? s.data() : null; });
  watch(`s${n}`, doc(db, "teamstats", n + G.suffix), s => { S.stats[n] = s.exists() ? s.data() : null; });
  watch(`c${n}`, query(collection(db, "scouting"), where("team", "==", n)), s => {
    S.scouting[n] = s.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) })).filter(x => (x.game || "override") === G.key).sort((a, b) => (b.at?.toMillis?.() || 0) - (a.at?.toMillis?.() || 0));
  });
};
watch("status", doc(db, "meta", G.status), s => {
  S.status = s.exists() ? s.data() : null;
  for (const e of S.status?.ourEvents || []) watchEvent(e.id);
});
const watchAutos = () => watch("autos", doc(db, "autos", "main"), s => { S.autos = s.exists() ? s.data() : { autos: [] }; });
const watchLists = () => watch("lists", collection(db, "checklists"), s => {
  S.lists = s.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) })).sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || String(a.name).localeCompare(b.name));
});

// The season indexes are big (every event and team), so keep a copy on the phone and
// only download again when the nightly sync has changed them.
async function loadIndex(kind) {
  if (S.index[kind]) return S.index[kind];
  S.index[kind] = [];
  const key = `19109m.index.${G.index}${kind}`;
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(key)); } catch {}
  if (cached?.items) { S.index[kind] = cached.items; refresh(); }
  try {
    const meta = await getDoc(doc(db, "index", `${G.index}${kind}Meta`));
    if (!meta.exists()) return S.index[kind];
    const stamp = meta.data().updatedAt?.toMillis?.() || 0;
    if (cached?.stamp === stamp && cached.items) return S.index[kind];
    const parts = await Promise.all(Array.from({ length: meta.data().chunks }, (_, i) => getDoc(doc(db, "index", `${G.index}${kind}-${i}`))));
    S.index[kind] = parts.flatMap(p => (p.exists() ? p.data().items : []));
    try { localStorage.setItem(key, JSON.stringify({ stamp, items: S.index[kind] })); } catch {}
  } catch (err) { console.warn("index", kind, err.code); }
  refresh();
  return S.index[kind];
}

async function request(kind, key) {
  S.requested.add(`${kind}:${key}`);
  refresh();
  await addDoc(collection(db, "requests"), { kind, key: String(key), game: G.key, by: user.uid, at: serverTimestamp() });
}

// ---------------------------------------------------------------- helpers

const ICONS = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  events: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  teams: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2a5 5 0 0 1 5.5 5.8"/>',
  autos: '<path d="M5 19c3 0 3-6 7-6s4-6 7-6"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="7" r="2"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  scorer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>',
  predict: '<path d="M4 19V5M4 19h16"/><path d="M7 15l4-4 3 3 5-6"/>',
  checklist: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  chev: '<path d="M9 5l7 7-7 7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill="currentColor"/>',
  trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  board: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 15c2-4 4 2 6-2s3-4 4-3"/><path d="M14.5 6.5l3 3"/>',
  pit: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M6.5 13.5l3-3 2.5 2 4.5-4.5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  robot: '<rect x="5" y="7" width="14" height="12" rx="2"/><path d="M12 3v4M9 12h.01M15 12h.01M9 16h6"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  insta: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.3" cy="6.7" r="1" fill="currentColor"/>',
};
const icon = (name, cls = "ic") => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.8"); s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("class", cls); s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICONS[name];
  return s;
};
const svgEl = (tag, attrs, parent) => { const n = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const k in attrs) n.setAttribute(k, attrs[k]); if (parent) parent.appendChild(n); return n; };
const store = {
  get(k, d) { try { const v = localStorage.getItem("19109m." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("19109m." + k, JSON.stringify(v)); } catch {} },
};

// Light, Dark or System (follow the device). index.html applies it before the page draws.
const applyTheme = t => {
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const dark = t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute("content", dark ? "#0c0d0f" : "#f2f3f5"));
};
applyTheme(store.get("theme", "system"));
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => applyTheme(store.get("theme", "system")));

const ms = d => (d ? Date.parse(d) : NaN);
const DAY = 86400e3;
const fmtDay = d => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const fmtDates = e => { if (!e.start) return ""; const a = fmtDay(e.start), b = e.end ? fmtDay(e.end) : a; return a === b ? a : `${a} – ${b}`; };
const fmtTime = d => (d ? new Date(d).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "");
const ago = ts => {
  const t = ts?.toMillis ? ts.toMillis() : ms(ts);
  if (!t) return "never";
  const m = Math.round((Date.now() - t) / 60e3);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const until = d => {
  const m = Math.round((ms(d) - Date.now()) / 60e3);
  if (!Number.isFinite(m)) return "";
  if (m <= 0) return "now";
  if (m < 60) return `in ${m} min`;
  if (m < 1440) return `in ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
  const d2 = Math.round(m / 1440);
  return d2 === 1 ? "tomorrow" : `in ${d2} days`;
};
// How often the sync checks VEX Events (it says in its status): faster on match days.
const checkEvery = live => { const n = (live ? S.status?.liveSeconds : S.status?.idleSeconds) || 5; return n === 1 ? "second" : `${n} seconds`; };
const pct = p => `${Math.round(p * 100)}%`;
const signed = x => (x > 0 ? "+" : "") + x;
const where_ = e => [e.city, e.region].filter(Boolean).join(", ");
const isLive = e => ms(e.start) <= Date.now() + DAY / 2 && Date.now() <= ms(e.end) + DAY;
const reEvent = sku => `https://events.vex.com/robot-competitions/vex-robotics-competition/${sku}.html`;
const reTeam = n => `https://events.vex.com/teams/V5RC/${encodeURIComponent(n)}`;
const teamHref = n => `#/team/${encodeURIComponent(n)}`;
const tn = n => h("span", { class: `tn${n === us() ? " us" : ""}` }, n);
// Team number in a fixed-size tile. The size here is a first guess; fitBadges() then
// measures the drawn text and shrinks any that are still too wide for their tile.
const badge = (n, size = "") => {
  const s = String(n), [w, max] = size === "lg" ? [76, 26] : [54, 17];
  const fs = Math.min(max, (w - 12) / (s.length * 0.55));
  return h("span", { class: `badge ${size}${n === us() ? " us" : ""}`, style: `font-size:${fs.toFixed(1)}px`, "aria-hidden": "true" }, s);
};
function fitBadges(el) {
  const r = document.createRange();
  for (const b of el.querySelectorAll(".badge")) {
    r.selectNodeContents(b);
    const text = r.getBoundingClientRect().width, room = b.clientWidth - 10;
    if (text > room) b.style.fontSize = `${(parseFloat(b.style.fontSize) * room / text).toFixed(1)}px`;
  }
}
document.fonts?.ready.then(() => fitBadges(document.body));
// "Qualifier #12" -> "Q12", "Practice #3" -> "P3", "SF #1-1" -> "SF 1-1", "Final #1-2" -> "F 1-2"
const shortName = name => String(name).replace(/^Qualifier #/, "Q").replace(/^Practice #/, "P").replace(/^Final #/, "F ").replace(/ #/, " ");
const teamName = n => teamInfo(n)?.name || "";
const ourEvents = () => (S.status?.ourEvents || []).slice().sort((a, b) => ms(a.start) - ms(b.start));
const ratingFrac = r => 1 / (1 + Math.exp(-1.6 * (r || 0)));
const meter = (v, cls = "") => h("span", { class: `meter ${cls}`, "aria-hidden": "true" }, h("i", { style: `width:${Math.max(4, Math.min(100, v * 100))}%` }));

/** One row of a grouped list, like the iPhone Settings app. `info` rows don't navigate. */
function lrow({ ic, lead, title, sub, trail, strong, href, onclick, external, info }) {
  const kids = [
    lead || (ic ? h("span", { class: "ico" }, icon(ic)) : null),
    h("span", { class: "tx" }, h("b", {}, title), sub ? h("span", {}, sub) : null),
    trail !== undefined && trail !== null && trail !== "" ? h("span", { class: `tr${strong ? " strong" : ""}` }, trail) : h("span", {}),
    info ? h("span", {}) : icon(external ? "ext" : "chev", "chev"),
  ];
  const cls = `lrow${lead || ic ? "" : " noicon"}`;
  if (info) return h("div", { class: cls, style: "cursor:default" }, ...kids);
  return href ? h("a", { class: cls, href, target: external ? "_blank" : null, rel: external ? "noopener" : null }, ...kids)
    : h("button", { type: "button", class: cls, onclick }, ...kids);
}
const group = (...rows) => h("div", { class: "group-list" }, ...rows);
const section = (title, link) => h("div", { class: "sec" }, h("h2", {}, title), link || null);
const card = (...kids) => h("section", { class: "card" }, ...kids);
const notice = (text, title, ic = "calendar") => h("div", { class: "notice" }, icon(ic), title ? h("b", {}, title) : null, h("span", {}, text));
const pagehead = (title, sub) => h("header", { class: "pagehead" }, h("h1", {}, title), sub ? h("p", {}, sub) : null);
const skeleton = (...heights) => heights.map(px => h("div", { class: "skel", style: `height:${px}px`, "aria-hidden": "true" }));
const searchBox = (placeholder, value, oninput) => h("div", { class: "search" }, icon("search"), h("input", { type: "search", placeholder, value, oninput, enterkeyhint: "search", "aria-label": placeholder }));
const seg = (options, cur, onpick, cls = "") => h("div", { class: `seg ${cls}`, role: "group" },
  options.map(([v, label]) => h("button", { type: "button", "data-v": v, "aria-pressed": String(cur === v), onclick: () => onpick(v) }, label)));
const glance = (items, cls = "") => h("div", { class: `glance ${cls}` }, items.map(([value, label, extra]) => h("div", { class: extra || null }, h("b", {}, value), h("span", {}, label))));

/** A chance shown as a big number, green when it favours the first side. `p` is 0..1. */
function ring(p, { color = p >= 0.5 ? "var(--good)" : "var(--bad)", label = "to win", cls = "" } = {}) {
  return h("span", { class: `chance ${cls}`, style: `--c:${color}` }, h("b", {}, pct(p)), h("span", {}, label));
}
const probBar = (pRed, labels = ["Red", "Blue"]) => h("div", { class: "prob" },
  h("div", { class: "bar", role: "img", "aria-label": `${labels[0]} ${pct(pRed)}, ${labels[1]} ${pct(1 - pRed)}` }, h("span", { style: `width:${pRed * 100}%` })),
  h("div", { class: "labels" }, h("span", { class: "red-t" }, `${labels[0]} ${pct(pRed)}`), h("span", { class: "blue-t" }, `${labels[1]} ${pct(1 - pRed)}`)));

/** The event that matters right now: the live one, else the next, else the last. */
function focusEvent() {
  const evs = ourEvents();
  return evs.find(isLive) || evs.find(e => ms(e.start) > Date.now()) || evs[evs.length - 1] || null;
}
function teamInfo(n) {
  for (const e of Object.values(S.events)) { const t = e?.teams?.find(x => x.number === n); if (t) return t; }
  return S.index.teams?.find(t => t.number === n) || S.stats[n]?.info || null; // info: teams looked up on request
}

// Scores seen so far, so a score that just came in (or changed) can light up for a moment.
const seen = new Map();
const changed = (key, v) => { const before = seen.get(key); seen.set(key, v); return before !== undefined && before !== v; };
/** Under the match name: Won / Lost / Tie for our matches, Final for others, else the start time. */
function result(m, won) {
  if (!m.scored) return h("span", {}, fmtTime(m.scheduled) || "");
  const ours = m.red.teams.includes(us()) ? "red" : m.blue.teams.includes(us()) ? "blue" : null;
  if (won === "tie") return h("span", {}, "Tie");
  if (!ours) return h("span", {}, "Final");
  return h("span", { class: won === ours ? "res won" : "res lost" }, won === ours ? "Won" : "Lost");
}
/** One match as a scoreboard row: name and time, red and blue teams, scores or win chances. */
function matchRow(ev, m, { foot, mark = true } = {}) {
  const mine = m.red.teams.includes(us()) || m.blue.teams.includes(us());
  const p = ev.predictions?.[m.id];
  const won = m.scored ? (m.red.score > m.blue.score ? "red" : m.blue.score > m.red.score ? "blue" : "tie") : null;
  for (const c of ["red", "blue"]) if (!m.scored) seen.set(`${m.id}${c}`, null);
  const side_ = c => h("div", { class: `side ${c}` }, h("span", { class: "teams" }, m[c].teams.map(tn)),
    m.scored ? h("span", { class: `sc${won && won !== c ? " lose" : ""}${changed(`${m.id}${c}`, m[c].score) ? " flash" : ""}` }, m[c].score)
      : p !== undefined ? h("span", { class: "pc" }, pct(c === "red" ? p : 1 - p)) : h("span", {}));
  return h("a", { class: `mrow${mark && mine ? " mine" : ""}`, href: `#/match/${ev.id}/${m.id}` },
    h("div", { class: "mname", title: m.name }, h("b", {}, shortName(m.name)), result(m, won)),
    h("div", { class: "sides" }, side_("red"), side_("blue"), foot ? h("div", { class: "mfoot" }, foot) : null));
}
const matchList = (ev, list, opts) => h("div", { class: "mlist" }, list.map(m => matchRow(ev, m, opts)));
const eventRow = e => lrow({ href: `#/event/${e.id}`, title: e.name, sub: [fmtDates(e), where_(e) || e.country].filter(Boolean).join(" · "),
  trail: isLive(e) ? h("span", { class: "pill live" }, "Live") : e.level && e.level !== "Other" ? e.level : "" });
function teamRow(t, ev) {
  const r = ev?.ratings?.[t.number], rk = ev?.rankings?.find(x => x.team === t.number);
  return lrow({ href: teamHref(t.number), lead: badge(t.number), title: t.name || t.number, sub: [t.number, t.org, t.city].filter(Boolean).join(" · "),
    trail: h("span", { class: "tr" }, r?.basis?.length ? meter(ratingFrac(r.rating), r.rating > 0 ? "good" : "") : null, rk ? h("span", { class: `rankbadge${rk.rank <= 3 ? " top" : ""}` }, `#${rk.rank}`) : null) });
}

// ---- bottom sheet with a searchable team list (used by the predictor)
function pickTeam({ title, teams, onPick }) {
  let q = "";
  const list = h("div", { class: "list group-list" });
  const close = () => { bg.classList.add("closing"); sheet.classList.add("closing"); setTimeout(() => { bg.remove(); sheet.remove(); }, calm.matches ? 0 : 180); };
  const draw = () => {
    const qq = q.trim().toLowerCase();
    const items = teams.filter(t => !qq || `${t.number} ${t.name} ${t.org}`.toLowerCase().includes(qq)).slice(0, 80);
    list.replaceChildren(...items.map(t => lrow({ lead: badge(t.number), title: t.number, sub: [t.name, t.org].filter(Boolean).join(" · "), onclick: () => { close(); onPick(t.number); } })));
    if (!items.length) list.append(h("p", { class: "empty" }, "No teams match."));
    if (list.isConnected) fitBadges(list);
  };
  const bg = h("div", { class: "sheet-bg", onclick: close });
  const input = h("input", { type: "search", placeholder: "Number, name or school", "aria-label": "Search teams", oninput: e => { q = e.target.value; draw(); } });
  const sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "grab", "aria-hidden": "true" }),
    h("div", { class: "head" }, h("h3", {}, title), h("button", { class: "btn small plain", type: "button", onclick: close }, "Cancel")),
    h("div", { class: "search" }, icon("search"), input), list);
  draw();
  document.body.append(bg, sheet);
  fitBadges(list);
  if (matchMedia("(min-width: 700px)").matches) input.focus();
}

// ---------------------------------------------------------------- views

const views = {};

views.home = () => {
  const out = [h("header", { class: "teamhead" }, h("h1", {}, S.status?.team?.number || "19109M"), h("p", {}, S.status?.team?.name || "UTS Circuit Breakers"),
    h("a", { class: `gamechip ${G.key}`, href: "#/settings", title: "Change game in Settings" }, `${G.name} · ${G.years}`))];
  if (S.status === undefined) return [...out, ...skeleton(150, 200, 160)];
  if (S.status === null) {
    out.push(notice("On GitHub, open Actions → Scout sync → Run workflow, mode full. Your events show up here when it finishes.", "Waiting for the first data sync", "refresh"));
    return out;
  }
  const left = [], right = [];
  const fe = focusEvent();
  const ev = fe && S.events[fe.id];

  // The event that matters now, with where we stand at it.
  if (fe) {
    const live = isLive(fe), r = ev?.rankings?.find(x => x.team === us()), o = ev?.oprs?.[us()];
    const status = live ? "Live now" : ms(fe.start) > Date.now() ? `Next event · ${until(fe.start)}` : "Last event";
    out.push(h("a", { class: `evcard${live ? " live" : ""}`, href: `#/event/${fe.id}` },
      h("div", { class: "evtop" }, h("span", { class: "status" }, status), icon("chev", "chev")),
      h("h2", {}, fe.name),
      h("p", {}, [fmtDates(fe), where_(fe), ev?.teams?.length ? `${ev.teams.length} teams` : null].filter(Boolean).join(" · ")),
      r ? glance([[`#${r.rank}`, "Rank", "accent"], [`${r.wins}-${r.losses}-${r.ties}`, "Record"], [r.wp, "WP"], [o?.matches >= 3 ? Math.round(o.opr) : "–", "OPR"]]) : null));
  }
  if (fe && ev === undefined) left.push(...skeleton(200, 160));
  // Before the match list is out: our season so far, and who to look out for at the event.
  if (!ev?.ourMatches?.length) {
    watchTeam(us());
    const st = S.stats[us()];
    if (st) left.push(section("Our season"), glance([[`${st.wins}-${st.losses}-${st.ties}`, "Record"], [st.events, st.events === 1 ? "Event" : "Events"],
      [st.bestRank ? `#${st.bestRank}` : "–", "Best rank"], [st.bestDriver + st.bestProg || "–", "Best skills"]]));
    const rivals = (ev?.teams || []).filter(t => t.number !== us()).sort((a, b) => (ev.ratings?.[b.number]?.rating ?? 0) - (ev.ratings?.[a.number]?.rating ?? 0));
    if (rivals.length) left.push(section("Teams to watch", h("a", { href: `#/event/${ev.id}/teams` }, `All ${ev.teams.length}`)), group(...rivals.slice(0, 6).map(t => teamRow(t, ev))),
      h("p", { class: "footnote" }, "Strongest first, from season record and skills. Updates with match results once the event starts."));
  }
  if (ev?.ourMatches?.length) {
    const ours = ev.ourMatches.map(om => ({ om, m: ev.matches.find(x => x.id === om.id) })).filter(x => x.m);
    const todo = ours.filter(x => !x.m.scored), done = ours.filter(x => x.m.scored).reverse();
    if (todo.length) {
      const { om, m } = todo[0];
      const who = (n, sub) => h("span", { class: "who" }, h("b", { class: n === us() ? "us-t" : null }, n), h("span", {}, sub || teamName(n) || " "));
      left.push(section("Next match"), h("a", { class: `next ${om.color}`, href: `#/match/${ev.id}/${m.id}` },
        h("div", { class: "row between", style: "flex-wrap:nowrap;align-items:flex-start" },
          h("div", { style: "display:flex;flex-direction:column;gap:4px;min-width:0" },
            h("span", { class: `eyebrow ${om.color}-t` }, `${om.color === "red" ? "Red" : "Blue"} alliance`),
            h("span", { class: "big" }, shortName(m.name)),
            h("span", { class: "muted small" }, [m.scheduled && `${fmtTime(m.scheduled)}, ${until(m.scheduled)}`, m.field].filter(Boolean).join(" · ") || fe.name)),
          om.win !== null ? ring(om.win, { label: "to win" }) : null),
        h("div", { class: "vs" },
          h("div", {}, h("span", { class: "eyebrow" }, "With"), who(us(), "Us"), om.partners.map(n => who(n))),
          h("div", {}, h("span", { class: "eyebrow" }, "Against"), om.opponents.map(n => who(n))))));
    }
    const all = h("a", { href: `#/event/${ev.id}/ours` }, "See all");
    if (todo.length > 1) left.push(section("Coming up", all), matchList(ev, todo.slice(1, 4).map(x => x.m), { mark: false }));
    if (done.length) left.push(section("Results", todo.length > 1 ? null : all), matchList(ev, done.slice(0, 4).map(x => x.m), { mark: false }));
  }

  const tool = (href, ic, label, sub) => h("a", { class: "tool", href }, h("span", { class: "tico" }, icon(ic)), h("span", { class: "tx" }, h("b", {}, label), h("span", {}, sub)));
  right.push(h("div", { class: "tools" },
    tool("#/checklist", "checklist", "Checklist", "Before each match"), tool("#/scorer", "scorer", "Scorer", "Timer and points"),
    tool("#/predict", "predict", "Predictor", "Any four teams"), tool("#/autos", "autos", "Autos", "Our routes"),
    tool("#/board", "board", "Whiteboard", "Draw on the field"), tool("#/pit", "pit", "Pit display", "Leave it at the pit")));
  right.push(section("Our events", h("a", { href: "#/events" }, "All events")), group(...ourEvents().map(eventRow)));
  right.push(h("p", { class: "footnote" }, (fe && isLive(fe)) || S.status.alwaysOn ? `Checking for new results every ${checkEvery(fe && isLive(fe))} · ${S.status.season?.name || ""}` : `${S.status.season?.name || ""} · updated ${ago(S.status.lastQuick)}`));
  return [...out, h("div", { class: "cols" }, h("div", { class: "col" }, ...left), h("div", { class: "col" }, ...right))];
};

let evQuery = "", evFilter = "region", evWhen = G.key === "override" ? "upcoming" : "any"; // last season is all in the past
views.events = () => {
  if (evFilter !== "ours") loadIndex("events");
  const region = S.status?.team?.region || "Ontario";
  const list = group();
  const count = h("p", { class: "footnote", style: "margin-top:0" });
  const drawList = () => {
    const q = evQuery.trim().toLowerCase();
    let items = evFilter === "ours" ? ourEvents() : (S.index.events || []);
    if (evFilter === "region") items = items.filter(e => e.region === region);
    if (evWhen === "upcoming") items = items.filter(e => ms(e.end || e.start) >= Date.now() - DAY);
    if (evWhen === "past") items = items.filter(e => ms(e.end || e.start) < Date.now() - DAY).reverse();
    if (q) items = items.filter(e => `${e.name} ${e.sku} ${e.city} ${e.region} ${e.country}`.toLowerCase().includes(q));
    list.replaceChildren(...items.slice(0, 80).map(eventRow));
    count.textContent = items.length > 80 ? `Showing 80 of ${items.length}. Search to narrow it down.` : "";
    if (!items.length) list.append(h("p", { class: "empty" }, S.index.events?.length || evFilter === "ours" ? "No events match." : "Loading events…"));
  };
  drawList();
  return [pagehead("Events"), searchBox("Name, city or event code", evQuery, e => { evQuery = e.target.value; drawList(); }),
    seg([["ours", "Ours"], ["region", region], ["all", "Everywhere"]], evFilter, v => { evFilter = v; render(); }),
    h("div", { class: "chips" }, [["upcoming", "Upcoming"], ["past", "Past"], ["any", "Any time"]].map(([v, label]) => h("button", { type: "button", "aria-pressed": String(evWhen === v), onclick: () => { evWhen = v; render(); } }, label))),
    list, count];
};

let rankSort = { key: "rank", dir: 1 };
views.event = (id, tab) => {
  watchEvent(id);
  const ev = S.events[id];
  if (ev === undefined) return [pagehead("Event"), ...skeleton(44, 300)];
  if (ev === null) {
    loadIndex("events");
    const e = S.index.events?.find(x => String(x.id) === String(id));
    const asked = S.requested.has(`event:${id}`);
    return [pagehead(e?.name || `Event ${id}`, e ? `${fmtDates(e)} · ${where_(e)}` : ""),
      h("div", { class: "notice" }, icon("download"), h("b", {}, "Not loaded yet"),
        h("span", {}, "It shows up after the next refresh, within the hour (within a minute while one of our events is live). It stays up to date while the event runs."),
        h("button", { class: "btn primary", disabled: asked, onclick: () => request("event", id) }, asked ? "Requested" : "Load this event")),
      e ? group(lrow({ href: reEvent(e.sku), title: "Open on VEX Events", external: true })) : null];
  }
  const hasUs = ev.teams.some(t => t.number === us());
  tab ||= hasUs ? "ours" : "matches";
  const tabs = [hasUs && ["ours", "Ours"], ["matches", "Matches"], ["rankings", "Rankings"], ["teams", "Teams"], ["skills", "Skills"]].filter(Boolean);
  const scored = ev.matches.filter(m => m.scored).length;
  const out = [
    h("header", { class: "pagehead" }, h("h1", {}, ev.name),
      h("p", {}, [fmtDates(ev), where_(ev), `${ev.teams.length} teams`, ev.matches.length ? `${scored} of ${ev.matches.length} played` : null].filter(Boolean).join(" · ")),
      isLive(ev) ? h("span", { class: "pill live", style: "align-self:flex-start;margin-top:4px" }, "Live") : null),
    h("nav", { class: "seg", "aria-label": "Event sections" }, tabs.map(([k, label]) => h("a", { href: `#/event/${id}/${k}`, "aria-current": k === tab ? "page" : null }, label))),
  ];
  if (tab === "ours") {
    if (!ev.ourMatches.length) out.push(notice("When the match list is out, our matches show here with partners, opponents and win chances.", "No match list yet"));
    else {
      const res = ev.ourMatches.map(om => ({ om, m: ev.matches.find(x => x.id === om.id) })).filter(x => x.m);
      const played = res.filter(x => x.m.scored);
      const wins = played.filter(({ om, m }) => m[om.color].score > m[om.color === "red" ? "blue" : "red"].score).length;
      const upcoming = res.filter(x => !x.m.scored && x.om.win !== null);
      out.push(glance([[`${wins}-${played.length - wins}`, "Won-lost"], [res.length - played.length, "To play"], [upcoming.length ? pct(upcoming.reduce((s, x) => s + x.om.win, 0) / upcoming.length) : "–", "Avg win chance"]], "three"));
      out.push(h("div", { class: "mlist" }, res.map(({ om, m }) => {
        const ours = m[om.color].score, theirs = m[om.color === "red" ? "blue" : "red"].score;
        const foot = m.scored
          ? [h("span", {}, `With ${om.partners.join(", ") || "—"}`), h("span", { class: `pill ${ours > theirs ? "win" : ours < theirs ? "loss" : ""}` }, ours > theirs ? "Won" : ours < theirs ? "Lost" : "Tied")]
          : [h("span", {}, `With ${om.partners.join(", ") || "—"}`), om.win !== null ? h("b", { style: `color:${om.win >= 0.5 ? "var(--good)" : "var(--bad)"}` }, `${pct(om.win)} to win`) : null];
        return matchRow(ev, m, { foot, mark: false });
      })));
    }
  } else if (tab === "matches") {
    if (!ev.matches.length) out.push(notice("Matches show here once the schedule is posted.", "No matches yet"));
    const groups = {};
    for (const m of ev.matches) (groups[m.round === 2 ? "Qualifications" : m.round === 1 ? "Practice" : "Eliminations"] ||= []).push(m);
    for (const [name, list] of Object.entries(groups)) out.push(section(name), matchList(ev, list));
    if (ev.accuracy?.total) out.push(h("p", { class: "footnote" }, `The win predictor called ${ev.accuracy.right} of ${ev.accuracy.total} played qualification matches here (${pct(ev.accuracy.right / ev.accuracy.total)}).`));
  } else if (tab === "rankings") {
    if (!ev.rankings.length) out.push(notice("Rankings appear after the first qualification matches.", "No rankings yet", "trophy"));
    else {
      const top = ev.rankings.slice().sort((a, b) => a.rank - b.rank).slice(0, 3);
      if (top.length === 3) {
        const pod = (r, i) => h("a", { class: i === 0 ? "first" : null, href: teamHref(r.team) }, h("span", { class: "place" }, ["1st", "2nd", "3rd"][i]), h("b", { class: r.team === us() ? "red-t" : null }, r.team),
          h("span", {}, `${r.wins}-${r.losses}-${r.ties} · ${r.wp} WP`));
        out.push(h("div", { class: "podium" }, pod(top[1], 1), pod(top[0], 0), pod(top[2], 2)));
      }
      const rows = ev.rankings.map(r => ({ ...r, opr: ev.oprs?.[r.team]?.opr ?? null, rating: ev.ratings?.[r.team]?.rating ?? null }));
      const cols = [["rank", "#"], ["team", "Team"], ["wins", "W-L-T"], ["wp", "WP"], ["ap", "AP"], ["sp", "SP"], ["opr", "OPR"], ["rating", "Rating"]];
      rows.sort((a, b) => { const x = a[rankSort.key], y = b[rankSort.key]; return (x === y ? a.rank - b.rank : x === null ? 1 : y === null ? -1 : x < y ? -1 : 1) * (x === y ? 1 : rankSort.dir); });
      out.push(h("div", { class: "group-list tablewrap" }, h("table", {},
        h("thead", {}, h("tr", {}, cols.map(([k, label]) => h("th", { class: k === "team" || k === "wins" ? "" : "num", "aria-sort": rankSort.key === k ? (rankSort.dir > 0 ? "ascending" : "descending") : null },
          h("button", { type: "button", onclick: () => { rankSort = { key: k, dir: rankSort.key === k ? -rankSort.dir : (k === "rank" || k === "team" ? 1 : -1) }; render(); } }, label + (rankSort.key === k ? (rankSort.dir > 0 ? " ↑" : " ↓") : "")))))),
        h("tbody", {}, rows.map(r => h("tr", { class: r.team === us() ? "us" : null },
          h("td", { class: "num" }, r.rank), h("td", {}, h("a", { href: teamHref(r.team) }, tn(r.team))),
          h("td", { class: "num" }, `${r.wins}-${r.losses}-${r.ties}`), h("td", { class: "num" }, r.wp), h("td", { class: "num" }, r.ap), h("td", { class: "num" }, r.sp),
          h("td", { class: "num" }, r.opr ?? "–"), h("td", { class: "num" }, r.rating === null ? "–" : signed(r.rating))))))),
        h("p", { class: "footnote" }, "OPR is the points a team adds per match here. Rating blends OPR, season record and skills; 0 is the event average. Tap a column to sort."));
    }
  } else if (tab === "teams") {
    const rated = ev.teams.slice().sort((a, b) => (ev.ratings?.[b.number]?.rating ?? 0) - (ev.ratings?.[a.number]?.rating ?? 0));
    out.push(group(...rated.map(t => teamRow(t, ev))), h("p", { class: "footnote" }, "Strongest first. The bar is each team's rating at this event."));
  } else if (tab === "skills") {
    if (!ev.skills.length) out.push(notice("Skills scores show here once teams run them.", "No skills runs yet", "trophy"));
    else {
      const max = Math.max(...ev.skills.map(s => s.total), 1);
      out.push(group(h("div", { class: "legend" }, h("span", {}, h("i", { style: "background:var(--accent)" }), "Driver"), h("span", {}, h("i", { style: "background:var(--faint)" }), "Autonomous")),
        ...ev.skills.map(s => h("a", { class: "sbar", href: teamHref(s.team) }, h("span", { class: "rk" }, s.rank), tn(s.team),
          h("span", { class: "track", role: "img", "aria-label": `Driver ${s.driver}, autonomous ${s.prog}` }, h("i", { class: "d", style: `width:${(s.driver / max) * 100}%` }), h("i", { class: "p", style: `width:${(s.prog / max) * 100}%` })),
          h("b", {}, s.total)))));
    }
  }
  out.push(section("More"), group(
    lrow({ href: `#/predict/${id}`, ic: "predict", title: "Win predictor", sub: "Pick any four teams here" }),
    !ev.ours ? lrow({ ic: "refresh", title: S.requested.has(`event:${id}`) ? "Refresh requested" : "Refresh this event", sub: `Updated ${ago(ev.updatedAt)}`, onclick: () => request("event", id) }) : null,
    lrow({ href: reEvent(ev.sku), ic: "ext", title: "Open on VEX Events", external: true })));
  return out;
};

views.match = (eid, mid) => {
  watchEvent(eid);
  const ev = S.events[eid];
  if (!ev) return ev === null ? [notice("This event isn't loaded.", "Not found")] : [pagehead("Match"), ...skeleton(120, 300)];
  const m = ev.matches.find(x => String(x.id) === String(mid));
  if (!m) return [notice("This match isn't in the schedule any more.", "Not found")];
  const p = ev.predictions?.[m.id];
  const side_ = color => {
    const rows = m[color].teams.map(n => {
      watchTeam(n);
      const r = ev.rankings.find(x => x.team === n), note = S.notes[n], o = ev.oprs?.[n];
      const sc = S.scouting[n] || [];
      const avg = sc.length ? sc.reduce((s, x) => s + x.rating, 0) / sc.length : 0;
      return h("a", { class: "note", href: teamHref(n) },
        h("div", { class: "row between", style: "flex-wrap:nowrap" }, h("span", { class: "row", style: "flex-wrap:nowrap;min-width:0" }, badge(n), h("span", { style: "display:flex;flex-direction:column;min-width:0" },
          h("b", {}, n), h("span", { class: "muted small" }, teamName(n)))), icon("chev", "chev")),
        h("div", { class: "row" }, r ? h("span", { class: "pill" }, `#${r.rank} · ${r.wins}-${r.losses}-${r.ties}`) : null, o?.matches >= 3 ? h("span", { class: "pill" }, `OPR ${Math.round(o.opr)}`) : null,
          sc.length ? h("span", { class: "pill" }, `★ ${avg.toFixed(1)} from ${sc.length}`) : null),
        note?.ai?.summary ? h("p", { class: "small" }, note.ai.summary) : note?.stats ? h("p", { class: "small muted" }, note.stats) : null,
        note?.ai?.watch?.length ? h("p", { class: "small", style: "color:var(--warn)" }, "Watch for: " + note.ai.watch.join(" · ")) : null);
    });
    return h("div", { class: "col" }, section(`${color === "red" ? "Red" : "Blue"} alliance${m.scored ? ` · ${m[color].score}` : ""}`), h("div", { class: "group-list", style: `border-top:4px solid var(--${color})` }, ...rows));
  };
  return [pagehead(m.name, [ev.name, m.field, m.scheduled && !m.scored && `${fmtTime(m.scheduled)}, ${until(m.scheduled)}`].filter(Boolean).join(" · ")),
    p !== undefined ? card(h("div", { class: "row", style: "flex-wrap:nowrap;gap:16px" },
      h("div", { style: "flex:1;display:flex;flex-direction:column;gap:8px;min-width:0" }, h("span", { class: "eyebrow" }, m.scored ? "Predicted before the match" : "Win chance"), probBar(p)),
      ring(Math.max(p, 1 - p), { size: 64, color: p >= 0.5 ? "var(--red)" : "var(--blue)", label: p >= 0.5 ? "red" : "blue" }))) : null,
    h("div", { class: "cols", style: "grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))" }, side_("red"), side_("blue"))];
};

let teamQuery = "", teamScope = "event";
views.teams = () => {
  const fe = focusEvent(), ev = fe && S.events[fe.id];
  if (teamScope !== "event" || !ev) loadIndex("teams");
  const scope = teamScope === "event" && !ev ? "region" : teamScope;
  const region = S.status?.team?.region || "Ontario";
  if (teamQuery.trim()) loadIndex("teams"); // a search also looks beyond the chosen scope
  const list = group(), extra = h("div", { class: "col" });
  const count = h("p", { class: "footnote", style: "margin-top:0" });
  const drawList = () => {
    const q = teamQuery.trim().toLowerCase();
    const hit = t => `${t.number} ${t.name} ${t.org} ${t.city} ${t.robot}`.toLowerCase().includes(q);
    let items = scope === "event" ? ev.teams : S.index.teams || [];
    if (scope === "region") items = items.filter(t => t.region === region);
    if (q) items = items.filter(hit);
    if (scope === "event") items = items.slice().sort((a, b) => (ev.ratings?.[b.number]?.rating ?? 0) - (ev.ratings?.[a.number]?.rating ?? 0));
    list.replaceChildren(...items.slice(0, 80).map(t => teamRow(t, scope === "event" ? ev : null)));
    list.hidden = !items.length && !!q;
    count.textContent = items.length > 80 ? `Showing 80 of ${items.length}. Search to narrow it down.` : "";
    if (!items.length && !q) list.append(h("p", { class: "empty" }, S.index.teams?.length || scope === "event" ? "No teams yet." : "Loading teams…"));
    // Searching: also show matches outside the chosen scope, and offer a VEX Events lookup
    // for a team number nobody has (it registered recently, or hasn't registered this season).
    extra.replaceChildren();
    if (q) {
      const shown = new Set(items.map(t => t.number));
      const others = scope === "all" ? [] : (S.index.teams || []).filter(t => !shown.has(t.number) && hit(t)).slice(0, 30);
      if (others.length) extra.append(section(items.length ? "More teams" : scope === "event" ? "Not at this event" : `Outside ${region}`), group(...others.map(t => teamRow(t, null))));
      const num = teamQuery.trim().toUpperCase();
      const known = items.concat(others).some(t => t.number === num);
      if (!known && /^\d{1,6}[A-Z]?$/.test(num)) {
        const asked = S.requested.has(`team:${num}`);
        extra.append(h("div", { class: "notice" }, h("b", {}, items.length || others.length ? `Looking for ${num}?` : `${num} isn't in the team list`),
          h("span", {}, "The list has the teams registered for this season, refreshed nightly. Look it up and it shows up within a minute while we're live, or within the hour."),
          h("div", { class: "row" },
            h("button", { class: "btn primary", disabled: asked, onclick: () => { request("team", num); location.hash = teamHref(num); } }, asked ? "Requested" : `Look up ${num}`),
            h("a", { class: "btn", href: reTeam(num), target: "_blank", rel: "noopener" }, "VEX Events", icon("ext")))));
      } else if (!items.length && !others.length) extra.append(h("p", { class: "empty" }, S.index.teams?.length ? "No teams match." : "Loading teams…"));
    }
    if (list.isConnected) { fitBadges(list); fitBadges(extra); }
  };
  drawList();
  return [pagehead("Teams"), searchBox("Number, name, school or city", teamQuery, e => { teamQuery = e.target.value; drawList(); }),
    seg([ev && ["event", "This event"], ["region", region], ["all", "Everyone"]].filter(Boolean), scope, v => { teamScope = v; render(); }), list, count, extra];
};

const AUTO_OPTIONS = G.key === "pushback"
  ? ["No auto", "Blocks in Long Goal", "Blocks in Center Goal", "Moved blocks only", "Parked", "Interfered / broke"]
  : ["No auto", "Toggle only", "Toggle + preload", "Midfield rush", "Several pins", "Interfered / broke"];
const PIECE = G.key === "pushback" ? "block" : "pin"; // what an auto scores, for the scouting form
const draft = {};
views.team = n => {
  watchTeam(n);
  if (!teamInfo(n)) loadIndex("teams");
  const t = teamInfo(n), st = S.stats[n], note = S.notes[n], sc = S.scouting[n] || [];
  const fe = focusEvent(), ev = fe && S.events[fe.id];
  const here = ev?.teams.some(x => x.number === n);
  const r = here && ev.rankings.find(x => x.team === n), o = here && ev.oprs?.[n], rt = here && ev.ratings?.[n];
  const avg = sc.length ? sc.reduce((s, x) => s + x.rating, 0) / sc.length : null;
  const left = [], right = [];

  left.push(card(h("div", { class: "kv" },
    h("div", {}, h("span", {}, "Rank here"), h("b", {}, r ? `#${r.rank}` : "–"), h("span", {}, r ? `${r.wins}-${r.losses}-${r.ties} · ${r.wp} WP` : here ? "Not ranked yet" : "Not at our event")),
    h("div", {}, h("span", {}, "OPR"), h("b", {}, o?.matches >= 3 ? Math.round(o.opr) : "–"), h("span", {}, rt?.basis?.length ? `Rating ${signed(rt.rating)}` : "Points per match")),
    h("div", {}, h("span", {}, "Season"), h("b", {}, st ? `${st.wins}-${st.losses}-${st.ties}` : "–"), h("span", {}, st ? `${st.events} event${st.events === 1 ? "" : "s"}${st.bestRank ? ` · best #${st.bestRank}` : ""}` : "")),
    h("div", {}, h("span", {}, "Best skills"), h("b", {}, st ? st.bestDriver + st.bestProg : "–"), h("span", {}, st ? `${st.bestDriver} driver + ${st.bestProg} auto` : "")))));
  if (here) {
    const withUs = ev.ourMatches.filter(om => om.partners.includes(n) || om.opponents.includes(n));
    if (withUs.length) left.push(group(...withUs.map(om => lrow({ href: `#/match/${ev.id}/${om.id}`, title: `${om.partners.includes(n) ? "Partner" : "Opponent"} in ${om.name}`,
      sub: ev.name, trail: om.win !== null ? `${pct(om.win)} to win` : "" }))));
  }
  const notesCard = card(h("h3", {}, "Notes"));
  if (note?.ai) {
    notesCard.append(h("p", {}, note.ai.summary));
    if (note.ai.strengths?.length || note.ai.watch?.length) notesCard.append(h("div", { class: "bullets" },
      h("div", {}, h("span", { class: "eyebrow" }, "Strengths"), h("ul", {}, (note.ai.strengths || []).map(s => h("li", {}, s)))),
      h("div", {}, h("span", { class: "eyebrow" }, "Watch for"), h("ul", {}, (note.ai.watch || []).map(s => h("li", {}, s))))));
  }
  if (note?.stats) notesCard.append(h("p", { class: note.ai ? "muted small" : "" }, note.stats));
  if (!note) notesCard.append(h("p", { class: "muted" }, note === undefined ? "Loading…" : "No notes yet. Notes are written for every team at our events."));
  else notesCard.append(h("p", { class: "muted small" }, note.ai ? `AI notes from results and our scouting, ${ago(note.ai.at)}` : `From ${note.statsEvent || "results"}`));
  left.push(notesCard);
  left.push(section("Season", h("a", { href: "#", onclick: e => { e.preventDefault(); request("team", n); } }, S.requested.has(`team:${n}`) ? "Requested" : "Refresh")));
  if (st?.rankings?.length) left.push(group(...st.rankings.map(x => lrow({ href: x.eventId ? `#/event/${x.eventId}` : undefined, info: !x.eventId,
    title: x.event, sub: `${x.wins}-${x.losses}-${x.ties} · ${x.wp} WP · high ${x.high}`, trail: h("span", { class: `rankbadge${x.rank <= 3 ? " top" : ""}` }, `#${x.rank}`) }))));
  else left.push(h("p", { class: "footnote" }, st === undefined ? "Loading…" : st ? "No events played yet this season." : "No season stats saved for this team yet. Tap Refresh to load them."));

  // Scouting form
  const d = draft[n] ||= { match: "", autoPins: 0, auto: "", rating: 0, notes: "", event: fe?.id || "" };
  const stars = h("div", { class: "stars", role: "radiogroup", "aria-label": "How good" });
  const drawStars = () => stars.replaceChildren(...[1, 2, 3, 4, 5].map(i => h("button", { type: "button", class: i <= d.rating ? "on" : null, "aria-label": `${i} star${i > 1 ? "s" : ""}`, "aria-checked": String(i === d.rating), role: "radio", onclick: () => { d.rating = i; drawStars(); } }, icon("star"))));
  drawStars();
  const pins = h("output", {}, d.autoPins);
  const stepPins = k => { d.autoPins = Math.max(0, Math.min(30, (Number(d.autoPins) || 0) + k)); pins.textContent = d.autoPins; };
  const opts = h("div", { class: "optchips", role: "group", "aria-label": "Auto" });
  const drawOpts = () => opts.replaceChildren(...AUTO_OPTIONS.map(o => h("button", { type: "button", "aria-pressed": String(d.auto === o), onclick: () => { d.auto = d.auto === o ? "" : o; drawOpts(); } }, o)));
  drawOpts();
  const msg = h("p", { class: "error", role: "status" });
  const form = h("form", { class: "card", onsubmit: async e => {
    e.preventDefault();
    if (!d.rating) { msg.textContent = "Pick a star rating."; return; }
    form.querySelector("button[type=submit]").disabled = true;
    try {
      await addDoc(collection(db, "scouting"), { team: n, event: String(d.event || ""), match: d.match.trim().slice(0, 20), autoPins: Number(d.autoPins) || 0,
        auto: d.auto, rating: d.rating, notes: d.notes.trim().slice(0, 1000), game: G.key, by: user.uid, nickname: S.nickname, at: serverTimestamp() });
      draft[n] = null; render();
    } catch (err) { msg.textContent = `Couldn't save: ${err.code || err.message}`; form.querySelector("button[type=submit]").disabled = false; }
  } },
    h("h3", {}, `Scout ${n}`),
    h("div", { class: "grid2", style: "align-items:end" },
      h("label", { class: "field" }, "Match", h("input", { value: d.match, placeholder: "Q12", maxlength: 20, autocapitalize: "characters", oninput: e => { d.match = e.target.value; } })),
      h("div", { class: "field" }, `${PIECE[0].toUpperCase() + PIECE.slice(1)}s in auto`, h("div", { class: "stepper" },
        h("button", { type: "button", "aria-label": `One fewer ${PIECE}`, onclick: () => stepPins(-1) }, "−"), pins,
        h("button", { type: "button", "aria-label": `One more ${PIECE}`, onclick: () => stepPins(1) }, "+")))),
    h("div", { class: "field" }, "Auto", opts),
    h("div", { class: "field" }, "How good", stars), // not a <label>: it would re-click the first star
    h("label", { class: "field" }, "Notes", h("textarea", { maxlength: 1000, placeholder: "Driving, defense, what they score, anything breaking", oninput: e => { d.notes = e.target.value; } }, d.notes)),
    msg, h("button", { class: "btn primary wide", type: "submit" }, "Save note"));
  right.push(form);
  if (sc.length) right.push(section(`Our scouting · ★ ${avg.toFixed(1)}`), group(...sc.map(x => h("div", { class: "note" },
    h("div", { class: "meta" }, h("b", {}, x.nickname), h("span", { class: "muted small" }, [x.match, ago(x.at)].filter(Boolean).join(" · "))),
    h("span", { class: "starline", "aria-label": `${x.rating} of 5 stars` }, "★".repeat(x.rating) + "☆".repeat(5 - x.rating)),
    x.auto || x.autoPins ? h("span", { class: "small muted" }, [x.auto, x.autoPins ? `${x.autoPins} auto ${PIECE}s` : ""].filter(Boolean).join(" · ")) : null,
    x.notes ? h("p", {}, x.notes) : null,
    x.by === user.uid ? h("button", { class: "btn small danger", style: "align-self:flex-start", onclick: () => { if (confirm("Delete this note?")) deleteDoc(doc(db, "scouting", x.id)); } }, "Delete") : null))));
  right.push(group(lrow({ href: reTeam(n), title: "Open on VEX Events", external: true })));

  return [h("header", { class: "profile" }, h("div", { class: "t" }, h("h1", {}, n), h("p", {}, [t?.name, t?.org, [t?.city, t?.region].filter(Boolean).join(", ")].filter(Boolean).join(" · ")))),
    h("div", { class: "cols" }, h("div", { class: "col" }, ...left), h("div", { class: "col" }, ...right))];
};

// ---- autos (view only; edited in the robot repo's scout/autos.json)
const T = 23.8, W = 3 * T;
const PX = 2 * W / 1464; // inches per pixel of the 1514 x 1508 field render (inside walls at x 23-1487, y 22-1485)
const CLAW = 12;
let side = store.get("alliance", "red"), pathMode = store.get("pathMode", "show"), autoGroup = "All", anim = null;
if (!["show", "faint", "hide"].includes(pathMode)) pathMode = "show";
const normH = d => ((d % 360) + 360) % 360;
const pose = s => side === "blue" ? [-s.x, -s.y, normH(s.h + 180)] : [s.x, s.y, s.h];
const textFor = s => side === "blue" ? s.replace(/Red Goal/g, "Blue Goal").replace(/to red/g, "to blue").replace(/(\d+)°/g, (m, d) => normH(+d + 180) + "°") : s;
const fx = x => x + W, fy = y => W - y;
// Same names as the robot code's Auto list (tools/gen-autons.mjs): "goal2-rush" -> GOAL2_RUSH, "252w" -> W252
const autoEnum = id => { const n = id.toUpperCase().replace(/[^A-Z0-9]+/g, "_"); return /^[0-9]/.test(n) ? "W" + n.replace(/W$/, "") : n; };
const placeRobot = (g, p) => g.setAttribute("transform", `translate(${fx(p[0])} ${fy(p[1])}) rotate(${p[2]})`);
const stopAnim = () => { if (anim) cancelAnimationFrame(anim.raf); anim = null; };
function fieldSvg(auto, thumb) {
  const svg = svgEl("svg", { viewBox: `${-23 * PX} ${-22 * PX} ${1514 * PX} ${1508 * PX}`, class: "fieldplot", role: "img", "aria-label": "Field diagram of " + textFor(auto.name) });
  svgEl("image", { href: "field.webp", x: -23 * PX, y: -22 * PX, width: 1514 * PX, height: 1508 * PX, preserveAspectRatio: "none" }, svg);
  const pts = auto.steps.map(pose);
  const rg = svgEl("g", { class: "route" }, svg);
  svgEl("polyline", { points: pts.map(p => fx(p[0]) + "," + fy(p[1])).join(" "), fill: "none", stroke: "#f2f2f2", "stroke-width": thumb ? 2.6 : 1.1, "stroke-dasharray": thumb ? "" : "2.4 1.6", "stroke-linejoin": "round" }, rg);
  if (!thumb) {
    let last = null;
    pts.forEach((p, i) => {
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.5) return;
      svgEl("circle", { cx: fx(p[0]), cy: fy(p[1]), r: 2.6, fill: "#f2f2f2" }, rg);
      svgEl("text", { x: fx(p[0]), y: fy(p[1]) + 1.15, "text-anchor": "middle", "font-size": 3.2, "font-weight": 600, fill: "#2b2e34" }, rg).textContent = i + 1;
      last = p;
    });
  }
  const col = side === "blue" ? "var(--blue)" : "var(--red)";
  const robot = svgEl("g", { class: "robot" }, svg);
  svgEl("rect", { x: -7.5, y: -7.5, width: 15, height: 15, rx: 1.5, fill: col, "fill-opacity": 0.5, stroke: col, "stroke-width": 0.9 }, robot);
  svgEl("line", { x1: 0, y1: 0, x2: 0, y2: -CLAW, stroke: "#f2f2f2", "stroke-width": 1 }, robot);
  svgEl("circle", { cx: 0, cy: -CLAW, r: 1.4, fill: "#f2f2f2" }, robot);
  placeRobot(robot, pts[0]);
  return svg;
}
views.autos = (id) => {
  if (G.key !== "override") return [pagehead("Autos"), notice(`Our autos are written for Override, this season's game. Switch the game back to Override in Settings to see them.`, `No ${G.name} autos`, "autos"),
    group(lrow({ href: "#/settings", title: "Change game", sub: `Showing ${G.name} ${G.years}` }))];
  watchAutos();
  if (S.autos === undefined) return [pagehead("Autos"), ...skeleton(300)];
  const a = id && S.autos.autos.find(x => x.id === id);
  if (id && !a) return [notice("That auto isn't in the list any more.", "Not found")];
  return a ? autoDetail(a) : autoList();
};
function autoList() {
  const groups = ["All", ...new Set(S.autos.autos.map(a => a.group))];
  const shown = S.autos.autos.filter(a => autoGroup === "All" || a.group === autoGroup);
  return [pagehead("Autos", "View only. Tap one to play it on the field."),
    h("div", { class: "chips" }, groups.map(g => h("button", { type: "button", "aria-pressed": String(g === autoGroup), onclick: () => { autoGroup = g; render(); } }, g))),
    group(...shown.map(a => h("a", { class: "auto-row", href: `#/autos/${a.id}` }, fieldSvg(a, true),
      h("span", { class: "tx" }, h("b", {}, textFor(a.name)), h("span", {}, `${a.time} · ${a.pins} pin${a.pins === 1 ? "" : "s"}${a.rec ? " · build first" : ""}`)),
      h("span", {}), icon("chev", "chev")))),
    S.autos.updatedAt ? h("p", { class: "footnote" }, `Updated ${ago(S.autos.updatedAt)}. Switch Red/Blue at the top to mirror them.`) : null];
}
function autoDetail(a) {
  const pts = a.steps.map(pose);
  const wrap = h("div", { class: "field-wrap", "data-path": pathMode });
  const svg = fieldSvg(a, false); wrap.append(svg);
  const robot = svg.querySelector(".robot");
  let cur = 0;
  const stepEls = [];
  const stepLabel = h("span", { class: "muted small num", style: "margin-left:auto" });
  const playBtn = h("button", { type: "button", class: "btn primary", onclick: () => (anim ? pause() : play()) }, "Play");
  const setStep = (i, place = true) => {
    cur = Math.max(0, Math.min(pts.length - 1, i));
    if (place) placeRobot(robot, pts[cur]);
    stepEls.forEach((el, j) => el.setAttribute("aria-current", j === cur ? "step" : "false"));
    stepLabel.textContent = `Step ${cur + 1} of ${pts.length}`;
  };
  const pause = () => { stopAnim(); playBtn.textContent = "Play"; };
  function play() {
    if (cur >= pts.length - 1) setStep(0);
    playBtn.textContent = "Pause";
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    anim = { raf: 0 };
    const runSeg = () => {
      if (!anim) return;
      if (cur >= pts.length - 1) { pause(); return; }
      const A = pts[cur], B = pts[cur + 1];
      const dH = ((B[2] - A[2] + 540) % 360) - 180, dist = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const tTurn = reduce ? 0 : Math.abs(dH) / 300, tDrive = reduce ? 0 : dist / 40, total = (tTurn + tDrive + (reduce ? 0.5 : 0.25)) * 1000;
      const t0 = performance.now();
      const tick_ = now => {
        if (!anim) return;
        const t = Math.max(0, (now - t0) / 1000); // the first frame can be stamped slightly before t0
        let p;
        if (tTurn > 0 && t < tTurn) p = [A[0], A[1], A[2] + dH * (t / tTurn)];
        else if (t < tTurn + tDrive) { const k = (t - tTurn) / tDrive; p = [A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + dH]; }
        else p = [B[0], B[1], A[2] + dH];
        placeRobot(robot, p);
        if (now - t0 >= total) { setStep(cur + 1, false); runSeg(); } else anim.raf = requestAnimationFrame(tick_);
      };
      anim.raf = requestAnimationFrame(tick_);
    };
    runSeg();
  }
  const steps = group();
  let prev = null;
  a.steps.forEach((s, i) => {
    const p = pts[i], d = prev ? Math.hypot(p[0] - prev[0], p[1] - prev[1]) : 0;
    const go = () => { pause(); setStep(i); };
    const el = h("div", { class: "step", role: "button", tabindex: "0", onclick: go, onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } } },
      h("span", { class: "n" }, i + 1),
      h("div", {}, h("div", {}, textFor(s.do)), h("div", { class: "meta" }, `x ${p[0].toFixed(1)}  y ${p[1].toFixed(1)}  h ${Math.round(p[2])}°${d ? `  · ${d.toFixed(1)}"` : ""}`)));
    stepEls.push(el); steps.append(el); prev = p;
  });
  setStep(0);
  const pathSeg = seg([["show", "Show"], ["faint", "Faint"], ["hide", "Hide"]], pathMode, v => {
    pathMode = v; store.set("pathMode", v); wrap.dataset.path = v;
    pathSeg.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === v)));
  });
  return [pagehead(textFor(a.name), `${a.group} · ${a.time} · ${a.pins} pin${a.pins === 1 ? "" : "s"}`),
    h("div", { class: "autodetail" },
      h("div", { class: "col sticky" }, card(wrap,
        h("div", { class: "row" }, playBtn,
          h("button", { type: "button", class: "btn", "aria-label": "Previous step", onclick: () => { pause(); setStep(cur - 1); } }, "‹"),
          h("button", { type: "button", class: "btn", "aria-label": "Next step", onclick: () => { pause(); setStep(cur + 1); } }, "›"), stepLabel),
        h("div", { class: "row between" }, h("span", { class: "muted small" }, "Path"), pathSeg))),
      h("div", { class: "col" },
        card(h("p", {}, textFor(a.summary)), h("p", { class: "small" }, h("b", {}, "Scores: "), textFor(a.score)), h("p", { class: "small" }, h("b", {}, "Risk: "), a.risk)),
        card(h("h3", {}, "Run it on the robot"),
          h("p", { class: "small" }, "Every auto is in one program. To pick this one, set these two lines in include/autons.hpp, then build and upload:"),
          h("pre", {}, `constexpr Auto SELECTED_AUTO = Auto::${autoEnum(a.id)};\nconstexpr Alliance ALLIANCE = Alliance::${side === "blue" ? "BLUE" : "RED"};`),
          h("p", { class: "muted small" }, "The brain screen shows which auto and alliance are loaded. Check it before you queue.")),
        section("Steps"), steps))];
}

// ---- checklists (shared by the whole team, live)
const DEFAULT_LISTS = [
  { name: "Before each match", items: ["Battery fully charged and locked in", "Cascade fully down (the code counts its height from where it starts)", "Preload in the claw",
    "Zip tie on the front, touching the field perimeter", "Robot centered on the alliance-wall toggle, facing it, about 2\" off",
    "Brain screen shows the right auto and alliance", "Controller paired and charged", "Partner knows which auto we run and where they start",
    "Spare battery and tools at the field", "All screws tight, nothing dragging"] },
  { name: "Packing list", items: ["Robot", "Controllers (2) and charging cable", "Batteries (all) and charger", "Laptop and USB cable for uploading", "Hex keys, screwdrivers, zip ties",
    "Spare screws, nuts, standoffs", "Spare motors and cartridges", "Engineering notebook", "Power bar and extension cord", "Team shirts", "Water and snacks"] },
];
const newId = () => Math.random().toString(36).slice(2, 10);
let listId = store.get("list", ""), editing = false, ticked = {};
const barAt = {};
const saveList = (l, patch) => setDoc(doc(db, "checklists", l.id), { name: l.name, order: l.order ?? 99, items: l.items, done: l.done || {}, ...patch, by: user.uid, at: serverTimestamp() });
views.checklist = () => {
  watchLists();
  if (S.lists === undefined) return [pagehead("Checklist"), ...skeleton(44, 300)];
  if (!S.lists.length) {
    return [pagehead("Checklist"), h("div", { class: "notice" }, icon("checklist"), h("b", {}, "Shared team checklists"),
      h("span", {}, "Everyone on the team sees the same lists, and ticks show up on every phone right away."),
      h("button", { class: "btn primary", onclick: async e => {
        e.currentTarget.disabled = true;
        for (const [order, l] of DEFAULT_LISTS.entries()) await setDoc(doc(db, "checklists", newId()), { name: l.name, order, items: l.items.map(text => ({ id: newId(), text })), done: {}, by: user.uid, at: serverTimestamp() });
      } }, "Start with a match list and a packing list"))];
  }
  const l = S.lists.find(x => x.id === listId) || S.lists[0];
  const done = l.done || {};
  const count = l.items.filter(i => done[i.id]).length;
  // Draw the bar where it was, then let it slide to the new amount.
  const pctDone = l.items.length ? (count / l.items.length) * 100 : 0;
  const bar = h("i", { style: `width:${barAt[l.id] ?? pctDone}%` });
  barAt[l.id] = pctDone;
  requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = `${pctDone}%`; }));
  const toggle = it => (ticked = { id: it.id, at: Date.now() }, updateDoc(doc(db, "checklists", l.id), { [`done.${it.id}`]: !done[it.id], by: user.uid, at: serverTimestamp() }));
  const move = (i, k) => { const items = l.items.slice(); const j = i + k; if (j < 0 || j >= items.length) return; [items[i], items[j]] = [items[j], items[i]]; saveList(l, { items }); };
  const remove = it => { const d2 = { ...done }; delete d2[it.id]; saveList(l, { items: l.items.filter(x => x.id !== it.id), done: d2 }); };
  const rows = l.items.map((it, i) => h("div", { class: `check${done[it.id] ? " done" : ""}${ticked.id === it.id && Date.now() - ticked.at < 1500 ? " pop" : ""}`, role: editing ? null : "checkbox", "aria-checked": editing ? null : String(!!done[it.id]), tabindex: editing ? null : "0",
    onclick: editing ? null : () => toggle(it), onkeydown: editing ? null : e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(it); } } },
    h("span", { class: "box", "aria-hidden": "true" }, icon("check")), h("span", { class: "txt" }, it.text),
    editing ? h("span", { class: "acts" },
      h("button", { type: "button", "aria-label": `Move "${it.text}" up`, onclick: () => move(i, -1) }, "↑"),
      h("button", { type: "button", "aria-label": `Move "${it.text}" down`, onclick: () => move(i, 1) }, "↓"),
      h("button", { type: "button", "aria-label": `Delete "${it.text}"`, style: "color:var(--bad)", onclick: () => remove(it) }, "✕")) : h("span", {})));
  const addInput = h("input", { placeholder: "Add an item", maxlength: 120, "aria-label": "New item" });
  const add = e => { e.preventDefault(); const text = addInput.value.trim(); if (!text) return; saveList(l, { items: [...l.items, { id: newId(), text }] }); addInput.value = ""; };
  return [pagehead("Checklist", l.at ? `Last change ${ago(l.at)}` : ""),
    h("div", { class: "chips" }, S.lists.map(x => h("button", { type: "button", "aria-pressed": String(x.id === l.id), onclick: () => { listId = x.id; store.set("list", x.id); render(); } }, x.name)),
      h("button", { type: "button", onclick: async () => { const name = prompt("Name for the new list"); if (!name?.trim()) return; const id = newId();
        listId = id; store.set("list", id); editing = true;
        await setDoc(doc(db, "checklists", id), { name: name.trim().slice(0, 40), order: S.lists.length, items: [], done: {}, by: user.uid, at: serverTimestamp() }); } }, icon("plus"), "New list")),
    card(h("div", { class: "row between" }, h("h3", {}, l.name), h("span", { class: "muted num" }, `${count} of ${l.items.length}`)),
      h("div", { class: "progress", role: "progressbar", "aria-label": "Done", "aria-valuenow": count, "aria-valuemax": l.items.length }, bar)),
    group(...rows, l.items.length ? null : h("p", { class: "empty" }, "No items yet. Tap Edit list to add some.")),
    editing ? h("form", { class: "row", style: "flex-wrap:nowrap", onsubmit: add }, addInput, h("button", { class: "btn primary", type: "submit" }, "Add")) : null,
    h("div", { class: "row" },
      h("button", { class: "btn", onclick: () => saveList(l, { done: {} }) }, "Uncheck all"),
      h("button", { class: "btn", onclick: () => { editing = !editing; render(); } }, editing ? "Done editing" : "Edit list"),
      editing ? h("button", { class: "btn danger", style: "margin-left:auto", onclick: async () => { if (confirm(`Delete the list "${l.name}" for everyone?`)) { editing = false; await deleteDoc(doc(db, "checklists", l.id)); } } }, "Delete list") : null)];
};

// ---- match scorer + timer
// Scoring for each game. `pool` counters share a limit across both alliances (what physically
// fits on the field); `max` is per alliance; `points` turns a count into points.
const RULES = {
  // Override: 63 pins, each visible half scores on its own (126 halves at most between both
  // alliances); two robots per alliance can end in midfield.
  override: { bonus: 12, items: [
    { k: "alliancePin", label: "Alliance pin halves", each: 5, pool: "halves" },
    { k: "yellowPin", label: "Owned yellow pin halves", each: 10, pool: "halves" },
    { k: "midfield", label: "Robots in midfield", each: 8, max: 2 }],
    pools: { halves: 126 },
    note: left => left.halves ? `Each visible pin half scores. ${left.halves} of 126 halves left (63 pins on the field); up to 2 robots per alliance in midfield.`
      : "All 126 pin halves are counted (63 pins on the field, 2 halves each). Take some off to add more." },
  // Push Back: 88 blocks but only 44 places in goals (Long Goals 15 each, Center Upper and Lower
  // 7 each). Each control zone (2 Long Goal zones, Center Upper, Center Lower) goes to one
  // alliance. Parking: 8 points for one robot, 30 for both.
  pushback: { bonus: 10, items: [
    { k: "blocks", label: "Blocks in goals", each: 3, pool: "blocks" },
    { k: "longZone", label: "Long Goal zones controlled", each: 10, pool: "longZone" },
    { k: "upper", label: "Center Upper controlled", each: 8, pool: "upper" },
    { k: "lower", label: "Center Lower controlled", each: 6, pool: "lower" },
    { k: "park", label: "Robots parked", points: n => [0, 8, 30][n], max: 2, hint: "8 for one, 30 for both" }],
    pools: { blocks: 44, longZone: 2, upper: 1, lower: 1 },
    note: left => `Goals hold 44 blocks in all: Long Goals 15 each, Center Upper and Lower 7 each. ${left.blocks} places left. Each control zone goes to one alliance.` },
};
const R = RULES[G.key];
const score = { red: {}, blue: {}, bonus: "" };
for (const c of ["red", "blue"]) for (const it of R.items) score[c][it.k] = 0;
const poolUsed = pool => ["red", "blue"].reduce((s, c) => s + R.items.filter(it => it.pool === pool).reduce((t, it) => t + score[c][it.k], 0), 0);
const poolsLeft = () => Object.fromEntries(Object.entries(R.pools).map(([p, n]) => [p, n - poolUsed(p)]));
const timer = { phase: "ready", left: 15, running: false, last: 0, raf: 0 };
const PHASE_LEN = { ready: 15, auto: 15, autoDone: 15, driver: 105, done: 105 };
let audio = null;
const beep = (freq = 880, len = 0.15) => {
  try {
    audio ||= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = freq; o.connect(g); g.connect(audio.destination);
    g.gain.setValueAtTime(0.25, audio.currentTime); g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + len);
    o.start(); o.stop(audio.currentTime + len);
  } catch {}
};
const fmtClock = secs => { const s = Math.ceil(secs); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
function tick(t) {
  if (!timer.running) return;
  const before = Math.ceil(timer.left);
  timer.left = Math.max(0, timer.left - (t - timer.last) / 1000); timer.last = t;
  const after = Math.ceil(timer.left);
  if (after !== before && timer.phase === "driver" && (after === 30 || after <= 5)) beep(after ? 660 : 440);
  if (timer.left <= 0) {
    timer.running = false; beep(440, 0.6); navigator.vibrate?.(400);
    timer.phase = timer.phase === "auto" ? "autoDone" : "done";
  }
  const el = document.getElementById("clock");
  if (el) { el.textContent = fmtClock(timer.left); el.classList.toggle("low", timer.phase === "driver" && timer.left <= 30); }
  const arc = document.getElementById("clock-arc");
  if (arc) arc.setAttribute("stroke-dasharray", `${arc.dataset.c * (timer.left / PHASE_LEN[timer.phase])} ${arc.dataset.c}`);
  if (timer.running) timer.raf = requestAnimationFrame(tick); else render();
}
const startTimer = (phase, secs) => { timer.phase = phase; if (secs) timer.left = secs; timer.running = true; timer.last = performance.now(); beep(988); timer.raf = requestAnimationFrame(tick); render(); };
const pauseTimer = () => { timer.running = false; cancelAnimationFrame(timer.raf); render(); };
views.scorer = () => {
  const total = c => R.items.reduce((s, it) => s + (it.points ? it.points(score[c][it.k]) : score[c][it.k] * it.each), 0) + (score.bonus === c ? R.bonus : 0);
  const phaseLabel = { ready: "Ready", auto: "Autonomous", autoDone: "Autonomous over", driver: "Driver control", done: "Match over" }[timer.phase];
  const buttons = timer.running ? [h("button", { class: "btn", onclick: pauseTimer }, "Pause")]
    : timer.phase === "ready" ? [h("button", { class: "btn primary", onclick: () => startTimer("auto", 15) }, "Start auto · 0:15")]
    : timer.phase === "autoDone" ? [h("button", { class: "btn primary", onclick: () => startTimer("driver", 105) }, "Start driver · 1:45")]
    : timer.phase === "done" ? [] : [h("button", { class: "btn primary", onclick: () => startTimer(timer.phase) }, "Resume")];
  const size = 200, stroke = 8, rad = (size - stroke) / 2, circ = 2 * Math.PI * rad;
  const dial = svgEl("svg", { width: size, height: size, viewBox: `0 0 ${size} ${size}`, "aria-hidden": "true" });
  svgEl("circle", { class: "track", cx: size / 2, cy: size / 2, r: rad, fill: "none", "stroke-width": stroke }, dial);
  const arc = svgEl("circle", { id: "clock-arc", cx: size / 2, cy: size / 2, r: rad, fill: "none", stroke: "var(--accent)", "stroke-width": stroke, "stroke-linecap": "round", "stroke-dasharray": `${circ * (timer.left / PHASE_LEN[timer.phase])} ${circ}` }, dial);
  arc.dataset.c = circ;
  const room = (c, it) => (it.pool ? R.pools[it.pool] - poolUsed(it.pool) : it.max - score[c][it.k]);
  const counter = (c, it) => { const k = it.k, label = it.label; return h("div", { class: "counter" }, h("span", { class: "lbl" }, label, h("small", {}, ` · ${it.hint || `${it.each} each`}`)),
    h("div", { class: "stepper" },
      h("button", { type: "button", "aria-label": `Fewer ${label}, ${c}`, disabled: score[c][k] <= 0, onclick: () => { score[c][k] = Math.max(0, score[c][k] - 1); render(); } }, "−"),
      h("output", {}, score[c][k]),
      h("button", { type: "button", "aria-label": `More ${label}, ${c}`, disabled: room(c, it) <= 0, onclick: () => { if (room(c, it) > 0) score[c][k]++; render(); } }, "+"))); };
  const sideBox = c => h("div", { class: `team ${c}` }, h("div", { class: "row between" }, h("h3", {}, c === "red" ? "Red" : "Blue"), h("span", { class: `total${changed(`score${c}`, total(c)) ? " flash" : ""}`, "aria-live": "polite" }, total(c))),
    R.items.map(it => counter(c, it)));
  const lead = total("red") - total("blue");
  return [pagehead("Scorer", `${G.name} scoring`),
    h("div", { class: "cols" },
      h("div", { class: "col" }, card(h("div", { class: "clockwrap" }, dial, h("div", { class: "inner" }, h("span", { class: "phase" }, phaseLabel),
          h("span", { id: "clock", class: `timer${timer.phase === "driver" && timer.left <= 30 ? " low" : ""}`, role: "timer" }, fmtClock(timer.left)))),
        h("div", { class: "row", style: "justify-content:center" }, ...buttons,
          h("button", { class: "btn", onclick: () => { pauseTimer(); Object.assign(timer, { phase: "ready", left: 15 }); render(); } }, "Reset")))),
      h("div", { class: "col" }, h("div", { class: "board" }, sideBox("red"), sideBox("blue")),
        card(h("div", { class: "row between" }, h("h3", {}, "Autonomous bonus"), h("span", { class: "muted small" }, lead === 0 ? "Tied" : `${lead > 0 ? "Red" : "Blue"} leads by ${Math.abs(lead)}`)),
          seg([["", "None"], ["red", `Red +${R.bonus}`], ["blue", `Blue +${R.bonus}`]], score.bonus, v => { score.bonus = v; render(); }, "red-blue")),
        h("button", { class: "btn plain", onclick: () => { for (const c of ["red", "blue"]) for (const it of R.items) score[c][it.k] = 0; score.bonus = ""; render(); } }, "Clear scores"),
        h("p", { class: "footnote" }, R.note(poolsLeft()))))];
};

// ---- win predictor
const pick = { event: null, red: [], blue: [] };
views.predict = eid => {
  if (eid && String(eid) !== pick.event) { pick.event = String(eid); pick.red = []; pick.blue = []; }
  for (const e of ourEvents()) watchEvent(e.id);
  if (pick.event) watchEvent(pick.event);
  const evs = Object.values(S.events).filter(Boolean).sort((a, b) => ms(b.start) - ms(a.start));
  pick.event ||= String(focusEvent()?.id || evs[0]?.id || "");
  const ev = S.events[pick.event];
  const out = [pagehead("Predictor", "Pick any four teams at an event")];
  if (evs.length > 1) out.push(h("div", { class: "chips" }, evs.map(e => h("button", { type: "button", "aria-pressed": String(String(e.id) === pick.event),
    onclick: () => { location.hash = `#/predict/${e.id}`; } }, e.name))));
  if (!ev) { out.push(ev === undefined && pick.event ? h("div", { class: "skel", style: "height:200px" }) : notice("Open an event first, or wait for the first data sync.", "No event loaded")); return out; }
  const teams = ev.teams.slice().sort((a, b) => parseInt(a.number) - parseInt(b.number) || a.number.localeCompare(b.number));
  if (!pick.red.length && !pick.blue.length && teams.some(t => t.number === us())) pick.red = [us()];
  const slot = (c, i) => {
    const n = pick[c][i];
    return lrow({ lead: n ? badge(n) : h("span", { class: "badge", "aria-hidden": "true" }, "+"), title: n || "Pick a team", sub: n ? teamName(n) : `${c === "red" ? "Red" : "Blue"} ${i + 1}`,
      onclick: () => pickTeam({ title: `${c === "red" ? "Red" : "Blue"} team ${i + 1}`, teams, onPick: num => { pick[c][i] = num; render(); } }) });
  };
  out.push(h("div", { class: "cols", style: "grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))" },
    h("div", { class: "col" }, section("Red alliance"), h("div", { class: "group-list", style: "border-top:4px solid var(--red)" }, slot("red", 0), slot("red", 1))),
    h("div", { class: "col" }, section("Blue alliance"), h("div", { class: "group-list", style: "border-top:4px solid var(--blue)" }, slot("blue", 0), slot("blue", 1)))));
  const red = pick.red.filter(Boolean), blue = pick.blue.filter(Boolean);
  if (red.length && blue.length) {
    const sum = ts => ts.reduce((s, t) => s + (ev.ratings?.[t]?.rating || 0), 0);
    const p = 1 / (1 + Math.exp(-1.15 * (sum(red) - sum(blue))));
    const fav = p >= 0.5 ? "red" : "blue";
    out.push(card(h("div", { style: "display:flex;flex-direction:column;align-items:center;gap:6px;padding:4px 0" },
        ring(Math.max(p, 1 - p), { size: 120, stroke: 9, color: `var(--${fav})`, label: fav === "red" ? "Red wins" : "Blue wins", cls: "lg" }),
        h("p", { class: "muted small" }, Math.abs(p - 0.5) < 0.08 ? "Too close to call" : `${fav === "red" ? "Red" : "Blue"} is favored`)),
      probBar(p)),
      group(...[...red.map(t => [t, "red"]), ...blue.map(t => [t, "blue"])].map(([t, c]) => {
        const r = ev.ratings?.[t];
        return lrow({ href: teamHref(t), lead: badge(t), title: t, sub: r?.basis?.length ? Object.entries(r.parts).map(([k, v]) => `${{ opr: "OPR", winRate: "win rate", skills: "skills" }[k]} ${signed(v)}`).join(" · ") : "No results yet, counted as average",
          trail: h("span", { class: "tr" }, meter(ratingFrac(r?.rating), (r?.rating || 0) > 0 ? "good" : ""), h("span", { class: `${c}-t num` }, signed(r?.rating ?? 0))) });
      })),
      h("p", { class: "footnote" }, "Ratings blend this event's OPR, season win rate and best skills. It's a guide, not a promise."));
  }
  return out;
};

// ---- whiteboard: one board for the whole session, kept across redraws so drawing is never lost
const IMMERSIVE = new Set(["board", "pit"]);
let board = null, redrawAfterStroke = false;
const exitTo = () => { if (document.fullscreenElement) document.exitFullscreen?.(); location.hash = wide.matches ? "#/" : "#/more"; };
const fullscreenBtn = () => document.fullscreenEnabled
  ? h("button", { type: "button", class: "wb-btn", "aria-label": "Full screen", title: "Full screen", onclick: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {})) }, icon("expand"), h("span", {}, "Full screen"))
  : null;
views.board = () => {
  board ||= createBoard({ h, icon, field: G.field, key: G.key === "override" ? "19109m.board" : `19109m.board.${G.key}`, starts: G.key === "pushback" ? [0.3, 0.7] : undefined,
    onIdle: () => { if (redrawAfterStroke) { redrawAfterStroke = false; refresh(); } } });
  // Robots are named after our next match: us and our partner, then the opponents.
  const fe = focusEvent(), ev = fe && S.events[fe.id];
  const om = ev?.ourMatches?.find(x => !ev.matches.find(m => m.id === x.id)?.scored);
  board.setTeams({ us: us(), partner: om?.partners?.[0], opponents: om?.opponents, color: om?.color || "red" });
  return [h("div", { class: "wb-head" },
      h("button", { type: "button", class: "back", onclick: exitTo }, icon("back"), h("span", {}, "Done")),
      h("div", { class: "wb-title" }, h("b", {}, "Whiteboard"), om ? h("span", {}, `${shortName(om.name)} · ${om.color === "red" ? "Red" : "Blue"} alliance`) : null),
      fullscreenBtn()),
    board.el];
};

// ---- pit display: a full-screen dashboard for a laptop or TV at our pit
let wakeLock = null, pitTimer = 0;
function pitMode(on) {
  // Keep the screen on and the clock ticking while the pit display is up.
  if (on && !pitTimer) {
    pitTimer = setInterval(refresh, 15e3);
    navigator.wakeLock?.request("screen").then(l => { wakeLock = l; }).catch(() => {});
    document.addEventListener("visibilitychange", relock);
  } else if (!on && pitTimer) {
    clearInterval(pitTimer); pitTimer = 0;
    wakeLock?.release().catch(() => {}); wakeLock = null;
    document.removeEventListener("visibilitychange", relock);
  }
}
function relock() { if (!document.hidden && pitTimer) navigator.wakeLock?.request("screen").then(l => { wakeLock = l; }).catch(() => {}); }
const INSTAGRAM = "19109robotics";
let qr = null;
import("./vendor/qrcode.js").then(({ default: qrcode }) => {
  const q = qrcode(0, "M"); q.addData(`https://instagram.com/${INSTAGRAM}`); q.make();
  qr = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  if (lastName === "pit") refresh();
}).catch(() => {});

// ---- pit lock: once locked, leaving the pit display needs the team code (the one people
// join with). The app can't read the code itself, only its hash (meta/lock, written by the sync).
let pitLocked = store.get("pitLock", false), unlockTries = 0, unlockWait = 0;
function lockPit() {
  pitLocked = true; store.set("pitLock", true);
  document.documentElement.requestFullscreen?.().catch(() => {});
  render();
}
const sha256 = async text => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, "0")).join("");
async function openUnlock() {
  if (document.querySelector(".unlock")) return;
  const lock = await getDoc(doc(db, "meta", "lock")).then(d => (d.exists() ? d.data() : null)).catch(() => null);
  // Before the sync has stored the code's hash, fall back to this account's own password.
  const what = lock ? "team code" : "account password";
  const input = h("input", { type: "password", autocomplete: "off", placeholder: lock ? "Team code" : "Password", "aria-label": what });
  const msg = h("p", { class: "error", role: "alert" });
  const close = () => { bg.remove(); box.remove(); };
  const bg = h("div", { class: "sheet-bg unlock-bg", onclick: close });
  const box = h("form", { class: "sheet unlock", role: "dialog", "aria-modal": "true", "aria-label": "Unlock pit display", onsubmit: async e => {
      e.preventDefault();
      if (Date.now() < unlockWait) { msg.textContent = `Too many tries. Wait ${Math.ceil((unlockWait - Date.now()) / 1000)} s.`; return; }
      const v = input.value.trim(); if (!v) return;
      let ok = false;
      if (lock) ok = (await sha256(`19109m-pit:${v}`)) === lock.hash;
      else ok = await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, v)).then(() => true, () => false);
      if (!ok) {
        input.value = ""; box.classList.remove("shake"); void box.offsetWidth; box.classList.add("shake");
        if (++unlockTries >= 5) { unlockTries = 0; unlockWait = Date.now() + 30e3; msg.textContent = "Wrong 5 times. Try again in 30 seconds."; }
        else msg.textContent = `That's not the ${what}.`;
        return;
      }
      unlockTries = 0; pitLocked = false; store.set("pitLock", false); close();
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      location.hash = "#/";
    } },
    h("div", { class: "head" }, h("h3", {}, "Unlock pit display"), h("button", { class: "btn small plain", type: "button", onclick: close }, "Cancel")),
    h("p", { class: "muted small" }, `Enter the ${what} to leave the pit display.`), input, msg,
    h("button", { class: "btn primary wide", type: "submit" }, icon("lock"), "Unlock"));
  box.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
  document.body.append(bg, box);
  input.focus();
}
document.addEventListener("fullscreenchange", () => { if (lastName === "pit") refresh(); });

/** Fits the pit display to one screen: drop ranking rows (never ours) and older matches until nothing is cut off. */
function fitPit() {
  if (!matchMedia("(min-width: 1001px)").matches) return;
  const over = el => el && el.scrollHeight > el.clientHeight + 1;
  const rank = root.querySelector(".pit-rank");
  while (over(rank)) { const rows = [...rank.querySelectorAll("tr:not(.us)")]; if (rows.length <= 3) break; rows.pop().remove(); }
  const list = root.querySelector(".pit-matches");
  while (over(list)) { const ms = list.querySelectorAll(".pit-m"); if (ms.length <= 2) break; ms[ms.length - 1].remove(); }
}
addEventListener("resize", () => { if (lastName === "pit") refresh(); });
/** Where we are right now, in a few words, for the top of the pit display. */
function pitStatus(fe, ev, next) {
  if (!fe) return ["Off season", ""];
  if (!isLive(fe)) return ms(fe.start) > Date.now() ? [`Next event ${until(fe.start)}`, fmtDates(fe)] : ["Event finished", fmtDates(fe)];
  if (!ev?.matches?.length) return ["At the event", "Waiting for the match list"];
  if (next) {
    const mins = (ms(next.m.scheduled) - Date.now()) / 60e3;
    if (!Number.isFinite(mins)) return ["Up next", shortName(next.m.name)];
    if (mins > 10) return ["Next match", `${shortName(next.m.name)} ${until(next.m.scheduled)}`];
    if (mins > -2) return ["Queue now", `${shortName(next.m.name)} on ${next.m.field || "the field"}`];
    return ["On the field", `${shortName(next.m.name)} (running ${Math.round(-mins)} min behind schedule)`];
  }
  return ev.ourMatches?.length ? ["Qualifications done", "Alliance selection and eliminations"] : ["At the event", ""];
}

views.pit = () => {
  const fe = S.status ? focusEvent() : null, ev = fe && S.events[fe.id];
  const ours = ev?.ourMatches?.map(om => ({ om, m: ev.matches.find(x => x.id === om.id) })).filter(x => x.m) || [];
  const todo = ours.filter(x => !x.m.scored), done = ours.filter(x => x.m.scored).reverse();
  const next = todo[0];
  const r = ev?.rankings?.find(x => x.team === us()), o = ev?.oprs?.[us()], sk = ev?.skills?.find(x => x.team === us());
  const [status, detail] = pitStatus(fe, ev, next);
  const now = new Date();
  const live = fe && isLive(fe);

  const head = h("header", { class: "pit-head" },
    h("div", { class: "pit-team" }, h("b", {}, us()), h("span", {}, S.status?.team?.name || "UTS Circuit Breakers")),
    h("div", { class: `pit-status${live ? " live" : ""}${status === "Queue now" ? " urgent" : ""}` }, h("span", {}, status), h("b", {}, detail || fe?.name || "")),
    h("div", { class: "pit-clock" }, h("b", {}, now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })), h("span", {}, now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }))));

  const who = n => h("div", { class: "pit-who" }, h("b", { class: n === us() ? "us-t" : null }, n), h("span", {}, n === us() ? "Us" : teamName(n) || ""));
  const nextCard = next
    ? h("section", { class: `pit-card pit-next ${next.om.color}` },
      h("div", { class: "pit-next-top" },
        h("div", {}, h("span", { class: `eyebrow ${next.om.color}-t` }, `Next match · ${next.om.color === "red" ? "Red" : "Blue"} alliance`),
          h("div", { class: "pit-big" }, shortName(next.m.name)),
          h("span", { class: "pit-when" }, [next.m.scheduled && `${fmtTime(next.m.scheduled)} · ${until(next.m.scheduled)}`, next.m.field].filter(Boolean).join(" · "))),
        next.om.win !== null ? ring(next.om.win, { label: "to win", cls: "lg" }) : null),
      h("div", { class: "pit-vs" },
        h("div", {}, h("span", { class: "eyebrow" }, "With"), who(us()), next.om.partners.map(who)),
        h("div", {}, h("span", { class: "eyebrow" }, "Against"), next.om.opponents.map(who))))
    : h("section", { class: "pit-card pit-next" }, h("span", { class: "eyebrow" }, fe ? (live ? "Next match" : "Next event") : "Season"),
      h("div", { class: "pit-big small" }, fe ? (live ? "No match scheduled" : fe.name) : "No events yet"),
      fe ? h("span", { class: "pit-when" }, [fmtDates(fe), where_(fe)].filter(Boolean).join(" · ")) : null);

  const stats = h("div", { class: "pit-stats" }, [[r ? `#${r.rank}` : "–", "Rank"], [r ? `${r.wins}-${r.losses}-${r.ties}` : "–", "Record"], [r ? r.wp : "–", "WP"],
    [o?.matches >= 3 ? Math.round(o.opr) : "–", "OPR"], [sk ? sk.total : "–", "Skills"]].map(([v, l]) => h("div", {}, h("b", {}, v), h("span", {}, l))));

  const mini = (m, om) => {
    const ourScore = m[om.color].score, theirs = m[om.color === "red" ? "blue" : "red"].score;
    return h("div", { class: `pit-m ${om.color}` }, h("b", {}, shortName(m.name)),
      h("span", { class: "pit-m-teams" }, `with ${om.partners.join(", ") || "—"} vs ${om.opponents.join(", ")}`),
      m.scored ? h("span", { class: `pit-m-res ${ourScore > theirs ? "won" : ourScore < theirs ? "lost" : ""}` }, `${ourScore > theirs ? "W" : ourScore < theirs ? "L" : "T"} ${ourScore}–${theirs}`)
        : h("span", { class: "pit-m-res" }, fmtTime(m.scheduled) || (om.win !== null ? pct(om.win) : "")));
  };
  const matches = h("section", { class: "pit-card pit-matches" },
    h("span", { class: "eyebrow" }, "Coming up"),
    todo.length > 1 ? todo.slice(1, 4).map(x => mini(x.m, x.om)) : h("p", { class: "muted" }, todo.length ? "That's our last scheduled match." : "Nothing scheduled yet."),
    h("span", { class: "eyebrow", style: "margin-top:10px" }, "Results"),
    done.length ? done.slice(0, 3).map(x => mini(x.m, x.om)) : h("p", { class: "muted" }, "No results yet."));

  const rk = (ev?.rankings || []).slice().sort((a, b) => a.rank - b.rank);
  const shown = rk.slice(0, 10);
  if (r && r.rank > 10) shown.push(r);
  const rankings = h("section", { class: "pit-card pit-rank" }, h("span", { class: "eyebrow" }, rk.length ? `Rankings · ${ev.name}` : "Rankings"),
    rk.length ? h("table", {}, h("tbody", {}, shown.map(x => h("tr", { class: x.team === us() ? "us" : null },
      h("td", { class: "num" }, x.rank), h("td", {}, h("span", { class: "tn" }, x.team), h("small", {}, teamName(x.team))), h("td", { class: "num" }, `${x.wins}-${x.losses}-${x.ties}`), h("td", { class: "num" }, `${x.wp} WP`)))))
      : h("p", { class: "muted" }, "Rankings show up after the first qualification matches."));

  const insta = h("section", { class: "pit-card pit-insta" },
    qr ? h("div", { class: "pit-qr", "aria-hidden": "true" }) : null,
    h("div", {}, h("span", { class: "pit-ig" }, icon("insta"), "Follow us"), h("b", {}, `@${INSTAGRAM}`), h("span", { class: "muted" }, "Scan to open our Instagram")));
  if (qr) insta.querySelector(".pit-qr").innerHTML = qr;

  const controls = pitLocked
    ? h("div", { class: "pit-controls" }, h("button", { type: "button", class: "wb-btn", "aria-label": "Unlock", title: "Unlock", onclick: openUnlock }, icon("lock"), h("span", {}, "Unlock")))
    : h("div", { class: "pit-controls" },
      h("button", { type: "button", class: "wb-btn", "aria-label": "Lock and go full screen", title: "Lock: leaving needs the team code", onclick: lockPit }, icon("lock"), h("span", {}, document.fullscreenEnabled ? "Lock & full screen" : "Lock")),
      h("button", { type: "button", class: "wb-btn", "aria-label": "Close pit display", title: "Close", onclick: exitTo }, icon("close"), h("span", {}, "Close")));
  // Locked but out of full screen (someone pressed Esc): offer the way back in, nothing else.
  const relock = pitLocked && document.fullscreenEnabled && !document.fullscreenElement
    ? h("div", { class: "pit-relock" }, h("div", { class: "row" },
      h("button", { type: "button", class: "btn primary", onclick: () => document.documentElement.requestFullscreen().catch(() => {}) }, icon("expand"), "Back to full screen"),
      h("button", { type: "button", class: "btn", onclick: openUnlock }, icon("lock"), "Unlock")))
    : null;

  return [head, h("div", { class: "pit-grid" }, nextCard, rankings, stats, matches, insta),
    relock, h("p", { class: "pit-foot" }, live || S.status?.alwaysOn ? `${G.name}${live ? " · live" : ""} · results checked every ${checkEvery(live)} · last change ${ago(ev?.updatedAt)}` : `${G.name} ${G.years} · updated ${ago(S.status?.lastQuick || S.status?.lastFull)}`), controls];
};

views.more = () => [pagehead("More"),
  group(
    lrow({ href: "#/checklist", ic: "checklist", title: "Checklist", sub: "Before each match, packing list, your own" }),
    lrow({ href: "#/scorer", ic: "scorer", title: "Scorer", sub: "Match timer and score counter" }),
    lrow({ href: "#/predict", ic: "predict", title: "Predictor", sub: "Win chance for any four teams" }),
    lrow({ href: "#/board", ic: "board", title: "Whiteboard", sub: "Draw plays on the field with our alliance" }),
    lrow({ href: "#/pit", ic: "pit", title: "Pit display", sub: "Full-screen dashboard to leave at the pit" })),
  group(
    lrow({ href: "#/settings", ic: "settings", title: "Settings", sub: `Signed in as ${S.nickname}` }),
    lrow({ href: reTeam(us()), ic: "ext", title: `${us()} on VEX Events`, external: true }))];

views.settings = () => {
  const nick = h("input", { value: S.nickname, maxlength: 24, "aria-label": "Nickname" });
  const msg = h("p", { class: "muted small", role: "status" });
  return [pagehead("Settings"),
    section("Nickname"),
    h("form", { class: "card", onsubmit: async e => {
      e.preventDefault(); const v = nick.value.trim(); if (!v) return;
      try { await updateDoc(doc(db, "members", user.uid), { nickname: v }); S.nickname = v; rememberMember(user.uid, { nickname: v }); msg.textContent = "Saved. New notes use this name."; } catch (err) { msg.textContent = `Couldn't save: ${err.code}`; }
    } }, nick, msg, h("button", { class: "btn primary", type: "submit" }, "Save")),
    h("p", { class: "footnote" }, "Shown on your scouting notes."),
    section("Game"),
    seg(Object.values(GAMES).map(g => [g.key, `${g.name} ${g.years}`]), G.key, v => {
      if (v === G.key) return;
      store.set("game", v);
      document.body.append(h("div", { id: "splash", role: "status" }, h("div", { class: "mark", "aria-hidden": "true" }, "M"), h("div", { class: "name" }, `Switching to ${GAMES[v].name}…`)));
      location.hash = "#/"; location.reload();
    }),
    h("p", { class: "footnote" }, "Events, teams, rankings, the scorer and the whiteboard all follow the game. Push Back is last season's, for looking back. Saved on this device."),
    section("Appearance"),
    seg([["system", "System"], ["light", "Light"], ["dark", "Dark"]], store.get("theme", "system"), v => { store.set("theme", v); transition("theme", () => { applyTheme(v); render(); }); }),
    h("p", { class: "footnote" }, "System follows your phone's light or dark mode. Saved on this device."),
    section("Data"),
    group(
      lrow({ info: true, title: "Last refresh", trail: ago(S.status?.lastQuick) }),
      lrow({ info: true, title: "Last full refresh", trail: ago(S.status?.lastFull) }),
      lrow({ info: true, title: "Season", trail: S.status?.season?.name || "—" })),
    h("p", { class: "footnote" }, S.status?.alwaysOn ? `Results come from VEX Events every ${checkEvery(true)} on match days, every ${checkEvery(false)} the rest of the time, and in full each night. New scores show up here the moment they're saved.`
      : `Results come from VEX Events: every ${checkEvery(true)} while one of our events is live, hourly otherwise, and in full each night. New scores show up here the moment they're saved.`),
    section("Account"),
    group(lrow({ info: true, title: user.email }),
      h("button", { type: "button", class: "lrow noicon", onclick: () => signOut(auth) }, h("span", { class: "tx" }, h("b", { style: "color:var(--bad)" }, "Sign out")), h("span"), h("span")))];
};

// ---------------------------------------------------------------- shell

// Five tabs on phones; the sidebar on wide screens lists everything.
const NAV = [["home", "Home", ""], ["events", "Events", "events"], ["teams", "Teams", "teams"], ["autos", "Autos", "autos"], ["more", "More", "more"]];
const NAV_WIDE = [["home", "Home", ""], ["events", "Events", "events"], ["teams", "Teams", "teams"], ["autos", "Autos", "autos"], ["checklist", "Checklist", "checklist"],
  ["scorer", "Scorer", "scorer"], ["predict", "Predictor", "predict"], ["board", "Whiteboard", "board"], ["pit", "Pit display", "pit"], ["settings", "Settings", "settings"]];
const TAB_OF = { event: "events", match: "events", team: "teams", checklist: "more", scorer: "more", predict: "more", settings: "more", board: "more", pit: "more" };
const BACK = { event: ["Events", "#/events"], match: ["Back"], team: ["Back"], checklist: ["More", "#/more"], scorer: ["More", "#/more"], predict: ["More", "#/more"], settings: ["More", "#/more"] };
const wide = matchMedia("(min-width: 900px)");
let lastRoute = "", titleObs = null;
// How deep each page sits, so moving deeper slides in from the right and Back slides the other way.
const DEPTH = { home: 0, events: 0, teams: 0, autos: 0, more: 0, event: 1, checklist: 1, scorer: 1, predict: 1, settings: 1, board: 1, pit: 1, match: 2, team: 2 };
const calm = matchMedia("(prefers-reduced-motion: reduce)");
let lastName = "", lastDepth = 0, drawn = false, moving = null;
/** Runs `change` as an animated transition (View Transitions where the browser has them). */
function transition(kind, change) {
  if (calm.matches || !document.startViewTransition) { change(); return false; }
  document.documentElement.dataset.nav = kind;
  const t = moving = document.startViewTransition(change);
  t.finished.finally(() => { if (moving === t) { moving = null; delete document.documentElement.dataset.nav; } });
  return true;
}
function render() {
  let parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  // A locked pit display stays put: Back, links and typed addresses come straight back here.
  if (pitLocked && parts[0] !== "pit") {
    history.replaceState(null, "", "#/pit"); parts = ["pit"];
    if (drawn) openUnlock();
  }
  const name = views[parts[0]] ? parts[0] : "home";
  const route = parts.join("/");
  const fresh = route !== lastRoute;
  // Only real navigation animates; live data redraws (every few seconds at events) stay still.
  const depth = name === "autos" && parts[1] ? 1 : DEPTH[name] ?? 0;
  if (!fresh || !drawn) { drawn = true; lastRoute = route; lastName = name; lastDepth = depth; draw(parts, name, fresh); return; }
  const from = lastDepth, to = depth;
  const kind = name === lastName && to === from ? "swap" : to > from ? "forward" : to < from ? "back" : "tab";
  lastRoute = route; lastName = name; lastDepth = depth;
  if (!transition(kind, () => draw(parts, name, true)) && !calm.matches) root.querySelector("main")?.classList.add(`enter-${kind}`);
}
function draw(parts, name, fresh) {
  stopAnim();
  const y = fresh ? 0 : scrollY;
  pitMode(name === "pit");
  if (IMMERSIVE.has(name)) {
    // Whiteboard and pit display fill the screen: no top bar or tab bar.
    document.body.classList.remove("has-nav");
    root.replaceChildren(h("main", { class: `immersive page-${name}` }, views[name](...parts.slice(1))));
    fitBadges(root);
    if (name === "pit") fitPit();
    if (fresh) scrollTo(0, 0);
    return;
  }
  document.body.classList.add("has-nav");
  const isWide = wide.matches;
  const tab = TAB_OF[name] || name;
  const sub = name === "autos" ? !!parts[1] : isWide ? ["event", "match", "team"].includes(name) : !!BACK[name];
  const [backLabel, backHref] = name === "autos" ? ["Autos", "#/autos"] : BACK[name] || ["Back"];
  const content = views[name](...parts.slice(1));
  const head = h("header", { class: "top" },
    h("div", { class: "left" }, sub ? h("button", { class: "back", onclick: () => { if (backHref) location.hash = backHref; else if (history.length > 1) history.back(); else location.hash = "#/"; } }, icon("back"), h("span", {}, backLabel)) : null),
    h("span", { class: "title" }, ""),
    h("div", { class: "right" }, name === "autos" ? seg([["red", "Red"], ["blue", "Blue"]], side, v => { side = v; store.set("alliance", v); render(); }, "red-blue") : null));
  const current = k => isWide ? (k === name || (k === "events" && ["event", "match"].includes(name)) || (k === "teams" && name === "team")) : k === tab;
  root.replaceChildren(head, h("main", {}, content),
    h("nav", { class: "bottom", "aria-label": "Main" }, isWide ? h("div", { class: "navbrand" }, h("b", {}, us()), h("span", {}, "Scout")) : null, (isWide ? NAV_WIDE : NAV).map(([k, label, path]) => h("a", { href: `#/${path}`, "aria-current": current(k) ? "page" : null }, icon(k), label))));
  const big = root.querySelector("main h1");
  head.querySelector(".title").textContent = big?.textContent || "";
  if (titleObs) titleObs.disconnect();
  head.classList.toggle("titled", !big);
  if (big && "IntersectionObserver" in window) {
    titleObs = new IntersectionObserver(([e]) => head.classList.toggle("titled", !e.isIntersecting), { rootMargin: "-52px 0px 0px 0px" });
    titleObs.observe(big);
  }
  fitBadges(root);
  scrollTo(0, y);
  head.classList.toggle("scrolled", scrollY > 4);
}
addEventListener("scroll", () => root.querySelector("header.top")?.classList.toggle("scrolled", scrollY > 4), { passive: true });
wide.addEventListener?.("change", () => render());

let pending = false;
function refresh() {
  // Data that lands mid-transition waits for it (a third of a second); redrawing now would cut it short.
  if (moving) { moving.finished.finally(refresh); return; }
  if (board?.busy()) { redrawAfterStroke = true; return; } // mid-stroke: redraw when the pen lifts
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    // Don't redraw under someone typing, or while the team picker is open.
    if (document.querySelector(".sheet")) return;
    const a = document.activeElement;
    if (a && root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) { a.addEventListener("blur", refresh, { once: true }); return; }
    render();
  });
}

// ---- "Update ready": a new version was published; switch over when the person taps Update.
function showUpdate(worker) {
  if (document.querySelector(".update")) return;
  const box = h("div", { class: "update", role: "alertdialog", "aria-labelledby": "upd-t", "aria-describedby": "upd-d" },
    h("span", { class: "uicon", "aria-hidden": "true" }, icon("download")),
    h("b", { id: "upd-t" }, "Update ready"),
    h("p", { id: "upd-d" }, "A new version of Scout is ready. Updating takes a second."),
    h("div", { class: "row" },
      h("button", { class: "btn small plain", onclick: () => box.remove() }, "Later"),
      h("button", { class: "btn small primary", onclick: () => {
        box.remove();
        document.body.append(h("div", { id: "splash", role: "status" }, h("div", { class: "mark", "aria-hidden": "true" }, "M"), h("div", { class: "name" }, "Updating…")));
        worker.postMessage("skipWaiting");
      } }, "Update now")));
  document.body.append(box);
}
if ("serviceWorker" in navigator && location.protocol === "https:") {
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloading) { reloading = true; location.reload(); } });
  navigator.serviceWorker.register("sw.js").then(reg => {
    const watchWorker = w => w?.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) showUpdate(w); });
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
    reg.addEventListener("updatefound", () => watchWorker(reg.installing));
    const check = () => reg.update().catch(() => {});
    setInterval(check, 30 * 60e3);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
  }).catch(err => console.warn("service worker", err));
}
window.__showUpdate = showUpdate; // lets the tests show the card

if (/\/autos(\.html)?$/.test(location.pathname)) history.replaceState(null, "", "./#/autos");
addEventListener("hashchange", () => { document.querySelectorAll(".sheet, .sheet-bg").forEach(n => n.remove()); render(); });
render();
// Hide the loading screen once the first data is in (usually instant from the phone's cache).
const firstData = setInterval(() => { if (S.status !== undefined) { clearInterval(firstData); render(); hideSplash(); } }, 40);
setTimeout(() => { clearInterval(firstData); hideSplash(); }, 2500);
