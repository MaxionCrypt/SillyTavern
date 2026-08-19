# Recursive Narrator: Director Reasoning as the Creative Bridge

## Problem

The current architecture separates the Director (mechanics, decisions) from the Narrator (prose) through notebook entries — tagged journal lines (`[ruling]`, `[note]`, `[result]`, `[secret]`) that the Director writes and the Narrator reads as "Director's Notes." This produces incoherent output:

- The Narrator talks weird — its prose is contaminated by mechanical language from the notebook format.
- The Director writes like the Narrator — bleeding style across the boundary.
- Details get made up or contradicted — the notebook is a lossy compression of what the Director actually thought, reducing 11,795 characters of reasoning to 100 characters of tagged instruction.

The notebook was designed as a structured record. It is the wrong medium for creative direction.

## Solution

Collapse the creative channel from notebook entries to **raw reasoning tokens**. The Narrator becomes a recursive second call of the Director's own pipeline: same underlying function, different inputs. The Director's thinking — captured from the API's reasoning/thinking channel — replaces the notebook as the bridge between direction and prose.

The notebook stays for what it's good at: Director self-memory, UI cards, structured record. It stops being the creative channel to the Narrator.

## Architecture

### Call 1 — Director (unchanged)

Same prompt, same protocol, same output format. `requestDirection()` already captures reasoning tokens via `streamChatPrompt` and stores them as `lastDirectorReasoning`. Currently this reasoning is logged to the direction record and thrown away. After this change, it becomes the primary creative bridge.

**Inputs:** Full context — character card, protocol, mechanics profile, variables, goals, state fence, notebook history, chat history, world info, persona.

**Outputs (unchanged):**
- Tagged entries (`[ruling]`, `[note]`, `[result]`, `[secret]`) → notebook store
- State fence → mechanics layer (`executeDirectionRequests`)
- Reasoning tokens → **newly promoted**: stored for the Narrator call

**Functions unchanged:** `compileDirectorPrompt`, `streamChatPrompt`, `parseDirectorReply`, `executeDirectionRequests`.

### Call 2 — Narrator (recursive Director)

A second generation call through the existing `context.generate()` pipeline. The Narrator is not a separate agent — it is the Director called again with stripped-down context and a different character card. Streaming to the user is preserved.

**Inputs (what the Narrator sees):**

| Included | Why |
|----------|-----|
| Narrator character card | Pure creative writing persona — voice, style, the character(s) being written. No mention of direction, mechanics, or protocol. |
| Director's reasoning tokens | The raw thinking from call 1. Unfiltered, unformatted. Truncated only for token budget. |
| Chat history (Narrator + character lines only) | The story so far. The Narrator reads its own prior prose and other characters' lines. |
| World info | Setting, lore, character knowledge — the creative grounding. |
| Persona | The user's authorial voice / preferences. |

**Excluded (what the Narrator never sees):**

