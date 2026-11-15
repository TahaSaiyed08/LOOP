# Thesis research chat: `thesisChat()` contract

For Taha (backend route and storage) and Anne (website UI). Owner: Vamsi (`server/thesis.js`, prompt in `prompts/thesis.md` → "Thesis chat").

`thesisChat` is one stateless function behind both chat experiences:

- **General thesis chat.** Available on any saved thesis, with or without news or notifications.
- **News investigation.** The user opens one matched article, for example from the challenge email, and asks about it.

It never saves anything, edits or confirms assumptions, turns on monitoring, sends email or trades. The caller stores `history`.

## Signature

```js
const { thesisChat } = require('./thesis');
const result = await thesisChat(thesis, history, message, context, opts);
```

| Argument | Type | Notes |
|---|---|---|
| `thesis` | object | The saved thesis. Either the `getConfirmedThesis(session)` shape, which is what `POST /api/thesis {session}` stores, or a plain Contract C thesis. It must have an `id`. If `assumptionStatus` is present it must be `"confirmed"`. Read-only. |
| `history` | array or null | `result.history` from the previous turn of **this thesis's** conversation. Use `[]` or `null` to start. |
| `message` | string | 1 to 2000 characters. |
| `context` | object | `{ evidence?: Item[], focus?: number }`. `evidence` takes saved matches (`GET /api/thesis/news` items) or raw news items (`{ticker, headline, summary, source, url, datetime}`). At most 8 are used. `focus` is the index **into your `evidence` array** of the article being investigated. Leave it out for general chat. |
| `opts` | object | `{ callLLM?, forceFallback? }`, only for tests and demos. Routes pass `{}`. |

Evidence for each turn is passed again by the caller (for example the current `thesisMatches`). Nothing is cached between calls.

## Result

```json
{
  "ok": true,
  "mode": "investigation",
  "thesisId": "draft_42c15fc1",
  "reply": "According to the article's summary, several large cloud customers are delaying GPU orders. [1]\n\nThat is close to what your first assumption says would challenge it.",
  "displayText": "<reply>\n\nEducational research, not investment advice.",
  "segments": [
    { "text": "According to the article's summary, several large cloud customers are delaying GPU orders.", "basis": "evidence", "citations": [1] },
    { "text": "That is close to what your first assumption says would challenge it.", "basis": "thesis", "citations": [] }
  ],
  "citations": [
    { "id": 1, "evidenceId": "E1", "title": "Nvidia warns of slowing AI data-center orders", "url": "https://example.com/sample/nvidia-slowing-ai-orders",
      "publisher": "Sample Wire", "datetime": "2026-11-15T13:00:00Z", "ticker": "NVDA", "evidence": "headline_and_summary" }
  ],
  "followUps": ["What would show that AI chip demand is still growing?"],
  "insufficientEvidence": false,
  "history": [
    { "role": "user", "content": "Why does this challenge my first assumption?", "thesisId": "draft_42c15fc1", "at": "2026-11-15T14:00:00.000Z" },
    { "role": "assistant", "content": "<reply>", "citations": [ "…as above…" ], "thesisId": "draft_42c15fc1", "at": "2026-11-15T14:00:00.000Z", "mode": "investigation", "source": "gemini" }
  ],
  "source": "gemini",
  "model": "gemini-…",
  "fallbackReason": null,
  "droppedCitations": 0,
  "removedClaims": 0,
  "disclaimer": "Educational research, not investment advice.",
  "error": null
}
```

- **`segments[].basis`** says where each paragraph comes from:
  - `thesis`: the user's own goals and confirmed assumptions. Never cited.
  - `evidence`: something a supplied article reports. Always cited, and always worded as "according to the summary…" or "based on the headline alone…".
  - `general`: educational explanation.
  - `uncertain`: the server replaced a claim it could not support.

  The UI can style each kind differently.
- **`citations`**:
  - Numbered `[1]..[n]` in the order they first appear in `reply`.
  - Built only from the original article: `title` is its headline, plus `url`, `publisher` and `datetime`. The URL is `null` when the original had no valid http(s) URL; show those as plain text.
  - `evidence: "headline_only"` means the source is only a headline. Show it as provisional.
  - A URL is attribution, not proof: the engine has only seen the headline and summary, never the full article.
- **`history`**:
  - Store it as given, per thesis id, and send it back on the next turn. It holds the last 20 entries.
  - Assistant entries keep their `citations`, so older answers can still render their links.
