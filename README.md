# 19109M Scout

The team's scouting app. It runs entirely in the cloud for free. Nobody's laptop has to be on.

- **Website + database:** Firebase (free Spark plan): hosting, email/password accounts and the Firestore database.
- **Data refresh:** a GitHub Actions job (`.github/workflows/sync.yml`) pulls results from VEX Events (events.vex.com, formerly RobotEvents):
  - every 5 seconds while one of our events is running (8am–6pm on event days, in the event's own time zone, so Worlds in Dallas works too). Each check reads only our division's matches and rankings (2 VEX Events requests); teams, skills and other divisions are re-read once a minute. That's about 30 requests a minute, well under VEX Events' limit, and the database is only written when a score actually changes, so the free Firebase quota isn't touched. Phones update the moment a write lands.
  - every 5 seconds the rest of the time too (`alwaysOn` in `config.json`): our upcoming events are checked one per round, and lookups from the app are answered within seconds. Each run lasts just under GitHub's 6-hour limit and then starts the next; the hourly schedule is a backup. Set `alwaysOn` to `false` to go back to hourly outside events.
  - a full refresh every night (or by the next hourly run, if GitHub skips the nightly one)
- **Pit display lock:** Lock & full screen on the pit display keeps it there; leaving needs the team code (checked against a hash the sync stores in `meta/lock`).
- **Two games:** Settings → Game switches the whole app between Override (this season) and Push Back (last season): events, teams, rankings, scorer, whiteboard field. Push Back data is refreshed weekly, and can be loaded on demand from Actions → Scout sync → Run workflow with game `pushback`.
- **Privacy:** every page needs an account, and an account needs the team code. Our autos and scouting notes are only readable by members.
- **Why this repo is public:** public repos get unlimited free GitHub Actions minutes, so live mode can run at every event. Nothing private is in here: the join code, VEX Events token and Firebase key are repository secrets, the Firebase web settings are meant to be public, and all data sits in Firestore behind the members-only rules. Our autos and robot code stay in the private robot repo.

## What's in the app

| Page | What it does |
|---|---|
| Home | Our next match with partners, opponents and win chance, our match list, our rank, our events |
| Events | Our events are loaded automatically. Search every event this season (Ontario by default) and load any of them |
| Event | Our matches, all matches with predictions, rankings with OPR, teams, skills |
| Match | Both alliances with each team's rank, OPR, notes and our scouting |
| Teams | Search every registered team (Ontario by default) |
| Team | Season record, rankings at every event, skills, notes, and our scouting notes. Scouts are shown by nickname |
| Scorer | 0:15 + 1:45 match timer with beeps and a score counter |
| Predict | Pick any four teams at an event and see the win chance |
| Autos | Our autonomous routes on the field (view only), with playback, red/blue mirroring and show/faint/hide path |
| Checklist | Shared team checklists (before each match, packing list, or your own) that tick live on every phone |

**Win predictor.** Each team gets a rating made from three things:
- points added per match at this event (OPR)
- season win rate
- best skills score

Alliance ratings are compared to give a win chance. The event page shows how many played matches it called right.

**Team notes:**
- Every team at our events gets a short note written from its numbers.
- If an Anthropic API key is added, upcoming events also get AI notes (Claude, `claude-opus-5-5`). These include a summary, strengths and things to watch for, based on the team's results plus our scouting notes. Server-side fallback is on (`fallbacks: "default"`), so if Opus is unavailable the request can be answered by Anthropic's default fallback model.
- A note is only rewritten when that team's data changes.
- At most 150 AI notes are written per night.

## Folder layout

```
config.json         team number, region, refresh windows
firestore.rules     who can read and write what
firebase.json
web/                the website (plain HTML/JS, no build step)
sync/               the VEX Events → Firestore job, plus tests (npm test)
```

Our autos (`scout/autos.json`) live in the private robot repo. A small workflow there checks out this repo and runs `sync.mjs` with `SYNC_MODE=autos` and `AUTOS_FILE` pointing at them.

## One-time setup (about 20 minutes)

### 1. Firebase project (on the personal Gmail)

1. Go to <https://console.firebase.google.com> → **Create a project** → name it e.g. `scout-19109m`. Turn Google Analytics off. It stays on the free Spark plan and doesn't need a card.
2. **Build → Authentication → Get started → Email/Password → Enable → Save.**
3. **Build → Firestore Database → Create database.** Pick location `northamerica-northeast1 (Montréal)`, then **production mode**.
4. **Build → Hosting → Get started.** Click Next through the steps; you don't need to run the commands it shows.
5. **Project settings (gear) → General → Your apps → Web `</>`.** Register an app called `19109M Scout`. Copy the whole `const firebaseConfig = { ... };` block it shows; you'll need it in step 2.
6. **Project settings → Service accounts → Generate new private key.** This downloads a `.json` file. Treat it like a password.
7. Open <https://console.cloud.google.com/iam-admin/iam>, pick the same project, and edit the `firebase-adminsdk-…` account (pencil icon). Add the roles **Firebase Admin** and **Service Usage Consumer**, then save.

### 2. GitHub secrets

In this repo (and the robot repo, for `FIREBASE_SERVICE_ACCOUNT` only) go to **Settings → Secrets and variables → Actions → New repository secret** and add:

| Name | Value |
|---|---|
| `ROBOTEVENTS_TOKEN` | Your VEX Events API token (the long `eyJ…` one; the name is from when it was RobotEvents) |
| `FIREBASE_SERVICE_ACCOUNT` | The entire contents of the `.json` file from step 1.6 |
| `TEAM_JOIN_CODE` | A code teammates type to join. Pick something not guessable |
| `ANTHROPIC_API_KEY` | *Optional.* An API key from <https://console.anthropic.com>, for AI notes. Set a monthly spend limit there |

Secrets are never shown again after saving, and they never appear in the code or logs.

### 3. Go live

1. **Actions → Scout deploy → Run workflow.** Later pushes to `main` that change the site deploy on their own.
2. **Actions → Scout sync → Run workflow → mode `full` → Run.** The first run takes about 15 minutes.
3. Open `https://<project-id>.web.app`, tap **New here**, and join with your email, a password, a nickname and the team code.
4. On a phone, use **Share → Add to Home Screen** so it opens like an app.

Teammates do step 3 with their own email (school or personal).

## Everyday use

- **New or changed auto:** in the robot repo, edit `scout/autos.json`, run `node tools/gen-autons.mjs` to update the robot code (`include/auto_list.hpp`, `src/auto_routes.cpp`), and push to any branch. The Autos page updates within about a minute. Coordinates are red alliance, in inches from the field center, heading 0 = up the field image. One tile = 23.8 in.
- **Picking the auto for a match:** every auto is in one robot program. Set `SELECTED_AUTO` and `ALLIANCE` in the robot repo's `include/autons.hpp`, then build and upload. Each auto's page shows the exact two lines.
- **An event we're not registered for:** open it from Events and tap **Load this event**. It loads at the next refresh and stays live while it runs.
- **Change the team code:** update the `TEAM_JOIN_CODE` secret. Existing members stay in.
- **Remove someone:** Firebase console → Authentication → find them → Delete account. Also delete their `members/<id>` document in Firestore.

## Free-tier budget

- **GitHub Actions:** free and unlimited on a public repo, so live mode can run at every event day, Worlds included. GitHub pauses scheduled jobs in a public repo after 60 days with no commits; if that happens, the Actions tab shows a button to turn them back on (any commit also does).
- **Firebase Spark:** 50k reads and 20k writes a day, which is plenty for a team.

## Local testing

```
cd sync && npm install && npm test      # predictor math
```

`web/firebase-config.js` holds the project's web settings (they aren't secret) and `.firebaserc` names the project. To test against the Firebase emulators, temporarily add `emulators: true` to the config. The sync job also runs against the emulators when `FIRESTORE_EMULATOR_HOST` is set, and `ROBOTEVENTS_API` can point it at a fake API.
