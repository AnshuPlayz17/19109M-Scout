// A team's season as six numbers for the hexagon chart, shared by the app (team pages, Scout for me)
// and the sync job (which ranks pick lists with it). Plain JavaScript, no browser or Node APIs.
//
// Each axis starts as a raw number from a team's season stats (teamstats docs), then becomes a
// percentile against every team the sync has stats for (meta/scales, written each night), so
// 0.9 means "better than 90% of teams" whatever the axis measures.

export const AXES = [
  { key: "scoring", label: "Scoring", hint: "Average points per match" },
  { key: "win", label: "Win rate", hint: "Share of matches won" },
  { key: "auto", label: "Autonomous", hint: "Best autonomous skills score" },
  { key: "driver", label: "Driving", hint: "Best driver skills score" },
  { key: "consistency", label: "Consistency", hint: "How much results swing from event to event" },
  { key: "placement", label: "Placement", hint: "Average rank at events" },
];

const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
const sd = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };

/** Raw axis values from a teamstats doc. null = not enough data. */
export function rawAxes(st) {
  if (!st) return Object.fromEntries(AXES.map(a => [a.key, null]));
  const n = (st.wins || 0) + (st.losses || 0) + (st.ties || 0);
  const evs = (st.rankings || []).filter(r => (r.wins || 0) + (r.losses || 0) + (r.ties || 0) >= 3);
  const avgs = evs.map(r => Number(r.avg)).filter(x => x > 0);
  const rates = evs.map(r => (r.wins + 0.5 * (r.ties || 0)) / (r.wins + r.losses + (r.ties || 0)));
  // Consistency: steady win rates and steady scoring from event to event. One event isn't enough.
  const parts = [];
  if (rates.length >= 2) parts.push(Math.max(0, 1 - 2 * sd(rates)));
  if (avgs.length >= 2) parts.push(Math.max(0, 1 - sd(avgs) / Math.max(1, mean(avgs))));
  const ranks = (st.rankings || []).map(r => r.rank).filter(r => r > 0);
  const skills = st.bestDriver || st.bestProg;
  return {
    scoring: avgs.length ? mean(avgs) : null,
    win: n ? ((st.wins || 0) + 0.5 * (st.ties || 0)) / n : null,
    auto: skills || n ? st.bestProg || 0 : null,
    driver: skills || n ? st.bestDriver || 0 : null,
    consistency: parts.length ? mean(parts) : null,
    placement: ranks.length ? -mean(ranks) : null, // negative so that higher is better
  };
}

/** Quantiles (21 points, 0%..100%) of each axis over many teams' stats: the meta/scales doc. */
export function buildScales(statsList) {
  const out = { n: 0 };
  const raws = statsList.map(rawAxes);
  out.n = raws.filter(r => r.win !== null).length;
  for (const { key } of AXES) {
    const xs = raws.map(r => r[key]).filter(x => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
    out[key] = xs.length ? Array.from({ length: 21 }, (_, i) => xs[Math.min(xs.length - 1, Math.round((i / 20) * (xs.length - 1)))]) : [];
  }
  return out;
}

/** Where `v` falls among the scale's quantiles, 0..1 (null stays null). */
export function percentile(q, v) {
  if (v === null || v === undefined || !q?.length) return null;
  if (v <= q[0]) return 0;
  if (v >= q[q.length - 1]) return 1;
  for (let i = 1; i < q.length; i++) {
    if (v <= q[i]) {
      const lo = q[i - 1], hi = q[i];
      // Ties across several quantiles: land in the middle of them.
      let j = i; while (j + 1 < q.length && q[j + 1] === v) j++;
      const f = hi === lo ? (j - i) / 2 + 1 : (v - lo) / (hi - lo);
      return Math.min(1, (i - 1 + f) / (q.length - 1));
    }
  }
  return 1;
}

/** The six axes as 0..1 percentiles (null where there's no data). */
export function profile(st, scales) {
  const raw = rawAxes(st);
  return Object.fromEntries(AXES.map(({ key }) => [key, percentile(scales?.[key], raw[key])]));
}

// How much each axis counts towards a pick list score. Missing data counts as a little below average.
const WEIGHTS = { scoring: 0.24, win: 0.2, auto: 0.16, driver: 0.14, consistency: 0.12, placement: 0.14 };
export function pickScore(p) {
  return AXES.reduce((s, { key }) => s + WEIGHTS[key] * (p[key] ?? 0.35), 0);
}