| Excluded | Why |
|----------|-----|
| User messages | The Director already processed user intent. The Narrator should not be influenced by OOC commands, phrasing, or meta-instructions — only by the Director's creative interpretation of them. |
| Director's character card / protocol | Mechanical language. The Narrator has no concept of a Director. |
| Variables, goals, state fence | Mechanics. The Director handled these. |
| Notebook entries (Director's Notes) | Replaced by reasoning tokens. The notebook is the Director's memory, not the Narrator's channel. |
| Tagged entry format | `[ruling]`, `[note]`, `[result]`, `[secret]` — none of this reaches the Narrator. |
| Secrets (as tagged entries) | The `[secret]` tagged entries from the notebook don't reach the Narrator. However, the Director's reasoning may reference secrets freely — this is accepted. The Narrator treats them as creative context. |

### The Reasoning Bridge

The Director's reasoning tokens are the bridge between calls. They travel from call 1 to call 2 with no transformation:

- **No filtering.** The reasoning contains the Director's full internal monologue — creative thinking, mechanical references, tag formatting, self-correction. All of it passes through.
- **No formatting.** No wrapper tags, no structured extraction. Raw text.
- **Framing only.** A single header line gives the Narrator context for what it's reading:

```
[A scene director has reviewed the full context of this conversation —
the user's messages, the world's mechanics, and the story so far — and
worked out what should happen next. Below is their creative thinking.
Write the narrative from it. Ignore any technical references you don't
recognise.]
```

The full reasoning is passed. No truncation — code cannot reliably distinguish creative thinking from mechanical bookkeeping within the model's own internal monologue. The reasoning is typically 3-4K tokens, well within any context window. If the overall prompt exceeds the model's token budget, SillyTavern's existing prompt manager handles truncation across all blocks — no Remodel-specific truncation layer needed.

The Narrator latches onto what it understands (mood, character, pacing, plot beats) and ignores what it doesn't (variable names, fence syntax). The framing line tells it to do exactly this.

### Chat History Filtering

`filterNarratorHistory` in `narrator-history.js` currently removes:
- All `role: 'user'` messages (unconditional)
- `role: 'assistant'` messages whose `name` doesn't match the Narrator (cast exclusion under Completion names behavior)

This stays unchanged. User messages are already stripped. The filter's existing behavior is exactly what the new design needs.

### Narrator Character Card

The Narrator uses a different character card than the Director. This card is a pure creative writing persona:

- Character voice and style guidance
- The character(s) being portrayed
- Prose preferences (POV, tense, tone)
- No mention of: direction, mechanics, protocol, variables, goals, notebooks, tags, fences

**Implementation:** No new card type is needed. The Narrator's character card is the performer's own character card — the same card SillyTavern already uses for that character in native generation. `context.generate()` and `generateGroupWrapper` already resolve the performer's card via `performer.characterId`. The Director has its own separate card (the Director character), which is used only in call 1 and never reaches the Narrator.

## What Stays

| Component | Status |
|-----------|--------|
| Director's prompt, protocol, output format | Unchanged |
| `parseDirectorReply()` | Unchanged |
| Notebook store (`director-notes-store.js`) | Unchanged — still stores tagged entries for Director memory and UI |
| Mechanics layer (`executeDirectionRequests`) | Unchanged |
| State fence parsing | Unchanged |
| Variables, goals, mechanics profile | Unchanged |
| Recipe system / Prompt Studio | Unchanged |
| Reveal / pacing pipeline | Unchanged |
| Direction cards in roleplay stream | Unchanged |
| `filterNarratorHistory` | Unchanged (already strips user messages) |

## What Changes

### Modified

| Function | File | Change |
|----------|------|--------|
| `requestDirection()` | `live-direction.js` | Already returns `reasoning`. No change needed — it's already captured and returned. |
| `generateDirectedPerformer()` | `live-direction.js` | Line 1657: instead of `hooks.setNativePromptContent('directorNotes', formatDirectorNotesPrompt(scene))`, deliver the Director's reasoning via the recipe block. The reasoning comes from the envelope (which carries the `requestDirection` return value). |
| `persistDirectionRecord()` | `live-direction.js` | Already stores `reasoning: lastDirectorReasoning` on the direction record. No change needed. |
| `directorNotes` source block resolver | `prompt-studio.js` / `timeline-spine.js` | Instead of resolving to `formatDirectorNotesPrompt(scene)`, resolves to framed reasoning. The block key and native identifier stay the same. |

### Added

| What | Where | Purpose |
|------|-------|---------|
| `frameDirectorReasoning(reasoning)` | `live-direction.js` | Prepends the director-awareness framing header to raw reasoning. The header explains the Director's role to the Narrator so it understands the source and purpose of the reasoning block. Pure function. |
| Reasoning storage per turn | `director-notes-store.js` | Each notebook turn gains a `reasoning` field alongside its `entries`. Lifecycle matches entries — same cleanup, same depth windowing. |

### Removed (moved to fallback)

| What | Current role | After |
|------|-------------|-------|
| `buildDirectorNotesSource()` | Renders notebook entries for the Narrator | Fallback only — called when reasoning is empty (non-reasoning models) |
| `formatDirectorNotesPrompt()` | Ties notes source to recipe block depth | Fallback only — same condition |
| `NOTEBOOK_ENTRY_LABELS` | Labels entries for the Narrator | Fallback only |
| `describeNotebookTurn()` / `describeNotebookEntry()` | Formats individual entries | Fallback only |

These functions are not deleted. They become the non-reasoning fallback path.

## Non-Reasoning Fallback

When the Director's API call returns no reasoning tokens (model doesn't support thinking, or thinking is disabled):

