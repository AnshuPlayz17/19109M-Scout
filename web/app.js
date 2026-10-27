// 19109M Scout: events, teams, match predictions, scouting notes, autos, checklists and a match scorer.
import { db, h, requireMember, signOut, auth, splash, hideSplash, rememberMember, secret, askAdmin, verdict } from "./fb.js";
import { createBoard } from "./board.js";
import { AXES, profile } from "./profile.js";
import {
  doc, getDoc, getDocs, onSnapshot, collection, query, where, addDoc, setDoc, updateDoc, deleteDoc, serverTimestamp, orderBy, limit, arrayUnion, arrayRemove,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { EmailAuthProvider, reauthenticateWithCredential } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

const root = document.getElementById("app");
// Which game the app shows: this season's (Override) or last season's (Push Back). Each has its
// own season data from the sync, scoring rules, field and whiteboard. Chosen in Settings.
const GAMES = {
  override: { key: "override", name: "Override", years: "2026–27", status: "status", index: "", suffix: "", field: "field.webp" },
  pushback: { key: "pushback", name: "Push Back", years: "2025–26", status: "status-pushback", index: "pushback-", suffix: "__pushback", field: "field-pushback.webp" },
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
  past: {},        // team number -> last season's (Push Back) stats
  scales: {},      // game -> percentile scales
  reports: {},     // event id -> Scout for me report (null = none yet)
  ai: undefined,   // meta/ai: is AI set up, today's spending
  pits: {},        // team number -> pit scouting sheet (null = none yet)
  matchNotes: {},  // match id -> [our notes on that match]
};
const subs = new Map();
const us = () => S.status?.team?.number || "19109M";

function watch(key, ref, set, opts = {}) {
  if (subs.has(key)) return;
  subs.set(key, onSnapshot(ref, opts, snap => { set(snap); refresh(); }, err => console.warn(key, err.code)));
}
const unwatch = key => { subs.get(key)?.(); subs.delete(key); };
const watchEvent = id => watch(`e${id}`, doc(db, "events", String(id)), s => { S.events[id] = s.exists() ? s.data() : null; });
const watchTeam = n => {
  watch(`n${n}`, doc(db, "notes", n + G.suffix), s => { S.notes[n] = s.exists() ? s.data() : null; });
  watch(`s${n}`, doc(db, "teamstats", n + G.suffix), s => { S.stats[n] = s.exists() ? s.data() : null; });
  // Notes saved offline show straight away, marked "waiting to send" until they reach the server.
  watch(`c${n}`, query(collection(db, "scouting"), where("team", "==", n)), s => {
    S.scouting[n] = s.docs.map(d => ({ id: d.id, pending: d.metadata.hasPendingWrites, ...d.data({ serverTimestamps: "estimate" }) })).filter(x => (x.game || "override") === G.key).sort((a, b) => (b.at?.toMillis?.() || 0) - (a.at?.toMillis?.() || 0));
  }, { includeMetadataChanges: true });
};
// Last season's stats for a team (the dashed shape on its hexagon chart).
const watchPit = n => watch(`pit${n}`, doc(db, "pits", `${n}__${G.key}`), s => { S.pits[n] = s.exists() ? s.data({ serverTimestamps: "estimate" }) : null; }, { includeMetadataChanges: true });
const watchMatchNotes = mid => watch(`mn${mid}`, query(collection(db, "matchNotes"), where("match", "==", String(mid))), s => {
  S.matchNotes[mid] = s.docs.map(d => ({ id: d.id, pending: d.metadata.hasPendingWrites, ...d.data({ serverTimestamps: "estimate" }) })).filter(x => x.game === G.key);
}, { includeMetadataChanges: true });
const watchPast = n => watch(`p${n}`, doc(db, "teamstats", n + "__pushback"), s => { S.past[n] = s.exists() ? s.data() : null; });
// Percentiles for the hexagon charts (meta/scales-<game>, written by the nightly sync).
const watchScales = game => watch(`scales-${game}`, doc(db, "meta", `scales-${game}`), s => { S.scales[game] = s.exists() ? s.data() : null; });
watch("status", doc(db, "meta", G.status), s => {
  S.status = s.exists() ? s.data() : null;
  for (const e of S.status?.ourEvents || []) watchEvent(e.id);
});
// Admins (meta/admins, from the ADMIN_EMAILS secret) see team code requests and can see the code.
watch("admins", doc(db, "meta", "admins"), s => {
  S.admin = !!s.exists() && (s.data().uids || []).includes(user.uid);
  if (S.admin) watch("codeRequests", collection(db, "codeRequests"), q => {
    S.codeRequests = q.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) })).sort((a, b) => (b.at?.toMillis?.() || 0) - (a.at?.toMillis?.() || 0));
  });
});
watch("ai", doc(db, "meta", "ai"), s => { S.ai = s.exists() ? s.data() : null; });
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
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  skills: '<path d="M4 20h4v-6H4zM10 20h4V9h-4zM16 20h4V4h-4z"/>',
  review: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h5"/>',
  scout: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/>',
  send: '<path d="M5 12h13M12 5l7 7-7 7"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  wifi: '<path d="M2 8.5a15 15 0 0 1 20 0M5.5 12a10 10 0 0 1 13 0M9 15.5a5 5 0 0 1 6 0"/><circle cx="12" cy="19" r="1.2" fill="currentColor"/>',
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

/**
 * The hexagon chart: one corner per axis of profile.js, each pulled out as far as that team's
 * percentile (centre = worst of all teams, corner = best). `series` is [{ p, cls }]: the first is
 * drawn filled, later ones (last season) as dashed outlines. Corners with no data sit at the centre.
 */
function radarChart(series, { small = false } = {}) {
  const R = 100, n = AXES.length, pt = (i, r) => [r * Math.sin((2 * Math.PI * i) / n), -r * Math.cos((2 * Math.PI * i) / n)];
  const pad = small ? 8 : 64;
  const svg = svgEl("svg", { viewBox: `${-R - pad} ${-R - (small ? 8 : 34)} ${2 * (R + pad)} ${2 * R + (small ? 16 : 86)}`, class: `radar${small ? " small" : ""}`, role: "img",
    "aria-label": AXES.map(a => `${a.label} ${series[0]?.p?.[a.key] == null ? "no data" : `${Math.round(series[0].p[a.key] * 100)}th percentile`}`).join(", ") });
  for (const f of [0.25, 0.5, 0.75, 1]) svgEl("polygon", { class: `grid${f === 1 ? " edge" : ""}`, points: AXES.map((_, i) => pt(i, f * R).join(",")).join(" ") }, svg);
  AXES.forEach((_, i) => { const [x, y] = pt(i, R); svgEl("line", { class: "spoke", x1: 0, y1: 0, x2: x, y2: y }, svg); });
  series.slice().reverse().forEach(({ p, cls }) => {
    if (!p) return;
    const pts = AXES.map((a, i) => pt(i, Math.max(0.04, p[a.key] ?? 0) * R));
    svgEl("polygon", { class: `shape ${cls}`, points: pts.map(q => q.join(",")).join(" ") }, svg);
    if (!small) AXES.forEach((a, i) => svgEl("circle", { class: `dot ${cls}${p[a.key] == null ? " none" : ""}`, cx: pts[i][0], cy: pts[i][1], r: cls === "now" ? 3.6 : 2.6 }, svg));
  });
  if (!small) AXES.forEach((a, i) => {
    const [x, y] = pt(i, R + 16), v = series[0]?.p?.[a.key];
    const anchor = Math.abs(x) < 5 ? "middle" : x > 0 ? "start" : "end";
    const t = svgEl("text", { x, y: y + (y < -R ? -4 : y > R * 0.5 ? 10 : 4), "text-anchor": anchor, class: "lab" }, svg);
    t.textContent = a.label;
    const vt = svgEl("text", { x, y: y + (y < -R ? 10 : y > R * 0.5 ? 24 : 18), "text-anchor": anchor, class: `val${v == null ? " none" : ""}` }, svg);
    vt.textContent = v == null ? "no data" : `${Math.round(v * 100)}`;
  });
  return svg;
}
/** The hexagon with its legend, for a team. `past` is last season's stats (Override mode only). */
function profileCard(st, past, { title = "Profile" } = {}) {
  watchScales(G.key);
  if (G.key === "override") watchScales("pushback");
  const sc = S.scales[G.key];
  if (!st || !sc) return null;
  const now = profile(st, sc), last = past && S.scales.pushback ? profile(past, S.scales.pushback) : null;
  const known = AXES.filter(a => now[a.key] !== null).length;
  return card(h("div", { class: "row between" }, h("h3", {}, title), h("span", { class: "muted small" }, `vs ${sc.n} teams`)),
    radarChart([{ p: now, cls: "now" }, ...(last ? [{ p: last, cls: "past" }] : [])]),
    h("div", { class: "legend" }, h("span", {}, h("i", { class: "lg-now" }), `${G.name} ${G.years}`), last ? h("span", {}, h("i", { class: "lg-past" }), "Push Back 2025–26") : null),
    h("p", { class: "muted small" }, known < 4 ? "Not much data yet, so some corners sit at the centre. " : "", "Each corner is a percentile: 50 is a typical team, 100 the best. Consistency needs two or more events."),
    trendChart(st));
}
/** Event by event: win rate as bars, average points as the line. Shows how steady a team is. */
function trendChart(st) {
  const evs = (st?.rankings || []).filter(r => r.wins + r.losses + (r.ties || 0) > 0);
  if (evs.length < 2) return null;
  const W = 300, H = 90, bw = Math.min(36, (W - 10) / evs.length - 6);
  const maxAvg = Math.max(1, ...evs.map(r => Number(r.avg) || 0));
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H + 18}`, class: "trend", role: "img", "aria-label": evs.map(r => `${r.event}: ${r.wins}-${r.losses}-${r.ties}, rank ${r.rank}`).join("; ") });
  const x = i => 5 + (i + 0.5) * ((W - 10) / evs.length);
  svgEl("line", { x1: 0, x2: W, y1: H, y2: H, class: "base" }, svg);
  evs.forEach((r, i) => {
    const wr = (r.wins + 0.5 * (r.ties || 0)) / (r.wins + r.losses + (r.ties || 0));
    svgEl("rect", { x: x(i) - bw / 2, y: H - wr * (H - 8), width: bw, height: Math.max(1, wr * (H - 8)), rx: 3, class: "bar" }, svg);
    const t = svgEl("text", { x: x(i), y: H + 13, "text-anchor": "middle", class: "lab" }, svg); t.textContent = `#${r.rank}`;
  });
  const pts = evs.map((r, i) => (Number(r.avg) > 0 ? [x(i), H - (Number(r.avg) / maxAvg) * (H - 8)] : null)).filter(Boolean);
  if (pts.length >= 2) svgEl("polyline", { points: pts.map(q => q.join(",")).join(" "), class: "line" }, svg);
  pts.forEach(q => svgEl("circle", { cx: q[0], cy: q[1], r: 2.6, class: "pt" }, svg));
  return h("div", { class: "trendbox" }, h("span", { class: "eyebrow" }, "Event by event"), svg,
    h("div", { class: "legend" }, h("span", {}, h("i", { class: "lg-bar" }), "Win rate"), pts.length >= 2 ? h("span", {}, h("i", { class: "lg-line" }), "Avg points") : null, h("span", {}, "#rank under each")));
}

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
  if (S.admin && S.codeRequests?.length) out.push(h("a", { class: "notice admin-ask", href: "#/settings" }, h("b", {},
    `${S.codeRequests.length === 1 ? `${S.codeRequests[0].nickname} is` : `${S.codeRequests.length} people are`} asking for the team code`), h("span", {}, "Open Settings to see who, and to see the code.")));

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
  const mineCard = myScouting(fe);
  if (mineCard) left.push(mineCard);
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
  const hasElims = ev.matches.some(m => m.round > 2);
  const tabs = [hasUs && ["ours", "Ours"], ["matches", "Matches"], hasElims && ["bracket", "Bracket"], ["rankings", "Rankings"], ["teams", "Teams"], ["skills", "Skills"]].filter(Boolean);
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
  } else if (tab === "bracket") {
    out.push(...bracketView(ev));
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
    ev.ours ? lrow({ href: `#/review/${id}`, ic: "review", title: "Event review", sub: "How it went, and a notebook entry" }) : null,
    lrow({ href: `#/select/${id}`, ic: "trophy", title: "Alliance selection", sub: "Cross off teams as they're picked; best still available" }),
    lrow({ href: `#/assign/${id}`, ic: "teams", title: "Scouting assignments", sub: "Split the teams here between our scouts" }),
    lrow({ ic: "download", title: "Export scouting", sub: "Scouting notes, pit sheets and match notes as a spreadsheet (CSV)", onclick: () => exportScouting(ev) }),
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
          sc.length && areasOpen() ? h("span", { class: "pill" }, `★ ${avg.toFixed(1)} from ${sc.length}`) : null),
        note?.ai?.summary && areasOpen() ? h("p", { class: "small" }, note.ai.summary) : note?.stats ? h("p", { class: "small muted" }, note.stats) : null,
        note?.ai?.watch?.length && areasOpen() ? h("p", { class: "small", style: "color:var(--warn)" }, "Watch for: " + note.ai.watch.join(" · ")) : null);
    });
    return h("div", { class: "col" }, section(`${color === "red" ? "Red" : "Blue"} alliance${m.scored ? ` · ${m[color].score}` : ""}`), h("div", { class: "group-list", style: `border-top:4px solid var(--${color})` }, ...rows));
  };
  return [pagehead(m.name, [ev.name, m.field, m.scheduled && !m.scored && `${fmtTime(m.scheduled)}, ${until(m.scheduled)}`].filter(Boolean).join(" · ")),
    p !== undefined ? card(h("div", { class: "row", style: "flex-wrap:nowrap;gap:16px" },
      h("div", { style: "flex:1;display:flex;flex-direction:column;gap:8px;min-width:0" }, h("span", { class: "eyebrow" }, m.scored ? "Predicted before the match" : "Win chance"), probBar(p)),
      ring(Math.max(p, 1 - p), { size: 64, color: p >= 0.5 ? "var(--red)" : "var(--blue)", label: p >= 0.5 ? "red" : "blue" }))) : null,
    h("div", { class: "cols", style: "grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))" }, side_("red"), side_("blue")),
    ...(m.red.teams.includes(us()) || m.blue.teams.includes(us()) ? [...gamePlan(ev, m), ...matchNotes(ev, m)] : [])];
};

