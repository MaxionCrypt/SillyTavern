# Single-Agent Narrator with Archivist Memory

**Status:** Design — **supersedes** `2026-08-19-archivist-narrator-layer2-design.md` (the two-agent, stripped-context Narrator). Keeps `2026-08-19-archivist-narrator-design.md`'s Layer 1 (archivist store + capabilities) as the foundation.

## Why the two-agent split failed (live)

The Director/Narrator split produced incoherent prose in practice. Two causes, both fatal:

1. **Starved context.** To stop the Narrator rewriting past prose, Layer 2 removed the full chat history and fed it only structured state + a 2–3 line window. That same history is what grounds prose in voice and immediate situation. The Narrator, with nothing to stand on, hallucinated unmoored texture ("the comb speaks names, the mirror shows what fed you") aligned to nothing.
2. **Two minds, one voice.** Even when the Director reasoned perfectly, the Narrator was a *different model call* re-interpreting that reasoning. Every turn paid a translation loss between the mind that decided and the mind that wrote.

The lesson: structured state is excellent for **consistency** (facts don't drift) but cannot substitute for **continuity** (voice, rhythm, what just happened). And direction should not be dictated to a second creative mind.

## Solution

**One authoring agent, prose-first, state-after.** A single model writes the prose the user reads, grounded in real (bounded) history plus the archivist's structured state. After the prose lands, a **mechanical extraction step** reads what was actually written and records the state deltas. State follows the prose instead of dictating it — the reverse of the failed design.

"One agent" is honored: exactly one mind authors the story. The extraction step authors nothing the user reads; it is structured-output bookkeeping.

The **archivist becomes the single memory store**, replacing the Director's notebook entirely.

## Architecture

### Pass 1 — Narrate (the only creative call)

One streamed call via `streamChatPrompt`, replacing *both* the old Director call and the old Narrator call.

**Prompt (`compileNarratorPrompt`, revised):**
- Character card(s) + persona
- World info (lorebook)
- **Archivist "story state" block** — rendered as readable markdown (never raw JSON): current scene facts, character states, active goals/variables, a short "already happened" event ledger, and the current beat. (This is Layer 2's `buildNarratorArchivistSections`, kept.)
- **Bounded recent history window** — the last N messages of actual prose (default ~2000 tokens / ~15–20 messages, tuned in code, not a UI setting). Long-range memory comes from the archivist state block, not raw history — that is what lets the window stay bounded.
- Standing direction / pacing, if set.

The agent **reasons first** (thinking tokens — the "Director" judgment the user liked, now internal to the writer), then writes the prose continuation. Append-only is enforced honestly: it has the recent history *and* the "already happened" ledger, so it knows what is on the page — instead of being blinded and hoping.

Streamed into the existing reveal pipeline. The performer message is created by us (Layer 2's self-created attributed message, kept).

### Pass 2 — Extract (mechanical, structured)

After the prose is **accepted** (fully revealed, or frozen by a manual cut-off), a cheap non-streaming call derives state changes from the actual delivered prose **and from Pass 1's own reasoning**.

**Pass 1's reasoning is the intent channel.** A thinking model emits reasoning *before* the prose — the author working out what is happening mechanically ("Eli takes the blade; a goal to escape forms; the receipt is a clue"). That reasoning is a **separate channel** from the prose: never shown to the user, and — unlike an inline state fence — it cannot bleed into the streamed writing. `streamChatPrompt` already returns it and Pass 1 already stores it (`activeRun.reasoning`). Feeding it to extraction gives the extractor the *intent* the prose may only imply — a hidden motive, a subtle stat change, a forming goal. It is the **writer's own thinking about its own prose**, so there is no translation gap (the good version of the old reasoning bridge: it now informs bookkeeping instead of dictating a second mind's prose). When no reasoning is available (non-thinking model / reasoning off), extraction falls back to prose-only.

**Input:** the accepted prose + **Pass 1's captured reasoning** + the current archivist/mechanics state + the capability dictionary.
**Output:** a validated **mechanics request** (the existing structured-output schema, `getMechanicsRequestSchema` — Layer 1 already added the archivist verbs to it): `event.record`, `scene.set`, `char_state.set`, `beat.set`, `secret.set`, and the variable/goal verbs.
**Execution:** `executeMechanicsRequest` → archivist + mechanics, one atomic transaction (Layer 1).

Because extraction reads the prose the user actually got, the recorded state can never contradict the fiction. A cut-off turn extracts from the partial prose. If nothing was accepted, extraction is skipped.

Model: a fast/cheap model, configurable, defaulting to the main model. Non-streaming (structured output), so no reveal machinery involved.

### The archivist as the single memory (notebook removed)

`director-notes-store.js` and its reader/labeler paths are removed. Its residual jobs move to the archivist:
- **Secrets** → archivist `secret` records (Pass 2 can set them).
- **Self-memory** → the agent has the real history + the archivist state; it needs no private journal of past notes.
- **Reasoning bridge → repurposed, not removed.** The single agent reasons for itself, so nothing is bridged *to a second mind*. But the reasoning capture stays: Pass 1's reasoning is stored and handed to Pass 2 as the intent channel (above). `frameDirectorReasoning`'s prose-framing header is dropped (extraction reads raw reasoning, not framed-for-a-narrator reasoning).

### Direction cards → re-sourced from the archivist

The roleplay-stream direction cards (currently notebook-fed) re-point to the archivist: they show the current beat and the most recent state changes (from the last extraction) — the at-a-glance "what the AI is tracking" view — instead of notebook entries.

### Stop = cut off, never delete

Manual **Stop** must preserve everything generated so far and freeze it, never delete. Today it discards the unrevealed buffer (and when reveal lags, that reads as "deleted everything"). Fix: on manual stop, **flush the buffered prose into the accepted text** (reveal-to-end immediately), finalize keeping it, then run extraction on the cut-off prose. A message is deleted only when *nothing at all* was generated.

## Data Flow (one turn)

```
user sends / continue / retry
  → canStreamStory()?  ── false → refuse (gate, kept from L2)
  → Pass 1: compileNarratorPrompt(card, persona, world info,
       archivist story-state block, bounded history window)
     → agent reasons → writes prose → streamChatPrompt → reveal loop
  → prose accepted (full reveal, OR manual Stop flushes buffer → accepted)
  → finalizeRunMessage writes message.mes + saveChat + emit MESSAGE_RECEIVED
  → Pass 2: extract — cheap structured call over accepted prose + Pass 1 reasoning
     → mechanics request → executeMechanicsRequest → archivist + mechanics
  → direction cards refresh from archivist
```

## What's Kept vs Removed

**Kept (Layer 1 + reusable Layer 2 machinery):**
- `archivist-store.js` + the archivist capabilities in `mechanics-capabilities.js` + atomic transaction undo (Layer 1) — now the single memory.
- `buildNarratorArchivistSections` (markdown render of state) — Pass 1 read path.
- `streamChatPrompt`, the reveal/pacing pipeline, the self-created attributed message, `MESSAGE_RECEIVED` emission, the debug-console wiring (`captureNarratorPromptLog`, `narrator.compiled`) — Pass 1 output path.
- The mechanics request schema + `executeMechanicsRequest` — Pass 2 write path.
- The stream-availability gate (`narratorStreamBlock`).

**Removed (two-agent rollback):**
- The separate **Director pre-call** (`requestDirection` / `compileDirectorPrompt` as a distinct generation) — its judgment folds into Pass 1's reasoning; its state-authoring folds into Pass 2.
- The **notebook** (`director-notes-store.js`) and its reader/labeler paths.
- The **reasoning-*bridge*** (feeding framed reasoning to a separate Narrator's prose). The reasoning *capture* is kept and repurposed as Pass 2's intent channel.
- The two-mind translation seam.

**Added:**
- Pass 1's revised `compileNarratorPrompt` (adds the bounded history window).
- Pass 2 **extraction** — a new `extractStateFromProse(prose, reasoning, context)` call + wiring after finalize (reasoning = Pass 1's captured `activeRun.reasoning`).
- **Cut-off-preserving Stop** in `interruptLiveDirection` / the reveal flush.
- Direction cards re-sourced from the archivist.

## Rollout

1. **Pass 1 grounding** — add the bounded history window to `compileNarratorPrompt`; remove the separate Director pre-call so the single agent both reasons and writes. Verify prose is coherent again (the core fix). Archivist state still read; extraction not wired yet (state can lag one turn).
2. **Pass 2 extraction** — add `extractStateFromProse` after finalize; wire to `executeMechanicsRequest`. State now tracks the delivered prose.
3. **Stop = cut off** — flush-on-stop; never delete a non-empty run.
4. **Notebook removal + direction cards** — delete `director-notes-store.js`, re-source cards from the archivist.

Each step is independently shippable and testable; step 1 alone should restore coherence.

## Risks

| Risk | Mitigation |
|------|-----------|
| Bounded window too small → prose loses continuity | Default sized generously (~2000 tokens); the archivist ledger covers older facts. Tunable in code if scenes need more. |
| Extraction misses or invents a state change | It reads the *actual* prose **plus Pass 1's reasoning** (intent the prose only implies), so it sees both what happened and what was meant; the mechanics schema + validation reject malformed requests; a missed change self-corrects next turn. |
| Extra call per turn (Pass 2) adds latency/cost | Cheap model, non-streaming, runs *after* the user already has their prose — it never blocks reading. |
| Re-sourcing direction cards touches stream UI | Scoped to a card data-source swap; the archivist already holds everything the card needs. |
| Losing the Director's explicit "beat" direction | Pass 1's own reasoning sets direction; Pass 2 may still record a `beat` as a forward hint for next turn's prompt. |

## Testing

- **Unit (Jest):** revised `compileNarratorPrompt` includes the bounded history window and the archivist block, excludes nothing it needs; `extractStateFromProse` turns a prose sample + schema into valid mechanics requests (via a stubbed structured call, like the existing Director/streaming stubs); cut-off Stop keeps accepted prose and never deletes a non-empty run; notebook removal leaves no dangling readers.
- **Live-verified:** prose coherence over a multi-turn scene (the whole point); state accuracy after extraction; direction cards reflecting archivist state; Stop cutting off cleanly — all inspectable in the debug console (`narrator.compiled`, extraction journal, Prompt Log → Narrator).

## Out of Scope

- Configurable history-depth UI (fixed sensible default in code).
- Multi-scene long-term archivist retrieval beyond the current scene.
- Any return to a separate creative Director/Narrator call.
