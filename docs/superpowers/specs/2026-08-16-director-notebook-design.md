# The Director's notebook — design

## Why

Directed Roleplay works and reads flat. A debug export from a live session
(`test_logs/remodel-debug-2026-08-16T11-26-45.286Z.json`) shows why, and the
numbers are not marginal.

Two consecutive turns, measured from the journal:

| Stage | Pass 1 | Pass 2 |
|---|---|---|
| Snapshot build | 0.8s | 10.9s |
| **Director call** | **101.5s** | **201.6s** |
| Narrator generation | 4.5s | 5.0s |
| Paced reveal | 24.1s | 32.9s |
| **Send to settled** | **2m 11s** | **4m 11s** |

Pass 1's `envelope` record:

```
"durationMs":       101458
"instructionChars": 100
"reasoningLength":  11795
"requestCount":     0
"responseLimit":    4000
```

**The Director thought for 101 seconds, produced 11,795 characters of
reasoning, and emitted a 100-character instruction.** That instruction is the
Narrator's entire direction — `formatMovementPrompt` sends one header line and
the instruction, nothing else.

Three consequences, all from the same cause:

- **The prose is samey.** A hundred characters cannot differentiate one
  response from the next. Consecutive passes over near-identical history
  produce near-identical prose. The export rules out a mechanical cause: pass 1
  buffered 894 characters, pass 2 buffered 1,079, distinct message ids,
  `discardedLength: 0`, `stillOwned: true` on both. Nothing accumulated.
- **The wait is opaque.** `composing…` for one to three minutes, because a
  schema-enforced call cannot stream.
- **The thinking is discarded.** All 11,795 characters are captured, stored on
  the direction record, and rendered into a `<details>` that defaults closed.

The mechanism behind the 100 characters is in the code's own comment: reasoning
and the envelope **share** the response allowance. ~3,000 of 4,000 tokens went
to thinking, and the direction had to fit in what was left. The Director is not
choosing to be terse; it is being squeezed by its own schema.

## The structural fact everything hangs on

SillyTavern core decides streaming in one line (`openai.js:2724`):

```js
const stream = settings.stream_openai && type !== 'quiet' && !isO1 && !isWorkersAIJsonMode;
```

`generateRaw` and `generateRawData` hard-code the type to `'quiet'`
(`script.js:4018`). **Any schema-enforced call is structurally unstreamable.**
Worse, with a `jsonSchema` supplied `generateRawData` returns
`extractJsonFromData(...)` and discards the raw provider object — the only place
reasoning lives — which is why `live-direction.js` monkey-patches
`globalThis.fetch` to steal it back.

Story mode streams because it calls `sendOpenAIRequest('continue', …)` directly
and has no schema to enforce.

So dropping the envelope is not merely a simplification. It is the single change
that makes live visibility possible, and it deletes the `fetch` patch with it.

## Decisions

Settled with the project owner before design:

| Decision | Choice |
|---|---|
| Director output | Free-form, shaped entirely by its recipe. No JSON envelope. |
| Director's role | An active member with a persistent notebook, not a one-shot instruction |
| State changes | A machine-readable tail in the reply, parsed leniently — one call, no second pass |
| Note shape | Typed entries the Director chooses |
| Type vocabulary | Fixed: `note`, `ruling`, `result`, `secret` |
| Secret visibility | Never sent to the Narrator; visible to the owner |
| Narrator history | Its own prose only — not user messages, not other characters |
| The direction | This turn's entries. No separate instruction field. |
| Untagged prose | Becomes a `note`, never discarded |

## Design

### 1. The loop

1. The user's message posts to the chat **immediately**, before anything runs.
   `buildDirectionSnapshot` excludes the newest entry from `STORY SO FAR` so it
   does not appear twice alongside `CURRENT ACTION`. The World Info scan and
   Variable retrieval, which take `action` as a separate input, get the same
   treatment.
2. **The Director runs, streaming**, via `sendOpenAIRequest('continue', …)`.
   Its content is shaped entirely by the user's recipe. Reasoning and text both
   stream; the card fills live.
3. Its reply is parsed into **typed entries** and appended to the Director's
   notebook for that Timeline.
4. Code extracts the **state tail** and applies any requests.
5. **The Narrator runs**, with a Director Notes recipe block and a filtered
   history.
6. The prose reveals at scene pacing, unchanged.

