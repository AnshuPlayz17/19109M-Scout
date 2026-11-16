// Splitting the game manual's text into rules. Shared by the app (an admin loads the PDF) and the
// sync job (sync/manual.mjs). Plain JavaScript, no browser or Node APIs.

/** One PDF page's text (from pdf.js getTextContent), one line per line of the page. */
export function pageText(content) {
  let text = "";
  for (const item of content.items) { text += item.str; text += item.hasEOL ? "\n" : ""; }
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
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
      if (cur && line.trim() && cur.text.length < 6000 && !FURNITURE.some(re => re.test(line.trim()))) cur.text += `\n${line.trim()}`;
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


// ---------- Showing a rule: the PDF's text tidied into paragraphs, lists and call-outs.

// Page furniture that lands inside a rule when it runs across a page break.
const FURNITURE = [/game manual\s*$/i, /copyright\s+\d{4}/i, /^\d{1,3}\s*$/, /^\d{1,3}\s*version\s+\d/i];
const CALLOUTS = /^(note|notes|caution|tip|tips|example|examples|clarification|violation notes|red box|important)\s*:?\s*$/i;
const ITEM = /^(?:(\d{1,2})[.)]|([a-h])[.)]|[•●▪◦-])\s+(.*)$/;
const ends = t => /[.:;!?)]\s*$/.test(t);
// A short Title Case line with no full stop at the very end is the next section's heading.
const isHeading = t => t.length <= 45 && !/[.:;!?,]$/.test(t) && /^[A-Z][A-Za-z]*(\s+(and|of|the|for|in|&|[A-Z][A-Za-z]*))*$/.test(t);

/** A short heading for a rule: its title, cut down when it's really a whole first sentence. */
export function shortTitle(title) {
  const t = String(title || "").replace(/\s*[:.]\s*$/, "");
  if (t.length <= 64) return t;
  // A long opening sentence usually names the game term it defines: "An Autonomous Win Point is…".
  const term = t.match(/^(?:(?:A|An|The|Each|Any|All|If|When)\s+)?((?:[A-Z][a-z]+\s+){1,4}[A-Z][a-z]+)\b/);
  if (term) return term[1];
  const words = t.split(/\s+/);
  return `${words.slice(0, 9).join(" ")}…`;
}

/**
 * The rule's text as blocks to draw: { type: "p" | "item" | "callout" | "aside", text, n, label }.
 * Joins the PDF's wrapped lines back into sentences and drops page headers and footers.
 */
export function ruleBlocks(text) {
  let lines = String(text || "").replace(/^\s*<[^>]+>\s*/, "").split("\n").map(l => l.trim()).filter(Boolean)
    .filter(l => !FURNITURE.some(re => re.test(l)));
  while (lines.length > 1 && isHeading(lines[lines.length - 1])) lines.pop();
  const width = Math.max(40, ...lines.map(l => l.length));
  const blocks = [];
  let cur = null, callout = null;
  const push = b => { (callout ? callout.body : blocks).push(b); cur = b; return b; };
  for (const [i, line] of lines.entries()) {
    const prev = lines[i - 1] || "";
    const label = line.match(CALLOUTS);
    if (label) { callout = { type: "callout", label: label[1][0].toUpperCase() + label[1].slice(1).toLowerCase(), body: [] }; blocks.push(callout); cur = null; continue; }
    if (/^this rule is applied differently for/i.test(line)) { callout = null; cur = { type: "aside", text: line }; blocks.push(cur); continue; }
    const item = line.match(ITEM);
    if (item) { push({ type: "item", n: item[1] ? Number(item[1]) : item[2] || null, text: item[3] }); continue; }
    // Keep going with the same paragraph or item unless the line before clearly ended one
    // (a full stop on a short line, or a colon).
    const newPara = !cur || /:\s*$/.test(prev) || (ends(prev) && prev.length < width * 0.72 && /^[A-Z"“(]/.test(line));
    if (!newPara) cur.text += ` ${line}`;
    else push({ type: "p", text: line });
  }
  return blocks;
}
