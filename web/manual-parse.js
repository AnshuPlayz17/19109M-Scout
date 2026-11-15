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