// ---- notes on our own matches: what went right, what went wrong, what to change. One per person
// per match; everyone sees all of them (behind the team code), and the AI reads them too.
const mnDraft = {};
function matchNotes(ev, m) {
  watchMatchNotes(m.id);
  const list = S.matchNotes[m.id] || [];
  const mine = list.find(x => x.by === user.uid);
  const out = [section("Our match notes")];
  const d = mnDraft[m.id];
  if (d) {
    const field = (k, label, ph, max) => h("label", { class: "field" }, label, h("textarea", { maxlength: max, rows: 2, placeholder: ph, oninput: e => { d[k] = e.target.value; } }, d[k] || ""));
    out.push(h("form", { class: "card", onsubmit: e => {
      e.preventDefault();
      if (![d.good, d.bad, d.next].some(x => x?.trim())) return;
      setDoc(doc(db, "matchNotes", `${m.id}__${user.uid}`), { event: String(ev.id), match: String(m.id), name: m.name, game: G.key,
        teams: [...m.red.teams, ...m.blue.teams].filter(t => t !== us()), good: (d.good || "").trim().slice(0, 800), bad: (d.bad || "").trim().slice(0, 800),
        next: (d.next || "").trim().slice(0, 400), by: user.uid, nickname: S.nickname, at: serverTimestamp() })
        .catch(err => toast(`Match notes couldn't be saved (${err.code || err.message}).`, "bad"));
      toast(navigator.onLine ? "Match notes saved" : "Saved on this phone. They send when you're back online.");
      mnDraft[m.id] = null; render();
    } },
      field("good", "What went well", "Auto scored, fast cycles, partner did their job", 800),
      field("bad", "What went wrong", "Missed the park, got pushed off the goal, intake jammed", 800),
      field("next", "Change for next time", "Start on the left, play defense on 2088A", 400),
      h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Save"), h("button", { class: "btn", type: "button", onclick: () => { mnDraft[m.id] = null; render(); } }, "Cancel"))));
  } else out.push(h("button", { type: "button", class: "btn", onclick: () => { mnDraft[m.id] = { ...(mine || {}) }; render(); } }, icon("plus"), mine ? "Edit my notes" : "Add notes on this match"));
  if (list.length && !areasOpen()) out.push(areaGate("Match notes", `${list.length} note${list.length === 1 ? "" : "s"} on this match from the team.`, { focus: false }));
  else if (list.length) out.push(group(...list.map(x => h("div", { class: "note" },
    h("div", { class: "meta" }, h("b", {}, x.nickname), h("span", { class: "muted small" }, ago(x.at)), x.pending ? h("span", { class: "pill waiting" }, "Waiting to send") : null),
    x.good ? h("p", {}, h("b", { class: "good-t" }, "Went well: "), x.good) : null,
    x.bad ? h("p", {}, h("b", { class: "bad-t" }, "Went wrong: "), x.bad) : null,
    x.next ? h("p", {}, h("b", {}, "Next time: "), x.next) : null))));
  return out;
}

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
// The extra details on a scouting note. Each is optional; numbers are stored for defense and driver.
const SCOUT_MORE = [
  { key: "drive", label: "Drivetrain", options: ["Tank", "X-drive", "Mecanum", "Other"] },
  { key: "autoSide", label: "Auto side", options: ["Left", "Right", "Both", "Skills only"] },
  { key: "endgame", label: G.key === "pushback" ? "Park" : "Endgame", options: G.key === "pushback" ? ["No park", "Parked", "Double park"] : ["None", "Tried", "Done"] },
  { key: "defense", label: "Defense", options: ["None", "Light", "Heavy"], num: true },
  { key: "driver", label: "Driver", options: ["Shaky", "OK", "Good", "Great"], num: true },
  { key: "reliable", label: "Reliability", options: ["Solid", "Minor issues", "Broke down"] },
];
const SCOUT_TAGS = ["Fast", "Accurate", "Strong auto", "Good defense", "Big scorer", "Smart driver", "Great partner", "Slow", "Tips over", "Jams", "Messy"];
/** Chips where tapping picks one (tap again to clear). `get`/`set` read and write the value. */
function choice(options, get, set, label) {
  const box = h("div", { class: "optchips", role: "group", "aria-label": label });
  const draw = () => box.replaceChildren(...options.map((o, i) => h("button", { type: "button", "aria-pressed": String(get() === o || get() === i + 1),
    onclick: () => { set(get() === o || get() === i + 1 ? null : o, i + 1); draw(); } }, o)));
  draw();
  return box;
}
/** A scouting note's extra details as short labels, for the notes list. */
const scoutBits = x => [
  ...SCOUT_MORE.map(f => { const v = f.num ? f.options[(x[f.key] || 0) - 1] : x[f.key]; return v ? `${f.label}: ${v}` : null; }).filter(Boolean),
  ...(x.tags || []),
];
const draft = {};
views.team = n => {
  watchTeam(n);
  watchPit(n);
  if (G.key === "override") watchPast(n);
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
  const prof = profileCard(st, G.key === "override" ? S.past[n] : null);
  if (prof) left.push(prof);
  if (here) {
    const withUs = ev.ourMatches.filter(om => om.partners.includes(n) || om.opponents.includes(n));
    if (withUs.length) left.push(group(...withUs.map(om => lrow({ href: `#/match/${ev.id}/${om.id}`, title: `${om.partners.includes(n) ? "Partner" : "Opponent"} in ${om.name}`,
      sub: ev.name, trail: om.win !== null ? `${pct(om.win)} to win` : "" }))));
  }
  const notesCard = card(h("h3", {}, "Notes"));
  const open = areasOpen(); // AI notes and our scouting are behind the team code
  if (note?.ai && open) {
    const A = note.ai, list = (title, xs) => xs?.length ? h("div", {}, h("span", { class: "eyebrow" }, title), h("ul", {}, xs.map(s => h("li", {}, s)))) : null;
    notesCard.append(h("p", {}, A.summary));
    if (A.strengths?.length || A.watch?.length || A.weaknesses?.length) notesCard.append(h("div", { class: "bullets" },
      list("Strengths", A.strengths), list("Weaknesses", A.weaknesses), list("Watch for", A.watch)));
    const para = (title, text) => text ? h("div", { class: "notepara" }, h("span", { class: "eyebrow" }, title), h("p", {}, text)) : null;
    notesCard.append(...[para("As our partner", A.asPartner), para("Playing against them", A.asOpponent), para("Trend", A.trend), para("Last season", A.lastSeason)].filter(Boolean));
  }
  if (note?.stats) notesCard.append(h("p", { class: note.ai && open ? "muted small" : "" }, note.stats));
  if (!note) notesCard.append(h("p", { class: "muted" }, note === undefined ? "Loading…" : "No notes yet. Notes are written for every team at our events."));
  else if (note.ai && !open) notesCard.append(h("p", { class: "muted small" }, "AI notes from our scouting are locked. Unlock scouting notes to see them."));
  else notesCard.append(h("p", { class: "muted small" }, note.ai ? `AI notes from results and our scouting, ${ago(note.ai.at)}` : `From ${note.statsEvent || "results"}`));
  left.push(notesCard);
  left.push(section("Season", h("a", { href: "#", onclick: e => { e.preventDefault(); request("team", n); } }, S.requested.has(`team:${n}`) ? "Requested" : "Refresh")));
  if (st?.rankings?.length) left.push(group(...st.rankings.map(x => lrow({ href: x.eventId ? `#/event/${x.eventId}` : undefined, info: !x.eventId,
    title: x.event, sub: `${x.wins}-${x.losses}-${x.ties} · ${x.wp} WP · high ${x.high}`, trail: h("span", { class: `rankbadge${x.rank <= 3 ? " top" : ""}` }, `#${x.rank}`) }))));
  else left.push(h("p", { class: "footnote" }, st === undefined ? "Loading…" : st ? "No events played yet this season." : "No season stats saved for this team yet. Tap Refresh to load them."));

  // Scouting form
  const d = draft[n] ||= { match: "", autoPins: 0, auto: "", rating: 0, notes: "", event: fe?.id || "", tags: [], more: false };
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
    // Saved on the phone first and sent when there's a connection: event Wi-Fi drops all the
    // time, so this doesn't wait for the server (Firestore keeps the write until it goes through).
    const extra = {};
    for (const f of SCOUT_MORE) if (d[f.key]) extra[f.key] = d[f.key];
    if (d.tags.length) extra.tags = d.tags;
    setDoc(doc(collection(db, "scouting")), { team: n, event: String(d.event || ""), match: d.match.trim().slice(0, 20), autoPins: Number(d.autoPins) || 0,
      auto: d.auto, rating: d.rating, notes: d.notes.trim().slice(0, 1000), game: G.key, by: user.uid, nickname: S.nickname, at: serverTimestamp(), ...extra })
      .catch(err => toast(`A note on ${n} couldn't be saved (${err.code || err.message}).`, "bad"));
    toast(navigator.onLine ? `Note on ${n} saved` : `Saved on this phone. It sends when you're back online.`);
    draft[n] = null; render();
  } },
    h("h3", {}, `Scout ${n}`),
    h("div", { class: "grid2", style: "align-items:end" },
      h("label", { class: "field" }, "Match", h("input", { value: d.match, placeholder: "Q12", maxlength: 20, autocapitalize: "characters", oninput: e => { d.match = e.target.value; } })),
      h("div", { class: "field" }, `${PIECE[0].toUpperCase() + PIECE.slice(1)}s in auto`, h("div", { class: "stepper" },
        h("button", { type: "button", "aria-label": `One fewer ${PIECE}`, onclick: () => stepPins(-1) }, "−"), pins,
        h("button", { type: "button", "aria-label": `One more ${PIECE}`, onclick: () => stepPins(1) }, "+")))),
    h("div", { class: "field" }, "Auto", opts),
    h("div", { class: "field" }, "How good", stars), // not a <label>: it would re-click the first star
    h("details", { class: "more-fields", open: d.more || null, ontoggle: e => { d.more = e.target.open; } },
      h("summary", {}, "More details", h("span", { class: "muted small" }, "drivetrain, auto side, endgame, defense, driver, reliability, tags")),
      ...SCOUT_MORE.map(f => h("div", { class: "field" }, f.label, choice(f.options, () => d[f.key], (v, i) => { d[f.key] = v === null ? null : f.num ? i : v; }, f.label))),
      h("div", { class: "field" }, "Tags", (() => {
        const box = h("div", { class: "optchips", role: "group", "aria-label": "Tags" });
        const draw = () => box.replaceChildren(...SCOUT_TAGS.map(t => h("button", { type: "button", "aria-pressed": String(d.tags.includes(t)),
          onclick: () => { d.tags = d.tags.includes(t) ? d.tags.filter(x => x !== t) : [...d.tags, t]; draw(); } }, t)));
        draw();
        return box;
      })())),
    h("label", { class: "field" }, "Notes", h("textarea", { maxlength: 1000, placeholder: "Driving, defense, what they score, anything breaking", oninput: e => { d.notes = e.target.value; } }, d.notes)),
    msg, h("button", { class: "btn primary wide", type: "submit" }, "Save note"));
  right.push(pitCard(n, open), form);
  if (!open && sc.length) right.push(areaGate("Our scouting", `${sc.length} note${sc.length === 1 ? "" : "s"} on ${n} from the team.`, { focus: false }));
  else if (sc.length) right.push(section(`Our scouting · ★ ${avg.toFixed(1)}`), group(...sc.map(x => h("div", { class: "note" },
    h("div", { class: "meta" }, h("b", {}, x.nickname), h("span", { class: "muted small" }, [x.match, ago(x.at)].filter(Boolean).join(" · ")),
      x.pending ? h("span", { class: "pill waiting", title: "Saved on this phone; sends when there's a connection" }, "Waiting to send") : null),
    h("span", { class: "starline", "aria-label": `${x.rating} of 5 stars` }, "★".repeat(x.rating) + "☆".repeat(5 - x.rating)),
    x.auto || x.autoPins ? h("span", { class: "small muted" }, [x.auto, x.autoPins ? `${x.autoPins} auto ${PIECE}s` : ""].filter(Boolean).join(" · ")) : null,
    scoutBits(x).length ? h("div", { class: "row tagrow" }, scoutBits(x).map(b => h("span", { class: "pill" }, b))) : null,
    x.notes ? h("p", {}, x.notes) : null,
    x.by === user.uid ? h("button", { class: "btn small danger", style: "align-self:flex-start", onclick: () => { if (confirm("Delete this note?")) deleteDoc(doc(db, "scouting", x.id)); } }, "Delete") : null))));
  right.push(group(lrow({ href: reTeam(n), title: "Open on VEX Events", external: true })));

  return [h("header", { class: "profile" }, h("div", { class: "t" }, h("h1", {}, n), h("p", {}, [t?.name, t?.org, [t?.city, t?.region].filter(Boolean).join(", ")].filter(Boolean).join(" · ")))),
    h("div", { class: "cols" }, h("div", { class: "col" }, ...left), h("div", { class: "col" }, ...right))];
};

// ---- pit scouting: one shared sheet per team, filled in at their pit. Anyone can edit it.
const PIT_FIELDS = [
  ["motors", "Motors and gearing", "6 motors, 450 rpm", 60],
  ["intake", "Intake", "What it picks up, how fast", 300],
  ["scoring", "Scoring", "What they score and where", 300],
  ["endgame", G.key === "pushback" ? "Parking" : "Endgame", "What they do at the end", 300],
  ["autos", "Autos they have", "Which sides, how many points, solo AWP?", 300],
  ["strategy", "Their game plan", "How they like to play, what they want in a partner", 300],
];
const pitDraft = {};
function pitCard(n, open) {
  const p = S.pits[n];
  if (pitDraft[n]) {
    const d = pitDraft[n];
    const save = e => {
      e.preventDefault();
      const data = { team: n, game: G.key, by: user.uid, nickname: S.nickname, at: serverTimestamp(), notes: (d.notes || "").trim().slice(0, 1000) };
      if (d.drive) data.drive = d.drive;
      for (const [k, , , max] of PIT_FIELDS) if ((d[k] || "").trim()) data[k] = d[k].trim().slice(0, max);
      setDoc(doc(db, "pits", `${n}__${G.key}`), data).catch(err => toast(`Pit notes on ${n} couldn't be saved (${err.code || err.message}).`, "bad"));
      toast(navigator.onLine ? `Pit notes on ${n} saved` : "Saved on this phone. They send when you're back online.");
      pitDraft[n] = null; render();
    };
    return h("form", { class: "card", onsubmit: save },
      h("div", { class: "row between" }, h("h3", {}, `Pit scouting · ${n}`), h("button", { type: "button", class: "btn small plain", onclick: () => { pitDraft[n] = null; render(); } }, "Cancel")),
      h("div", { class: "field" }, "Drivetrain", choice(SCOUT_MORE[0].options, () => d.drive, v => { d.drive = v; }, "Drivetrain")),
      ...PIT_FIELDS.map(([k, label, ph, max]) => h("label", { class: "field" }, label, h(max > 60 ? "textarea" : "input", { maxlength: max, placeholder: ph, rows: 2, value: max > 60 ? null : d[k] || "", oninput: e => { d[k] = e.target.value; } }, max > 60 ? d[k] || "" : null))),
      h("label", { class: "field" }, "Anything else", h("textarea", { maxlength: 1000, placeholder: "Build quality, weight, who the driver is, what they said", oninput: e => { d.notes = e.target.value; } }, d.notes || "")),
      h("button", { class: "btn primary wide", type: "submit" }, "Save pit notes"));
  }
  const edit = h("button", { type: "button", class: "btn small", onclick: () => { pitDraft[n] = { ...(p || {}) }; render(); } }, p ? "Edit" : "Add pit notes");
  if (!p) return card(h("div", { class: "row between" }, h("h3", {}, "Pit scouting"), edit), h("p", { class: "muted small" }, p === undefined ? "Loading…" : "Nobody has scouted their pit yet. Drivetrain, intake, autos and their game plan, from talking to them."));
  if (!open) return card(h("div", { class: "row between" }, h("h3", {}, "Pit scouting"), edit), h("p", { class: "muted small" }, `Pit notes by ${p.nickname}, ${ago(p.at)}. Unlock scouting notes to read them.`));
  const rows = [["Drivetrain", p.drive], ...PIT_FIELDS.map(([k, label]) => [label, p[k]]), ["Notes", p.notes]].filter(([, v]) => v);
  return card(h("div", { class: "row between" }, h("h3", {}, "Pit scouting"), edit),
    h("dl", { class: "pitlist" }, rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
    h("p", { class: "muted small" }, `By ${p.nickname}, ${ago(p.at)}`, p.pending ? " · waiting to send" : ""));
}

// ---- autos (view only; edited in the robot repo's scout/autos.json)
const T = 23.8, W = 3 * T;
const PX = 2 * W / 1464; // inches per pixel of the 1514 x 1508 field render (inside walls at x 23-1487, y 22-1485)
const CLAW = 12;
let side = store.get("alliance", "red"), pathMode = store.get("pathMode", "show"), autoGroup = "All", anim = null;
if (!["show", "faint", "hide"].includes(pathMode)) pathMode = "show";
const normH = d => ((d % 360) + 360) % 360;
const pose = s => side === "blue" ? [-s.x, -s.y, normH(s.h + 180)] : [s.x, s.y, s.h];
// Blue routes are the red ones turned 180°, so left/right and top/bottom swap too
const DIRS = { left: "right", right: "left", top: "bottom", bottom: "top", Left: "Right", Right: "Left", Top: "Bottom", Bottom: "Top" };
const flipDirs = s => s.replace(/\b(left|right|top|bottom|Left|Right|Top|Bottom)\b/g, w => DIRS[w]);
const textFor = s => side === "blue" ? flipDirs(s.replace(/Red Goal/g, "Blue Goal").replace(/to red/g, "to blue").replace(/(\d+)°/g, (m, d) => normH(+d + 180) + "°")) : s;
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
  if (!areasOpen()) return [pagehead("Autos"), areaGate("Autos", "Our autonomous routes are for the team only.")];
  if (G.key !== "override") return [pagehead("Autos"), notice(`Our autos are written for Override, this season's game. Switch the game back to Override in Settings to see them.`, `No ${G.name} autos`, "autos"),
    group(lrow({ href: "#/settings", title: "Change game", sub: `Showing ${G.name} ${G.years}` }))];
  watchAutos();
  if (S.autos === undefined) return [pagehead("Autos"), ...skeleton(300)];
  const a = id && S.autos.autos.find(x => x.id === id);
  if (id && !a) return [notice("That auto isn't in the list any more.", "Not found")];
  return a ? autoDetail(a) : autoList();
};
// ---- auto picker: filters -> the best auto and backups
let pickF = { quad: "left", aim: "points", ends: "any", fast: false, ...store.get("autoPick", {}) };
if (pickF.quad === "top") pickF.quad = "left"; // no top-quadrant autos: it's on the other side of the autonomous line
const setPick = patch => { pickF = { ...pickF, ...patch }; store.set("autoPick", pickF); render(); };
const LEVEL = { low: 0, medium: 1, high: 2 };
function pickAutos(list) {
  const limit = pickF.quad === "skills" ? 60 : 15;
  const fits = a => a.quad === pickF.quad && (pickF.fast ? a.fast : a.real) <= limit && (pickF.ends === "any" || a.ends === pickF.ends);
  const key = a => pickF.aim === "safe" ? [LEVEL[a.level], -a.points, a.real] : [-a.points, LEVEL[a.level], a.real];
  return list.filter(fits).sort((x, y) => { const p = key(x), q = key(y); for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return p[i] - q[i]; return 0; });
}
function autoPicker(list, onMap = false) {
  if (!list.some(a => a.quad)) return null; // older autos without the numbers
  const chipRow = (label, opts, cur, onpick) => h("div", { class: "pickrow" }, h("span", { class: "muted small" }, label),
    h("div", { class: "chips" }, opts.map(([v, t]) => h("button", { type: "button", "aria-pressed": String(v === cur), onclick: () => onpick(v) }, t))));
  const res = pickAutos(list);
  // on the Field map a result opens its route on the map; on the Autos page, the playback
  const row = (a, tag) => h("div", { class: "pickres" },
    h("a", { class: "auto-row", href: onMap ? `#/fieldmap/${a.id}` : `#/autos/${a.id}` }, fieldSvg(a, true),
      h("span", { class: "tx" }, h("b", {}, textFor(a.name)),
        h("span", {}, `${tag} · ${a.points} pts · ${pickF.fast ? a.fast : a.real} s · ${a.level} risk${a.ends === "midfield" ? " · ends in the midfield" : a.ends === "loader" ? " · ends at the loader" : ""}`)),
      h("span", {}), icon("chev", "chev")),
    onMap ? h("a", { class: "btn small", href: `#/autos/${a.id}` }, "Play") : h("a", { class: "btn small", href: `#/fieldmap/${a.id}` }, "Map"));
  return [section("Pick an auto"),
    h("div", { class: "card picker" },
      chipRow("We start in", [["left", textFor("Left (our wall)")], ["bottom", textFor("Bottom")], ["skills", "Skills run"]], pickF.quad, v => setPick({ quad: v })),
      chipRow("We want", [["points", "Most points"], ["safe", "Safest"]], pickF.aim, v => setPick({ aim: v })),
      chipRow("End", [["any", "Anywhere"], ["midfield", "In the midfield"], ["loader", "At the loader"]], pickF.ends, v => setPick({ ends: v })),
      chipRow("Robot speed", [[false, "Today's speed"], [true, "Full speed (tuned)"]], pickF.fast, v => setPick({ fast: v }))),
    res.length ? group(row(res[0], "Best"), ...res.slice(1, 4).map((a, i) => row(a, `Backup ${i + 1}`)))
      : notice(pickF.ends !== "any" ? "No auto from there ends that way. Try End: Anywhere." : "Nothing fits in the time at today's speed. Try Full speed.", "No match", "autos")];
}
function autoList() {
  const groups = ["All", ...new Set(S.autos.autos.map(a => a.group))];
  const shown = S.autos.autos.filter(a => autoGroup === "All" || a.group === autoGroup);
  return [pagehead("Autos", "View only. Tap one to play it on the field."),
    group(lrow({ href: "#/fieldmap", ic: "autos", title: "Field map", sub: "What Red Goal 2, the bottom toggle, a wall pin… mean" })),
    ...(autoPicker(S.autos.autos) || []),
    section("All autos"),
    h("div", { class: "chips" }, groups.map(g => h("button", { type: "button", "aria-pressed": String(g === autoGroup), onclick: () => { autoGroup = g; render(); } }, textFor(g)))),
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
// Robot practice for tuning the autos: what to do and what to send back
const PRACTICE_LIST = { name: "Practice day", items: [
  "Full battery in the robot", "Merge the latest robot PR, pull, upload with USB on the brain",
  "Claw flat and cascade fully down before turning the robot on", "Keep the robot still for 3 s at startup (IMU)",
  "Brain Devices screen: is port 1 (claw arm) showing a motor?", "Third cascade motor: write down its port",
  "Drive test (Left arrow): photo of the brain screen", "Turn test (Right arrow): photo of the brain screen",
  "Test B (pick up) and Y (reset) on a stacked pin and cup", "Cascade number at short-goal scoring height",
  "Cascade number at tall-goal scoring height", "Photo: claw on a pin, tape from robot front to pin center",
  "Photo: backed onto a goal, tape from robot back to goal center", "Autos on, run Toggle + preload, film it",
  "Send the photos, numbers and videos to Claude"] };
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
        await setDoc(doc(db, "checklists", id), { name: name.trim().slice(0, 40), order: S.lists.length, items: [], done: {}, by: user.uid, at: serverTimestamp() }); } }, icon("plus"), "New list"),
      S.lists.some(x => x.name === PRACTICE_LIST.name) ? null : h("button", { type: "button", onclick: async () => { const id = newId();
        listId = id; store.set("list", id);
        await setDoc(doc(db, "checklists", id), { name: PRACTICE_LIST.name, order: S.lists.length, items: PRACTICE_LIST.items.map(text => ({ id: newId(), text })), done: {}, by: user.uid, at: serverTimestamp() }); } }, icon("plus"), "Practice day")),
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
  if (!areasOpen()) return [h("div", { class: "wb-head" }, h("button", { type: "button", class: "back", onclick: exitTo }, icon("back"), h("span", {}, "Done")), h("div", { class: "wb-title" }, h("b", {}, "Whiteboard")), h("span", {})),
    h("div", { class: "gate-wrap" }, areaGate("The whiteboard", "Our plays are for the team only."))];
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
/**
 * Checks the team code for the pit display and the locked areas. The app only has the code's
 * hash (meta/lock). Before the sync has stored it, this account's own password is asked instead.
 * Five wrong tries in a row pause checking for 30 seconds.
 */
