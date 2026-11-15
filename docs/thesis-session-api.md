# Thesis session API (`handleThesisAction`)

For Taha (backend route and storage) and Anne (website UI). Owner: Vamsi (`server/thesis.js`).

`handleThesisAction` runs the whole thesis flow from one web route:

1. Onboarding.
2. Exploring investments.
3. Picking 1–5 assets and confirming them.
4. Creating a draft.
5. Reviewing, editing and confirming the assumptions.
6. Getting the confirmed thesis.

The handler is **stateless**: the backend loads and saves the session itself. It never saves anything, starts monitoring, sends email or trades. Educational research, not investment advice.

```js
const { handleThesisAction } = require('./thesis');
const response = await handleThesisAction(session, action, payload, { expectedVersion });
```

It always resolves (it never throws).

## Suggested route (Taha)

`POST /api/thesis/session`

```json
{ "sessionId": "s_123", "action": "selectAssets", "payload": { "symbols": "NVDA, VOO" } }
```

Route steps:

1. Load the session from **trusted server storage** by `sessionId`, together with its stored `version`. For the first `onboard` call, use no session (`null`).
2. **Never accept a session object from the client.** The browser sends only `sessionId`, `action` and `payload`. The handler cleans whatever it is given, but a session sent by the client could still claim a confirmed selection or confirmed assumptions the user never made.
3. Call `handleThesisAction(stored, action, payload, { expectedVersion: storedVersion })`.
4. If `response.ok && response.changed`, save `response.session` **only if** the stored version is still the one you loaded (compare-and-swap, see below).
5. Return to the browser everything except `session`, plus `sessionId`. The UI does not need the raw session.

## Response (every action)

```json
{
  "ok": true,
  "action": "selectAssets",
  "error": null,
  "session": { "...": "engine state to persist", "version": 2 },
  "version": 2,
  "changed": true,
  "stage": "selection_pending",
  "nextActions": ["confirmSelection", "selectAssets", "explore", "onboard"],
  "displayText": "Selected for research: NVDA (NVIDIA), VOO (Vanguard S&P 500 ETF). Confirm these 2? (yes / change)",
  "result": { "...": "action-specific, see below" }
}
```

| Field | Meaning |
|---|---|
| `ok` / `error` | On failure, `ok` is `false` and `error` is `{ code, message }`. `message` is safe to show the user. **Do not save the session when `ok` is false.** |
| `session` | The persisted state, JSON-safe. Keys: `history` (user/assistant text only), `profile`, `askedFields`, `activeFlow`, `tickers`, `lastQuestionField`, `profileDetails`, `selection {pending, confirmed}`, `thesisDraft`, `version`. It holds no credentials, raw model replies or diagnostics. Unknown keys are dropped. |
| `version` / `changed` | See "Session version" below. |
| `stage` / `nextActions` | Drive the UI from these. See the table below. |
| `displayText` | Text ready to show the user. |
| `result` | The engine function's normal output, without `session`. Provider error details (`fallbackReason`) are left out; `source` (`gemini` or `fallback`) and `model` remain. |

### Stages

| `stage` | Meaning | `nextActions` (main action first) |
|---|---|---|
| `onboarding` | Profile incomplete (needs purpose, amount, cadence, timeline). | `onboard`, `explore`, `selectAssets` |
| `selecting` | Profile ready, nothing picked yet. | `explore`, `selectAssets`, `onboard` |
| `selection_pending` | Assets picked but not confirmed. | `confirmSelection`, `selectAssets`, `explore`, `onboard` |
| `drafting` | Selection confirmed. | `createDraft`, `selectAssets`, `explore`, `onboard` |
| `reviewing` | Draft proposed; assumptions not confirmed. | `editAssumption`, `confirmAssumptions`, `createDraft` |
| `confirmed` | Assumptions confirmed. | `getConfirmedThesis`, `editAssumption` |

## Actions

| `action` | `payload` | `result` highlights |
|---|---|---|
| `onboard` | `{ "message": "string, 1-2000 chars" }` | `reply`, `nextQuestion {field,text}`, `profile`, `missingFields`, `readyToProceed`, `nextSteps [{id,label}]`, `intent` |
| `explore` | `{}` | `intro`, `categories [{ ..., assets: [{symbol,name,...}] }]`, `selectableCount` |
| `selectAssets` | `{ "symbols": "NVDA, VOO" }` or `{ "symbols": ["NVDA","VOO"] }` | `selected [{symbol,name,category}]`, `unsupported`, `unmatched`, `overLimit`, `duplicates`, `needsConfirmation` |
| `confirmSelection` | `{}` | `confirmed` assets |
| `createDraft` | `{}` | `draft` (Contract C fields plus `assumptionDetails`, `selectedAssets`, `risks`, `disclaimer`), `monitoringActivated: false` |
| `editAssumption` | `{ "number": 1, "text"?: "...", "challenge"?: "...", "keepChallenge"?: true }` | updated `assumptions`, `status` |
| `confirmAssumptions` | `{}` | `thesis`, `status: "confirmed"` |
| `getConfirmedThesis` | `{}` | `thesis` (read-only; `version` does not change) |

Rules for `editAssumption`:

- `text` changes the wording. You must also send either new `challenge` criteria or `keepChallenge: true`. Otherwise the error is `challenge_decision_needed`, and its `result.currentChallenge` lets the UI ask the user.
- `challenge` without `text` changes only the criteria.
- Any edit of a confirmed thesis returns it to `reviewing`.

### Example: a full sequence

Requests in order:

```json
{ "action": "onboard", "payload": { "message": "I want to invest $50 a month for 5 years to build long-term wealth." } }
{ "sessionId": "s_123", "action": "explore", "payload": {} }
{ "sessionId": "s_123", "action": "selectAssets", "payload": { "symbols": "NVDA, VOO" } }
{ "sessionId": "s_123", "action": "confirmSelection", "payload": {} }
{ "sessionId": "s_123", "action": "createDraft", "payload": {} }
{ "sessionId": "s_123", "action": "editAssumption", "payload": { "number": 1, "text": "Demand for NVIDIA AI data-center chips keeps growing as cloud companies expand AI infrastructure.", "challenge": "NVIDIA lowering guidance, or cloud customers cutting AI infrastructure spending." } }
{ "sessionId": "s_123", "action": "confirmAssumptions", "payload": {} }
{ "sessionId": "s_123", "action": "getConfirmedThesis", "payload": {} }
```

Response to the first `onboard` (abridged):

```json
{ "ok": true, "action": "onboard", "error": null, "version": 1, "changed": true, "stage": "selecting",
  "nextActions": ["explore", "selectAssets", "onboard"],
  "displayText": "Got it: $50 monthly, goal: build long-term wealth, about 5 years away. If your investments dropped 20% in a bad year, how comfortable would you be: low, medium or high?",
  "result": { "intent": "goal_exploration", "nextQuestion": { "field": "riskComfort", "text": "If your investments dropped 20% in a bad year, ..." },
              "profile": { "amount": 50, "cadence": "monthly", "timelineYears": 5, "purpose": "build long-term wealth", "...": null },
              "readyToProceed": true, "source": "gemini", "model": "gemini-3.5-flash-lite" } }
```

Response to `getConfirmedThesis` (abridged). It is a **superset of Contract C**, which is what a future "save thesis" endpoint would store:

```json
{ "ok": true, "action": "getConfirmedThesis", "version": 6, "changed": false, "stage": "confirmed",
  "result": { "thesis": {
    "id": "draft_ab12cd34", "goal": "Build long-term wealth", "budget": { "amount": 50, "cadence": "monthly" },
    "horizonYears": 5, "tier": "medium", "createdAt": "2026-11-15T14:00:00.000Z",
    "assumptions": ["Demand for NVIDIA AI data-center chips keeps growing as cloud companies expand AI infrastructure.", "..."],
    "assumptionDetails": [{ "index": 0, "text": "...", "tickers": ["NVDA"], "whatWouldChallengeIt": "...", "origin": "user" }],
    "selectedAssets": [{ "symbol": "NVDA", "...": "..." }, { "symbol": "VOO", "...": "..." }],
    "assumptionStatus": "confirmed" } } }
```

Error example (an edit without a criteria decision):

```json
{ "ok": false, "action": "editAssumption", "changed": false, "stage": "reviewing",
  "error": { "code": "challenge_decision_needed", "message": "The new wording may need different \"could be challenged by\" criteria. Current criteria: \"...\". Give new criteria, or explicitly keep the current ones." },
  "result": { "needsChallengeDecision": true, "assumptionNumber": 1, "currentChallenge": "..." } }
```

### Error codes

| Code | Cause |
|---|---|
| `unknown_action` | Action not in the list above. |
| `missing_session` | Any action other than `onboard` without a session. |
| `invalid_payload` | Payload fails the rules in the Actions table. |
| `version_conflict` | `expectedVersion` does not match the session. |
| `not_confirmed` | `getConfirmedThesis` called before the assumptions are confirmed. |
| `internal_error` | Unexpected failure. Retry; do not save. |

The engine also passes through these codes:

- `selection_not_confirmed`, `missing_profile`, `nothing_pending`
- `bad_index`, `invalid_assumption`, `invalid_challenge`, `challenge_decision_needed`
- `invalid_assumptions`, `no_draft`

## Session version (preventing stale or overlapping updates)

- `session.version` is an integer that rises by 1 after every successful action that **actually changed** the session. `explore`, `getConfirmedThesis`, a repeated confirm and every failed action leave it unchanged (`changed: false`).
- A session saved before versions existed (no `version`) counts as version 0, so older sessions keep working.
- **Optimistic concurrency:** pass `{ expectedVersion: <stored version> }`. If it doesn't match the session's version, nothing runs and the error is `version_conflict`. When saving, also use a conditional write, so two overlapping requests (for example, two browser tabs) can't overwrite each other:

  ```sql
  UPDATE thesis_sessions SET data = $new, version = $newVersion
  WHERE id = $id AND version = $loadedVersion;   -- 0 rows updated => conflict: reload and retry
  ```

  A JSON store does the same compare inside one read-modify-write.

## What it does not do

- No storage and no session map.
- No monitoring, matching, email or trades.
- No saving a confirmed thesis as the user's active thesis. That is a separate backend step; `GET /api/thesis` and the pipeline are unchanged.

To try it: `npm run test:session` runs offline, with no key needed.
