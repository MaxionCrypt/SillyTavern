# Archivist Narrator — Layer 2 Design (Custom Narrator Generation Path)

**Status:** Design — Layer 2 of `2026-08-19-archivist-narrator-design.md`. Layer 1 (archivist store + Director capabilities) is shipped. This layer moves the Narrator off native generation onto a custom, archivist-driven path.

**Investigation:** Grounded in `scratchpad/layer2-pipeline-findings.md` (the live pipeline map). Every seam referenced below was verified against source.

## Problem

The Narrator rewrites past content because native `context.generate()` / `generateGroupWrapper` bake the full chat history into its prompt, and the Director's notebook describes the *outcome* of what the Narrator already wrote. Prompt-level "do not restate" instructions have not held. Layer 1 gave the Director a structured store to write to; Layer 2 makes the Narrator read from that store through a generation path we fully control — one that never receives the raw prose of prior turns, so it has nothing to rewrite.

## Decision: Chat-Completion-streaming only

The custom path uses `streamChatPrompt`, which only works on Chat Completion with streaming on (`canStreamStory()` — `mainApi === 'openai'` and `stream_openai` enabled). **When the backend cannot stream, the directed Narrator is refused up front with a clear message.** There is no native fallback: one code path, no dual maintenance, no silent regression to history-bearing generation. Users on other backends or with streaming off do not get the directed Narrator until they switch.

## Architecture

Today's Narrator flow (`generateDirectedPerformer`, live-direction.js:1671): inject direction via `setNativePromptContent('directorNotes', …)`, then `context.generate('normal')` / `generateGroupWrapper(false,'normal',{force_chid})`. Core creates the chat message, streams tokens into it, and fires events; the extension observes the stream via `STREAM_TOKEN_RECEIVED → acceptNativeBuffer`, reveals gradually, and writes the final text once in `finalizeRunMessage`.

The custom path keeps the entire reveal/pacing/finalization machinery unchanged and replaces only the generation call and its inputs.

### Component 1 — Availability gate (`canStreamStory()`)

Before a directed turn begins (the entry points that reach `generateDirectedPerformer` — `submitLiveDirection`, `requestNextDirection`, retry/continue), check `canStreamStory()`. If false, refuse the turn with a clear, user-facing reason (same delivery surface as `describeNativeGenerationBlock()` uses today) explaining that the directed Narrator needs Chat Completion with streaming enabled. No message row is created, no Director pass is wasted beyond what already ran.

The gate lives at the point where a directed performer turn is about to start, so the Director may still run (it already requires streaming itself); the refusal is specifically about the Narrator generation step.

### Component 2 — `narrator-prompt.js` → `compileNarratorPrompt(scene, run)`

A new module, parallel to `compileDirectorPrompt`. It returns an OpenAI-style message array for `streamChatPrompt`. It assembles, in order:

1. **System message** — character card fields (`getCharacterCardFields()` for the performer) + persona + the **camera constraint** framing ("You are a camera. You only move forward. You see the current scene, you hear the director's instruction, you write what happens next. You never cut away, never rewind, never restate what is already on the page.").
2. **World info** — relevant lorebook entries (`getWorldInfoPrompt()`), the same source the Director uses.
3. **Archivist state** (Component 3 formatter) — scene facts, character states, the event log ("already written, do not restate"), the beat ("what happens next"). Secrets filtered out.
4. **Reasoning bridge** — `frameDirectorReasoning(envelope.reasoning)` (kept from the prior design): the Director's fuller creative thinking, framed. Present only when the Director's model returned reasoning.
5. **Voice window** — the last 2–3 chat messages, labelled "the most recent lines — continue from where they end, do not rewrite or restate them." This is the only raw prose the Narrator sees, and only for stylistic continuity.