let lockDoc;
async function codeCheck() {
  lockDoc ??= await getDoc(doc(db, "meta", "lock")).then(d => (d.exists() ? d.data() : null)).catch(() => null);
  const lock = lockDoc;
  return {
    what: lock ? "team code" : "account password",
    placeholder: lock ? "Team code" : "Password",
    async check(v) {
      if (Date.now() < unlockWait) return `Too many tries. Wait ${Math.ceil((unlockWait - Date.now()) / 1000)} s.`;
      const ok = lock ? (await sha256(`19109m-pit:${v}`)) === lock.hash
        : await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, v)).then(() => true, () => false);
      if (ok) { unlockTries = 0; return true; }
      if (++unlockTries >= 5) { unlockTries = 0; unlockWait = Date.now() + 30e3; return "Wrong 5 times. Try again in 30 seconds."; }
      return `That's not the ${lock ? "team code" : "account password"}.`;
    },
  };
}
async function openUnlock() {
  if (document.querySelector(".unlock")) return;
  const { what, placeholder, check } = await codeCheck();
  const input = h("input", { type: "password", autocomplete: "off", placeholder, "aria-label": what });
  const msg = h("p", { class: "error", role: "alert" });
  const close = () => { bg.remove(); box.remove(); };
  const bg = h("div", { class: "sheet-bg unlock-bg", onclick: close });
  const box = h("form", { class: "sheet unlock", role: "dialog", "aria-modal": "true", "aria-label": "Unlock pit display", onsubmit: async e => {
      e.preventDefault();
      const v = input.value.trim(); if (!v) return;
      msg.textContent = "";
      const fb = verdict(box.querySelector("button[type=submit]"));
      const ok = await check(v);
      await fb.done(ok === true);
      if (ok !== true) { input.value = ""; box.classList.remove("shake"); void box.offsetWidth; box.classList.add("shake"); msg.textContent = ok; return; }
      pitLocked = false; store.set("pitLock", false); close();
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      location.hash = "#/";
    } },
    h("div", { class: "head" }, h("h3", {}, "Unlock pit display"), h("button", { class: "btn small plain", type: "button", onclick: close }, "Cancel")),
    h("p", { class: "muted small" }, `Enter the ${what} to leave the pit display.`), secret(input, what), msg,
    h("button", { class: "btn primary wide", type: "submit" }, icon("lock"), "Unlock"),
    askAdmin("Pit display", S.nickname));
  box.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
  document.body.append(bg, box);
  input.focus();
}
document.addEventListener("fullscreenchange", () => { if (lastName === "pit") refresh(); });

// ---- locked areas: Autos, the Whiteboard and our scouting notes need the team code too.
// Once it's entered they stay open on this device for 12 hours (or a week, or 30 days: the
// person's choice), or until they lock it again with the lock in the top bar or in Settings.
// This locks the screens, not the data: everyone who can sign in is already a team member.
const UNLOCK_CHOICES = [[12, "12 hours"], [168, "1 week"], [720, "30 days"]];
const unlockHours = () => store.get("unlockHours", 12);
const unlockLabel = () => (UNLOCK_CHOICES.find(([h_]) => h_ === unlockHours()) || UNLOCK_CHOICES[0])[1];
const areasOpen = () => store.get("areasOpenUntil", 0) > Date.now();
const openAreas = () => store.set("areasOpenUntil", Date.now() + unlockHours() * 3600e3);
const lockAreas = () => { store.set("areasOpenUntil", 0); render(); };
// The code field is a real password field with a username next to it, so the phone's password
// manager can save the team code and fill it in with Face ID or a fingerprint next time.
const codeUser = () => h("input", { type: "text", name: "username", autocomplete: "username", value: "19109M team code", tabindex: "-1", "aria-hidden": "true", class: "pm-user", readonly: true });
/** The lock in the top bar: one tap to unlock everything (team code), or to lock it again. */
function lockButton() {
  const open = areasOpen();
  return h("button", { type: "button", class: `lockbtn${open ? " open" : ""}`, "aria-label": open ? "Lock team notes" : "Unlock team notes", title: open ? "Unlocked: tap to lock" : "Unlock team notes",
    onclick: () => { if (open) { lockAreas(); toast("Locked"); } else quickUnlock(); } }, icon(open ? "unlock" : "lock"));
}
async function quickUnlock() {
  if (document.querySelector(".unlock")) return;
  const { what, placeholder, check } = await codeCheck();
  const input = h("input", { type: "password", name: "password", autocomplete: "current-password", placeholder, "aria-label": what, enterkeyhint: "go" });
  const msg = h("p", { class: "error", role: "alert" });
  const close = () => { bg.remove(); box.remove(); };
  const bg = h("div", { class: "sheet-bg unlock-bg", onclick: close });
  const box = h("form", { class: "sheet unlock", method: "post", action: "#", role: "dialog", "aria-modal": "true", "aria-label": "Unlock team notes", onsubmit: async e => {
      e.preventDefault();
      const v = input.value.trim(); if (!v) return;
      msg.textContent = "";
      const fb = verdict(box.querySelector("button[type=submit]"));
      const ok = await check(v);
      await fb.done(ok === true);
      if (ok !== true) { input.value = ""; box.classList.remove("shake"); void box.offsetWidth; box.classList.add("shake"); msg.textContent = ok; input.focus(); return; }
      gateMsg = ""; openAreas(); close(); render();
      toast(`Unlocked for ${unlockLabel()}`);
    } },
    h("div", { class: "head" }, h("h3", {}, "Unlock team notes"), h("button", { class: "btn small plain", type: "button", onclick: close }, "Cancel")),
    h("p", { class: "muted small" }, `Scouting notes, pit sheets, match notes, autos and the whiteboard. Enter the ${what} once.`),
    codeUser(), secret(input, what), msg,
    h("div", { class: "field" }, "Keep unlocked on this phone for", seg(UNLOCK_CHOICES.map(([v, l]) => [v, l]), unlockHours(), v => { store.set("unlockHours", v); box.querySelectorAll(".seg button").forEach(b => b.setAttribute("aria-pressed", String(Number(b.dataset.v) === v))); }, "mini")),
    h("button", { class: "btn primary wide", type: "submit" }, icon("unlock"), "Unlock"),
    askAdmin("Team notes", S.nickname));
  box.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
  document.body.append(bg, box);
  input.focus();
}
let gateMsg = ""; // kept outside the form so a live-data redraw doesn't wipe "wrong code"
function areaGate(title, why, { focus = true } = {}) {
  const input = h("input", { type: "password", name: "password", autocomplete: "current-password", "aria-label": "Team code", enterkeyhint: "go" });
  const msg = h("p", { class: "error", role: "alert" }, gateMsg);
  const what = h("span", {}, "team code");
  codeCheck().then(c => { what.textContent = c.what; input.placeholder = c.placeholder; input.setAttribute("aria-label", c.what); });
  const form = h("form", { class: "card gate", onsubmit: async e => {
    e.preventDefault();
    const v = input.value.trim(); if (!v) return;
    gateMsg = ""; document.querySelectorAll(".gate .error").forEach(m => { m.textContent = ""; }); // a new try clears the old "wrong"
    const fb = verdict(form.querySelector("button[type=submit]"));
    const ok = await (await codeCheck()).check(v);
    await fb.done(ok === true);
    if (ok !== true) { input.value = ""; gateMsg = ok; document.querySelectorAll(".gate .error").forEach(m => { m.textContent = ok; }); const f = document.querySelector(".gate") || form; f.classList.remove("shake"); void f.offsetWidth; f.classList.add("shake"); return; }
    gateMsg = "";
    openAreas();
    input.blur(); render();
  } },
    h("span", { class: "gate-icon", "aria-hidden": "true" }, icon("lock")),
    h("h2", {}, `${title} ${/s$/.test(title) && title !== "Autos" ? "are" : "is"} locked`),
    h("p", { class: "muted" }, why, " Enter the ", what, ` to open everything on this device for ${unlockLabel()} (change it in Settings or the lock at the top).`),
    codeUser(), secret(input, "team code"), msg,
    h("button", { class: "btn primary wide", type: "submit" }, icon("lock"), "Unlock"),
    askAdmin(title, S.nickname));
  if (focus) setTimeout(() => { if (form.isConnected && matchMedia("(hover: hover)").matches) input.focus(); }, 50);
  return form;
}

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
    const mins = (ms(next.m.scheduled) - Date.now()) / 60e3, q = queueState(ev);
    if (q?.due && mins > -2) return ["Queue now", `${shortName(next.m.name)} on ${next.m.field || "the field"}`];
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

// ---- "Queue now" alerts. Our next match is due when it's at most QUEUE.ahead matches away in
// our division, or QUEUE.minutes from its scheduled time (same rule as sync/alerts.mjs, which
// sends the phone notifications). In the app: a banner on every page, plus a chime and a buzz once.
const QUEUE = { ahead: 3, minutes: 10 };
function queueState(ev) {
  if (!ev?.matches) return null;
  const next = ev.matches.find(m => !m.scored && (m.red.teams.includes(us()) || m.blue.teams.includes(us())));
  if (!next) return null;
  const same = ev.matches.filter(m => m.div === next.div && m.round === next.round);
  const ahead = same.slice(0, same.indexOf(next)).filter(m => !m.scored).length;
  const mins = (ms(next.scheduled) - Date.now()) / 60e3;
  return { next, ahead, mins, due: ahead <= QUEUE.ahead || (Number.isFinite(mins) && mins <= QUEUE.minutes) };
}
let alertAudio = null;
// Phones only play sound after a tap, so get the alertAudio ready on the first one.
addEventListener("pointerdown", () => { try { alertAudio ||= new (window.AudioContext || window.webkitAudioContext)(); alertAudio.resume?.(); } catch {} }, { once: true, capture: true });
function chime() {
  try {
    if (!alertAudio) return;
    [0, 0.22, 0.44].forEach((t, i) => {
      const o = alertAudio.createOscillator(), g = alertAudio.createGain(), at = alertAudio.currentTime + t;
      o.frequency.value = [880, 1175, 1568][i]; o.type = "sine";
      g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.35, at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      o.connect(g).connect(alertAudio.destination); o.start(at); o.stop(at + 0.4);
    });
  } catch {}
}
/** The banner for the top of every page while our next match is due (and the chime, once). */
function queueBanner() {
  const fe = S.status ? focusEvent() : null, ev = fe && isLive(fe) && S.events[fe.id];
  const q = ev && queueState(ev);
  if (!q?.due) return null;
  const m = q.next, color = m.red.teams.includes(us()) ? "red" : "blue", other = color === "red" ? "blue" : "red";
  const told = store.get("queueTold", []);
  if (!told.includes(m.id) && store.get("inAppAlerts", true)) {
    store.set("queueTold", [...told.slice(-40), m.id]);
    chime(); navigator.vibrate?.([300, 120, 300, 120, 300]);
  }
  const partners = m[color].teams.filter(t => t !== us());
  return h("a", { class: `queue ${color}`, href: `#/match/${fe.id}/${m.id}`, role: "alert" },
    h("span", { class: "qicon", "aria-hidden": "true" }, icon("bell")),
    h("span", { class: "tx" }, h("b", {}, `Queue now · ${shortName(m.name)}`),
      h("span", {}, [`${color === "red" ? "Red" : "Blue"}${partners.length ? ` with ${partners.join(", ")}` : ""} vs ${m[other].teams.join(", ")}`, m.field,
        q.ahead ? `${q.ahead} match${q.ahead === 1 ? "" : "es"} before ours` : "We're next"].filter(Boolean).join(" · "))),
    icon("chev", "chev"));
}

