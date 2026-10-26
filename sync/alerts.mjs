// "Queue now" alerts: a phone notification to everyone who turned on match alerts, once per match,
// when our next match is close. The app shows the same alert itself (banner, sound, vibration)
// while it's open; this covers phones in a pocket.
//
// Standard Web Push. The sync makes its own key pair the first time (config/vapid, which the app
// can't read) and publishes the public half in meta/push for the app to subscribe with.
import webpush from "web-push";

/**
 * Our next match and how close it is: `ahead` is how many matches of the same round in our
 * division are still to be played before ours, `mins` the minutes until its scheduled time.
 * Same rule as queueState() in web/app.js.
 */
export function queueState(event, us, now, { matchesAhead, minutes }) {
  const next = event.matches.find(m => !m.scored && (m.red.teams.includes(us) || m.blue.teams.includes(us)));
  if (!next) return null;
  const same = event.matches.filter(m => m.div === next.div && m.round === next.round);
  const ahead = same.slice(0, same.indexOf(next)).filter(m => !m.scored).length;
  const mins = (Date.parse(next.scheduled) - now) / 60e3;
  const due = ahead <= matchesAhead || (Number.isFinite(mins) && mins <= minutes);
  return { next, ahead, mins, due };
}

export function createAlerts({ db, FieldValue, config }) {
  let ready = false;
  async function init() {
    const ref = db.doc("config/vapid");
    let keys = (await ref.get()).data();
    if (!keys?.publicKey) { keys = webpush.generateVAPIDKeys(); await ref.set(keys); console.log("Made the push notification keys"); }
    webpush.setVapidDetails("https://github.com/AnshuPlayz17/19109M-Scout", keys.publicKey, keys.privateKey);
    await db.doc("meta/push").set({ publicKey: keys.publicKey });
    ready = true;
  }

  /** Checks one live event of ours; sends the alert if our next match is due and nobody was told yet. */
  async function check(event, us) {
    if (!ready) return;
    const q = queueState(event, us, Date.now(), { matchesAhead: config.queueMatchesAhead, minutes: config.queueMinutes });
    if (!q?.due) return;
    const m = q.next, color = m.red.teams.includes(us) ? "red" : "blue", other = color === "red" ? "blue" : "red";
    try { await db.doc(`alerts/${m.id}`).create({ at: FieldValue.serverTimestamp(), event: event.id }); }
    catch { return; } // already sent (create fails if the document exists)
    const name = String(m.name).replace(/^Qualifier #/, "Q").replace(/^Practice #/, "P");
    const partners = m[color].teams.filter(t => t !== us);
    const payload = JSON.stringify({
      title: `Queue now: ${name}`,
      body: `${color === "red" ? "Red" : "Blue"}${partners.length ? ` with ${partners.join(", ")}` : ""} vs ${m[other].teams.join(", ")}${m.field ? ` · ${m.field}` : ""}`,
      url: `#/match/${event.id}/${m.id}`, tag: `queue-${m.id}`,
    });
    const subs = await db.collection("pushSubs").get();
    let sent = 0;
    await Promise.all(subs.docs.map(async d => {
      const { endpoint, p256dh, auth } = d.data();
      try { await webpush.sendNotification({ endpoint, keys: { p256dh, auth } }, payload, { TTL: 900, urgency: "high" }); sent++; }
      catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) await d.ref.delete(); // that phone turned alerts off or uninstalled
        else console.log(`  push failed (${err.statusCode || err.message})`);
      }
    }));
    console.log(`  Queue alert for ${name}: sent to ${sent} of ${subs.size} phones`);
  }
  return { init, check };
}
