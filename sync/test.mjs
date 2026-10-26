// Tests for the scouting math. Run: npm test (from sync/)
import assert from "node:assert/strict";
import { computeOPR, computeRatings, winProbability, predictMatches, predictorAccuracy, statsNote } from "./model.mjs";

const team = n => ({ team: { name: n } });
const match = (id, red, blue, rs, bs, scored = true) => ({
  id, round: 2, scored,
  alliances: [{ color: "red", score: rs, teams: red.map(team) }, { color: "blue", score: bs, teams: blue.map(team) }],
});

// Synthetic event: true contributions A=30, B=20, C=10, D=5. Every pairing plays.
const truth = { A: 30, B: 20, C: 10, D: 5 };
const pairs = [[["A", "B"], ["C", "D"]], [["A", "C"], ["B", "D"]], [["A", "D"], ["B", "C"]]];
const matches = [];
let id = 1;
for (let rep = 0; rep < 3; rep++) for (const [r, b] of pairs) {
  matches.push(match(id++, r, b, r.reduce((s, t) => s + truth[t], 0), b.reduce((s, t) => s + truth[t], 0)));
}
const opr = computeOPR(matches, 0.01);
for (const t of Object.keys(truth)) assert.ok(Math.abs(opr[t].opr - truth[t]) < 1, `OPR ${t} ≈ ${truth[t]} (got ${opr[t].opr})`);
assert.equal(opr.A.matches, 9);

// Unscored and non-qual matches are ignored.
assert.deepEqual(computeOPR([match(99, ["A", "B"], ["C", "D"], 50, 10, false)]), {});

// Ratings order follows OPR, and season stats fill in when a team has no event matches.
const season = { A: { wins: 8, losses: 1, ties: 0, bestDriver: 90, bestProg: 40 }, B: { wins: 5, losses: 4, ties: 0, bestDriver: 70, bestProg: 20 },
  C: { wins: 3, losses: 6, ties: 0, bestDriver: 50, bestProg: 10 }, D: { wins: 1, losses: 8, ties: 0, bestDriver: 30, bestProg: 0 },
  E: { wins: 9, losses: 0, ties: 0, bestDriver: 95, bestProg: 50 } };
const ratings = computeRatings(["A", "B", "C", "D", "E"], opr, season);
assert.ok(ratings.A.rating > ratings.B.rating && ratings.B.rating > ratings.C.rating && ratings.C.rating > ratings.D.rating, "ratings follow strength");
assert.ok(ratings.E.rating > 0, "a strong team with only season stats still rates above average");
assert.deepEqual(ratings.E.basis.sort(), ["skills", "winRate"]);

// Win probability is symmetric and favours the stronger alliance.
const p = winProbability(["A", "B"], ["C", "D"], ratings);
assert.ok(p > 0.7, `strong alliance favoured (got ${p})`);
assert.ok(Math.abs(p + winProbability(["C", "D"], ["A", "B"], ratings) - 1) < 1e-9);
assert.equal(winProbability(["X"], ["Y"], {}), 0.5);

// Predictions and accuracy on the synthetic event: should call every match.
const preds = predictMatches(matches, ratings);
const acc = predictorAccuracy(matches, preds);
assert.equal(acc.total, 9);
assert.equal(acc.right, 9);

// Notes read sensibly with partial data.
assert.match(statsNote("Z", {}), /No results/);
const note = statsNote("A", { ranking: { rank: 1, wins: 9, losses: 0, ties: 0 }, opr: opr.A, rating: ratings.A, season: { ...season.A, events: 2 }, scouting: { n: 2, rating: 4.5, bestAuto: 5 }, eventSize: 4 });
assert.match(note, /Ranked 1 of 4/);
assert.match(note, /strongest/);

console.log("all model tests passed");

