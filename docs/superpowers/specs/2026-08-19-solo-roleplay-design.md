# Solo Roleplay: The Story Loom Architecture

**Status:** DEFINITIVE design for the roleplay system. Supersedes `2026-08-19-single-agent-narrator-design.md`, `2026-08-19-archivist-narrator-layer2-design.md`, and `2026-08-18-recursive-narrator-design.md`. Keeps Layer 1 from `2026-08-19-archivist-narrator-design.md` (the archivist store + capabilities), which is shipped. Implementation status and the Director-removal ordering live in `docs/superpowers/plans/2026-08-19-narrator-archivist-handoff.md`.

## 1. The idea in one paragraph

A roleplay turn runs **two calls, in order**: a cheap **Archivist** pass (mechanical) first, then a **Narrator** pass (creative). The Archivist reads the user's new action plus the previous narration, records what happened, and resolves any mechanics the action triggers (dice rolls, variable/goal changes — dice are code-rolled). The Narrator is **one creative mind** — an ordinary SillyTavern **character card** (for the omniscient case, a **"Story Loom"** card whose system-prompt is *how it reasons and how it writes*) — generated through **native generation** (its full configured prompt), with the freshly-updated **archivist** state injected as context. It reads the state, reasons, and writes the prose, honouring the mechanical outcomes but owning every creative choice. The Director is *dissolved*: its bookkeeping became the Archivist, its directing became the Narrator itself. There is no separate creative mind, no notebook. The Archivist decides only numbers, never story — so there is no translation loss. The system targets **reasoning-capable models** (non-reasoning still works from prose, less sharply).

## 2. Why (the history that got us here)

- The original **two-agent** system (Director plans → Narrator writes) produced a translation gap: two minds, one voice, drift every turn.
- A **custom stripped-prompt Narrator** (Layer 2) made it worse — starved of the user's real prompt, it rambled and invented. **Lesson (memory `remodel-narrator-needs-native-prompt`): the narrator must use native generation.** Reverted.
- The fix: **one mind** that both reasons and writes, grounded by structured memory it fills itself. The Director's judgement becomes the card's *authored reasoning*; the Director's state-authoring becomes *Pass 2 extraction*.

## 3. Core architecture — the two-phase turn

Each turn runs two calls in a fixed order: a **mechanical Archivist pass first**, then a **creative Narrator pass**. The Director is *dissolved, not deleted*: its bookkeeping half became the Archivist (memory + numbers); its directing half became the Narrator itself, which reads the record and decides the story. **No separate creative mind survives** — the Archivist decides only mechanics (facts, rolls, variable/goal changes), never beats or story direction, so there is no creative intent to translate and no translation loss. The single creative mind is the Narrator; the Archivist just hands it accurate, up-to-date state.

### 3.1 Phase 1 — Archivist (mechanical, runs FIRST)

Triggered the moment the user submits an action. A cheap non-streaming call that reads **the user's new action + the *previous* narration** (its prose, and its reasoning if stored) and does two things:

1. **Archives** the results of that last narration — events, scene facts, character states, secrets. Past-tense record.
2. **Resolves the mechanics the user's action sets in motion** — requests `goal.reach` (code rolls the d100), adjusts variables, moves goals. **Dice stay code-rolled** (the Archivist *requests*; the mechanics layer *executes*), so a 30%-chance attempt can genuinely fail before a word of prose is written.

It emits a state fence → `executeDirectionRequests` → archivist + mechanics (one atomic transaction), resolved against the address book. Implementation-wise this is **today's Pass-2 extraction, moved to the front of the turn and additionally fed the user's action.**

**The Archivist has NO creative authority.** It never emits a beat or "what happens next" — the future is the Narrator's to decide. The store is a pure record of the past plus current mechanical state.

### 3.2 Phase 2 — Narrate (the ONLY creative call, runs SECOND)