// ---- phone notifications for queue alerts (Web Push; the sync job sends them)
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && location.protocol === "https:";
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const installed = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const b64ToBytes = b64 => { const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, c => c.charCodeAt(0)); };
let pushBusy = false, pushMsg = "";
async function pushOn() {
  pushBusy = true; pushMsg = ""; render();
  try {
    if (await Notification.requestPermission() !== "granted") throw new Error("Notifications are blocked for Scout. Allow them in your phone's settings, then try again.");
    const key = (await getDoc(doc(db, "meta", "push"))).data()?.publicKey;
    if (!key) throw new Error("Alerts aren't ready yet: the sync sets them up the next time it runs.");
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    const j = sub.toJSON(), id = (await sha256(j.endpoint)).slice(0, 40);
    await setDoc(doc(db, "pushSubs", id), { by: user.uid, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, at: serverTimestamp() });
    store.set("pushSub", id);
    reg.showNotification("Match alerts are on", { body: "You'll get a notification like this when it's time to queue.", icon: "icon-180.png", tag: "push-on" });
  } catch (err) { pushMsg = err.message; }
  pushBusy = false; render();
}
async function pushOff() {
  pushBusy = true; render();
  try {
    const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
    const id = store.get("pushSub", null) || (sub && (await sha256(sub.endpoint)).slice(0, 40));
    if (id) await deleteDoc(doc(db, "pushSubs", id)).catch(() => {});
    await sub?.unsubscribe();
  } catch {}
  store.set("pushSub", null); pushBusy = false; render();
}
function alertsSection() {
  const on = !!store.get("pushSub", null) && pushSupported() && Notification.permission === "granted";
  const phone = !pushSupported()
    ? lrow({ info: true, ic: "bell", title: "Phone notifications", sub: isIOS && !installed() ? "On iPhone and iPad: Share → Add to Home Screen, then open Scout from there to turn these on." : "This browser can't get notifications. Try Chrome or Safari, or the Home Screen app." })
    : lrow({ info: true, ic: "bell", title: "Phone notifications", sub: pushMsg || (on ? "On for this device, even with the app closed" : "Off for this device"),
      trail: h("button", { type: "button", class: `btn small${on ? "" : " primary"}`, disabled: pushBusy, onclick: on ? pushOff : pushOn }, pushBusy ? "…" : on ? "Turn off" : "Turn on") });
  return [section("Match alerts"),
    group(phone,
      lrow({ info: true, ic: "bell", title: "In the app", sub: "Banner, chime and buzz while Scout is open",
        trail: seg([["on", "On"], ["off", "Off"]], store.get("inAppAlerts", true) ? "on" : "off", v => { store.set("inAppAlerts", v === "on"); if (v === "on") chime(); render(); }, "mini") })),
    h("p", { class: "footnote" }, `"Queue now" goes off once per match, when ours is ${QUEUE.ahead} matches away or ${QUEUE.minutes} minutes from its scheduled time.`)];
}

// ---- small messages at the bottom ("Note saved"), and the offline bar
function toast(text, kind = "") {
  document.querySelector(".toast")?.remove();
  const t = h("div", { class: `toast ${kind}`, role: "status" }, text);
  document.body.append(t);
  setTimeout(() => { t.classList.add("gone"); setTimeout(() => t.remove(), 300); }, 3200);
}
addEventListener("online", () => { toast("Back online. Saved notes are sending."); refresh(); });
addEventListener("offline", () => refresh());
const offlineBar = () => navigator.onLine ? null : h("div", { class: "offline", role: "status" }, icon("wifi"), h("span", {}, h("b", {}, "Offline. "), "Showing saved data; scouting notes save on this phone and send when you're back."));

// ---------------------------------------------------------------- AI: Ask Scout (chat) and Scout for me
// Both are jobs in aiJobs that the sync job answers with Claude (sync/assist.mjs), within the
// team's daily budget (meta/ai). The chat keeps its history on this phone.
const aiReady = () => S.ai?.enabled;
const money = x => `$${x < 10 ? x.toFixed(2) : x.toFixed(0)}`;
function aiSection() {
  if (!S.ai) return [];
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
  const today = S.ai.day === day, thisMonth = S.ai.month === day.slice(0, 7);
  const mine = today ? S.ai.people?.[user.uid] || 0 : 0;
  return [section("AI"),
    group(lrow({ info: true, ic: "scout", title: S.ai.enabled ? "Ask Scout and Scout for me" : "AI isn't set up", sub: S.ai.enabled
      ? `This month: ${money(thisMonth ? S.ai.monthUsd || 0 : 0)} of ${money(S.ai.monthCap || 50)} · Today: ${money(today ? S.ai.usd || 0 : 0)} of ${money(S.ai.cap || 5)} · You today: ${money(mine)} of ${money(S.ai.perPerson || 2)}`
      : "An admin adds the ANTHROPIC_API_KEY secret on GitHub to turn it on." })),
    h("p", { class: "footnote" }, "Uses Claude Haiku (Anthropic's low-cost model). The monthly budget covers everyone, including the nightly AI team notes; daily limits reset at midnight Toronto time.")];
}

