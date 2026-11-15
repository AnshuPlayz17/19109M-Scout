// The game manual for the app's Manual tab and its "ask about a ruling" helper.
//
// The sync finds the current manual PDF on VEX's manual page (the one not marked obsolete), reads
// its text, splits it into rules (<SG1>, <G3>, <R12>, ...) and stores both in Firestore:
//   manual/<game>               which version, where from, how many rules
//   manual/<game>-rules-<i>     the rules, a few hundred per document
//   manual/<game>-text-<i>      every page's text, for the AI to read
// Nothing from the manual is kept in this repository; it comes from VEX each time.
import { getDocumentProxy } from "unpdf";

export const MANUAL_PAGES = {
  override: "https://www.vexrobotics.com/override-manual",
  pushback: "https://www.vexrobotics.com/push-back-manual",
};
// VEX's public short links that redirect to the current manual PDF (tried first).
export const MANUAL_LINKS = {
  override: ["https://link.vex.com/docs/26-27/v5rc-override-manual"],
  pushback: ["https://link.vex.com/docs/25-26/v5rc-pushback-manual"],
};
const UA = { "User-Agent": "19109M-Scout-sync (team scouting app; github.com/AnshuPlayz17/19109M-Scout)" };
const isPdf = res => res.ok && (/pdf/i.test(res.headers.get("content-type") || "") || /\.pdf($|\?)/i.test(res.url || ""));

/**
 * The current manual PDF's address. In order: a fixed address (config.json manualPdf.<game>, or
 * MANUAL_PDF_<GAME> when testing); VEX's short link; the PDF linked on VEX's manual page.
 * If VEX turns the sync away, set manualPdf in config.json to the PDF's address.
 */
export async function findManualPdf(game, config) {
  const fixed = config.manualPdf?.[game] || process.env[`MANUAL_PDF_${game.toUpperCase()}`];
  if (fixed) return fixed;
  const tried = [];
  for (const link of MANUAL_LINKS[game] || []) {
    try {
      const res = await fetch(link, { headers: UA, redirect: "follow" });
      await res.body?.cancel().catch(() => {});
      if (isPdf(res)) return res.url;
      tried.push(`${res.status} from ${new URL(link).host}`);
    } catch (err) { tried.push(`${new URL(link).host}: ${err.message}`); }
  }
  try {
    const res = await fetch(MANUAL_PAGES[game], { headers: UA });
    if (res.ok) { const url = pickManualPdf(await res.text()); if (url) return url; tried.push("no PDF on the manual page"); }
    else tried.push(`${res.status} from the manual page`);
  } catch (err) { tried.push(`manual page: ${err.message}`); }
  throw new Error(`couldn't find the manual (${tried.join("; ")}); set manualPdf.${game} in config.json`);
}
/** The current manual's PDF among the links on VEX's page: old versions are renamed "...-obs.pdf" / "...-obsolete.pdf". */
export function pickManualPdf(html) {
  const urls = [...new Set((html.match(/https?:\/\/content\.vexrobotics\.com\/[^"'\s<>)]+?\.pdf/gi) || []).map(u => u.replace(/&amp;/g, "&")))];
  return urls.find(u => !/[-_]obs(olete)?\.pdf$/i.test(u)) || null;
}

/** Each page's text, one line per line of the PDF. */
export async function readPdf(buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) { text += item.str; text += item.hasEOL ? "\n" : ""; }
    pages.push(text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
  }
  return pages;
}

const RULE_START = /^\s*<([A-Z]{1,3}\d{1,2}[a-z]?)>\s*(.*)$/;
/**
 * The rules, in order: { id, title, text, page }. A rule starts on a line that begins with its
 * tag (<SG1> Starting a Match ...) and runs until the next one; tags quoted inside a rule
 * ("see <G1>") are not rule starts because they don't begin a line.
 */
export function parseRules(pages) {
  const rules = [];
  let cur = null;
  pages.forEach((text, p) => {
    for (const line of text.split("\n")) {
      const m = line.match(RULE_START);
      if (m && !rules.some(r => r.id === m[1])) {
        cur = { id: m[1], title: "", text: line.trim(), page: p + 1 };
        rules.push(cur);
        continue;
      }
      if (cur && line.trim() && cur.text.length < 6000) cur.text += `\n${line.trim()}`;
    }
  });
  for (const r of rules) {
    const body = r.text.replace(/^<[^>]+>\s*/, "").replace(/\s+/g, " ").trim();
    // The title is the rule's opening phrase, before the first sentence ends or a dash.
    r.title = (body.split(/(?<=[.!?])\s|\s[–—-]\s/)[0] || body).slice(0, 110);
    r.text = r.text.slice(0, 6000);
  }
  return rules;
}

/** The version printed in the PDF's address or on its first page, if any. */
export function manualVersion(url, pages) {
  const m = (url || "").match(/v[-_ ]?(\d+(?:\.\d+)+)/i) || (pages[0] || "").match(/Version\s+(\d+(?:\.\d+)+)/i);
  return m ? m[1] : "";
}

/** Fetches, parses and stores the manual when VEX has a new one (or ours is over a week old). */
export async function syncManual({ db, FieldValue, chunk, config }, game, { force = false } = {}) {
  const url = await findManualPdf(game, config);
  const meta = (await db.doc(`manual/${game}`).get()).data();
  const fresh = meta?.url === url && Date.now() - (meta.fetchedAt?.toMillis?.() || 0) < 7 * 86400e3;
  if (fresh && !force) return { url, unchanged: true };
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${res.status} downloading the manual`);
  const pages = await readPdf(await res.arrayBuffer());
  const rules = parseRules(pages);
  if (rules.length < 10) throw new Error(`only ${rules.length} rules found; not replacing the stored manual`);
  const ruleParts = chunk(rules, 150);
  // Page text in pieces under Firestore's 1 MB document limit.
  const textParts = [];
  let part = [], size = 0;
  for (const [i, t] of pages.entries()) {
    if (size + t.length > 600e3 && part.length) { textParts.push(part); part = []; size = 0; }
    part.push({ page: i + 1, text: t }); size += t.length;
  }
  if (part.length) textParts.push(part);
  const batch = db.batch();
  ruleParts.forEach((items, i) => batch.set(db.doc(`manual/${game}-rules-${i}`), { items }));
  textParts.forEach((items, i) => batch.set(db.doc(`manual/${game}-text-${i}`), { items }));
  batch.set(db.doc(`manual/${game}`), { url, version: manualVersion(url, pages), pages: pages.length, rules: rules.length,
    chunks: ruleParts.length, textChunks: textParts.length, fetchedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  await batch.commit();
  console.log(`Manual (${game}): ${rules.length} rules from ${pages.length} pages, ${url.split("/").pop()}`);
  return { url, rules: rules.length };
}

/** The stored manual for the AI: every page's text joined, and the rules. */
export async function loadManual(db, game) {
  const meta = (await db.doc(`manual/${game}`).get()).data();
  if (!meta) return null;
  const texts = await Promise.all(Array.from({ length: meta.textChunks }, (_, i) => db.doc(`manual/${game}-text-${i}`).get()));
  const rules = await Promise.all(Array.from({ length: meta.chunks }, (_, i) => db.doc(`manual/${game}-rules-${i}`).get()));
  return { meta, pages: texts.flatMap(d => d.get("items") || []), rules: rules.flatMap(d => d.get("items") || []) };
}
