# Archivist Narrator: Structured Narrative State as the Single Source of Truth

**Status:** Design — supersedes `2026-08-18-recursive-narrator-design.md` (the raw-reasoning-bridge approach)

**Relationship to prior work:** The recursive-narrator design tried to fix incoherent narration by piping the Director's raw reasoning tokens to the Narrator instead of tagged notebook entries. It improved voice but did not fix the core failure: **the Narrator keeps rewriting content it (or the character) already wrote.** Root cause — the Narrator sees the full chat history plus scene state that describes the *outcome* of what it already narrated, and prompt labels ("do NOT narrate this again") are not enforcement. This design removes the ability to rewrite by removing the raw history from the Narrator's inputs and replacing it with structured state.

## Problem

The Narrator restates and rewrites past content. Two inputs feed this:

1. **Full chat history** — native `Generate()` bakes every prior message into the Narrator's prompt. It has the literal prose of paragraph 3 and can echo or rewrite it.
2. **Notebook entries** — the Director's tagged journal (`[note]`, `[ruling]`, `[result]`, `[secret]`) describes scene state, which is the *result* of what the Narrator already wrote. Reading it, the Narrator re-narrates the same beats.

Prompt-level instructions ("Write only what happens NEXT", "do NOT narrate this again") have not held. The fix must be architectural: the Narrator cannot rewrite what it never receives.

## Solution

Introduce an **Archivist** — a single structured store that holds the narrative's ground truth as typed records. The Director writes to it through capabilities (the same mechanism it already uses for variables and goals). The Narrator moves off native `Generate()` to a **custom generation path** that assembles exactly what it should see: the archivist's structured state, world info, character card, and a small voice window — **not** the full chat history, **not** the notebook.

Append-only is enforced by construction: events are facts in a list ("this happened"), never prose to echo; the Narrator never receives the raw text of prior turns, so it has nothing to rewrite.

The Director's notebook (`director-notes-store.js`) is retired. Its two remaining jobs — Director self-memory and secret-holding — are absorbed by the Director's own chat history (already sliced into its prompt) and a `secret` archivist record type.

## Architecture

### Component 1 — Archivist Store (`archivist-store.js`)

A new store alongside `variables-store.js` and `story-goals-store.js`, following the same conventions: a single store object, `getArchivistStore()` / `saveArchivistStore()`, typed CRUD functions, per-timeline keying, `snapshot`/`restore` helpers, and `deleteArchivistForTimeline(timelineId)` for cleanup. Persisted in extension settings like the other stores.

**Record types (all keyed per timeline, scoped to the active scene where noted):**

| Type | Shape | Semantics |
|------|-------|-----------|
| `scene_fact` | `{ id, key, value, establishedMsgId }` | Something true in the current scene (location, time, weather, atmosphere). The Director sets and clears these. Overwriting the same `key` replaces the value. |
| `event` | `{ id, summary, msgId, turnIndex, seq }` | Something that happened. **Append-only** — never edited or deleted by the Director. Accumulates into a chronological log. This is the "already written, do not restate" record. |
| `char_state` | `{ id, charId, facets: { mood, injury, stance, ... } }` | A character's *current* condition. The Director overwrites facets as they change. Holds present state only — not history. |
| `beat` | `{ directive, tone }` | The forward instruction: what should happen next. **Singleton** — only one active beat; `beat.set` replaces it. This is the Narrator's primary directive. |
| `secret` | `{ id, key, value }` | Director-only knowledge the Narrator must not see. Filtered out of the Narrator's compile, same boundary as today's `[secret]` entries. |

**Boundary:** The Director writes to the archivist. The archivist is the single structured-state store. The Director remembers its own reasoning through its chat history (already included by `buildDirectionSnapshot`). The Narrator reads the archivist only, filtered to exclude `secret` records.

### Component 2 — Director Capabilities (`mechanics-capabilities.js`)

New capabilities extend the existing `CAPABILITY_NAMES` array and `CAPABILITIES` map. They reuse the existing `capability(description, applicableKinds, authorityPolicy)` helper and slot into the same state-fence JSON schema — `parseDirectorReply` reads them from the same `requests` array, and `executeDirectionRequests` processes them. No new parsing format.

| Capability | Required arguments | authorityPolicy |
|------------|-------------------|-----------------|
| `scene.set` | `key`, `value` | `hybrid` |
| `scene.clear` | `key` | `hybrid` |
| `event.record` | `summary` | `hybrid` |
| `char_state.set` | `charId`, `facet`, `value` | `hybrid` |
| `char_state.clear` | `charId`, `facet` | `hybrid` |
| `beat.set` | `directive`, `tone` (optional) | `hybrid` |
| `secret.set` | `key`, `value` | `hybrid` |
| `secret.clear` | `key` | `hybrid` |