/** Light formatting for AI answers: paragraphs, "- " lists, **bold** and team numbers as links. Never HTML. */
function richText(text) {
  const inline = line => {
    const out = [];
    for (const part of String(line).split(/(\*\*[^*]+\*\*)/)) {
      if (/^\*\*[^*]+\*\*$/.test(part)) { out.push(h("b", {}, part.slice(2, -2))); continue; }
      let last = 0;
      for (const m of part.matchAll(/\b(\d{1,6}[A-Z])\b/g)) {
        out.push(part.slice(last, m.index), h("a", { href: teamHref(m[1]) }, m[1]));
        last = m.index + m[1].length;
      }
      out.push(part.slice(last));
    }
    return out;
  };
  const blocks = [];
  let list = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    const item = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)/);
    if (item) { if (!list) blocks.push(list = h("ul", {})); list.append(h("li", {}, inline(item[1]))); continue; }
    list = null;
    if (line) blocks.push(h("p", {}, inline(line.replace(/^#+\s*/, ""))));
  }
  return blocks;
}

const chatKey = `chat.${G.key}`;
let chat = store.get(chatKey, []), chatJob = null, chatUnsub = null, chatStep = "";
function chatButton(name) {
  let b = document.querySelector(".chatfab");
  const hide = IMMERSIVE.has(name) || document.querySelector(".chatpanel");
  if (hide) { b?.remove(); return; }
  if (!b) document.body.append(b = h("button", { type: "button", class: "chatfab", "aria-label": "Ask Scout (AI chat)", onclick: () => openChat() }, icon("chat"), h("span", {}, "Ask")));
}
function closeChat() {
  const p = document.querySelector(".chatpanel"), bg = document.querySelector(".chat-bg");
  if (!p) return;
  p.classList.add("closing"); bg?.classList.add("closing");
  setTimeout(() => { p.remove(); bg?.remove(); chatButton(lastName); }, calm.matches ? 0 : 180);
}
function openChat(prefill = "") {
  if (document.querySelector(".chatpanel")) return;
  document.querySelector(".chatfab")?.remove();
  const list = h("div", { class: "chatlog", "aria-live": "polite" });
  const input = h("textarea", { rows: 1, placeholder: "Ask about a team, an event, or who to pick", "aria-label": "Message", maxlength: 1500,
    oninput: () => { input.style.height = "auto"; input.style.height = `${Math.min(140, input.scrollHeight)}px`; },
    onkeydown: e => { if (e.key === "Enter" && !e.shiftKey && matchMedia("(hover: hover)").matches) { e.preventDefault(); send(); } } }, prefill);
  const sendBtn = h("button", { type: "submit", class: "btn primary send", "aria-label": "Send" }, icon("send"));
  const form = h("form", { class: "chatinput", onsubmit: e => { e.preventDefault(); send(); } }, input, sendBtn);
  const draw = () => {
    const kids = [];
    if (!chat.length) kids.push(h("div", { class: "chathello" }, h("span", { class: "gate-icon", "aria-hidden": "true" }, icon("scout")),
      h("b", {}, "Ask Scout"), h("p", { class: "muted small" }, `Questions about teams, events, rankings and picks, answered from live VEX Events data (${G.name}).`),
      h("div", { class: "chips" }, ["What's our next match and our chances?", "Who are the strongest teams at our next event?", "How did 16610V do last season?", "Who would make a good alliance partner for us?"]
        .map(q => h("button", { type: "button", onclick: () => { input.value = q; send(); } }, q)))));
    for (const m of chat) kids.push(h("div", { class: `msg ${m.role}${m.error ? " error" : ""}` }, m.role === "assistant" ? richText(m.text) : h("p", {}, m.text)));
    if (chatJob) kids.push(h("div", { class: "msg assistant typing" }, h("span", { class: "dots", "aria-hidden": "true" }, h("i"), h("i"), h("i")), h("span", { class: "muted small" }, chatStep || "Thinking…")));
    if (S.ai && !aiReady()) kids.push(h("p", { class: "footnote" }, "AI isn't set up yet: an admin adds the ANTHROPIC_API_KEY secret on GitHub."));
    list.replaceChildren(...kids);
    sendBtn.disabled = !!chatJob;
    list.scrollTop = list.scrollHeight;
  };
  async function send() {
    const text = input.value.trim();
    if (!text || chatJob) return;
    if (!navigator.onLine) { toast("You're offline. Ask again when you're connected.", "bad"); return; }
    chat.push({ role: "user", text }); input.value = ""; input.style.height = "auto";
    chat = chat.slice(-30); store.set(chatKey, chat);
    chatStep = "Sending…"; chatJob = "…"; draw();
    try {
      const ref = await addDoc(collection(db, "aiJobs"), { kind: "chat", by: user.uid, nickname: S.nickname, at: serverTimestamp(), game: G.key, status: "new",
        messages: chat.filter(m => !m.error).slice(-12).map(m => ({ role: m.role, text: m.text.slice(0, 2000) })), open: areasOpen() });
      chatJob = ref.id; chatStep = "Waiting for Scout…"; draw();
      const timer = setTimeout(() => { if (chatJob === ref.id) { chatStep = "Still waiting. Scout answers while the sync is running."; draw(); } }, 25e3);
      chatUnsub?.();
      chatUnsub = onSnapshot(ref, snap => {
        const j = snap.data();
        if (!j) return;
        if (j.step) chatStep = j.step;
        if (j.status === "done" || j.status === "error") {
          clearTimeout(timer); chatUnsub?.(); chatUnsub = null; chatJob = null;
          chat.push(j.status === "done" ? { role: "assistant", text: j.answer || "" } : { role: "assistant", text: j.error || "Something went wrong.", error: true });
          store.set(chatKey, chat.slice(-30));
          deleteDoc(ref).catch(() => {});
        }
        if (document.querySelector(".chatpanel")) draw();
      });
    } catch (err) { chatJob = null; chat.push({ role: "assistant", text: `Couldn't send: ${err.code || err.message}`, error: true }); draw(); }
  }
  const bg = h("div", { class: "chat-bg", onclick: () => closeChat() });
  const panel = h("div", { class: "chatpanel", role: "dialog", "aria-modal": "true", "aria-label": "Ask Scout" },
    h("div", { class: "head" },
      h("div", { class: "who" }, h("span", { class: "avatar", "aria-hidden": "true" }, icon("scout")), h("span", {}, h("b", {}, "Ask Scout"), h("span", { class: "muted small" }, `AI · ${G.name}`))),
      h("div", { class: "row" },
        h("button", { type: "button", class: "btn small plain", onclick: () => { if (chatJob) return; chat = []; store.set(chatKey, []); draw(); } }, "New chat"),
        h("button", { type: "button", class: "btn small plain icon-only", "aria-label": "Close", onclick: () => closeChat() }, icon("close")))),
    list, form,
    h("p", { class: "chatfoot" }, "AI can be wrong. Check anything important on VEX Events."));
  panel.addEventListener("keydown", e => { if (e.key === "Escape") closeChat(); });
  document.body.append(bg, panel);
  draw();
  if (matchMedia("(hover: hover)").matches) input.focus();
}
addEventListener("hashchange", () => { if (document.querySelector(".chatpanel") && matchMedia("(max-width: 899px)").matches) closeChat(); });

// ---- Scout for me: pick an event, the sync scouts every team there (sync/assist.mjs report()).
let scoutQuery = "", reportTier = "All", reportOpen = new Set();
const watchReports = () => watch("reports", query(collection(db, "reports"), orderBy("startedAt", "desc"), limit(40)), s => {
  S.reportList = s.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => r.id.startsWith(`${G.key}-`));
});
const watchReport = id => watch(`r${id}`, doc(db, "reports", `${G.key}-${id}`), s => { S.reports[id] = s.exists() ? s.data({ serverTimestamps: "estimate" }) : null; });
const asking = {}; // event id -> job id, while waiting for the sync to start a report
async function scoutEvent(id) {
  if (!navigator.onLine) { toast("You're offline. Try again when you're connected.", "bad"); return; }
  asking[id] = "…"; render();
  try {
    const ref = await addDoc(collection(db, "aiJobs"), { kind: "report", event: String(id), by: user.uid, nickname: S.nickname, at: serverTimestamp(), game: G.key, status: "new" });
    asking[id] = ref.id;
    const un = onSnapshot(ref, snap => {
      const j = snap.data();
      if (!j || j.status === "new") return;
      un(); delete asking[id];
      if (j.status === "error" && !S.reports[id]) toast(j.error || "Couldn't start the report.", "bad");
      deleteDoc(ref).catch(() => {});
      refresh();
    });
  } catch (err) { delete asking[id]; toast(`Couldn't start: ${err.code || err.message}`, "bad"); }
}
views.scout = id => id ? scoutReport(id) : scoutHome();
function scoutHome() {
  loadIndex("events");
  watchReports();
  const list = group(), count = h("p", { class: "footnote", style: "margin-top:0" });
  const drawList = () => {
    const q = scoutQuery.trim().toLowerCase();
    let items;
    if (q) items = (S.index.events || []).filter(e => `${e.name} ${e.sku} ${e.city} ${e.region} ${e.country}`.toLowerCase().includes(q)).slice(0, 30);
    else items = ourEvents().filter(e => ms(e.end || e.start) >= Date.now() - DAY);
    list.replaceChildren(...items.map(e => lrow({ href: `#/scout/${e.id}`, title: e.name, sub: [fmtDates(e), where_(e)].filter(Boolean).join(" · "), trail: isLive(e) ? h("span", { class: "pill live" }, "Live") : "" })));
    if (!items.length) list.append(h("p", { class: "empty" }, q ? (S.index.events?.length ? "No events match." : "Loading events…") : "No upcoming events of ours. Search for any event."));
    count.textContent = q ? "" : "Our upcoming events. Search to scout any event.";
  };
  drawList();
  const done = (S.reportList || []).filter(r => r.event);
  return [pagehead("Scout for me", "Pick an event. Scout looks at every team there: this season and Push Back, a chart for each, write-ups and a ranked pick list."),
    !aiReady() && S.ai !== undefined ? notice("Reports still rank every team with charts. Write-ups and the overview need AI: an admin adds the ANTHROPIC_API_KEY secret on GitHub.", "AI isn't set up", "scout") : null,
    searchBox("Find an event: name, city or code", scoutQuery, e => { scoutQuery = e.target.value; drawList(); }), list, count,
    done.length ? section("Reports") : null,
    done.length ? group(...done.map(r => lrow({ href: `#/scout/${r.event.id}`, ic: "scout", title: r.event.name,
      sub: r.status === "working" ? r.step || "Working…" : r.status === "error" ? r.error : `${r.count || r.teams?.length || 0} teams · by ${r.by || "someone"} · ${ago(r.doneAt)}`,
      trail: r.status === "working" ? h("span", { class: "pill live" }, "Working") : "" }))) : null];
}
const tierClass = t => (t === "First pick" ? "t1" : t === "Second pick" ? "t2" : "t3");
function scoutReport(id) {
  watchReport(id);
  loadIndex("events");
  const r = S.reports[id];
  const e = r?.event || S.index.events?.find(x => String(x.id) === String(id)) || ourEvents().find(x => String(x.id) === String(id));
  const head = pagehead(e?.name || `Event ${id}`, e ? [fmtDates(e), where_(e)].filter(Boolean).join(" · ") : "");
  const waiting = asking[id];
  if (r === undefined && !waiting) return [head, ...skeleton(120, 300)];
  if (!r || r.status === "error") {
    return [head, h("div", { class: "notice" }, icon("scout"), h("b", {}, r?.status === "error" ? "That didn't work" : waiting ? "Asking Scout…" : "Scout this event"),
      h("span", {}, r?.status === "error" ? r.error : "Scout loads every team's season (and last season, Push Back), charts each one, ranks them into a pick list and writes them up. Big events take a few minutes."),
      h("button", { class: "btn primary", disabled: !!waiting, onclick: () => scoutEvent(id) }, icon("scout"), waiting ? "Starting…" : r ? "Try again" : "Scout this event"))];
  }
  if (r.status === "working") {
    return [head, h("div", { class: "card working" }, h("span", { class: "spinner", "aria-hidden": "true" }),
      h("div", {}, h("b", {}, "Scouting…"), h("p", { class: "muted small" }, r.step || "Starting"),
        h("p", { class: "muted small" }, `Started ${ago(r.startedAt)}${r.by ? ` by ${r.by}` : ""}. You can leave this page; it keeps going.`)))];
  }
  const tiers = ["All", "First pick", "Second pick", "Depth"];
  const teams = r.teams.filter(t => reportTier === "All" || t.tier === reportTier);
  const A = r.ai;
  const chipTeams = (title, xs) => xs?.length ? h("div", { class: "pickchips" }, h("span", { class: "eyebrow" }, title), h("div", { class: "row" }, xs.map(n => h("a", { class: `tn${n === us() ? " us" : ""}`, href: teamHref(n) }, n)))) : null;
  const out = [head,
    h("p", { class: "muted small", style: "margin:-6px 0 4px" }, `${r.teams.length} teams · by ${r.by || "someone"} · ${ago(r.doneAt)} · `,
      h("button", { type: "button", class: "linkbtn", disabled: !!waiting, onclick: () => scoutEvent(id) }, waiting ? "Starting…" : "Run again"))];
  if (A) out.push(card(h("span", { class: "eyebrow" }, "Overview"), ...richText(A.overview), chipTeams("First picks", A.firstPicks), chipTeams("Sleepers", A.sleepers), chipTeams("Careful", A.avoid),
    A.plan ? h("div", { class: "notepara" }, h("span", { class: "eyebrow" }, "Our plan"), h("p", {}, A.plan)) : null));
  else if (r.aiNote) out.push(notice(r.aiNote, "No write-ups this time", "scout"));
  const ourRow = r.teams.find(t => t.number === us());
  if (ourRow) out.push(h("p", { class: "footnote" }, `We're #${ourRow.rank} of ${r.teams.length} on this list.`));
  out.push(h("div", { class: "chips" }, tiers.map(t => h("button", { type: "button", "aria-pressed": String(t === reportTier), onclick: () => { reportTier = t; render(); } }, t))));
  out.push(h("div", { class: "picklist" }, teams.map(t => {
    const open = reportOpen.has(t.number);
    const toggle = () => { open ? reportOpen.delete(t.number) : reportOpen.add(t.number); render(); };
    const rec = t.season ? `${t.season.wins}-${t.season.losses}-${t.season.ties}` : "no results";
    const row = h("button", { type: "button", class: `pick${t.number === us() ? " us" : ""}`, "aria-expanded": String(open), onclick: toggle },
      h("span", { class: "rk" }, t.rank), badge(t.number),
      h("span", { class: "tx" }, h("b", {}, t.name || t.number), h("span", {}, [t.number, rec, t.ai?.pick && t.ai.pick !== "maybe" ? t.ai.pick : null].filter(Boolean).join(" · "))),
      radarChart([{ p: t.profile, cls: "now" }], { small: true }),
      h("span", { class: `tier ${tierClass(t.tier)}` }, t.tier.replace(" pick", "")));
    if (!open) return h("div", { class: "pickwrap" }, row);
    const T = t.ai, list = (title, xs) => xs?.length ? h("div", {}, h("span", { class: "eyebrow" }, title), h("ul", {}, xs.map(x => h("li", {}, x)))) : null;
    const pb = t.pbSeason;
    return h("div", { class: "pickwrap open" }, row, h("div", { class: "pickbody" },
      h("div", { class: "pickchart" }, radarChart([{ p: t.profile, cls: "now" }, ...(t.pushback ? [{ p: t.pushback, cls: "past" }] : [])]),
        h("div", { class: "legend" }, h("span", {}, h("i", { class: "lg-now" }), G.name), t.pushback ? h("span", {}, h("i", { class: "lg-past" }), "Push Back") : null)),
      h("div", { class: "pickinfo" },
        T ? h("p", {}, T.summary) : null,
        T ? h("div", { class: "bullets" }, list("Strengths", T.strengths), list("Weaknesses", T.weaknesses)) : null,
        T?.why ? h("div", { class: "notepara" }, h("span", { class: "eyebrow" }, `Call: ${T.pick}`), h("p", {}, T.why)) : null,
        glance([[rec, "Season"], [t.season?.bestRank ? `#${t.season.bestRank}` : "–", "Best rank"], [t.season ? t.season.bestDriver + t.season.bestProg : "–", "Best skills"],
          [t.here ? `#${t.here.rank}` : "–", "Rank here"]]),
        h("div", { class: "notepara" }, h("span", { class: "eyebrow" }, "Push Back season"),
          h("p", {}, T?.lastSeason || (pb ? `${pb.wins}-${pb.losses}-${pb.ties} over ${pb.events} event${pb.events === 1 ? "" : "s"}${pb.bestRank ? `, best rank #${pb.bestRank}` : ""}, best skills ${pb.bestDriver + pb.bestProg}.` : "No Push Back results."))),
        h("a", { class: "btn small", href: teamHref(t.number) }, "Open team", icon("chev")))));
  })));
  out.push(h("p", { class: "footnote" }, "Order: a weighted score of the six corners (scoring, win rate, autonomous, driving, consistency, placement), as percentiles against every team this season. Tap a team for its chart and write-up."));
  return out;
}

// ---------------------------------------------------------------- elimination bracket
// Columns by round, our alliance highlighted, and our path: the chance of winning each round
// (against the actual opponent, or the likely one while that's still being decided) and of
// getting that far. Assumes slots 1+2 feed the next round's slot 1, 3+4 feed slot 2, and so on,
// until the real next match is posted.
const ELIM_ORDER = [6, 3, 4, 5];
const ROUND_NAME = { 6: "Round of 16", 3: "Quarterfinals", 4: "Semifinals", 5: "Finals" };
const allianceWin = (a, b, ratings) => { const sum = ts => ts.reduce((s, t) => s + (ratings?.[t]?.rating || 0), 0); return 1 / (1 + Math.exp(-1.15 * (sum(a) - sum(b)))); };
function bracketModel(ev) {
  const elims = ev.matches.filter(m => m.round > 2);
  const rounds = [...new Set(elims.map(m => m.round))].sort((a, b) => (ELIM_ORDER.indexOf(a) + 1 || 99) - (ELIM_ORDER.indexOf(b) + 1 || 99));
  const known = ELIM_ORDER.slice(ELIM_ORDER.indexOf(rounds[0]) >= 0 ? ELIM_ORDER.indexOf(rounds[0]) : 0);
  const order = rounds.length && ELIM_ORDER.includes(rounds[0]) ? known : rounds;
  const slots = {};
  for (const m of elims) (slots[`${m.round}-${m.instance}`] ||= []).push(m);
  const key = ts => ts.slice().sort().join(" ");
  const winner = list => { const done = list.filter(m => m.scored); const m = done[done.length - 1]; if (!m || m.red.score === m.blue.score) return null; return m.red.score > m.blue.score ? m.red.teams : m.blue.teams; };
  const memo = {};
  // Who comes out of a slot, and how likely: { key: { teams, p } }
  const dist = (ri, inst) => {
    const id = `${ri}-${inst}`;
    if (memo[id]) return memo[id];
    const list = slots[`${order[ri]}-${inst}`];
    let out = {};
    if (list?.length) {
      const m = list[list.length - 1], w = winner(list);
      if (w) out[key(w)] = { teams: w, p: 1 };
      else { const p = allianceWin(m.red.teams, m.blue.teams, ev.ratings); out[key(m.red.teams)] = { teams: m.red.teams, p }; out[key(m.blue.teams)] = { teams: m.blue.teams, p: 1 - p }; }
    } else if (ri > 0) {
      const A = dist(ri - 1, 2 * inst - 1), B = dist(ri - 1, 2 * inst);
      for (const a of Object.values(A)) for (const b of Object.values(B)) {
        const pa = allianceWin(a.teams, b.teams, ev.ratings);
        (out[key(a.teams)] ||= { teams: a.teams, p: 0 }).p += a.p * b.p * pa;
        (out[key(b.teams)] ||= { teams: b.teams, p: 0 }).p += a.p * b.p * (1 - pa);
      }
      if (!Object.keys(A).length) out = B; else if (!Object.keys(B).length) out = A;
    }
    return (memo[id] = out);
  };
  return { elims, order, slots, dist, key, winner };
}
function bracketView(ev) {
  const B = bracketModel(ev), out = [];
  const isUs = ts => ts.includes(us());
  const ourFirst = B.elims.find(m => isUs(m.red.teams) || isUs(m.blue.teams));
  if (ourFirst) {
    const ours = isUs(ourFirst.red.teams) ? ourFirst.red.teams : ourFirst.blue.teams, k = B.key(ours);
    const first = B.order.indexOf(ourFirst.round);
    let ri = first, inst = ourFirst.instance, prev = 1, lastInst = inst;
    const rows = [];
    for (; ri < B.order.length; ri++, lastInst = inst, inst = Math.ceil(inst / 2)) {
      const d = B.dist(ri, inst), mine = d[k]?.p ?? 0;
      const list = B.slots[`${B.order[ri]}-${inst}`];
      const real = list?.[list.length - 1];
      let opp;
      if (real && (isUs(real.red.teams) || isUs(real.blue.teams))) opp = isUs(real.red.teams) ? real.blue.teams : real.red.teams;
      else {
        // Whoever comes out of the other half: the slot next to the one we came from.
        const sib = ri > first ? B.dist(ri - 1, lastInst % 2 ? lastInst + 1 : lastInst - 1) : {};
        opp = Object.values(sib).sort((a, b) => b.p - a.p)[0]?.teams;
      }
      const done = real && real.scored && (isUs(real.red.teams) || isUs(real.blue.teams));
      const lost = done && !(B.winner(list) || []).includes(us());
      rows.push(lrow({ info: true, title: ROUND_NAME[B.order[ri]] || `Round ${B.order[ri]}`,
        sub: opp ? `${real && (isUs(real.red.teams) || isUs(real.blue.teams)) ? "vs" : "likely vs"} ${opp.join(", ")}` : "Opponent not known yet",
        trail: done ? h("span", { class: `pill ${lost ? "loss" : "win"}` }, lost ? "Lost" : "Won") : h("span", { class: "tr strong" }, prev > 0 ? `${pct(mine / prev)}` : "–") }));
      if (lost) break;
      prev = mine;
      if (!mine) break;
    }
    const champ = B.dist(B.order.length - 1, 1)[k]?.p;
    out.push(section("Our path"), group(...rows),
      h("p", { class: "footnote" }, `Chance to win each round from the ratings${champ !== undefined ? `; to win it all: ${champ < 0.01 ? "under 1%" : pct(champ)}` : ""}. Later opponents are the likeliest winners of the other side of the bracket.`));
  } else out.push(notice("We're not in the eliminations here.", "Not in the bracket", "trophy"));
  // The bracket itself, a column per round.
  const cols = B.order.map((r, ri) => {
    const expect = Math.max(1, 2 ** (B.order.length - 1 - ri));
    const cards = [];
    for (let inst = 1; inst <= expect; inst++) {
      const list = B.slots[`${r}-${inst}`];
      if (!list) { cards.push(h("div", { class: "bslot tbd" }, h("span", { class: "muted small" }, "To be decided"))); continue; }
      const m = list[list.length - 1], w = B.winner(list), p = ev.predictions?.[m.id];
      const side = c => h("div", { class: `bside ${c}${w && w === m[c].teams ? " won" : ""}${isUs(m[c].teams) ? " us" : ""}` },
        h("span", { class: "teams" }, m[c].teams.map(tn)), h("b", {}, m.scored ? m[c].score : p !== undefined ? pct(c === "red" ? p : 1 - p) : ""));
      cards.push(h("a", { class: "bslot", href: `#/match/${ev.id}/${m.id}` }, h("span", { class: "bname" }, shortName(m.name)), side("red"), side("blue")));
    }
    return h("div", { class: "bcol" }, h("span", { class: "eyebrow" }, ROUND_NAME[r] || `Round ${r}`), h("div", { class: "bslots" }, cards));
  });
  out.push(section("Bracket"), h("div", { class: "bracket" }, cols));
  return out;
}

// ---------------------------------------------------------------- skills planner
// Our skills runs (official ones from VEX Events, plus practice runs we log), against our region's
// leaderboard (meta/skills-<game>, from the nightly sync) and a target rank we pick.
const watchSkillsBoard = () => watch("skillsBoard", doc(db, "meta", `skills-${G.key}`), s => { S.skillsBoard = s.exists() ? s.data() : null; });
const watchSkillsRuns = () => watch("skillsRuns", query(collection(db, "skillsRuns"), where("game", "==", G.key)), s => {
  S.skillsRuns = s.docs.map(d => ({ id: d.id, pending: d.metadata.hasPendingWrites, ...d.data() })).sort((a, b) => a.date.localeCompare(b.date));
}, { includeMetadataChanges: true });
const skDraft = { kind: "driver", score: "", date: new Date().toLocaleDateString("en-CA"), notes: "" };
let skillsGrade = null; // "High School" | "Middle School" | "All"; defaults to our own grade
views.skills = () => {
  watchSkillsBoard(); watchSkillsRuns();
  const ourGrade = S.status?.team?.grade === "Middle School" ? "Middle School" : "High School";
  skillsGrade ||= store.get("skillsGrade", ourGrade);
  const whole = S.skillsBoard, runs = S.skillsRuns || [];
  // One grade's list (ranked within it), or everyone. A board from before the grade split has no
  // per-grade lists yet: show nothing for one grade rather than everyone under the wrong label.
  const noSplit = whole && !whole.byGrade && skillsGrade !== "All";
  const board = noSplit ? null : whole && skillsGrade !== "All" ? { ...whole, ...whole.byGrade[skillsGrade] } : whole;
  const gradeLabel = skillsGrade === "All" || !whole?.byGrade ? "" : skillsGrade === "Middle School" ? " MS" : " HS";
  const official = ourEvents().map(e => ({ e, s: S.events[e.id]?.skills?.find(x => x.team === us()) })).filter(x => x.s);
  const target = store.get("skillsTarget", 10);
  const at = board?.top?.[Math.min(target, board.top.length) - 1];
  const near = board?.top?.slice(Math.max(0, target - 3), target + 2) || [];
  const avg = k => near.length ? Math.round(near.reduce((s, r) => s + r[k], 0) / near.length) : 0;
  const best = k => Math.max(0, ...official.map(x => x.s[k === "prog" ? "prog" : "driver"]), ...runs.filter(r => r.kind === k).map(r => r.score));
  const bestOfficial = board?.ours;
  const out = [pagehead("Skills planner", `${G.name} · ${board?.region || "our region"}`),
    seg([["High School", "High School"], ["Middle School", "Middle School"], ["All", "Both"]], skillsGrade, v => { skillsGrade = v; store.set("skillsGrade", v); render(); }),
    noSplit ? notice("The leaderboard is split into High School and Middle School at the next full refresh (within a day). Tap Both to see everyone until then.", `No ${skillsGrade} list yet`, "skills") : null];
  out.push(glance([[bestOfficial ? `#${bestOfficial.rank}` : "–", `In ${board?.region || "region"}${gradeLabel}`, "accent"], [bestOfficial ? bestOfficial.total : "–", "Best official"],
    [best("driver") || "–", "Best driver"], [best("prog") || "–", "Best auto"]]));
  // Target
  out.push(section("Target"), card(
    h("div", { class: "row between" }, h("span", {}, `Top ${target} in ${board?.region || "the region"}${skillsGrade === "All" ? "" : ` (${skillsGrade})`}`),
      h("div", { class: "stepper" }, h("button", { type: "button", "aria-label": "Lower target", onclick: () => { store.set("skillsTarget", Math.max(1, target - 1)); render(); } }, "−"), h("output", {}, target),
        h("button", { type: "button", "aria-label": "Higher target", onclick: () => { store.set("skillsTarget", Math.min(60, target + 1)); render(); } }, "+"))),
    at ? h("p", {}, `#${target} right now is `, h("b", {}, `${at.n} with ${at.total}`), ` (${at.driver} driver + ${at.prog} auto). Teams around there average ${avg("driver")} driver and ${avg("prog")} auto.`)
      : h("p", { class: "muted" }, whole === undefined ? "Loading…" : noSplit ? `Waiting for the ${skillsGrade} list.` : "The leaderboard fills in after the next nightly refresh."),
    at ? (() => {
      const gapD = Math.max(0, avg("driver") - best("driver")), gapP = Math.max(0, avg("prog") - best("prog")), total = best("driver") + best("prog");
      return h("div", { class: "kv" },
        h("div", {}, h("span", {}, "Need overall"), h("b", {}, total >= at.total ? "✓" : `+${at.total - total + 1}`), h("span", {}, `our best ${total} vs ${at.total}`)),
        h("div", {}, h("span", {}, "Driver"), h("b", {}, gapD ? `+${gapD}` : "✓"), h("span", {}, `best ${best("driver")} vs ~${avg("driver")}`)),
        h("div", {}, h("span", {}, "Autonomous"), h("b", {}, gapP ? `+${gapP}` : "✓"), h("span", {}, `best ${best("prog")} vs ~${avg("prog")}`)));
    })() : null,
    h("p", { class: "muted small" }, "Set the target to how many skills spots qualify from our region this season (check the qualification criteria). Our bests include practice runs; the region uses each team's best official scores.")));
  // Chart of runs
  const pts = [...official.map(x => ({ date: x.e.start.slice(0, 10), driver: x.s.driver, prog: x.s.prog, official: true, label: x.e.name })),
    ...runs.map(r => ({ date: r.date, [r.kind]: r.score, official: false }))].sort((a, b) => a.date.localeCompare(b.date));
  if (pts.length) out.push(section("Our runs"), card(skillsChart(pts, at ? { driver: avg("driver"), prog: avg("prog") } : null)));
  // Log a practice run
  const msg = h("p", { class: "error", role: "status" });
  out.push(section("Log a run"), h("form", { class: "card", onsubmit: e => {
    e.preventDefault();
    const score = parseInt(skDraft.score, 10);
    if (!(score >= 0 && score <= 999)) { msg.textContent = "Enter the score."; return; }
    setDoc(doc(collection(db, "skillsRuns")), { kind: skDraft.kind, score, date: skDraft.date.slice(0, 10), notes: skDraft.notes.trim().slice(0, 200), game: G.key, by: user.uid, nickname: S.nickname, at: serverTimestamp() })
      .catch(err => toast(`Couldn't save the run (${err.code || err.message}).`, "bad"));
    toast("Run saved"); skDraft.score = ""; skDraft.notes = ""; render();
  } },
    seg([["driver", "Driver"], ["prog", "Autonomous"]], skDraft.kind, v => { skDraft.kind = v; render(); }),
    h("div", { class: "grid2" }, h("label", { class: "field" }, "Score", h("input", { type: "number", inputmode: "numeric", min: 0, max: 999, value: skDraft.score, oninput: e => { skDraft.score = e.target.value; } })),
      h("label", { class: "field" }, "Date", h("input", { type: "date", value: skDraft.date, oninput: e => { skDraft.date = e.target.value; } }))),
    h("label", { class: "field" }, "Notes", h("input", { maxlength: 200, placeholder: "Practice, new route, what went wrong", value: skDraft.notes, oninput: e => { skDraft.notes = e.target.value; } })),
    msg, h("button", { class: "btn primary wide", type: "submit" }, "Save run")));
  if (runs.length) out.push(group(...runs.slice().reverse().slice(0, 30).map(r => lrow({ info: true, title: `${r.kind === "driver" ? "Driver" : "Autonomous"} ${r.score}`,
    sub: [r.date, r.nickname, r.notes, r.pending ? "waiting to send" : ""].filter(Boolean).join(" · "),
    trail: r.by === user.uid ? h("button", { type: "button", class: "btn small danger", onclick: () => { if (confirm("Delete this run?")) deleteDoc(doc(db, "skillsRuns", r.id)); } }, "Delete") : "" }))));
  // Leaderboard
  if (board?.top?.length) out.push(section(`${board.region}${skillsGrade === "All" ? "" : ` ${skillsGrade}`} leaderboard`), h("div", { class: "group-list tablewrap" }, h("table", {},
    h("thead", {}, h("tr", {}, h("th", { class: "num" }, "#"), h("th", {}, "Team"), h("th", { class: "num" }, "Driver"), h("th", { class: "num" }, "Auto"), h("th", { class: "num" }, "Total"))),
    h("tbody", {}, [...board.top.slice(0, 25), ...(board.ours && board.ours.rank > 25 ? [board.ours] : [])].map(r => h("tr", { class: `${r.n === us() ? "us" : ""}${r.rank === target ? " target" : ""}` },
      h("td", { class: "num" }, r.rank), h("td", {}, h("a", { href: teamHref(r.n) }, tn(r.n))), h("td", { class: "num" }, r.driver), h("td", { class: "num" }, r.prog), h("td", { class: "num" }, r.total)))))),
    h("p", { class: "footnote" }, `Best driver plus best autonomous for each team this season, from ${board.count} ${skillsGrade === "All" ? "" : `${skillsGrade.toLowerCase()} `}teams; Middle School and High School are ranked separately; VEX ranks the best combined run from one event, so it can differ a little. Updated ${ago(board.updatedAt)}.`));
  return out;
};
/** Driver and autonomous scores over time; official runs are big dots, dashed lines are the target. */
function skillsChart(pts, target) {
  const W = 320, H = 150, pad = 26;
  const max = Math.max(10, ...pts.map(p => Math.max(p.driver || 0, p.prog || 0)), target?.driver || 0, target?.prog || 0) * 1.1;
  const t0 = Date.parse(pts[0].date), t1 = Math.max(t0 + 86400e3, Date.parse(pts[pts.length - 1].date));
  const x = d => pad + ((Date.parse(d) - t0) / (t1 - t0)) * (W - pad - 8), y = v => H - 18 - (v / max) * (H - 30);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "skchart", role: "img", "aria-label": "Skills scores over time" });
  for (const f of [0, 0.5, 1]) { svgEl("line", { x1: pad, x2: W - 6, y1: y(f * max / 1.1), y2: y(f * max / 1.1), class: "grid" }, svg); const t = svgEl("text", { x: pad - 4, y: y(f * max / 1.1) + 3, "text-anchor": "end", class: "lab" }, svg); t.textContent = Math.round(f * max / 1.1); }
  for (const k of ["driver", "prog"]) {
    if (target) svgEl("line", { x1: pad, x2: W - 6, y1: y(target[k]), y2: y(target[k]), class: `tgt ${k}` }, svg);
    const ps = pts.filter(p => p[k] !== undefined);
    if (ps.length > 1) svgEl("polyline", { points: ps.map(p => `${x(p.date)},${y(p[k])}`).join(" "), class: `ln ${k}` }, svg);
    ps.forEach(p => svgEl("circle", { cx: x(p.date), cy: y(p[k]), r: p.official ? 4.5 : 2.8, class: `pt ${k}${p.official ? " off" : ""}` }, svg));
  }
  const d0 = svgEl("text", { x: pad, y: H - 4, class: "lab" }, svg); d0.textContent = fmtDay(pts[0].date);
  const d1 = svgEl("text", { x: W - 6, y: H - 4, "text-anchor": "end", class: "lab" }, svg); d1.textContent = fmtDay(pts[pts.length - 1].date);
  return h("div", { class: "trendbox", style: "border:0;padding:0" }, svg, h("div", { class: "legend" }, h("span", {}, h("i", { class: "lg-drv" }), "Driver"), h("span", {}, h("i", { class: "lg-prg" }), "Autonomous"),
    h("span", {}, "big dots: official"), target ? h("span", {}, "dashed: target") : null));
}

// ---------------------------------------------------------------- season and event review
// Our results event by event, what changed between events, our match notes, and an AI-written
// engineering notebook entry (sync/assist.mjs review()) with a copy button.
const watchReview = key => watch(`rev${key}`, doc(db, "reviews", `${G.key}-${key}`), s => { S.reviews ||= {}; S.reviews[key] = s.exists() ? s.data({ serverTimestamps: "estimate" }) : null; });
const reviewWait = {};
async function makeReview(key) {
  if (!navigator.onLine) { toast("You're offline. Try again when you're connected.", "bad"); return; }
  reviewWait[key] = "Asking Scout…"; render();
  try {
    const ref = await addDoc(collection(db, "aiJobs"), { kind: "review", event: String(key), by: user.uid, nickname: S.nickname, at: serverTimestamp(), game: G.key, status: "new" });
    const un = onSnapshot(ref, snap => {
      const j = snap.data(); if (!j) return;
      if (j.step) reviewWait[key] = j.step;
      if (j.status === "done" || j.status === "error") { un(); delete reviewWait[key]; if (j.status === "error") toast(j.error || "Couldn't write the review.", "bad"); deleteDoc(ref).catch(() => {}); }
      refresh();
    });
  } catch (err) { delete reviewWait[key]; toast(`Couldn't ask: ${err.code || err.message}`, "bad"); render(); }
}
function eventSummary(e, ev) {
  const r = ev?.rankings?.find(x => x.team === us()), o = ev?.oprs?.[us()], sk = ev?.skills?.find(x => x.team === us());
  const ours = (ev?.ourMatches || []).map(om => ({ om, m: ev.matches.find(x => x.id === om.id) })).filter(x => x.m?.scored);
  const pts = ours.map(({ om, m }) => m[om.color].score);
  const wins = ours.filter(({ om, m }) => m[om.color].score > m[om.color === "red" ? "blue" : "red"].score).length;
  return { e, ev, r, opr: o?.matches >= 3 ? Math.round(o.opr) : null, skills: sk?.total ?? null, avg: pts.length ? Math.round(pts.reduce((a, b) => a + b, 0) / pts.length) : null,
    played: ours.length, wins, size: ev?.teams?.length };
}
views.review = id => {
  const key = id || "season";
  watchReview(key);
  const evs = (id ? ourEvents().filter(e => String(e.id) === String(id)) : ourEvents().filter(e => ms(e.start) <= Date.now()));
  if (id && !evs.length) { watchEvent(id); const ev = S.events[id]; if (ev) evs.push(ev); }
  const sums = evs.map(e => eventSummary(e, S.events[e.id]));
  const out = [pagehead(id ? `Review · ${evs[0]?.name || "Event"}` : "Season review", id ? fmtDates(evs[0] || {}) : `${G.name} ${G.years} · ${sums.length} event${sums.length === 1 ? "" : "s"} played`)];
  if (!sums.length) return [...out, notice("Reviews show up once we've played an event.", "Nothing played yet", "trophy")];
  // Table of events
  out.push(h("div", { class: "group-list tablewrap" }, h("table", {},
    h("thead", {}, h("tr", {}, h("th", {}, "Event"), h("th", { class: "num" }, "Rank"), h("th", { class: "num" }, "W-L"), h("th", { class: "num" }, "Avg pts"), h("th", { class: "num" }, "OPR"), h("th", { class: "num" }, "Skills"))),
    h("tbody", {}, sums.map(x => h("tr", {}, h("td", {}, h("a", { href: `#/review/${x.e.id}` }, x.e.name)), h("td", { class: "num" }, x.r ? `${x.r.rank}/${x.size}` : "–"),
      h("td", { class: "num" }, x.played ? `${x.wins}-${x.played - x.wins}` : "–"), h("td", { class: "num" }, x.avg ?? "–"), h("td", { class: "num" }, x.opr ?? "–"), h("td", { class: "num" }, x.skills ?? "–")))))));
  // What changed between the last two events
  if (sums.length >= 2) {
    const [a, b] = sums.slice(-2);
    const d = (k, better = 1) => a[k] == null || b[k] == null ? null : { v: b[k] - a[k], good: (b[k] - a[k]) * better > 0 };
    const rows = [["Rank", a.r && b.r ? { v: b.r.rank - a.r.rank, good: b.r.rank < a.r.rank } : null, true], ["Avg points", d("avg")], ["OPR", d("opr")], ["Skills", d("skills")],
      ["Win rate", a.played && b.played ? { v: Math.round((b.wins / b.played - a.wins / a.played) * 100), good: b.wins / b.played > a.wins / a.played, pct: true } : null]].filter(r => r[1]);
    if (rows.length) out.push(section(`Since ${a.e.name}`), group(...rows.map(([k, x, rank]) => lrow({ info: true, title: k,
      trail: h("span", { class: `tr strong ${x.v === 0 ? "" : x.good ? "good-t" : "bad-t"}` }, `${x.v > 0 ? "+" : ""}${x.v}${x.pct ? " pts" : ""}${rank ? (x.good ? " (better)" : x.v ? " (worse)" : "") : ""}`) }))));
  }
  // Our match notes for these events
  for (const x of sums) watch(`mnev${x.e.id}`, query(collection(db, "matchNotes"), where("event", "==", String(x.e.id))), s => { S.mnEvent ||= {}; S.mnEvent[x.e.id] = s.docs.map(d => d.data()).filter(n => n.game === G.key); });
  const notes = sums.flatMap(x => (S.mnEvent?.[x.e.id] || []).map(n => ({ ...n, ev: x.e.name })));
  if (notes.length) {
    out.push(section("Our match notes"));
    if (!areasOpen()) out.push(areaGate("Match notes", `${notes.length} notes from our matches.`, { focus: false }));
    else out.push(group(...notes.map(n => h("div", { class: "note" }, h("div", { class: "meta" }, h("b", {}, `${shortName(n.name)} · ${n.ev}`), h("span", { class: "muted small" }, n.nickname)),
      n.good ? h("p", {}, h("b", { class: "good-t" }, "Went well: "), n.good) : null, n.bad ? h("p", {}, h("b", { class: "bad-t" }, "Went wrong: "), n.bad) : null, n.next ? h("p", {}, h("b", {}, "Next time: "), n.next) : null))));
  }
  // AI notebook entry
  const rv = S.reviews?.[key], busy = reviewWait[key];
  const btn = h("button", { type: "button", class: `btn${rv ? "" : " primary"}`, disabled: !!busy || !aiReady(), onclick: () => makeReview(key) }, icon("scout"), busy || (rv ? "Write it again" : "Write a notebook entry"));
  out.push(section("Engineering notebook"));
  if (!rv) out.push(card(h("p", { class: "muted small" }, aiReady() ? "Scout writes an entry from our results, the changes between events and our match notes: highlights, what worked, what didn't, next steps." : "Needs AI: an admin adds the ANTHROPIC_API_KEY secret."), btn));
  else {
    const list = (title, xs) => xs?.length ? h("div", {}, h("span", { class: "eyebrow" }, title), h("ul", {}, xs.map(t => h("li", {}, t)))) : null;
    const text = [rv.title, "", rv.notebook, "", ...[["Highlights", rv.highlights], ["What worked", rv.worked], ["What didn't", rv.didnt], ["What changed", rv.changed], ["Next steps", rv.next]]
      .filter(([, xs]) => xs?.length).flatMap(([t, xs]) => [t, ...xs.map(x => `- ${x}`), ""])].join("\n");
    out.push(card(h("h3", {}, rv.title), h("p", {}, rv.summary),
      h("div", { class: "bullets" }, list("Highlights", rv.highlights), list("What worked", rv.worked), list("What didn't", rv.didnt), list("What changed", rv.changed), list("Next steps", rv.next)),
      h("div", { class: "notepara" }, h("span", { class: "eyebrow" }, "Notebook entry"), h("p", { class: "nbtext" }, rv.notebook)),
      h("p", { class: "muted small" }, `By ${rv.by || "Scout"} · ${ago(rv.at)} · AI, check it before it goes in the notebook`),
      h("div", { class: "row" }, h("button", { type: "button", class: "btn primary", onclick: () => navigator.clipboard?.writeText(text).then(() => toast("Copied. Paste it into the notebook."), () => toast("Couldn't copy on this device.", "bad")) }, "Copy for notebook"), btn)));
  }
  return out;
};

// ---------------------------------------------------------------- game plan for one of our matches
// The sync writes it with AI (sync/assist.mjs plan()) from the four teams' stats, notes and our scouting.
const planWait = {};
const watchPlan = mid => watch(`plan${mid}`, doc(db, "plans", `${G.key}-${mid}`), s => { S.plans ||= {}; S.plans[mid] = s.exists() ? s.data({ serverTimestamps: "estimate" }) : null; });
async function makePlan(ev, m) {
  if (!navigator.onLine) { toast("You're offline. Try again when you're connected.", "bad"); return; }
  planWait[m.id] = "Asking Scout…"; render();
  try {
    const ref = await addDoc(collection(db, "aiJobs"), { kind: "plan", event: String(ev.id), match: String(m.id), by: user.uid, nickname: S.nickname, at: serverTimestamp(), game: G.key, status: "new", open: areasOpen() });
    const un = onSnapshot(ref, snap => {
      const j = snap.data(); if (!j) return;
      if (j.step) planWait[m.id] = j.step;
      if (j.status === "done" || j.status === "error") { un(); delete planWait[m.id]; if (j.status === "error") toast(j.error || "Couldn't make a plan.", "bad"); deleteDoc(ref).catch(() => {}); }
      refresh();
    });
  } catch (err) { delete planWait[m.id]; toast(`Couldn't ask: ${err.code || err.message}`, "bad"); render(); }
}
function gamePlan(ev, m) {
  watchPlan(m.id);
  const p = S.plans?.[m.id], busy = planWait[m.id];
  const btn = h("button", { type: "button", class: `btn${p ? "" : " primary"}`, disabled: !!busy || !aiReady(), onclick: () => makePlan(ev, m) }, icon("scout"), busy ? busy : p ? "Make a new plan" : "Make a game plan");
  const out = [section("Game plan")];
  if (!p) return [...out, card(h("p", { class: "muted small" }, aiReady() ? "Scout reads up on all four teams (stats, notes, our scouting and pit sheets) and writes a plan for this match." : "Game plans need AI: an admin adds the ANTHROPIC_API_KEY secret."), btn)];
  if (p.usedScouting && !areasOpen()) return [...out, areaGate("Game plan", "This plan uses our scouting notes.", { focus: false })];
  const list = (title, xs) => xs?.length ? h("div", {}, h("span", { class: "eyebrow" }, title), h("ul", {}, xs.map(x => h("li", {}, x)))) : null;
  const para = (title, text) => text ? h("div", { class: "notepara" }, h("span", { class: "eyebrow" }, title), h("p", {}, text)) : null;
  return [...out, card(h("p", {}, p.summary), para("Autonomous", p.auto), para("Our job", p.us), para("Ask our partner", p.partner),
    h("div", { class: "bullets" }, list("Watch out for", p.threats), list("Drive team checklist", p.checklist)), para("Endgame", p.endgame),
    h("p", { class: "muted small" }, `By ${p.by || "Scout"} · ${ago(p.at)} · AI, check it against what you see`), btn)];
}

// ---------------------------------------------------------------- alliance selection
// Cross teams off as they're picked (shared live with everyone); the best still available stay on top.
// Order: the Scout for me report if there is one, else the event's ratings.
const watchSelection = id => watch(`sel${id}`, doc(db, "selection", `${G.key}-${id}`), s => { S.selection ||= {}; S.selection[id] = s.exists() ? s.data({ serverTimestamps: "estimate" }) : null; });
function takeTeam(id, n, taken) {
  setDoc(doc(db, "selection", `${G.key}-${id}`), { taken: taken ? arrayUnion(n) : arrayRemove(n), by: user.uid, nickname: S.nickname, at: serverTimestamp() }, { merge: true })
    .catch(err => toast(`Couldn't save: ${err.code || err.message}`, "bad"));
}
views.select = id => {
  watchEvent(id); watchReport(id); watchSelection(id);
  const ev = S.events[id], rep_ = S.reports[id], sel = S.selection?.[id];
  if (!ev) return [pagehead("Alliance selection"), ...(ev === null ? [notice("Load this event first from its page.", "Not loaded")] : skeleton(80, 300))];
  const taken = new Set(sel?.taken || []);
  const report = rep_?.status === "done" ? new Map(rep_.teams.map(t => [t.number, t])) : null;
  const rk = n => ev.rankings.find(r => r.team === n);
  const rows = ev.teams.map(t => {
    const r = report?.get(t.number), rate = ev.ratings?.[t.number]?.rating ?? null;
    return { n: t.number, name: t.name, score: r ? r.score : rate === null ? -1 : ratingFrac(rate), tier: r?.tier, rank: rk(t.number), opr: ev.oprs?.[t.number], call: r?.ai?.pick };
  }).sort((a, b) => b.score - a.score);
  const ourRate = ev.ratings?.[us()]?.rating ?? 0;
  const left = rows.filter(r => !taken.has(r.n) && r.n !== us()), gone = rows.filter(r => taken.has(r.n));
  const row = r => h("div", { class: `selrow${taken.has(r.n) ? " taken" : ""}` },
    h("a", { class: "selteam", href: teamHref(r.n) }, badge(r.n), h("span", { class: "tx" }, h("b", {}, r.name || r.n),
      h("span", {}, [r.n, r.rank ? `#${r.rank.rank} here (${r.rank.wins}-${r.rank.losses}-${r.rank.ties})` : null, r.opr?.matches >= 3 ? `OPR ${Math.round(r.opr.opr)}` : null, r.call && r.call !== "maybe" ? r.call : null].filter(Boolean).join(" · ")))),
    r.tier ? h("span", { class: `tier ${tierClass(r.tier)}` }, r.tier.replace(" pick", "")) : h("span"),
    h("button", { type: "button", class: `btn small${taken.has(r.n) ? "" : " plain"}`, onclick: () => takeTeam(id, r.n, !taken.has(r.n)) }, taken.has(r.n) ? "Undo" : "Taken"));
  // "With us": win chance of us + them against an average alliance at this event.
  const withUs = n => 1 / (1 + Math.exp(-1.1 * (ourRate + (ev.ratings?.[n]?.rating ?? 0))));
  const best = left.slice(0, 3);
  return [pagehead("Alliance selection", `${ev.name} · ${left.length} available, ${gone.length} taken`),
    best.length ? h("div", { class: "bestpicks" }, best.map((r, i) => h("a", { class: "bestpick", href: teamHref(r.n) },
      h("span", { class: "eyebrow" }, i === 0 ? "Best available" : `Next best #${i + 1}`), h("b", {}, r.n), h("span", { class: "muted small" }, r.name || ""),
      ev.ratings?.[r.n] ? h("span", { class: "small" }, `${pct(withUs(r.n))} with us vs an average alliance`) : null))) : notice("Every team is taken.", "No one left"),
    section("Available"), h("div", { class: "group-list" }, left.map(row)),
    gone.length ? section("Taken") : null, gone.length ? h("div", { class: "group-list" }, gone.map(row)) : null,
    h("p", { class: "footnote" }, `${report ? "Order from the Scout for me report." : "Order from the event's ratings. Make a Scout for me report for a better order."} Everyone sees the same list live${sel?.nickname ? `; last change by ${sel.nickname} ${ago(sel.at)}` : ""}.`),
    h("div", { class: "row" }, report ? null : h("a", { class: "btn", href: `#/scout/${id}` }, icon("scout"), "Scout for me report"),
      gone.length ? h("button", { type: "button", class: "btn danger", onclick: () => { if (confirm("Clear every taken team?")) setDoc(doc(db, "selection", `${G.key}-${id}`), { taken: [], by: user.uid, nickname: S.nickname, at: serverTimestamp() }); } }, "Reset") : null)];
};

// ---------------------------------------------------------------- scouting assignments
// Pick who's scouting, then split the teams at the event between them: teams in our upcoming
// matches first, then the strongest. Each scout sees their list (and what's done) here and on Home.
const watchAssign = id => watch(`asg${id}`, doc(db, "assignments", `${G.key}-${id}`), s => { S.assign ||= {}; S.assign[id] = s.exists() ? s.data() : null; });
const watchEventScouting = id => watch(`evsc${id}`, query(collection(db, "scouting"), where("event", "==", String(id))), s => {
  S.evScouting ||= {}; S.evScouting[id] = s.docs.map(d => d.data()).filter(x => (x.game || "override") === G.key);
});
let membersList = null, assignPick = null, assignEditing = false;
async function loadMembers() {
  if (membersList) return;
  membersList = [];
  try { membersList = (await getDocs(collection(db, "members"))).docs.map(d => ({ uid: d.id, nickname: d.data().nickname })).sort((a, b) => a.nickname.localeCompare(b.nickname)); }
  catch (err) { toast(`Couldn't load the team list (${err.code})`, "bad"); }
  refresh();
}
function splitTeams(ev, scouts) {
  const ours = new Set(), order = [];
  for (const om of ev.ourMatches || []) { const m = ev.matches.find(x => x.id === om.id); if (m && !m.scored) [...om.partners, ...om.opponents].forEach(t => ours.add(t)); }
  const rest = ev.teams.map(t => t.number).filter(n => n !== us() && !ours.has(n)).sort((a, b) => (ev.ratings?.[b]?.rating ?? 0) - (ev.ratings?.[a]?.rating ?? 0));
  order.push(...[...ours].filter(n => n !== us()), ...rest);
  const teams = {};
  order.forEach((n, i) => { teams[n] = scouts[i % scouts.length].uid; });
  return teams;
}
views.assign = id => {
  watchEvent(id); watchAssign(id); watchEventScouting(id); loadMembers();
  const ev = S.events[id], a = S.assign?.[id], done = S.evScouting?.[id] || [];
  if (!ev) return [pagehead("Scouting assignments"), ...(ev === null ? [notice("Load this event first from its page.", "Not loaded")] : skeleton(80, 300))];
  const isDone = (n, uid) => done.some(x => x.team === n && x.by === uid);
  const out = [pagehead("Scouting assignments", ev.name)];
  if (!a || assignEditing) {
    assignPick ||= new Set((a?.scouts || []).map(x => x.uid));
    out.push(section("Who's scouting?"), group(...(membersList || []).map(mb => lrow({ info: true, title: mb.nickname, sub: mb.uid === user.uid ? "You" : "",
      trail: h("input", { type: "checkbox", class: "check", checked: assignPick.has(mb.uid) || null, "aria-label": mb.nickname, onchange: e => { e.target.checked ? assignPick.add(mb.uid) : assignPick.delete(mb.uid); } }) }))),
      h("div", { class: "row" },
        h("button", { type: "button", class: "btn primary", onclick: () => {
          const scouts = (membersList || []).filter(mb => assignPick.has(mb.uid));
          if (!scouts.length) { toast("Pick at least one scout.", "bad"); return; }
          setDoc(doc(db, "assignments", `${G.key}-${id}`), { scouts, teams: splitTeams(ev, scouts), by: user.uid, nickname: S.nickname, at: serverTimestamp() })
            .catch(err => toast(`Couldn't save: ${err.code || err.message}`, "bad"));
          assignPick = null; assignEditing = false; render();
        } }, `Split ${ev.teams.length - 1} teams`),
        a ? h("button", { type: "button", class: "btn", onclick: () => { assignPick = null; assignEditing = false; render(); } }, "Cancel") : null),
      h("p", { class: "footnote" }, "Teams in our next matches go first, then the strongest, dealt out evenly. Splitting again replaces the old split."));
    return out;
  }
  const mineCount = Object.values(a.teams).filter(u => u === user.uid).length;
  if (mineCount) out.push(h("p", { class: "footnote", style: "margin-top:0" }, `You have ${mineCount} teams. Tap one to scout it.`));
  for (const sc of a.scouts) {
    const list = Object.entries(a.teams).filter(([, u]) => u === sc.uid).map(([n]) => n);
    const n = list.filter(t => isDone(t, sc.uid)).length;
    out.push(section(`${sc.nickname}${sc.uid === user.uid ? " (you)" : ""} · ${n} of ${list.length} done`),
      h("div", { class: "group-list assignlist" }, list.map(t => h("a", { class: `assignteam${isDone(t, sc.uid) ? " done" : ""}`, href: teamHref(t) }, isDone(t, sc.uid) ? icon("check") : h("span", { class: "dot" }), h("b", {}, t), h("span", { class: "muted small" }, teamName(t))))));
  }
  out.push(h("p", { class: "footnote" }, `Split by ${a.nickname}. A team counts as done when its scout saves a scouting note on it at this event.`),
    h("button", { type: "button", class: "btn", onclick: () => { assignPick = new Set(a.scouts.map(x => x.uid)); assignEditing = true; render(); } }, "Change scouts and split again"));
  return out;
};
/** Home: this person's scouting list for the event that matters now. */
function myScouting(fe) {
  if (!fe) return null;
  watchAssign(fe.id);
  const a = S.assign?.[fe.id];
  const mine = a ? Object.entries(a.teams).filter(([, u]) => u === user.uid).map(([n]) => n) : [];
  if (!mine.length) return null;
  watchEventScouting(fe.id);
  const done = (S.evScouting?.[fe.id] || []).filter(x => x.by === user.uid).map(x => x.team);
  const left = mine.filter(n => !done.includes(n));
  return h("a", { class: "notice scoutme", href: `#/assign/${fe.id}` }, h("b", {}, left.length ? `Your scouting: ${mine.length - left.length} of ${mine.length} done` : "Your scouting is done"),
    h("span", {}, left.length ? `Next: ${left.slice(0, 6).join(", ")}${left.length > 6 ? "…" : ""}` : "Nice work. Check the list for anyone else's teams."));
}

// ---------------------------------------------------------------- export to a spreadsheet
async function exportScouting(ev) {
  if (!areasOpen()) { toast("Unlock scouting notes first (open a team page and enter the team code).", "bad"); return; }
  toast("Getting the notes…");
  try {
    const nums = ev.teams.map(t => t.number), rows = [];
    const cols = ["Type", "Team", "Name", "Match", "By", "When", "Stars", "Auto", "Auto pieces", "Drivetrain", "Auto side", "Endgame", "Defense", "Driver", "Reliability", "Tags", "Notes",
      "Motors", "Intake", "Scoring", "Their autos", "Game plan", "Went well", "Went wrong", "Next time"];
    const when = t => (t?.toDate ? t.toDate().toISOString().slice(0, 16).replace("T", " ") : "");
    const sc = (await getDocs(query(collection(db, "scouting"), where("event", "==", String(ev.id))))).docs.map(d => d.data()).filter(x => (x.game || "override") === G.key);
    for (const x of sc) rows.push({ Type: "Scouting", Team: x.team, Name: teamName(x.team), Match: x.match, By: x.nickname, When: when(x.at), Stars: x.rating, Auto: x.auto, "Auto pieces": x.autoPins,
      Drivetrain: x.drive, "Auto side": x.autoSide, Endgame: x.endgame, Defense: SCOUT_MORE[3].options[(x.defense || 0) - 1], Driver: SCOUT_MORE[4].options[(x.driver || 0) - 1],
      Reliability: x.reliable, Tags: (x.tags || []).join("; "), Notes: x.notes });
    for (let i = 0; i < nums.length; i += 30) {
      const part = nums.slice(i, i + 30);
      const pits = await Promise.all(part.map(n => getDoc(doc(db, "pits", `${n}__${G.key}`))));
      pits.forEach(p => { if (!p.exists()) return; const x = p.data();
        rows.push({ Type: "Pit", Team: x.team, Name: teamName(x.team), By: x.nickname, When: when(x.at), Drivetrain: x.drive, Endgame: x.endgame, Notes: x.notes, Motors: x.motors, Intake: x.intake,
          Scoring: x.scoring, "Their autos": x.autos, "Game plan": x.strategy }); });
    }
    const mn = (await getDocs(query(collection(db, "matchNotes"), where("event", "==", String(ev.id))))).docs.map(d => d.data()).filter(x => x.game === G.key);
    for (const x of mn) rows.push({ Type: "Our match", Team: x.teams.join(" "), Match: x.name, By: x.nickname, When: when(x.at), "Went well": x.good, "Went wrong": x.bad, "Next time": x.next });
    if (!rows.length) { toast("No scouting notes for this event yet.", "bad"); return; }
    const cell = v => { const t = v === undefined || v === null ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const csv = "\ufeff" + [cols.join(","), ...rows.map(r => cols.map(c => cell(r[c])).join(","))].join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = h("a", { href: url, download: `${ev.sku || ev.id} scouting.csv` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`Exported ${rows.length} rows`);
  } catch (err) { toast(`Couldn't export: ${err.code || err.message}`, "bad"); }
}

// ---- field map: the names the autos use for things on the field (red alliance view;
// Red/Blue at the top mirrors it, like the autos)
const MAP_KINDS = { // [section title, color, letter on the map]
  goal: ["Goals", "#f2c94c", "G"], toggle: ["Toggles", "#eb5757", "T"], pin: ["Yellow pins we pick up", "#56ccf2", "P"],
  cluster: ["Pin clusters (lying down; drive around them)", "#bb6bd9", "C"], other: ["Other", "#d0d0d0", "O"],
};
const MAP_ITEMS = [
  // [kind, name, x, y, note]
  ["goal", "Red Goal 2", -2 * T, -T, "Our alliance goal below our toggle"],
  ["goal", "Red Goal 3", -T, -2 * T, "Our alliance goal above the bottom toggle"],
  ["goal", "Blue Goal 2", 2 * T, T, "Their alliance goal below their toggle"],
  ["goal", "Blue Goal 3", T, 2 * T, "Their alliance goal next to the top toggle"],
  ["goal", "Left short goal", -2 * T, T, "Neutral short goal above our toggle"],
  ["goal", "Top-left short goal", -T, 2 * T, "Neutral short goal by the top toggle"],
  ["goal", "Right short goal", 2 * T, -T, "Neutral short goal below their toggle"],
  ["goal", "Bottom-right short goal", T, -2 * T, "Neutral short goal by the bottom toggle"],
  ["goal", "Tall goal", 0, 0, "Center of the midfield. Its yellow pins count for whoever has more robots in the midfield"],
  ["toggle", "Our toggle (alliance wall)", -W, 0, "Owns the left quadrant: Red Goal 2 and the left short goal"],
  ["toggle", "Bottom toggle", 0, -W, "Owns the bottom quadrant: Red Goal 3 and the bottom-right short goal"],
  ["toggle", "Top toggle", 0, W, "Owns the top quadrant (their side of the autonomous line)"],
  ["toggle", "Their toggle (right wall)", W, 0, "Owns the right quadrant"],
  ["pin", "Wall pin, top-left", -70, T, "On our wall, with a cup each side. Picked by driving straight in at an angle"],
  ["pin", "Wall pin, bottom-left", -70, -T, "On our wall below the toggle"],
  ["pin", "Wall pin, bottom (left)", -T, -70, "On the bottom wall"],
  ["pin", "Wall pin, bottom (right)", T, -70, "On the bottom wall"],
  ["pin", "Wall pin, top (left)", -T, 70, "On the top wall"],
  ["pin", "Wall pin, top (right)", T, 70, "On the top wall"],
  ["pin", "Wall pin, right (top)", 70, T, "On their wall"],
  ["pin", "Wall pin, right (bottom)", 70, -T, "On their wall"],
  ["pin", "Yellow pin between the red goals", -2 * T, -2 * T, "Stacked on a cup in the corner of our half"],
  ["pin", "Yellow pin below the midfield", -T, -T, "Stacked on a cup next to the midfield"],
  ["pin", "Yellow pin above the midfield", T, T, "Stacked on a cup on their side of the midfield"],
  ["pin", "Yellow pin, top-right corner", 2 * T, 2 * T, "Stacked on a cup in the corner of their half"],
  ["cluster", "Pin cluster, top-left", -2 * T, 2 * T, "Blocks the top-left match loader"],
  ["cluster", "Pin cluster, left", -T, T, "Next to the midfield"],
  ["cluster", "Pin cluster, right", T, -T, "Next to the midfield"],
  ["cluster", "Pin cluster, bottom-right", 2 * T, -2 * T, "Corner of their half"],
  ["other", "Bottom-left match loader (red)", -68.5, -59.5, "The loader our autos use"],
  ["other", "Top-left match loader (red)", -68.5, 59.5, "Blocked for our robot by the cluster next to it"],
  ["other", "Midfield corner pins", -T, 0, "Pins at the four corners of the midfield (the diamond)"],
];
const SWAP_RB = { Red: "Blue", Blue: "Red", red: "blue", blue: "red" };
const mapName = n => side === "blue" ? flipDirs(n.replace(/\b(Red|Blue|red|blue)\b/g, m => SWAP_RB[m])) : n;
// map items with their codes (G1, T1, P1, ...), in red alliance coordinates
const MAP_CODED = (() => { const n = {}; return MAP_ITEMS.map(([kind, name, x, y, note]) => ({ kind, name, x, y, note, code: MAP_KINDS[kind][2] + (n[kind] = (n[kind] || 0) + 1) })); })();
const nearestItem = (kinds, x, y) => MAP_CODED.filter(m => kinds.includes(m.kind)).reduce((b, m) => (Math.hypot(m.x - x, m.y - y) < Math.hypot(b.x - x, b.y - y) ? m : b));
/** The auto's actions in map terms: [{ step, codes, text }] */
function autoActions(a) {
  const out = [], u = h => [Math.sin(h * Math.PI / 180), Math.cos(h * Math.PI / 180)];
  a.steps.forEach((s, i) => {
    const t = s.do, [ux, uy] = u(s.h), add = (codes, text) => out.push({ step: i, codes, text });
    if (/toggle over/.test(t)) { const m = nearestItem(["toggle"], s.x + 4 * ux, s.y + 4 * uy); add([m.code], `Push ${m.code}, ${mapName(m.name).toLowerCase().replace(/^our/, "our")}, over to ${side}`); }
    else if (/PICK UP the preload/.test(t)) add([], "Pick up the preload (already in the claw)");
    else if (/MATCH LOAD/.test(t)) add(["O1"], "Wait at the loader (O1) for a match load, then pick it up");
    else if (/PICK UP/.test(t)) { const m = nearestItem(["pin"], s.x + CLAW * ux, s.y + CLAW * uy); add([m.code], `Drive in and pick up ${m.code} (${mapName(m.name).toLowerCase()})`); }
    if (/SCORE/.test(t)) { const m = nearestItem(["goal"], s.x - 9 * ux, s.y - 9 * uy); add([m.code], `Back onto ${m.code} (${mapName(m.name)}) and score`); }
    if (i === a.steps.length - 1) {
      if (/midfield/.test(t) && !/SCORE/.test(t)) add(["G9"], "Park in the midfield, next to the tall goal (G9)");
      else if (/midfield/.test(t)) add([], "Stay there: the robot ends in the midfield");
      else if (/match loader/.test(t)) add(["O1"], "Park facing the loader (O1), claw open, ready for the driver");
    }
  });
  return out;
}
let mapAuto = "";
views.fieldmap = (id = "") => {
  const canAutos = areasOpen() && G.key === "override";
  if (canAutos) watchAutos();
  const autos = canAutos && S.autos ? S.autos.autos : [];
  const a = autos.find(x => x.id === id) || null;
  const acts = a ? autoActions(a) : [];
  const used = new Set(acts.flatMap(x => x.codes));

  // a margin around the field for the driver stations, audience and scorekeeper
  const M = 9, x0 = -23 * PX - M, y0 = -22 * PX - M, vw = 1514 * PX + 2 * M, vh = 1508 * PX + 2 * M;
  const svg = svgEl("svg", { viewBox: `${x0} ${y0} ${vw} ${vh}`, class: "fieldplot", role: "img", "aria-label": a ? `Field map of ${textFor(a.name)}` : "Field map with labels" });
  svgEl("image", { href: "field.webp", x: -23 * PX, y: -22 * PX, width: 1514 * PX, height: 1508 * PX, preserveAspectRatio: "none" }, svg);
  {
    // Drive teams stand behind the side walls: red behind the left wall, blue behind the
    // right one (fixed, whichever alliance we are). The audience and scorekeeper are on the
    // top and bottom; which is where changes by event, so it's a setting.
    const lab = (text, x, y, rot, col) => { const t = svgEl("text", { x, y, "text-anchor": "middle", "dominant-baseline": "middle", "font-size": 3.6, "font-weight": 700, fill: col, transform: rot ? `rotate(${rot} ${x} ${y})` : "" }, svg); t.textContent = text; };
    const us = side === "blue" ? "Blue" : "Red", cy = y0 + vh / 2;
    lab(`Red driver station${us === "Red" ? " (us)" : ""}`, x0 + M / 2, cy, -90, "var(--red)");
    lab(`Blue driver station${us === "Blue" ? " (us)" : ""}`, x0 + vw - M / 2, cy, 90, "var(--blue)");
    const audTop = store.get("audienceAt", "bottom") === "top";
    lab("Audience", x0 + vw / 2, audTop ? y0 + M / 2 : y0 + vh - M / 2, 0, "var(--muted)");
    lab("Scorekeeper", x0 + vw / 2, audTop ? y0 + vh - M / 2 : y0 + M / 2, 0, "var(--muted)");
  }
  { // the autonomous line: the double tape from the top-left corner to the bottom-right one,
    // around the midfield. In auto each alliance stays on its own side: red has the left and
    // bottom quadrants, blue the top and right. Shade the other alliance's side.
    const blue = side === "blue", k = blue ? -1 : 1, col = blue ? "var(--red)" : "var(--blue)";
    svgEl("polygon", { points: [[-W, W], [W, W], [W, -W]].map(([x, y]) => fx(k * x) + "," + fy(k * y)).join(" "), fill: col, opacity: 0.12 }, svg);
    [["Their side of the", 31.5], ["autonomous line:", 35], ["don't cross in auto", 38.5]].forEach(([line, y]) =>
      svgEl("text", { x: fx(k * 36), y: fy(k * 36) + y - 35, "text-anchor": "middle", "font-size": 2.8, "font-weight": 700, fill: "#ffd23f" }, svg).textContent = line);
  }
  // quadrant names, faint
  for (const [name, x, y] of [["Left quadrant", -46, 4], ["Bottom quadrant", -4, -38], ["Top quadrant", 4, 38], ["Right quadrant", 46, -4]]) {
    const [px, py] = side === "blue" ? [-x, -y] : [x, y];
    svgEl("text", { x: fx(px), y: fy(py), "text-anchor": "middle", "font-size": 3.4, "font-weight": 600, fill: "#ffffff", opacity: a ? 0.3 : 0.55 }, svg).textContent = mapName(name);
  }
  if (a) { // the route, under the labels
    const pts = a.steps.map(pose), col = side === "blue" ? "var(--blue)" : "var(--red)";
    svgEl("polyline", { points: pts.map(p => fx(p[0]) + "," + fy(p[1])).join(" "), fill: "none", stroke: "#f2f2f2", "stroke-width": 1.2, "stroke-linejoin": "round", opacity: 0.9 }, svg);
    const r0 = svgEl("g", {}, svg);
    svgEl("rect", { x: -7.5, y: -7.5, width: 15, height: 15, rx: 1.5, fill: col, "fill-opacity": 0.45, stroke: col, "stroke-width": 0.9 }, r0);
    placeRobot(r0, pts[0]);
  }
  // letters, not plain numbers, so they aren't confused with the goal numbers printed on the field
  const legend = Object.fromEntries(Object.keys(MAP_KINDS).map(k => [k, []]));
  for (const m of MAP_CODED) {
    const col = MAP_KINDS[m.kind][1], [px, py] = side === "blue" ? [-m.x, -m.y] : [m.x, m.y];
    const g = svgEl("g", { opacity: a && !used.has(m.code) ? 0.35 : 1 }, svg);
    svgEl("rect", { x: fx(px) - 3.9, y: fy(py) - 2.6, width: 7.8, height: 5.2, rx: 2.6, fill: col, stroke: used.has(m.code) ? "#ffffff" : "#1b1d22", "stroke-width": used.has(m.code) ? 0.9 : 0.5 }, g);
    svgEl("text", { x: fx(px), y: fy(py) + 1.05, "text-anchor": "middle", "font-size": 3, "font-weight": 700, fill: "#1b1d22" }, g).textContent = m.code;
    legend[m.kind].push(lrow({ info: true, lead: h("span", { class: "mapnum", style: `background:${col}` }, m.code), title: mapName(m.name), sub: mapName(m.note) }));
  }
  if (a) { // numbered actions on top
    acts.forEach((x, k) => { const [px, py] = pose(a.steps[x.step]);
      svgEl("circle", { cx: fx(px), cy: fy(py), r: 2.7, fill: "#ffffff", stroke: "#1b1d22", "stroke-width": 0.4 }, svg);
      svgEl("text", { x: fx(px), y: fy(py) + 1.1, "text-anchor": "middle", "font-size": 3.1, "font-weight": 700, fill: "#1b1d22" }, svg).textContent = k + 1; });
  }

  // auto picker
  let picker = null;
  if (!canAutos) picker = h("p", { class: "muted small" }, areasOpen() ? "Our autos are for Override; switch the game back in Settings to see them here." : "Unlock with the lock button at the top to see our autos on the map.");
  else if (S.autos === undefined) picker = h("p", { class: "muted small" }, "Loading our autos…");
  else {
    const groups = [...new Set(autos.map(x => x.group))];
    const sel = h("select", { class: "mapselect", "aria-label": "Show an auto on the map", onchange: e => { location.hash = e.target.value ? `#/fieldmap/${e.target.value}` : "#/fieldmap"; } },
      h("option", { value: "" }, "Just the map (no auto)"),
      ...groups.map(g => h("optgroup", { label: textFor(g) }, ...autos.filter(x => x.group === g).map(x => h("option", { value: x.id, selected: x.id === id || null }, textFor(x.name))))));
    picker = h("div", { class: "row", style: "gap:8px;flex-wrap:wrap" }, sel, a ? h("a", { class: "btn", href: `#/autos/${a.id}` }, "Play it") : null);
  }

  const explain = a ? [
    section(`${textFor(a.name)} · ${a.time}`),
    h("p", { class: "mapflow" }, acts.flatMap((x, k) => [k ? h("span", { class: "arrow" }, "→") : null, h("b", {}, x.codes.length ? x.codes.join(" + ") : /preload/.test(x.text) ? "preload" : "stay")]).filter(Boolean)),
    h("div", { class: "group-list mapsteps" }, ...acts.map((x, k) => lrow({ info: true, lead: h("span", { class: "mapnum stepnum" }, k + 1), title: x.text }))),
    a.summary ? h("p", { class: "footnote" }, textFor(a.summary)) : null] : [];

  return [pagehead("Field map", a ? "The auto's route on the labelled field. Pick another below, or switch Red/Blue at the top." : "What the autos mean by Red Goal 2, the bottom toggle, a wall pin and so on. Pick an auto to see its route. Switch Red/Blue at the top to flip it."),
    canAutos && S.autos ? h("div", {}, ...(autoPicker(S.autos.autos, true) || [])) : null,
    picker,
    h("div", { class: "field-wrap mapsmall" }, svg),
    h("div", { class: "row mapsides" }, h("label", {}, "Audience side ", h("select", { onchange: e => { store.set("audienceAt", e.target.value); render(); } },
      ...[["bottom", "Bottom (scorekeeper top)"], ["top", "Top (scorekeeper bottom)"]].map(([v, t]) => h("option", { value: v, selected: store.get("audienceAt", "bottom") === v || null }, t))))),
    ...explain,
    ...Object.entries(MAP_KINDS).flatMap(([k, [title]]) => [section(title), group(...legend[k])]),
    h("p", { class: "footnote" }, "Positions come from the field drawing, snapped to the 23.8\" tiles. Coordinates in the autos: inches from the field center, +X right, +Y up.")];
};

views.more = () => [pagehead("More"),
  group(
    lrow({ href: "#/autos", ic: "autos", title: "Autos", sub: "Our autonomous routes" }),
    lrow({ href: "#/fieldmap", ic: "autos", title: "Field map", sub: "Names of the goals, toggles and pins the autos use" }),
    lrow({ ic: "chat", title: "Ask Scout", sub: "AI chat about teams, events and picks", onclick: () => openChat() }),
    lrow({ href: "#/skills", ic: "skills", title: "Skills planner", sub: "Our runs vs the region and a target" }),
    lrow({ href: "#/review", ic: "review", title: "Season review", sub: "Results, what changed, notebook entries" }),
    lrow({ href: "#/checklist", ic: "checklist", title: "Checklist", sub: "Before each match, packing list, your own" }),
    lrow({ href: "#/scorer", ic: "scorer", title: "Scorer", sub: "Match timer and score counter" }),
    lrow({ href: "#/predict", ic: "predict", title: "Predictor", sub: "Win chance for any four teams" }),
    lrow({ href: "#/board", ic: "board", title: "Whiteboard", sub: "Draw plays on the field with our alliance" }),
    lrow({ href: "#/pit", ic: "pit", title: "Pit display", sub: "Full-screen dashboard to leave at the pit" })),
  group(
    lrow({ href: "#/settings", ic: "settings", title: "Settings", sub: `Signed in as ${S.nickname}` }),
    lrow({ href: reTeam(us()), ic: "ext", title: `${us()} on VEX Events`, external: true }))];

let codeShown = null;
function adminSection() {
  const reqs = S.codeRequests || [];
  return [section("Admin · team code requests"),
    group(...(reqs.length ? reqs.map(r => lrow({ info: true, title: `${r.nickname} · ${r.email}`, sub: `${r.where} · ${ago(r.at)}`,
      trail: h("button", { type: "button", class: "btn small", onclick: () => deleteDoc(doc(db, "codeRequests", r.id)) }, "Done") }))
      : [h("p", { class: "empty" }, "Nobody is asking for the code right now.")]),
      lrow({ info: true, ic: "lock", title: "Team code", sub: codeShown ?? "Hidden",
        trail: h("button", { type: "button", class: "btn small", onclick: async () => {
          codeShown = codeShown ? null : await getDoc(doc(db, "config", "secret")).then(d => d.data()?.code || "Not set yet", err => `Can't read it (${err.code})`);
          render();
        } }, codeShown ? "Hide" : "Show") })),
    h("p", { class: "footnote" }, "Tell them the code yourself, then tap Done. Only admins see this. To change the code, update the TEAM_JOIN_CODE secret.")];
}
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
    ...alertsSection(),
    ...(S.admin ? adminSection() : []),
    ...aiSection(),
    section("Locked areas"),
    group(lrow({ info: true, ic: "lock", title: "Team notes, autos, whiteboard", sub: areasOpen() ? `Open on this device until ${new Date(store.get("areasOpenUntil", 0)).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "Locked: they ask for the team code",
      trail: areasOpen() ? h("button", { type: "button", class: "btn small", onclick: lockAreas }, "Lock now") : h("button", { type: "button", class: "btn small primary", onclick: quickUnlock }, "Unlock") }),
      lrow({ info: true, ic: "unlock", title: "Stay unlocked for", trail: seg(UNLOCK_CHOICES, unlockHours(), v => { store.set("unlockHours", v); if (areasOpen()) openAreas(); render(); }, "mini") })),
    h("p", { class: "footnote" }, "The lock at the top of every page unlocks or locks everything in one tap. Your phone can save the team code and fill it in with Face ID."),
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
const NAV = [["home", "Home", ""], ["events", "Events", "events"], ["teams", "Teams", "teams"], ["scout", "Scout", "scout"], ["more", "More", "more"]];
const NAV_WIDE = [["home", "Home", ""], ["events", "Events", "events"], ["teams", "Teams", "teams"], ["scout", "Scout for me", "scout"], ["autos", "Autos", "autos"], ["skills", "Skills planner", "skills"], ["review", "Season review", "review"], ["checklist", "Checklist", "checklist"],
  ["scorer", "Scorer", "scorer"], ["predict", "Predictor", "predict"], ["board", "Whiteboard", "board"], ["pit", "Pit display", "pit"], ["settings", "Settings", "settings"]];
const TAB_OF = { skills: "more", review: "more", event: "events", match: "events", select: "events", assign: "events", team: "teams", autos: "more", checklist: "more", scorer: "more", predict: "more", settings: "more", board: "more", pit: "more" };
const BACK = { skills: ["More", "#/more"], review: ["Back"], event: ["Events", "#/events"], match: ["Back"], select: ["Back"], assign: ["Back"], team: ["Back"], checklist: ["More", "#/more"], scorer: ["More", "#/more"], predict: ["More", "#/more"], settings: ["More", "#/more"] };
const wide = matchMedia("(min-width: 900px)");
let lastRoute = "", titleObs = null;
// How deep each page sits, so moving deeper slides in from the right and Back slides the other way.
const DEPTH = { home: 0, events: 0, teams: 0, autos: 0, scout: 0, more: 0, event: 1, checklist: 1, scorer: 1, predict: 1, settings: 1, board: 1, pit: 1, match: 2, team: 2, select: 2, assign: 2, skills: 1, review: 1 };
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
  const depth = (name === "autos" || name === "scout") && parts[1] ? 1 : DEPTH[name] ?? 0;
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
    chatButton(name);
    fitBadges(root);
    if (name === "pit") fitPit();
    if (fresh) scrollTo(0, 0);
    return;
  }
  document.body.classList.add("has-nav");
  const isWide = wide.matches;
  const tab = TAB_OF[name] || name;
  const sub = name === "autos" || name === "scout" ? !!parts[1] : isWide ? ["event", "match", "team", "select", "assign"].includes(name) : !!BACK[name];
  const [backLabel, backHref] = name === "autos" ? ["Autos", "#/autos"] : name === "scout" ? ["Scout", "#/scout"] : BACK[name] || ["Back"];
  const content = views[name](...parts.slice(1));
  const head = h("header", { class: "top" },
    h("div", { class: "left" }, sub ? h("button", { class: "back", onclick: () => { if (backHref) location.hash = backHref; else if (history.length > 1) history.back(); else location.hash = "#/"; } }, icon("back"), h("span", {}, backLabel)) : null),
    h("span", { class: "title" }, ""),
    h("div", { class: "right" }, name === "autos" && areasOpen() ? seg([["red", "Red"], ["blue", "Blue"]], side, v => { side = v; store.set("alliance", v); render(); }, "red-blue") : null, lockButton()));
  const current = k => isWide ? (k === name || (k === "events" && ["event", "match", "select", "assign"].includes(name)) || (k === "teams" && name === "team")) : k === tab;
  root.replaceChildren(head, h("main", {}, offlineBar(), queueBanner(), content),
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
  chatButton(name);
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
