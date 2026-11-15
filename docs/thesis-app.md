# THESIS web app (`/app.html`)

For Taha, Anne and Dianne: the new beginner-first experience. It is built **alongside** the original site, and `/` is unchanged. Educational research, not investment advice.

## Run it
```
npm run start:tigerdata                 # TigerData, schema thesis_dev (docs/persistence.md)
open http://localhost:3000/app.html
```
- Local database without TigerData: `LOOP_DB=pglite npm start`.
- Plain `npm start` (JSON mode): the app still opens and Explore works, but saving theses says the database is off.

## Pages (hash routes, all in `public/app.js`)

| Route | What it is |
|---|---|
| `#/` | **My theses**: saved theses with activity, unfinished thesis conversations to resume, "Create a new thesis" |
| `#/new` → `#/create/:sessionId` | **Create a thesis**: conversation (`onboard`) → explore and pick 1–5 assets → confirm picks → draft → edit assumptions and "what would challenge it" → explicit confirmation (checkbox) → save. Every step is saved server-side, and a refresh resumes it |
| `#/thesis/:id` | **Workspace overview**: goal, contribution, time frame, chosen investments (explained), confirmed assumptions, risks, alerts, recent activity, pause/resume monitoring |
| `#/thesis/:id/evidence` | **News evidence** grouped by assumption: stance, why it matters, publisher, published and assessed times, original link, "Investigate with AI" |
| `#/thesis/:id/chat[/:conversationId]` | **Research chat**: general or article investigation (`/chat/new?match=…`), clickable `[n]` citations that jump to source cards with links to the evidence, follow-up chips, conversation history |
| `#/portfolio` | **Portfolio** tab: Dianne's paper portfolio (`portfolio.html/js/css`, unchanged) hosted inside THESIS, labelled virtual money |
| `#/feed` | **Feed** tab: Anne's feed (`index.html` + `feed.js`, unchanged) hosted inside THESIS, including paper Buy |
| `#/explore` | Older THESIS view of the ranked list; still reachable, no longer in the nav. Explore & Learn inside New Thesis is separate and unchanged |

## Data rules
- **The server is the source of truth.** The browser stores only `thesis.userId` (a demo id, **not a login**) and the Explore risk-level choice. Theses, sessions, evidence and chats always come from `/api/v2`.
- **Unknown id:** if the stored id is unknown to the database, the app creates a new demo profile. `?user=usr_…` in the URL adopts an existing id (e.g. on another device).
- **Conflicts:** session actions send `expectedVersion`. A 409 reloads the latest version.

## Portfolio and Feed sections (for teammates)
The top nav is **My Theses | Portfolio | Feed**. Portfolio and Feed are the original pages, each loaded unchanged in a same-origin frame by `public/sections/legacy-host.js`. The adapter:
- hides their own header and footer (`public/sections/legacy-embed.css`, loaded only inside the frame);
- sizes the frame to its content, so there is one page scroll;
- keeps the Feed's detail panel in view;
- sends internal links (`/`, `/portfolio.html`, `/thesis.html`) to THESIS routes, and opens external links in a new tab.

It also skips the Feed's email/passcode screen by calling the page's own `showDash()`. No account, email or thesis is written, and the Feed's risk-level picker stays its filter.

**To update a section:** keep editing `index.html`/`feed.js`/`styles.css` or `portfolio.*` as before; THESIS shows the new version automatically. If a page is renamed, change its `src` in `SECTIONS` at the top of `legacy-host.js`. The standalone pages (`/`, `/portfolio.html`) still work as a fallback.

## Known limitation: contribution amounts are single values
Onboarding stores one contribution amount (`profile.amount`, plus `cadence`). If the user says a range ("$50 to $100 a month"), only one number is kept and the range is lost. Risk comfort is likewise one value. Only the time frame keeps the user's wording (`profileDetails.timelineText`, e.g. "2–3 years"). The Research Chat is told these details may be approximate and to say "about", but it cannot recover a range that was never stored. Changing this needs an onboarding schema change, which is not planned yet.

## Backend additions (small, additive)
- `POST /api/v2/theses`: a newly created thesis is matched against the **already-stored** news in the background (`pipeline.matchStoredFeedFor`).
  - It uses the same news selection and the same `matchNewsDetailed`.
  - It **never emails**: challenges found at save time get a `skipped` notification ("found when the thesis was saved"), so later runs don't email them either.
  - A seed that arrives during this run waits for it instead of being skipped.
- `GET /api/v2/thesis/session/:id`:
  - `draft` gains goal, budget, horizon text and note, tier, `selectedAssets`, risks, disclaimer and `confirmedAt`;
  - plus `selectionAssets` (picks with names) and `savedThesisId`.
- `GET /api/v2/thesis/sessions`: each session gains `savedThesisId`, `goal`, `assets` and `lastDisplayText`.
- `GET /api/v2/theses`: each thesis gains `assumptionCount` and `activity` (matches, challenges, conversations, last activity).

## Tests
- `npm run test:app` (part of `npm test`), offline:
  - static checks: every `/api/v2` call in `app.js` has a route; wording rules;
  - the full journey with mock Gemini on in-memory PostgreSQL, including a restart;
  - the original site still works.