### 2. What the Director badge contributes

Exactly one locked block, as now. It states the reply contract and nothing
about pacing, autonomy, or style — those belong to the user's recipe. It
teaches four line tags and one fenced block:

```
[note]   observation, colour, what is in the air
[ruling] a decision that binds the next response
[result] what actually happened, for the record
[secret] never shown to the performer
```

and, last in the reply:

````
```state
{"requests":[{"capability":"variable.adjust","name":"Morale","amount":-1}],
 "flow":{"continue":false}}
```
````

### 3. Parsing — `director-reply.js`, pure

A new module with no `st-context.js` import, following the
`direction-beats.js` / `direction-address.js` precedent, so the exact parse can
be asserted offline.

- Split the reply on line-leading `[type]` tags into typed entries. Leading
  untagged prose becomes one `note`.
- An unknown tag is treated as literal text inside the current entry, not as a
  new type — a typo must not silently create an unreadable entry.
- Take the **last** ` ```state ` fence, so a Director discussing state mid-reply
  cannot confuse the parser. Strip it from stored text.
- Validate every request name against the closed set advertised this turn, via
  the existing `buildAddressBook` / `resolveByName`. **The containment property
  is unchanged**: a name that was not advertised is rejected.
- **A missing or unparseable tail is not an error.** The turn proceeds with no
  state changes and a journal entry. Prose always wins; a malformed tail can
  never break a scene.

### 4. The notebook — `director-notes-store.js`

Per Timeline, entries `{id, sceneId, turn, at, type, text}`. Ordered, append
only during a turn, editable and deletable by the owner afterwards.

The read API the Narrator block uses returns the last N entries **excluding
`secret`**. Secrets are filtered at the store boundary, not at the caller, so a
future caller cannot forget.

### 5. The Narrator's recipe block

A new `directorNotes` source in the narrator recipe's source definitions, with a
configurable look-back depth. This turn's entries are the direction; older
entries are context.

### 6. The Narrator's history

Filtered to messages authored by the Narrator character — not the user's, not
other cast members'. Implemented at the prompt-assembly boundary
(`chat_completion_prompt_ready` / `GENERATE_AFTER_COMBINE_PROMPTS`), not by
mutating `context.chat`, which must stay the true record.

### 7. What gets deleted

- `getDirectionEnvelopeSchema` and the `jsonSchema` path
- `withCapturedResponse` — the `fetch` monkey-patch, obsolete once streaming
  supplies `state.reasoning` directly
- `formatMovementPrompt`'s depth-0 injection, replaced by the notes block

## Out of scope

- Story mode, untouched.
- The capability layer itself. Capabilities, transactions and validation are
  unchanged; only the channel that carries requests changes.
- Per-call model override — still unavailable, so the Director's latency is a
  property of the owner's connection, not something this design can fix.
- Notebook pruning policy beyond a simple cap. Long-scene growth is a known
  follow-up.

## Risks

- **The Director becomes the sole channel for user intent.** With the Narrator
  blind to user messages, anything the Director fails to record is invisible to
  the performer. Accepted deliberately; the mitigation is that this turn's
  entries always reach the Narrator, so only *omission by the Director* loses
  information.
- **Recipe wording becomes load-bearing.** A user who edits away the tail
  instruction silently loses automatic state changes. Mitigated by the locked
  block owning that instruction and by journalling every parse failure.
- **A secret could leak.** The whole value of the type rests on it never
  reaching the Narrator's prompt. This needs a test that fails if it ever does.
- **Streaming exposes partial notes.** A Director interrupted mid-reply leaves
  a partial entry. It should be stored as what it is, marked incomplete, rather
  than parsed as if whole.
- **Latency is unchanged.** This design makes the wait *legible*, not shorter.
  A 200-second Director call remains a 200-second call.

## Verification

- Parse fixtures: tagged entries, untagged prose, unknown tags, no tail,
  malformed tail, a `state` fence appearing mid-reply as well as at the end.
- A test asserting a `secret` entry never appears in the Narrator's compiled
  prompt, mutation-checked by removing the filter and confirming it goes red.
- A test that the user's message appears exactly once in the Director's prompt
  after the ordering change.
- Confirm in the running app that the Narrator's assembled prompt contains no
  user-authored message.
- A real directed pass on a live connection remains the only test of the whole
  loop.