The current Solo narrator, unchanged. Native SillyTavern generation as the bound narrator card — full configured prompt (system prompt, card, persona, world info, examples, history) **plus** the freshly-updated archivist state injected as readable markdown **plus** the append-only + anti-echo directive. The model reads the updated state (including any roll the user's action just triggered), **reasons**, and writes the prose — honoring the mechanical outcomes but free to dramatize them however it likes. Streams into the reveal pipeline; `finalizeRunMessage` writes + saves. **The Narrator no longer authors mechanics** — Archivist owns the numbers, Narrator owns the story.

### 3.3 The archivist store (SHIPPED, minor change)

`archivist-store.js` + archivist capabilities in `mechanics-capabilities.js`. Per timeline+scene: `scene_fact`, `event` (append-only), `char_state`, `secret` (never shown to the narrator). Read as markdown via `buildNarratorArchivistSections` (secrets filtered, fail-closed); written as JSON via the state fence. Single memory — the notebook is removed. **The `beat` record is dropped as a forward directive** — it was the last splinter of the Director's directing role; the future is the Narrator's call each turn. (The `beat` field may remain as a soft narrator-authored breadcrumb, never as a command.)

### 3.4 Ordering wrinkles (accepted)

- **Latency (accepted):** the user waits for the Archivist call *and* the Narrator call before any prose appears (vs. today's invisible after-the-prose extraction). The Archivist call is small/structured; the added wait is the accepted price of resolving-before-narrating — the cost of dice with teeth.
- **Last narration (needs a mechanic):** with archiving-on-the-next-turn, a session's final narration is never archived unless the user acts again. A **scene-close flush** archives it on scene exit.

## 4. The Story Loom card model

**The narrator is a character card. No new card type, no new plumbing.** Solo generation already runs natively as the bound card (`narratorRef`), so a card's system-prompt/personality/examples already flow into the prompt today.

- **"Story Loom"** = a character card authored as an omniscient narrator: camera framing + append-only + reasoning guidance baked into its system prompt. We **ship a default Story Loom card** so a new user gets the experience out of the box; power users edit it or author their own.
- Because the narrator is a card, **"how it reasons and how it talks" is authored in the card**, not hardcoded in the extension.

## 5. Two narration modes (scene setting)

A scene chooses its narration style:

- **Omniscient** — **one** narrator card (Story Loom) writes everyone and the world. Other characters are **context the archivist and the card's lorebook carry**, not separate speaking cards. Creation = **one card + persona**. Uses solo's single-performer path.
- **Ensemble** — a **cast** of character cards, each speaks its own turn (classic SillyTavern group). Uses the existing group path (`force_chid`, who-speaks-next). Each card still narrates as one mind for its own turns; the archivist + extraction are shared across the scene.

Both are supported. The setting lives on the scene (e.g. `liveDirection.narration: 'omniscient' | 'ensemble'`).

## 6. Card-authored reasoning (a core feature, not a nicety)

The Archivist (Phase 1) reads the **previous narration's reasoning channel** (the hidden thinking a reasoning model emits before its answer — `streamChatPrompt` captures it; it is stored on the narration and read on the next turn). The narrator card **instructs what that reasoning contains**: e.g. *"before you write, in your private reasoning note any tracked value that changed, any fact established, and who witnessed it."*

**What it buys us:** extraction stops *inferring* state from prose ("the blade caught her forearm" → guess "HP −4") and instead reads what the narrating mind **declared** it changed. The mind that wrote the scene is the mind that records its consequences — no translation loss. And it is **authorable per story**: a mystery's Story Loom reasons about clues, a combat one about HP and positioning.

## 7. Model gate — reasoning-capable only

The system deliberately targets reasoning-capable models. Non-reasoning models are **warned or blocked**. Detection is mostly **empirical** — there is no universal "supports reasoning" flag:

1. **Soft pre-flight:** where the backend exposes a thinking/reasoning toggle, check it is on; warn at scene setup if we can see it is off/unsupported. Also requires `canStreamStory()` (Chat Completion + streaming), as Pass 1 streams.
2. **Empirical gate (authoritative):** after a turn, if the returned reasoning is empty, that is the definitive signal. **Warn** by default ("this model isn't producing reasoning; extraction is running on prose alone, less accurate — enable thinking or switch models"); **block** the scene in a strict setting until reasoning appears.

**Decision:** empirical gate + soft pre-flight. **No hardcoded model allowlist** (brittle, needs constant updating).

## 8. Creation flow & UI changes

The two-agent UI assumed a Director seat and a Narrator seat. Solo removes the Director everywhere:

- **Scene creation:** drop the "pick a Director card" step. Omniscient = pick **your persona + one narrator card** (default Story Loom offered). Ensemble = persona + a **cast** of cards. Add the **narration-mode** choice (Omniscient/Ensemble).
- **The Director badge / duet seats** (`directorRef`, the director display) are removed. `narratorRef` remains and means "the narrating card" (Omniscient) or the group drives turns (Ensemble).
- **Direction cards** in the stream re-source from the **archivist** (recent state changes / rolls) instead of notebook entries.
- **Reasoning-gate surfacing:** a warning affordance when the connected model isn't producing reasoning.
- The transitional **Engine (Director/Solo) toggle** disappears once the Director is deleted and solo is the only route.

## 9. What is built vs remaining

**Built and green (current HEAD):** archivist store + capabilities; native narrator with full prompt; archivist injection + append-only + anti-echo directive; mid-prose speaker-label stripping; Pass-2 extraction (narrative + mechanics, reasoning-fed) running *after* the narration; Solo mode as a selectable mode (`solo-direction.js`, the two seams); `setLiveDirectionMode` + Engine toggle; reasoning-gate warning on the UI state + toolbar; default Story Loom card + install; solo Stop = cut off; solo lifecycle tests. **Live-verified** (2026-08-19, DeepSeek + Kimi via debug Chrome): injection reaches the model, archivist grounds cleanly, no instruction-echo, no label leak, non-reasoning models still narrate and extract from prose.

**Remaining (roughly ordered):**
1. **Reposition to Archivist-first (§3) — the headline change.** Move the extraction call to the *front* of the turn; feed it the user's action + the previous narration; let it resolve `goal.reach`/variable/goal mechanics before the Narrator runs. Add the **scene-close flush** for the last narration. Drop the `beat` as a forward directive.
2. **Delete the Director** — remove the turn-flow branch (always solo), retire the Director-via-turn tests (cascades ~5 files — see handoff), delete Director code + notebook. Own branch.
3. **Separate extraction model (configurable)** — let Phase 1 (Archivist) use a different, reasoning-capable connection/model than the Narrator, so a non-reasoning narrator still gets sharp mechanical extraction. (Confirmed direction.)
4. **Narration modes** — the Omniscient/Ensemble scene setting + wiring (single-performer vs group).
5. **Creation flow + UI** — drop the Director seat; narrator-card + persona (+ cast) selection; direction cards from the archivist.

## 10. Non-negotiable constraints (carried from hard-won lessons)

- **Narrator = native generation, always.** Never hand-build its prompt; inject context via `setNativePromptContent`. (`remodel-narrator-needs-native-prompt`.)
- **`envelope.mechanics` is the Director's pending requests; the extraction snapshot rides on `envelope.mechanicsSnapshot`.** Clobbering the former silently kills all mechanics.
- **Archivist: read as markdown, written as JSON.** Raw JSON in the narrator prompt degrades the prose.
- **Secrets fail closed** — filtered at a single point in the archivist formatter, covered by a test.
- **`eventSource.emit` is slow async** — never block the reveal/finalize on it.
- **Mutation-test before trusting green** — this suite has certified false properties before.