**Approval policy:** All archivist capabilities use `hybrid` (auto-apply, user can veto/undo) rather than `review` (held for user). Narrative-state bookkeeping is the Director's job and should not gate the turn on user approval. We reuse `hybrid` rather than inventing a third policy — the existing two-policy model covers the need (YAGNI). The existing variable/goal capabilities keep their current policies unchanged (`variable.create` stays `review`; the rest stay `hybrid`).

Each capability gets a `REQUIRED_ARGUMENTS` entry with argument keys and hints, so `getCapabilityDictionary()` renders them into the Director's prompt exactly like the variable/goal capabilities. The Director learns to use them from a new section in the `directionHandbook` recipe block explaining scene tracking, event recording, character-state upkeep, and beat-setting.

### Component 3 — Custom Narrator Path (`compileNarratorPrompt` + `streamChatPrompt`)

The Narrator moves from native `Generate()` (`generateDirectedPerformer` → `hooks.setNativePromptContent('directorNotes', …)` → `generateGroupWrapper` / `context.generate`) to a custom compile-and-stream path parallel to the Director's, using the existing `streamChatPrompt({ prompt, onChunk, signal }) → { text, reasoning, streamed }`.

**`compileNarratorPrompt(scene)`** — new function, parallel to `compileDirectorPrompt`. It assembles the Narrator's message array from:

1. **System prompt** — character card (description, personality, scenario) via `getCharacterCardFields()` + persona. Gives the Narrator its voice and identity. Includes the **camera constraint** framing (below).
2. **World info** — relevant lorebook entries via `getWorldInfoPrompt()`.
3. **Archivist state** — compiled ground truth, secrets filtered out, formatted into labelled sections:
   - *Scene:* current `scene_fact` records
   - *Characters:* current `char_state` records
   - *What has happened:* the `event` log, chronological — framed as "already written, do not restate"
   - *What happens next:* the current `beat.directive` (and `tone`)
4. **Voice window** — the last 2–3 chat messages, for stylistic continuity only, labelled: "These are the most recent lines. Continue from where they end. Do not rewrite or restate them."

**What the Narrator never receives:** the full chat history, the notebook, secrets, variables/goals internals, the Director's card or protocol.

**Camera constraint** (baked into the system prompt): "You are a camera. You can only move forward. You see the current scene, you hear the director's instruction, and you write what happens next. You never cut away, never rewind, never restate what is already on the page."

**Append-only enforcement is structural, not textual.** Because the Narrator receives the voice window (2–3 lines) and structured state — never the raw prose of earlier turns — it does not have the text to rewrite. The event log tells it *that* something happened, as a fact, not *as prose to echo*.

**Response handling:** the Narrator streams through `streamChatPrompt`, and Remodel inserts the result into the chat as the performer's message — the same slot native `Generate()` fills today. Streaming to the user is preserved. The reveal/pacing pipeline downstream is unchanged.

### Data Flow — one turn end to end

```
User sends message (or Continue / Retry)
        │
        ▼
1. Director runs
   compileDirectorPrompt → streamChatPrompt → parseDirectorReply
        │
        ▼
2. Archivist updates (synchronous, before Narrator)
   executeDirectionRequests applies:
     event.record, scene.set, char_state.set, beat.set,
     secret.set, + existing variable/goal requests
        │
        ▼
3. Narrator runs
   compileNarratorPrompt reads the UPDATED archivist state,
   character card, world info, voice window, beat
   → streamChatPrompt → insert as performer message
        │
        ▼
4. Reveal / pacing pipeline (unchanged)
```

The Narrator always reads archivist state *after* the Director's writes for that turn have applied. The event log the Narrator sees is the state as of the Director's direction; what the Narrator then writes becomes eligible for the Director to annotate via `event.record` on the *next* turn.

## What Stays

