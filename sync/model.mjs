// Pure scouting math: OPR, team ratings, win predictions and stats notes.
// No network or database access here, so it can be tested on its own (see test.mjs).

export const QUAL_ROUND = 2;

/** Teams on an alliance, by team number (RobotEvents puts the number in `team.name`). */
export const allianceTeams = alliance => (alliance?.teams || []).map(t => t.team?.name).filter(Boolean);
export const alliance = (match, color) => (match.alliances || []).find(a => a.color === color) || { teams: [], score: 0 };

/**
 * Offensive power rating: each team's estimated point contribution, from
 * scored matches at one event. Ridge-regularised least squares so teams with
 * few matches don't blow up.
 */
export function computeOPR(matches, lambda = 0.5) {
  const scored = matches.filter(m => m.scored && m.round === QUAL_ROUND);
  const teams = [...new Set(scored.flatMap(m => ["red", "blue"].flatMap(c => allianceTeams(alliance(m, c)))))].sort();
  const n = teams.length;
  if (!n) return {};
  const idx = Object.fromEntries(teams.map((t, i) => [t, i]));
  const ata = Array.from({ length: n }, () => new Float64Array(n));
  const atb = new Float64Array(n);
  const count = new Array(n).fill(0);
  for (const m of scored) {
    for (const c of ["red", "blue"]) {
      const a = alliance(m, c);
      const ids = allianceTeams(a).map(t => idx[t]);
      const score = Number(a.score) || 0;
      for (const i of ids) {
        count[i]++;
        atb[i] += score;
        for (const j of ids) ata[i][j] += 1;
      }
    }
  }
  for (let i = 0; i < n; i++) ata[i][i] += lambda;
  const x = solve(ata, atb);
  const out = {};
  teams.forEach((t, i) => { out[t] = { opr: round1(x[i]), matches: count[i] }; });
  return out;
}

function solve(a, b) {
  // Gaussian elimination with partial pivoting on copies.
  const n = b.length;
  const m = a.map(r => Float64Array.from(r));
  const v = Float64Array.from(b);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    [v[c], v[p]] = [v[p], v[c]];
    const d = m[c][c] || 1e-9;
    for (let r = c + 1; r < n; r++) {
      const f = m[r][c] / d;
      if (!f) continue;
      for (let k = c; k < n; k++) m[r][k] -= f * m[c][k];
      v[r] -= f * v[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = v[r];
    for (let k = r + 1; k < n; k++) s -= m[r][k] * x[k];
    x[r] = s / (m[r][r] || 1e-9);
  }
  return x;
}

const round1 = x => Math.round(x * 10) / 10;
const mean = xs => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = xs => { const mu = mean(xs); return Math.sqrt(mean(xs.map(x => (x - mu) ** 2))) || 1; };

/**
 * One strength number per team at an event, on a z-score scale (0 = event average).
 * Blends what we know, weighting each source by how much evidence it has:
 *  - opr:     points contributed at this event (needs 3+ scored matches)
 *  - winRate: season win rate from rankings at other events
 *  - skills:  season best driver + programming skills
 * `seasonStats` is keyed by team number: { wins, losses, ties, bestDriver, bestProg }.
 */
export function computeRatings(teamNumbers, oprs, seasonStats) {
  const feats = {
    opr: t => (oprs[t] && oprs[t].matches >= 3 ? oprs[t].opr : null),
    winRate: t => { const s = seasonStats[t]; const g = s ? s.wins + s.losses + s.ties : 0; return g >= 4 ? (s.wins + 0.5 * s.ties) / g : null; },
    skills: t => { const s = seasonStats[t]; const v = s ? (s.bestDriver || 0) + (s.bestProg || 0) : 0; return v > 0 ? v : null; },
  };
  const weights = { opr: 0.55, winRate: 0.25, skills: 0.2 };
  const z = {};
  for (const [k, f] of Object.entries(feats)) {
    const vals = teamNumbers.map(f).filter(v => v !== null);
    const mu = mean(vals), s = sd(vals);
    z[k] = t => { const v = f(t); return v === null || vals.length < 3 ? null : (v - mu) / s; };
  }
  const out = {};
  for (const t of teamNumbers) {
    let num = 0, den = 0;
    const parts = {};
    for (const k of Object.keys(feats)) {
      const v = z[k](t);
      if (v === null) continue;
      parts[k] = round1(v);
      num += weights[k] * v; den += weights[k];
    }
    // Shrink toward average when evidence is thin (den < 1 means some sources are missing).
    const rating = den ? (num / den) * Math.min(1, 0.4 + den) : 0;
    out[t] = { rating: Math.round(rating * 100) / 100, basis: Object.keys(parts), parts };
  }
  return out;
}

/** Probability that red wins, from the summed ratings of each alliance. */
export function winProbability(redTeams, blueTeams, ratings, scale = 1.15) {
  const sum = ts => ts.reduce((s, t) => s + (ratings[t]?.rating || 0), 0);
  const diff = sum(redTeams) - sum(blueTeams);
  return 1 / (1 + Math.exp(-scale * diff));
}

export function predictMatches(matches, ratings) {
  const out = {};
  for (const m of matches) {
    const red = allianceTeams(alliance(m, "red")), blue = allianceTeams(alliance(m, "blue"));
    if (!red.length || !blue.length) continue;
    out[m.id] = Math.round(winProbability(red, blue, ratings) * 1000) / 1000;
  }
  return out;
}

/** How often the predictor called the winner on scored matches (ties skipped). */
export function predictorAccuracy(matches, predictions) {
  let right = 0, total = 0;
  for (const m of matches) {
    if (!m.scored || predictions[m.id] === undefined) continue;
    const r = Number(alliance(m, "red").score), b = Number(alliance(m, "blue").score);
    if (r === b) continue;
    total++;
    if ((predictions[m.id] >= 0.5) === (r > b)) right++;
  }
  return { right, total };
}

/** A short, plain-language note about a team built only from numbers. */
export function statsNote(team, { ranking, opr, rating, season, scouting, eventSize }) {
  const bits = [];
  if (ranking) bits.push(`Ranked ${ranking.rank}${eventSize ? ` of ${eventSize}` : ""} here (${ranking.wins}-${ranking.losses}-${ranking.ties}).`);
  if (opr && opr.matches >= 3) bits.push(`Adds about ${Math.round(opr.opr)} points per match (OPR).`);
  if (season) {
    const g = season.wins + season.losses + season.ties;
    if (g) bits.push(`Season record ${season.wins}-${season.losses}-${season.ties} across ${season.events || "?"} event${season.events === 1 ? "" : "s"}.`);
    if (season.bestDriver || season.bestProg) bits.push(`Best skills: driver ${season.bestDriver || 0}, programming ${season.bestProg || 0}.`);
  }
  if (scouting && scouting.n) bits.push(`Our scouting: ${scouting.n} note${scouting.n === 1 ? "" : "s"}, average ${scouting.rating.toFixed(1)}★, best auto ${scouting.bestAuto} pins.`);
  if (rating && rating.basis.length) {
    const r = rating.rating;
    bits.push(r > 0.8 ? "One of the strongest teams at this event." : r > 0.25 ? "Above average for this event." : r < -0.8 ? "Among the weaker teams at this event." : r < -0.25 ? "Below average for this event." : "About average for this event.");
  }
  if (!bits.length) return `No results for ${team} yet this season.`;
  return bits.join(" ");
}