It does **not** include the full chat history, the notebook, secrets, or mechanics internals. `setNativePromptContent` and the `CHAT_COMPLETION_PROMPT_READY`/`filterNarratorHistory` seams are dead on this path (they live inside core's `prepareOpenAIMessages`, which `streamChatPrompt` bypasses) — this module owns the whole prompt.

### Component 3 — Archivist → Narrator formatter (in `narrator-prompt.js`)

A pure function that reads the archivist store for `(timelineId, sceneId)` and renders labelled sections, **excluding all `secret` records** (the single filter point, covered by a test — the same fail-closed discipline as today's `NARRATOR_VISIBLE_TYPES`):

- *Scene:* `listSceneFacts` → `key: value` lines
- *Characters:* `listCharStates` → `charId — facet: value` lines
- *What has happened:* `listEvents` → chronological summaries, framed as already-written
- *What happens next:* `getBeat` → the directive (+ tone)

Reads only Layer 1's public store functions. No writes.

### Component 4 — Self-created, attributed message

Core no longer creates the chat row, so the extension must. Before generation, push a performer message onto `context.chat` stamped with the performer's identity — `name`, `is_user: false`, avatar (`force_avatar` / the member's avatar), `character_id`, and `extra` (including `extra.type = 'narrator'` for a narrator performer) — replicating what `generateGroupWrapper` + `force_chid` (or solo `generate`) stamped for free. Set `run.messageId` to the pushed index.

`finalizeRunMessage` (live-direction.js:2240) then works unchanged: it reads `context.chat[run.messageId]`, writes `message.mes = accepted`, and calls `saveChat()`. Its existing empty-result branch (`deleteMessage`) still deletes an empty row. The attribution fields must be correct at push time so the visible bubble shows the right name and portrait during reveal.

### Component 5 — Generation + reveal rewire

Replace the native call inside `generateDirectedPerformer` with:

```
const controller = new AbortController();
run.abortController = controller;
const prompt = compileNarratorPrompt(scene, run);
const result = await streamChatPrompt({
    prompt,
    onChunk: (update) => acceptNativeBuffer(update.text),   // cumulative — drop-in
    signal: controller.signal,
});
run.reasoning = result.reasoning;
run.generationFinished = true;
run.generationSettled = true;
scheduleReveal(0);
```

`onChunk.text` is cumulative and `acceptNativeBuffer` replaces `rawBufferedText` cumulatively — they already match. The reveal/pacing loop (`scheduleReveal`/`revealStep`) is untouched; it still walks `rawBufferedText` into `acceptedVisibleText`. The `STREAM_TOKEN_RECEIVED`/`MESSAGE_RECEIVED`/`GENERATION_ENDED` listeners no longer fire for this path — `generationFinished` is set directly on resolve instead. A `streamed: false` return (provider answered in one piece) is treated as the final text: `acceptNativeBuffer(result.text)` then finish.

### Component 6 — Interruption via AbortController

The native path had no abort handle and relied on `context.stopGeneration()`. The custom path gives each run its own `AbortController`. `interruptLiveDirection` (live-direction.js:2210) calls `run.abortController.abort()` instead of `stopGeneration()`. Because the `await streamChatPrompt(...)` returns (or throws an abort) synchronously with the abort, the current `waitFor(() => run.generationSettled, 2200)` race collapses to a direct resolution; `generationSettled` is set when the awaited call settles. An aborted request is caught and treated as a normal interruption (not an error), matching the Director's pattern at live-direction.js:1479-1489. Partial `acceptedVisibleText` is still kept by `finalizeRunMessage`; the unrevealed tail is still preserved as the performer's unspoken remainder.

### Component 7 — Event-emission audit

Native generation emitted `MESSAGE_RECEIVED`, `CHARACTER_MESSAGE_RENDERED`, `GENERATION_ENDED`, etc., that core UI and other extensions may depend on. The custom path emits none unless we do. One task audits which downstream listeners must still see an event when a Narrator message is finalized, and emits exactly those via `eventSource.emit` after `finalizeRunMessage` — no more. `CHAT_CHANGED` is slow async (~8.5s, 21 listeners) and must never block the reveal or finalization; if it must fire, fire it without awaiting on the reveal path.

## Data Flow (one directed Narrator turn)

```
submit / continue / retry
  → canStreamStory()?  ── false → refuse with clear message, stop
  → true
  → Director runs (streamChatPrompt) → parseDirectorReply
  → archivist + mechanics updates apply (Layer 1 transaction)
  → push attributed performer message; run.messageId = index
  → compileNarratorPrompt(scene, run)  [archivist state, card, world info,
       voice window, beat, framed reasoning — no full history, no secrets]
  → streamChatPrompt(onChunk → acceptNativeBuffer, signal)
  → reveal loop reveals rawBufferedText → acceptedVisibleText  (unchanged)
  → resolve: generationFinished = true → completeVisibleRun
  → finalizeRunMessage writes message.mes + saveChat  (unchanged)
  → emit audited events
```

## What Stays Unchanged

- The reveal/pacing pipeline (`scheduleReveal`, `revealStep`, `acceptNativeBuffer`, the four run fields).
- `finalizeRunMessage`, `completeVisibleRun`, `failEmptyVisibleRun`, `acceptedProse`, saveChat.
- The Director's own flow (`compileDirectorPrompt`, `streamChatPrompt`, `parseDirectorReply`, Layer 1 mechanics/archivist execution).
- `frameDirectorReasoning` and the reasoning capture (now a Narrator input, per the parent spec).
- The interruption *entry points* (`submitLiveDirection`, `stopLiveDirection`) — only the stop mechanism inside `interruptLiveDirection` changes.

## What Changes

| What | Where | Change |
|------|-------|--------|
| Availability gate | `live-direction.js` (turn entry) | Refuse directed Narrator when `!canStreamStory()` |
| `compileNarratorPrompt` + archivist formatter | new `narrator-prompt.js` | Compile the Narrator's message array from archivist state, card, world info, voice window, beat, reasoning |
| Narrator generation | `live-direction.js:generateDirectedPerformer` | Replace `context.generate`/`generateGroupWrapper` + `setNativePromptContent` with self-created message + `streamChatPrompt` |
| Message creation | `live-direction.js:generateDirectedPerformer` | Push attributed performer row; set `run.messageId` |
| Interruption | `live-direction.js:interruptLiveDirection` | `abortController.abort()` instead of `stopGeneration()` |
| Event emissions | `live-direction.js` (post-finalize) | Emit audited downstream events |

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Wrong name/avatar on the self-created bubble | Attribution fields set at push time from the resolved performer/character; a live check confirms the bubble matches before this ships. |
| A downstream listener silently stops firing | Component 7's audit enumerates listeners and emits the needed events; verified in the live app, since this is not unit-testable. |
| `streamed: false` providers (o1, streaming edge cases) | Handled as a final-answer return: `acceptNativeBuffer(result.text)` then finish — same reveal, no gradual stream. |
| Reveal/interruption regressions | The reveal loop and finalize are untouched; only their inputs change. Interruption simplifies (no `waitFor` race). |
| Thin archivist state early in a scene | The voice window always carries immediate continuity; Layer 1 shipped first so event-recording is tuned before the Narrator depends on it. |
| Secret leakage to the Narrator | Single filter point in the formatter drops all `secret` records; covered by a fail-closed test. |

## Testing Strategy

- **Unit-testable (Jest):** `compileNarratorPrompt` and the archivist formatter — assert section content, ordering, voice-window size, that full history is absent, and that secrets never appear (fail-closed). The `canStreamStory()` gate decision. Reasoning-present vs absent branches.
- **Live-verified (browser, not unit):** message attribution (name/avatar), streaming into the reveal, interruption via abort, and the event-emission audit. These touch the live generation core and the DOM; they are checked in the running app, not asserted in Jest. This is the integration risk the layered rollout exists to contain.

## Out of Scope

- Notebook removal and relocating reasoning storage off the notebook — Layer 3.
- Archivist UI/inspector.
- Any non-streaming or non-Chat-Completion Narrator path (explicitly refused, per the decision above).