- **`source: "fallback"`** means Gemini was unavailable and the reply is a plain recap of the user's thesis (plus the opened article, cited). The `ok` field is still `true`. `fallbackReason` is one of `offline`, `not_configured`, `ai_error` or `unusable_reply`. No provider details are included.
- **Misleading answers are regenerated, not trimmed.** If a Gemini answer says the user bought, owns or plans to buy an investment, calls a bond fund stable or capital-preserving, or calls something suitable for the user, the engine asks Gemini once more with those sentences named. If the second answer is clean it is used (`source: "gemini"`). Otherwise the reply is the plain thesis recap (`source: "fallback"`, `fallbackReason: "unusable_reply"`). At most two Gemini calls per message; sentences are never cut out of an answer.
- **`insufficientEvidence: true`** means the evidence didn't support part of the answer. `removedClaims` counts claims the server removed; `droppedCitations` counts invalid source ids.

### Errors (`ok: false`)

`error: { code, message }`. `history` comes back exactly as it was sent, and nothing else changes.

| code | when |
|---|---|
| `invalid_message` | empty, or more than 2000 characters |
| `invalid_thesis` | no thesis, no `id`, or no goal and no assumptions |
| `thesis_not_confirmed` | a draft whose assumptions aren't confirmed |
| `invalid_history` | `history` is not an array |
| `history_thesis_mismatch` | history from a different thesis id (conversations stay separate) |
| `invalid_focus` | `focus` doesn't point at a usable article in `evidence` |
| `internal_error` | unexpected failure |

## How grounding works

1. **Evidence ids.** Evidence items get internal ids E1..E8; in investigation mode the focused article is always E1. Gemini sees each article's headline, publisher, date, summary (if any) and the earlier news-check assessment. **It never sees URLs.**
2. **The answer format.** Gemini answers in segments: `{text, basis, sources: ["E2"]}`.
3. **Server-side rules:**
   - Keep only ids from this turn.
   - Remove evidence claims whose citation is missing or invalid, and replace them with an uncertainty line. They are never relabelled as general knowledge.
   - Prefix every evidence claim with its attribution (headline alone, or summary) if Gemini didn't already attribute it.
   - Strip any URL or `[n]` text Gemini wrote.
   - Drop sentences that claim research or verification the engine never did.
   - Scrub buy/sell/hold advice, guarantees and "I'm tracking this" claims.
4. **Earlier answers.** These are sent back to Gemini with their `[n]` markers replaced by the cited headline, so old ids can't be reused for new claims.
5. **Fallback.** With no key, or when both models fail: primary `GEMINI_MODEL`, then backup `FALLBACK_GEMINI_MODEL` (on errors and malformed JSON, never on auth errors). After that the deterministic recap is returned.

## Suggested route (Taha)

```
POST /api/thesis/:id/chat
body: { "message": "...", "focus": { "ticker": "NVDA", "headline": "..." } | null }
```

1. Load thesis `:id`, its saved chat history, and its matches (today: `store.get('thesisMatches')`).
2. Find `focus` in the matches by ticker and headline and pass its index as `context.focus`. Use ticker and headline rather than a client index, because the match list is replaced on every seed. If no match is found, return 404 `article_not_found`.
3. Call `thesisChat(thesis, history, message, { evidence: matches, focus: index })`.
4. If `ok`, save `result.history` for that thesis. Respond with the result minus `history` (or with it; it's JSON-safe).

Optionally, `GET /api/thesis/:id/chat` returns the saved history so the page can render the conversation.

**Storage needed for full use:**
- several theses keyed by id (today there is one `thesis` key)
- chat history per thesis id
- matches per thesis id

With today's single thesis, `:id` can just be checked against the saved thesis.

**Email link:** Contract E's `link` could deep-link to `#thesis` with the ticker and headline as query parameters, so the page opens the investigation directly. That's optional and needs no contract change.

## UI notes (Anne)

- Render `reply` as text and turn `[n]` into links to `citations[n-1].url`, opening in a new tab. When `url` is `null`, show the title and publisher as plain text. Mark `headline_only` sources as "headline only".
- Always show `disclaimer`. Show `followUps` as suggestion chips, and a small note when `insufficientEvidence` is true.
- Put an "Ask about this thesis" entry on the thesis page, and an "Ask about this article" entry on each news item, which sends `focus`.

## Saved matches now include `summary`

`matchNews` / `matchNewsDetailed` matches have one new additive field, `summary`: the article's own summary text, or `null`. Nothing else about matching changed: relevance, stance, sorting and which articles match are identical (checked against a recorded baseline in `scripts/test-thesis-chat.js`), and the Contract E email payload is unchanged.

## Try it

```
npm run test:chat                 # offline, mocked Gemini
npm run demo:chat -- --offline    # interactive, no API calls
npm run demo:chat                 # interactive, real Gemini from .env
```
