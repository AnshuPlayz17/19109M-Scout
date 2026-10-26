# 19109M Scout

The team's scouting app. It runs entirely in the cloud for free. Nobody's laptop has to be on.

- **Website + database:** Firebase (free Spark plan): hosting, email/password accounts and the Firestore database.
- **Data refresh:** a GitHub Actions job (`.github/workflows/sync.yml`) pulls results from VEX Events (events.vex.com, formerly RobotEvents):
  - every 2 seconds on match days, while one of our events is running (8am–6pm on event days, in the event's own time zone, so Worlds in Dallas works too). Each check reads only our division's matches and rankings (2 VEX Events requests); teams, skills and other divisions are re-read once a minute. That's about 65 requests a minute on match days and 40 otherwise, under VEX Events' ~100 a minute limit, and the database is only written when a score actually changes, so the free Firebase quota isn't touched. Phones update the moment a write lands.
  - every 3 seconds the rest of the time (`alwaysOn` and `idleSeconds` in `config.json`): our upcoming events are checked one per round, and lookups from the app are answered within seconds. Each run lasts just under GitHub's 6-hour limit and then starts the next; the hourly schedule is a backup. Set `alwaysOn` to `false` to go back to hourly outside events.
  - a full refresh every night (or by the next hourly run, if GitHub skips the nightly one)
- **Locked areas:** Autos, the Whiteboard and our scouting notes (and the AI notes made from them) ask for the team code too, then stay open on that device for 12 hours (Settings → Lock now locks them again). Adding a scouting note doesn't need it. It locks the screens, not the data; everyone who can sign in is a member.
- **Forgot the team code:** every place that asks for it has "Ask an admin"; admins (`ADMIN_EMAILS`) see who asked in Settings, with the code.
- **Pit display lock:** Lock & full screen on the pit display keeps it there; leaving needs the team code (checked against a hash the sync stores in `meta/lock`).
- **Two games:** Settings → Game switches the whole app between Override (this season) and Push Back (last season): events, teams, rankings, scorer, whiteboard field. Push Back data is refreshed weekly, and can be loaded on demand from Actions → Scout sync → Run workflow with game `pushback`.
- **Queue now alerts:** when our next match is 3 matches away in our division (or 10 minutes from its scheduled time), every phone with the app open shows a banner with a chime and a buzz, and phones that turned on Settings → Match alerts → Phone notifications get a notification even with the app closed (once per match). On iPhone, notifications need Scout added to the Home Screen first (Share → Add to Home Screen) and opened from there. The sync makes its own Web Push keys the first time (`config/vapid`, unreadable from the app).
- **Notes the team writes:** scouting notes (stars, auto, plus optional drivetrain, auto side, endgame, defense, driver, reliability and quick tags), a shared pit sheet per team (drivetrain, motors, intake, scoring, endgame, autos, game plan), and notes on each of our matches (what went well, what went wrong, what to change). All are behind the team code to read, and all feed the AI notes and Ask Scout.
- **AI notes for the whole region:** besides every team at our events, each night the AI writes notes for up to 300 more Ontario teams (stalest first), within the notes budget.
- **At events:** from any event page: **Alliance selection** (cross teams off as they're picked, live on every phone, with the best still available on top, ordered by the Scout for me report or the event's ratings), **Scouting assignments** (pick who's scouting and the teams are split between them, teams in our next matches first; each scout sees their list and progress on Home), and **Export scouting** (scouting notes, pit sheets and match notes as a CSV spreadsheet). On each of our matches, **Game plan** has the AI write a plan from all four teams' stats, notes and our scouting.
- **Bracket:** an event's Bracket tab (once eliminations start) shows every round, our alliance highlighted, and our path: the chance to win each round against the actual or likeliest opponent, and to win it all.
- **Skills planner** (More): our official and practice skills runs on a chart, our rank in the region, and how far we are from a target rank you set (driver and autonomous separately), with the region's leaderboard (refreshed nightly).
- **Season review** (More, or Event review on an event's page): results event by event, what changed since the last event, our match notes, and an AI-written engineering notebook entry with a copy button.
- **Offline scouting:** scouting notes save on the phone straight away and send when there's a connection (marked "Waiting to send" until then). The app shows when it's offline.
- **AI (needs `ANTHROPIC_API_KEY`):** Ask Scout (the chat button on every page) answers questions about teams, events and picks by looking up our data. Scout for me (the Scout tab) takes any event, loads every team's season and last season (Push Back), draws a hexagon chart for each, ranks them into a pick list and writes them up. All AI uses Claude Haiku (`claude-haiku-5-5`, Anthropic's low-cost model) and is answered by the running sync job. **Spending cap:** $50 a month for the whole team, and per day at most $5 for the team, $2 a person and $1 for the nightly notes (`aiMonthlyUsd`, `aiDailyUsd`, `aiPerPersonUsd`, `aiNotesUsd` in `config.json`); the totals show in Settings → AI. A Scout for me report costs a few cents and a chat answer a fraction of a cent. Also set a monthly limit in the Anthropic console as a backstop.
- **Hexagon charts:** each team's season as six percentiles against every team with stats (scoring, win rate, autonomous, driving, consistency, placement), with last season dashed on top, plus an event-by-event chart. The math is in `web/profile.js`, shared by the app and the sync.
- **Privacy:** every page needs an account, and an account needs the team code. Our autos and scouting notes are only readable by members.
- **Why this repo is public:** public repos get unlimited free GitHub Actions minutes, so live mode can run at every event. Nothing private is in here: the join code, VEX Events token and Firebase key are repository secrets, the Firebase web settings are meant to be public, and all data sits in Firestore behind the members-only rules. Our autos and robot code stay in the private robot repo.

## What's in the app

| Page | What it does |
|---|---|
| Scout | Scout for me: pick any event, get a ranked pick list with a chart and write-up for every team |
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
- If an Anthropic API key is added, upcoming events also get AI notes (Claude Haiku, `claude-haiku-5-5`): a longer summary, strengths, weaknesses, things to watch for, how to play with and against them, their trend over the season and their Push Back season, based on their results event by event and match by match, plus our scouting notes.
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
| `ADMIN_EMAILS` | *Optional.* Emails of the app's admins, comma separated (their accounts must exist). Admins get "Ask an admin" requests for the team code in Settings and can see the code there. Only account ids are stored. |
| `ANTHROPIC_API_KEY` | *Optional.* An API key from <https://console.anthropic.com>, for AI notes, Ask Scout and Scout for me. Set a monthly spend limit there |

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