```js
const bridge = reasoning
    ? frameDirectorReasoning(reasoning, maxReasoningChars)
    : formatDirectorNotesPrompt(scene);
```

One branch. The notebook-based Director's Notes path stays as-is for models without reasoning. The experience is worse — the Narrator gets tagged notebook entries instead of raw creative thinking — but it works exactly as it does today. The journal logs which path was taken.

## Flow Diagram

```
User submits message
        │
        ▼
┌───────────────────────────┐
│ 1. Director call          │  requestDirection() — unchanged
│    (generateRaw / stream) │  Reasoning tokens captured
└───────────┬───────────────┘
            ▼
┌───────────────────────────┐
│ 2. Parse Director reply   │  parseDirectorReply() — unchanged
│    entries → notebook     │  
│    state fence → mechanics│  
│    reasoning → stored     │  ← NEW: reasoning travels forward
└───────────┬───────────────┘
            ▼
┌───────────────────────────┐
│ 3. Apply mechanics        │  executeDirectionRequests() — unchanged
└───────────┬───────────────┘
            ▼
┌───────────────────────────┐
│ 4. Deliver reasoning      │  hooks.setNativePromptContent(
│    to recipe block        │    'directorNotes',
│                           │    frameDirectorReasoning(reasoning)
│                           │      || formatDirectorNotesPrompt(scene)
│                           │  )
└───────────┬───────────────┘
            ▼
┌───────────────────────────┐
│ 5. Narrator generates     │  context.generate() — unchanged pipeline
│                           │
│  Prompt contains:         │  Character card (performer's own)
│                           │  Chat history (no user messages)
│                           │  World info, persona
│                           │  Scene Direction (framed reasoning)
│                           │
│  Prompt excludes:         │  User messages, Director's card,
│                           │  protocol, mechanics, variables,
│                           │  goals, tags, fences, secrets
└───────────┬───────────────┘
            ▼
┌───────────────────────────┐
│ 6. Reveal / pacing        │  unchanged pipeline
└───────────────────────────┘
```

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Reasoning tokens contain mechanical noise | The framing line tells the Narrator to ignore unrecognised references. Truncation cuts the mechanical tail. In practice, the creative thinking clusters at the front. |
| Non-reasoning models get worse experience | Fallback to current notebook-based path. No regression — same as today. |
| Reasoning is too long for token budget | Full reasoning is passed. SillyTavern's prompt manager handles overall token budget across all blocks — no Remodel-specific truncation. Measured data: one session produced 11,795 chars of reasoning (~3-4K tokens), a small fraction of any modern context window. |
| Director's reasoning reveals secrets | Accepted. The Director may think about secrets in its reasoning. The Narrator treats them as creative context — it doesn't know what a "secret" is in the mechanical sense, so it weaves them naturally rather than withholding mechanically. |
| Narrator character card is missing | Falls back to the performer's existing character card, which is what `context.generate()` already uses. No new card type is strictly required for v1 — the existing card IS the Narrator's card. |

## Out of Scope

- Director recursion (Director calling itself multiple times for refinement) — additive future enhancement, doesn't change this architecture.
- Director reading its own reasoning from previous turns — additive, uses the `reasoning` field on the notebook turn store.
- New Narrator-specific character card type in UI — v1 uses the existing performer character card.
- Changes to the Director's prompt, protocol, or output format.
- Changes to the mechanics layer, variable system, or goals system.