// ---------- Live-mode hours use the event's own time zone ----------
{
  const { eventZone, liveNow } = await import("./zones.mjs");
  const worlds = { start: "2027-04-21T00:00:00-05:00", end: "2027-04-23T00:00:00-05:00", location: { region: "Texas", country: "United States" } };
  const local = { start: "2026-11-14T00:00:00-05:00", end: "2026-11-14T00:00:00-05:00", location: { region: "Ontario", country: "Canada" } };
  assert.equal(eventZone(worlds), "America/Chicago");
  assert.equal(eventZone({ location: { region: "Unknownland", country: "China" } }), "Asia/Shanghai");
  assert.equal(eventZone({}), "America/Toronto");
  assert.equal(liveNow(worlds, Date.parse("2027-04-22T08:30:00-05:00")), true);   // 8:30 Dallas
  assert.equal(liveNow(worlds, Date.parse("2027-04-22T07:30:00-05:00")), false);  // 7:30 Dallas (8:30 Toronto)
  assert.equal(liveNow(worlds, Date.parse("2027-04-23T17:30:00-05:00")), true);   // last day, 5:30pm Dallas
  assert.equal(liveNow(worlds, Date.parse("2027-04-23T18:30:00-05:00")), false);
  assert.equal(liveNow(local, Date.parse("2026-11-14T09:00:00-05:00")), true);
  assert.equal(liveNow(local, Date.parse("2026-11-15T09:00:00-05:00")), false);
  console.log("ok  live hours follow the event's time zone");
}

// ---------- Hexagon chart percentiles and the queue rule ----------
{
  const { rawAxes, buildScales, profile, pickScore } = await import("../web/profile.js");
  const mk = (w, l, avgs, prog, drv) => ({ wins: w, losses: l, ties: 0, bestProg: prog, bestDriver: drv,
    rankings: avgs.map((a, i) => ({ rank: 3 + i, wins: Math.round(w / avgs.length), losses: Math.round(l / avgs.length), ties: 0, avg: a })) });
  const field = Array.from({ length: 50 }, (_, i) => mk(i % 10, 10 - (i % 10), [20 + i, 25 + i], i, 2 * i));
  const sc = buildScales(field);
  const strong = profile(mk(10, 0, [90, 92], 60, 120), sc), weak = profile(mk(0, 10, [5, 30], 0, 0), sc);
  assert.ok(strong.scoring > 0.95 && strong.win > 0.95 && weak.win < 0.1, "percentiles order teams");
  assert.ok(strong.consistency > weak.consistency, "steady scoring is more consistent");
  assert.ok(pickScore(strong) > pickScore(weak));
  assert.equal(rawAxes({ wins: 2, losses: 1, ties: 0, rankings: [{ rank: 1, wins: 2, losses: 1, ties: 0 }] }).consistency, null, "one event isn't enough");
  assert.equal(profile(null, sc).win, null);

  const { queueState } = await import("./alerts.mjs");
  const M = (num, red, blue, scored) => ({ id: num, name: `Qualifier #${num}`, round: 2, div: "D", num, scored, scheduled: new Date(Date.UTC(2026, 0, 1, 12, num * 7)).toISOString(), red: { teams: red }, blue: { teams: blue } });
  const ev = { matches: [1, 2, 3, 4, 5, 6].map(n => M(n, n === 6 ? ["19109M", "A"] : ["X", "Y"], ["Z", "W"], n <= 1)) };
  const early = Date.UTC(2026, 0, 1, 11, 0);
  assert.equal(queueState(ev, "19109M", early, { matchesAhead: 3, minutes: 10 }).due, false, "4 matches ahead, an hour early");
  ev.matches[1].scored = true;
  assert.equal(queueState(ev, "19109M", early, { matchesAhead: 3, minutes: 10 }).due, true, "3 ahead: queue");
  assert.equal(queueState({ matches: ev.matches.slice(0, 5) }, "19109M", early, { matchesAhead: 3, minutes: 10 }), null, "no match of ours");
  console.log("ok  profile percentiles and queue alerts");
}