| Component | Status |
|-----------|--------|
| Director prompt, protocol, output format | Unchanged |
| `parseDirectorReply()` | Unchanged (reads new capabilities from the same `requests` array) |
| `executeDirectionRequests` dispatch mechanism | Extended with new capability handlers; mechanism unchanged |
| Variables, goals, mechanics profile | Unchanged |
| `streamChatPrompt` | Unchanged (now used by the Narrator too) |
| Recipe system / Prompt Studio | Unchanged (new `directionHandbook` section added) |
| Reveal / pacing pipeline, direction cards | Unchanged |
| `buildDirectionSnapshot` (Director's own context) | Unchanged — still slices chat history for Director memory |

## What Changes

### Added

| What | Where | Purpose |
|------|-------|---------|
| `archivist-store.js` | new file | Typed narrative-state store: `scene_fact`, `event`, `char_state`, `beat`, `secret` records; CRUD; snapshot/restore; per-timeline cleanup |
| Archivist capabilities | `mechanics-capabilities.js` | `scene.set/clear`, `event.record`, `char_state.set/clear`, `beat.set`, `secret.set/clear` — added to `CAPABILITY_NAMES`, `CAPABILITIES`, `REQUIRED_ARGUMENTS` |
| Archivist execution handlers | `live-direction.js` (or the execute-requests module) | Apply each new capability against `archivist-store.js` |
| `compileNarratorPrompt(scene)` | new `narrator-prompt.js` | Assemble the Narrator's message array from archivist state, card, world info, voice window, beat. New module (not `live-direction.js`) to keep that file from growing and to make the Narrator compile independently testable. |
| Archivist state formatter | `narrator-prompt.js` | Render archivist records into the labelled Narrator sections (secrets filtered) |
| `directionHandbook` scene-tracking section | recipe / prompt content | Teach the Director to use the archivist capabilities |

### Modified

| What | File | Change |
|------|------|--------|
| Narrator generation | `live-direction.js` | `generateDirectedPerformer` switches from native `Generate()` / `setNativePromptContent('directorNotes', …)` to `compileNarratorPrompt` + `streamChatPrompt` + message insertion |
| Capability dictionary consumers | `direction-sources.js` | Render the new capabilities (already generic over `getCapabilityDictionary()` — verify no per-capability special-casing needed) |

### Removed (Layer 3)

| What | Current role | After |
|------|-------------|-------|
| `director-notes-store.js` | Notebook store | Retired — secrets → `secret` records, self-memory → Director chat history |
| `buildDirectorNotesSource`, `formatDirectorNotesPrompt`, `NOTEBOOK_ENTRY_LABELS`, `readNarratorEntries` | Render notebook for the Narrator | Removed — Narrator reads the archivist |
| `frameDirectorReasoning` + reasoning-bridge wiring | Pipe raw Director reasoning to Narrator (prior design) | Retired — the `beat` is the Director's deliberate, structured forward directive; raw reasoning no longer leaks to the Narrator |

## Migration Path

Three independently deployable layers. Each ships and is tested on its own.

**Layer 1 — Archivist store + capabilities (additive, nothing breaks).** Build `archivist-store.js`, the new capabilities, execution handlers, and the `directionHandbook` section. The Director starts writing archivist state *alongside* its existing notebook entries. The Narrator still uses native `Generate()`. Fully testable in isolation: assert that Director requests mutate the store correctly.

**Layer 2 — Custom Narrator path (the breaking change).** Build `compileNarratorPrompt` and the archivist formatter; switch `generateDirectedPerformer` to the custom path. The Narrator now reads the archivist instead of chat history + notebook. This is where the rewrite bug dies.

**Layer 3 — Notebook removal.** Once Layer 2 is stable, remove `director-notes-store.js` and the notebook-reading / reasoning-bridge code. `buildDirectionSnapshot` already carries the Director's chat history, so the notebook is redundant for Director memory.

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Director fails to record an event → Narrator lacks context | The voice window (last 2–3 messages) always carries immediate continuity even if the archivist is thin. Layer 1 ships first so event-recording behaviour is tuned before the Narrator depends on it. |
| Archivist state drifts from actual narration (Director records intent, Narrator writes something else) | Next-turn `event.record` reconciles: the Director annotates what actually happened. The voice window keeps the Narrator anchored to real prior prose regardless. |
| Character card alone gives weaker voice than full history did | The voice window supplies live stylistic continuity; the card supplies identity. If insufficient, widen the voice window (tunable) before reintroducing history. |
| Non-streaming / non-custom providers | `streamChatPrompt` already backs the Director across providers; the Narrator reuses the same path, so provider coverage matches the Director's today. |
| `hybrid` auto-apply lets the Director thrash scene facts | Facts are keyed and overwrite in place; the store keeps only current values, so churn is self-limiting. Events are append-only and cheap. |
| Secrets leak to the Narrator | Single filter point in `compileNarratorPrompt` / the formatter drops all `secret` records — same boundary discipline as today's `NARRATOR_VISIBLE_TYPES`. Covered by a test. |

## Out of Scope

- Reintroducing the Director's raw reasoning to the Narrator (the prior design's bridge) — the `beat` replaces it.
- Archivist UI cards / inspector — v1 is data + generation only; surfacing archivist state in the timeline UI is a later enhancement.
- Multi-scene archivist history / long-term memory retrieval beyond the current scene's records.
- Changes to the variable/goal systems beyond adding the new sibling capabilities.
- Director self-recursion / multi-pass refinement.
