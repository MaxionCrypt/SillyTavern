# Narrator–Archivist System: Handoff & Dual-Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement the tasks in Part D. Steps use checkbox (`- [ ]`) syntax for tracking. **But read Parts A–C first — they are your orientation to a system you have zero context for.**

**Goal:** Bring the roleplay "Narrator" onto an archivist-backed single-agent design **without destroying the working two-agent Director system** — by building the single-agent path as its own module and switching to it per-scene at three seams.

**Architecture:** A SillyTavern extension ("Remodel"). The roleplay turn pipeline currently runs two LLM calls (a Director that plans + a Narrator that writes). This work adds a second **mode** where one agent both reasons and writes (native generation), grounded by an **archivist** (structured story-state store) that a cheap post-turn **extraction** pass fills from the delivered prose. Director mode stays bit-for-bit unchanged; solo mode is additive.

**Tech Stack:** Vanilla ES modules (browser), Jest (ESM via `--experimental-vm-modules`), a hand-rolled `st-context` stub for tests. No build step for the extension.

**Spec:** `docs/superpowers/specs/2026-08-19-single-agent-narrator-design.md` (the single-agent design). **NOTE:** that spec still says "remove the Director." The decision recorded in this plan supersedes it: the Director becomes a **fallback mode**, not deleted. Update the spec's framing when you touch it.

## Global Constraints

- **Repo root:** `C:\Users\RICHARD\Documents\Israel\SillyTavern`. All extension code lives in `public/scripts/extensions/third-party/SillyTavern-Remodel/`. Tests live in `tests/` (repo root), one flat folder, filenames `remodel-*.test.js`.
- **Test command** (run from the `tests/` directory): `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json <name-substring>`. Jest is installed under `tests/node_modules`, not the repo root.
- **Never mutate `live-direction.js` behaviour for Director mode.** Every change must leave the 46 `remodel-direction-lifecycle` tests green. Solo mode is reached only when `scene.liveDirection.mode === 'solo'`; the default/absent value is Director mode.
- **`Date.now()`/`Math.random()`** are fine in production store code (mirrors `variables-store.js`), never in test assertions.
- **Store persistence** uses the existing pattern only: namespace `'remodel'`, `getContext().extensionSettings`, `saveSettingsDebounced()`. No new persistence machinery.
- **Archivist is read as markdown, written as JSON.** The model reads rendered prose sections; it writes structured state-fence requests. Do not put raw JSON in the narrator's prompt.

---

## Part A — System Orientation (read first)

### A.1 What this extension is

"Remodel" reskins SillyTavern into a timeline/workspace UI with two authoring modes:
- **Story mode** — a document editor (`story-*.js`). **Not touched by this work.**
- **Roleplay mode** — a chat-style scene with "live direction." This is what the narrator–archivist work is about.

The roleplay turn pipeline is `live-direction.js` (~3000 lines — the biggest file; treat it with care).

### A.2 The roleplay turn today (Director mode — the working system)

One user action → one turn. Entry points (all `export`ed in `live-direction.js`) funnel into `beginDirection(...)`:
- `submitDirectedRoleplay` (user sends), `requestNextDirection` (Continue/autonomous), `retryLiveDirection`, `regenerateLastDirectedResponse`.

`beginDirection` (live-direction.js:~830) does, in order:
1. Post the user's message to chat (`sendMessageAsUser`).
2. Build a **snapshot** — `buildDirectionSnapshot` (:870): cast, persona, world info, chat history, and the **mechanics snapshot** (advertised Variables/Goals + an address book + capability dictionary, via `buildMechanicalSnapshot` in `mechanics-runtime.js`).
3. **Director call** — `requestDirection(scene, snapshot, …)` (:886): compiles the Director prompt from the roleplay recipe, streams it via `streamChatPrompt` (`story-stream.js`), and parses the reply (`director-reply.js` → typed entries + a ```state fence).
4. Store the reply's entries in the **notebook** (`appendDirectorEntries`, :915) and build an **envelope** (`buildDirectionEnvelope`, :940) carrying the Director's reasoning, flow (continue/pause), and mechanics requests.
5. Resolve the **performer** (which character speaks).
6. `generateDirectedPerformer(...)` — the **Narrator**: native SillyTavern generation (`context.generate` / `generateGroupWrapper`) using the full configured prompt, with the Director's direction injected into the roleplay recipe's "Director's Notes" slot. Streams tokens into a **reveal pipeline** (`scheduleReveal`/`revealStep`) that reveals prose gradually. `finalizeRunMessage` writes the final text + `saveChat`.

**Key fact learned the hard way:** the Narrator MUST use native generation. An earlier attempt hand-built a minimal prompt and stripped the user's system prompt / card / author's notes / examples — the narrator went incoherent (made up names, rambled). See memory `remodel-narrator-needs-native-prompt`. Direction reaches the narrator by *injecting into the native prompt*, never by rebuilding it.

### A.3 The archivist (SHIPPED, live in both modes)

The archivist is a structured story-state store — the single source of truth for "what has happened."

- **`archivist-store.js`** (SHIPPED) — per timeline+scene records: `scene_fact` (key/value), `event` (append-only log), `char_state` (per-character facets), `beat` (singleton "what's next"), `secret` (never shown to the narrator). Public API: `setSceneFact/clearSceneFact/listSceneFacts`, `recordEvent/listEvents`, `setCharStateFacet/clearCharStateFacet/listCharStates`, `setBeat/getBeat`, `setSecret/clearSecret/listSecrets`, plus `snapshotArchivistStore/restoreArchivistStore/deleteArchivistForTimeline`. Follows `variables-store.js` conventions exactly.
- **Archivist capabilities** (SHIPPED) in `mechanics-capabilities.js`: `scene.set/clear`, `event.record`, `char_state.set/clear`, `beat.set`, `secret.set/clear` — added to `CAPABILITY_NAMES`, `CAPABILITIES`, `REQUIRED_ARGUMENTS`, and the state-fence JSON schema. They ride the existing mechanics transaction (validation, receipts, atomic snapshot/rollback/undo). Archivist writes are included in the transaction's undo snapshot.
- **Reading it into a prompt:** `narrator-prompt.js` → `buildNarratorArchivistSections(timelineId, sceneId)` renders the records as markdown sections ("## Scene", "## Characters", "## What has happened", "## What happens next"), **filtering out secrets** (fail-closed, covered by a test).

### A.4 The narrator's injected direction (SHIPPED)

`narrator-prompt.js` → `buildDirectionInjection({ archivistState, directorDirection })` assembles what goes into the "Director's Notes" slot:
1. `APPEND_ONLY_DIRECTIVE` (always) — "continue forward, never restate/rewrite what's under 'What has happened'."
2. the archivist state (markdown).
3. the Director's direction (Director mode only — empty in solo mode).

`generateDirectedPerformer` calls this and injects via `hooks.setNativePromptContent('directorNotes', …)`. In solo mode there's no Director direction, so the injection naturally degrades to append-only + archivist — **no new code needed there.**

### A.5 Pass 2 — extraction (SHIPPED)

`live-direction.js` → `extractStateFromProse(run)` (:2010), called in `completeVisibleRun` after `finalizeRunMessage` (:2090). After the prose lands, a cheap non-streaming call reads the **delivered prose + the run's reasoning** and records what happened:
- Prompt built by **`narrator-extract.js`** → `buildExtractionPrompt({ prose, reasoning, currentState, mechanicsSkill })`. Records events/facts/char-states/beat/secrets (v1) **and** variable/goal changes (v2) when `mechanicsSkill` (the advertised Variables/Goals) is supplied.
- Parsed by `parseDirectorReply` (reused), executed by `executeDirectionRequests` with the run's address book (`run.variableRefs/goalRefs/addressBook`), so one call records narrative + mechanical state atomically.
- The Director's mechanics snapshot is carried onto the envelope as **`envelope.mechanicsSnapshot`** (a distinct field — `envelope.mechanics` already means the Director's pending requests; **clobbering it silently breaks all Director mechanics**, a bug the tests caught).
- Extraction is **opt-in for tests**: with test adapters installed but no `extractState` adapter, it returns without calling the transport (so it can't pollute Director-prompt captures).

**In Director mode, extraction currently ALSO runs** — at HEAD that's harmless only because the Director's own recipe is `contract-missing` (emits no state fence), so extraction is the de-facto sole author. Once modes are explicit, extraction must be **gated to solo mode** (connection point 2) so the two authors don't collide.

### A.6 The nine files this work touches (everything else is the untouched foundation)

`archivist-store.js` (new), `narrator-extract.js` (new), `narrator-prompt.js` (new), `live-direction.js` (the pipeline), `mechanics-capabilities.js` (+archivist verbs), `director-notes-store.js` (the notebook — slated for removal later), `prompt-studio.js` (a small debug-log wire), `timeline-spine.js` (roleplay-stream cards + idle mirror), `style.css`.

**The untouched foundation** (do not modify): the variables/goals engine (`variables-*.js`, `story-goals-*.js`, `mechanics-runtime.js`, `retrieval-recall.js`), Story mode (`story-*.js`), Prompt Studio (`prompt-studio-store.js`), the UI shell (`timeline-state.js`, `session-state.js`, most of `timeline-spine.js`), and the roleplay support modules that are reused as-is (`direction-sources.js`, `direction-address.js`, `direction-beats.js`, `narrator-history.js`, `director-reply.js`, `structured-reply.js`).

---

## Part B — The dual-mode design (the decision this plan implements)

### B.1 Why two modes, not a removal

The single-agent spec said "remove the Director." Doing that (removing the Director call from `beginDirection`) breaks **38 of 46** lifecycle tests, because that suite encodes the entire Director→notebook→mechanics flow. Removing a component that was producing *good* direction ("spot on," per the owner), to chase architectural purity, while breaking the safety net — that's a bad trade at that moment. Instead:

- **Director mode** (`mode: 'director'`, the default): today's proven two-agent system. Unchanged. All 46 lifecycle tests stay green.
- **Solo mode** (`mode: 'solo'`): the archivist-native single agent. One mind (native narrator reasons + writes), no Director call, no notebook; extraction fills the archivist afterward.

Both share the entire trunk (reveal, finalize, interruption, archivist, extraction module, performer resolution). Solo is a small module + a mode switch. If solo proves better in practice, the Director gets deleted later in a *deliberate* cleanup with its tests — not in a panic.

### B.2 The three connection points (the only switches)

1. **Envelope production** in `beginDirection`. Today lines ~886–940 call the Director and build the envelope. Extract that block verbatim into `directorEnvelope(scene, snapshot, turn, token, ctx)` and add: `const { envelope, storedTurn } = isSoloMode(scene) ? soloEnvelope(scene, snapshot, turn) : await directorEnvelope(...)`. Everything else in `beginDirection` (lock, post-message, snapshot, performer, `generateDirectedPerformer`, try/catch/finally) is untouched.
2. **Extraction gate** in `completeVisibleRun`: `if (isSoloMode(activeScene)) await extractStateFromProse(run);`.
3. **The mode setting** `scene.liveDirection.mode` + `isSoloMode(scene)` helper + (later) a UI toggle.

### B.3 What solo mode's `soloEnvelope` does

No LLM call. Returns `{ envelope, storedTurn: null }` where the envelope is the minimal shape the rest of the turn needs: `buildDirectionEnvelope({ reasoning: '', state: { requests: [], flow: { continue: false } } }, turn)` (pauses for the user after each turn) plus `mechanicsSnapshot: snapshot.mechanics` carried on it (so extraction can advertise/resolve mechanics). The stashed WIP (`git stash list` → "single-agent director-removal WIP") is the reference implementation of this envelope — mine it, don't re-derive.

---

## Part C — Current repo state (start here)

- **Branch:** `feature/ui-remodel`. **HEAD:** `c506d213d` "extraction v2". This is a **green base**: the archivist, extraction v1+v2, append-only directive, and native narrator are all shipped and passing, **with the Director still running**.
- **Verify green** before starting (from `tests/`): `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json "remodel-(direction|director|narrator|archivist|capability|goal|variable|story-goals|mechanic)"` → expect ~428 passed, 0 failed.
- **A stash exists:** `stash@{0}` "single-agent director-removal WIP (breaks 38 lifecycle tests)" — the raw Director-removal edit to `live-direction.js`. It is the reference for `soloEnvelope`'s minimal envelope, but do **not** `stash pop` it wholesale (it mutates `beginDirection` in place, which is exactly what we're replacing with the mode switch). Read it with `git stash show -p stash@{0}`.
- **Design docs:** `docs/superpowers/specs/2026-08-19-single-agent-narrator-design.md` (active, but reframe "remove Director" → "Director is a fallback mode"). Superseded: `…-layer2-design.md`, `2026-08-18-recursive-narrator-design.md`. Layer 1 (`…-archivist-narrator-design.md`) is shipped.

---

## File Structure (this plan)

- **Create `public/scripts/extensions/third-party/SillyTavern-Remodel/solo-direction.js`** — solo mode's envelope production + the `isSoloMode` helper. One responsibility: produce a Director-free envelope for a solo turn. No LLM call, no notebook.
- **Modify `live-direction.js`** — extract the Director block into a local `directorEnvelope(...)`; add the mode branch (connection point 1); gate extraction (connection point 2).
- **Create `tests/remodel-solo-direction.test.js`** — unit tests for `isSoloMode` and `soloEnvelope`.
- **Create `tests/remodel-solo-lifecycle.test.js`** — a full solo turn: no Director adapter is consulted, the narrator speaks, extraction fills the archivist, the turn waits for the user.

---

## Part D — Implementation Tasks

### Task 1: `isSoloMode` + `soloEnvelope` (the solo module)

**Files:**
- Create: `public/scripts/extensions/third-party/SillyTavern-Remodel/solo-direction.js`
- Test: `tests/remodel-solo-direction.test.js`

**Interfaces:**
- Consumes: `buildDirectionEnvelope(reply, turn)` from `live-direction.js` — but to avoid a circular import, `soloEnvelope` takes the already-built envelope-maker as an argument (see below) OR reconstructs the envelope shape inline. This plan uses the inline shape to keep `solo-direction.js` dependency-free.
- Produces:
  - `isSoloMode(scene) → boolean` — true iff `scene?.liveDirection?.mode === 'solo'`.
  - `soloEnvelope(scene, snapshot, turn) → { envelope, storedTurn }` where `storedTurn` is `null` and `envelope` has `{ protocol, directionId, notebookTurn: turn, reasoning: '', flow: { continueAfter: false, hardPauseAfter: true }, requests: [], mechanicsSnapshot: snapshot.mechanics }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/remodel-solo-direction.test.js
import { __setExtensionSettings } from './util/st-context-stub.js';
import { isSoloMode, soloEnvelope } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/solo-direction.js';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('isSoloMode is true only when the scene opts in', () => {
    expect(isSoloMode({ liveDirection: { mode: 'solo' } })).toBe(true);
    expect(isSoloMode({ liveDirection: { mode: 'director' } })).toBe(false);
    expect(isSoloMode({ liveDirection: {} })).toBe(false);
    expect(isSoloMode(null)).toBe(false);
});

test('soloEnvelope builds a Director-free envelope that pauses after the turn', () => {
    const snapshot = { mechanics: { addressBook: { entries: [] }, variableRefs: new Map(), goalRefs: new Map() } };
    const { envelope, storedTurn } = soloEnvelope({ id: 's1', timelineId: 't1' }, snapshot, 3);
    expect(storedTurn).toBe(null);
    expect(envelope.reasoning).toBe('');
    expect(envelope.requests).toEqual([]);
    expect(envelope.flow).toEqual({ continueAfter: false, hardPauseAfter: true });
    expect(envelope.notebookTurn).toBe(3);
    expect(envelope.mechanicsSnapshot).toBe(snapshot.mechanics);
    expect(typeof envelope.directionId).toBe('string');
    expect(envelope.directionId.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `tests/`): `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-solo-direction`
Expected: FAIL — `Cannot find module '.../solo-direction.js'`.

- [ ] **Step 3: Implement the module**

```js
// solo-direction.js
const DIRECTION_PROTOCOL = 'remodel-direction/1';

function createId(prefix) {
    return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

export function isSoloMode(scene) {
    return scene?.liveDirection?.mode === 'solo';
}

/**
 * Solo mode produces a turn with no separate Director call. The Narrator is the
 * one mind; a minimal envelope keeps the shared turn machinery (performer,
 * reveal, finalize, extraction) unchanged. The turn pauses for the user
 * afterward; the mechanics snapshot rides along so Pass 2 extraction can
 * advertise and resolve Variables/Goals.
 */
export function soloEnvelope(scene, snapshot, turn) {
    return {
        storedTurn: null,
        envelope: {
            protocol: DIRECTION_PROTOCOL,
            directionId: createId('direction'),
            notebookTurn: turn,
            reasoning: '',
            flow: { continueAfter: false, hardPauseAfter: true },
            requests: [],
            mechanicsSnapshot: snapshot.mechanics,
        },
    };
}
```

Note: confirm `DIRECTION_PROTOCOL`'s value against `live-direction.js` (search `const DIRECTION_PROTOCOL`) and copy it verbatim.

- [ ] **Step 4: Run to verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-solo-direction`
Expected: PASS — 2 tests.

- [ ] **Step 5: Mutation check**

Change `hardPauseAfter: true` to `false`; re-run; the pause test goes RED. Revert; GREEN. (Project habit — the test suite here has certified false properties before; mutate to trust it. See memory `remodel-mutation-test-before-trusting-suite`.)

- [ ] **Step 6: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/solo-direction.js tests/remodel-solo-direction.test.js
git commit -m "feat(remodel): solo-direction module — isSoloMode + Director-free envelope"
```

### Task 2: Wire the two seams into `live-direction.js`

**Files:**
- Modify: `live-direction.js` — import from `solo-direction.js`; extract the Director block into `directorEnvelope(...)`; branch on mode (connection point 1); gate extraction (connection point 2).
- Test: `tests/remodel-solo-lifecycle.test.js`

**Interfaces:**
- Consumes: `isSoloMode`, `soloEnvelope` from Task 1.
- Produces: a solo turn that never calls the Director and whose extraction fills the archivist.

- [ ] **Step 1: Write the failing lifecycle test**

Model it on `tests/remodel-narrator-extract-integration.test.js` (same harness helpers). Set `scene.liveDirection.mode = 'solo'`, install a `generatePerformer` adapter and an `extractState` adapter, install a `requestDirection` adapter **that throws** (to prove it is never called in solo mode):

```js
// tests/remodel-solo-lifecycle.test.js  (abridged — copy setup from remodel-narrator-extract-integration.test.js)
setLiveDirectionTestAdapters({
    requestDirection: async () => { throw new Error('Director must not run in solo mode'); },
    generatePerformer: speak,               // pushes a Narrator message + emits MESSAGE_RECEIVED
    extractState: async () => ['```state', extractionFence, '```'].join('\n'),
});
// scene.liveDirection.mode = 'solo'
test('a solo turn skips the Director and extraction records the prose', async () => {
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    expect(listEvents(scene.timelineId, scene.id).map((e) => e.summary)).toEqual(['Wren took the blade on her forearm']);
});
```

Use the exact `scene`, `speak`, `extractionFence`, and `until` from `remodel-narrator-extract-integration.test.js`.

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — the `requestDirection` adapter throws (Director still runs at this point).

- [ ] **Step 3: Add the import**

At the top of `live-direction.js` with the other local imports: `import { isSoloMode, soloEnvelope } from './solo-direction.js';`

- [ ] **Step 4: Extract the Director block into `directorEnvelope`**

Cut lines ~885–964 of `beginDirection` (from `const startedAt = Date.now();` through the `if (reply.tailError) { … }` block — the requestDirection call, notebook storage, `notes.unrouted` warning, `buildDirectionEnvelope`, and journals) into a new local async function directly above `beginDirection`:

```js
async function directorEnvelope(scene, snapshot, turn, token) {
    // <-- the exact block you cut, unchanged, returning { envelope, storedTurn }.
    // storedTurn = stored.length ? turn : null;
    // return { envelope: buildDirectionEnvelope(reply, turn), storedTurn };
}
```

Preserve every journal call and the `token.aborted` checks inside it. It returns `{ envelope, storedTurn }`.

- [ ] **Step 5: Add the mode branch (connection point 1)**

Where the cut block used to be in `beginDirection`, insert:

```js
const turn = toTurnNumber(notebookTurn) ?? nextNotebookTurn(scene);
const { envelope, storedTurn: storedTurnValue } = isSoloMode(scene)
    ? soloEnvelope(scene, snapshot, turn)
    : await directorEnvelope(scene, snapshot, turn, token);
if (storedTurnValue) storedTurn = storedTurnValue;
if (token.aborted) return abandonPass(token, 'director');
```

(`storedTurn` is the outer-scoped `let` the `finally` reads; keep assigning it.) Confirm `directorEnvelope` no longer redeclares `turn`/`storedTurn`.

- [ ] **Step 6: Gate extraction (connection point 2)**

In `completeVisibleRun`, change `await extractStateFromProse(run);` to:

```js
if (isSoloMode(hooks.getActiveScene())) await extractStateFromProse(run);
```

- [ ] **Step 7: Run the solo test — verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-solo-lifecycle`
Expected: PASS.

- [ ] **Step 8: Run the FULL Director suite — verify ZERO regression**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json "remodel-(direction-lifecycle|director|narrator|archivist|capability|goal|variable|story-goals|mechanic)"`
Expected: all pass (46 lifecycle + the rest, ~428). If any Director-lifecycle test fails, the extraction gate or the block-extraction changed Director behaviour — fix before committing.

- [ ] **Step 9: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js tests/remodel-solo-lifecycle.test.js
git commit -m "feat(remodel): dual-mode — switch to solo direction at the two seams"
```

### Task 3: A UI toggle for the mode (minimal)

**Files:**
- Modify: `live-direction.js` — add `export function setLiveDirectionMode(scene, mode)` mirroring `setLiveDirectionPacing` (:296).
- Modify: `timeline-spine.js` — add a mode control beside the existing pacing control in the roleplay toolbar (find where `setLiveDirectionPacing` is wired).
- Test: extend `tests/remodel-solo-direction.test.js`.

**Interfaces:**
- Produces: `setLiveDirectionMode(scene, mode)` persists `scene.liveDirection.mode` (`'director'` | `'solo'`) and saves.

- [ ] **Step 1: Write the failing test**

```js
import { setLiveDirectionMode } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
test('setLiveDirectionMode persists the chosen mode on the scene', () => {
    const scene = { liveDirection: {} };
    setLiveDirectionMode(scene, 'solo');
    expect(scene.liveDirection.mode).toBe('solo');
    setLiveDirectionMode(scene, 'director');
    expect(scene.liveDirection.mode).toBe('director');
});
```

- [ ] **Step 2: Run to verify it fails.** Expected: `setLiveDirectionMode is not a function`.

- [ ] **Step 3: Implement** — copy `setLiveDirectionPacing`'s body (live-direction.js:296), swapping `pacing` for `mode`, validating `mode` ∈ `{'director','solo'}` (default `'director'` on anything else), and persisting via the same hook it uses.

- [ ] **Step 4: Run — verify pass.**

- [ ] **Step 5: Wire the toolbar control** in `timeline-spine.js` next to the pacing control (a two-option segmented control: "Director" / "Solo"), calling `setLiveDirectionMode`. Follow the existing pacing-control markup/handler exactly.

- [ ] **Step 6: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-spine.js tests/remodel-solo-direction.test.js
git commit -m "feat(remodel): per-scene Director/Solo mode toggle"
```

---

## Part E — Remaining work AFTER solo mode lands (separate plans)

These complete the archivist plan. Each is its own plan; do not fold them into the tasks above.

1. **Stop = cut off (solo mode).** Today `interruptLiveDirection` discards the unrevealed buffer and deletes the message when nothing was revealed → "everything vanishes on Stop." Fix: on interrupt, flush `rawBufferedText.slice(rawOffset)` into `acceptedVisibleText` so all generated prose is kept; only delete a truly-empty run. The stashed WIP already contains this flush edit — reuse it. **7 lifecycle tests encode the old delete/remainder semantics**; they only need updating once solo is the context (or gate the flush to solo mode to avoid touching Director tests).
2. **Notebook removal.** Once solo mode is validated and the Director is retired, delete `director-notes-store.js` and its readers; secrets → archivist secret records. Not before — Director mode still uses it.
3. **Direction cards from the archivist.** The roleplay-stream cards (in `timeline-spine.js`) read the notebook. In solo mode, re-source them to show the archivist's current beat + recent state changes.
4. **Reframe the spec.** Update `2026-08-19-single-agent-narrator-design.md`: "remove the Director" → "Director is a fallback mode; solo is the archivist-native path." Record the three connection points.

---

## Hard-won gotchas (do not relearn these the expensive way)

- **Narrator = native generation, always.** Never hand-build the narrator's prompt. Inject direction into the native prompt via `setNativePromptContent`. (`remodel-narrator-needs-native-prompt`.)
- **`envelope.mechanics` is the Director's pending requests.** The extraction mechanics snapshot rides on `envelope.mechanicsSnapshot`. Clobbering `envelope.mechanics` silently kills all Director mechanics. The test `a fully revealed response applies the direction's requests` (expects `hp() === 8`) is your tripwire.
- **`eventSource.emit` is slow async** (`CHAT_CHANGED` ~8.5s / 21 listeners). Never block the reveal or finalize on emissions. (`remodel-eventsource-emit-is-slow-async`.)
- **Mutation-test before trusting green.** This suite has certified false properties three times. (`remodel-mutation-test-before-trusting-suite`.)
- **`Number(null)` coercion trap** in clamp helpers here has twice defaulted null/''/[] to min. (`remodel-number-null-coercion-trap`.)
- **Extraction is opt-in for tests** — with test adapters installed but no `extractState`, `extractStateFromProse` returns early so it can't fire the real transport and pollute Director-prompt captures.
- **`buildMechanicalSnapshot` retrieval is expensive.** Solo mode reuses the snapshot `beginDirection` already built; it does NOT retrieve twice.

---

## Self-Review

**Spec coverage:** The active spec's archivist (store, capabilities, injection, append-only) is SHIPPED (Part A.3–A.5). Extraction v1+v2 is SHIPPED (A.5). The spec's "single agent, no Director" is delivered as **solo mode** (Tasks 1–2), reframed from removal to a mode (B.1). Stop=cut-off, notebook removal, and direction-cards are deferred to Part E with concrete guidance (matches the spec's rollout). Gap: the spec text still says "remove Director" — Part E task 4 fixes the doc.

**Placeholder scan:** No TBD/TODO. Every code step has full code; every run step names the command and expected result; the one place that references existing code to move (Task 2 Step 4) points at exact line ranges and the return contract.

**Type consistency:** `isSoloMode(scene)→boolean` and `soloEnvelope(scene, snapshot, turn)→{envelope, storedTurn}` are defined in Task 1 and consumed with those exact signatures in Task 2. `envelope.mechanicsSnapshot` matches the field name the shipped `extractStateFromProse` already reads (`run.envelope?.mechanicsSnapshot`). `setLiveDirectionMode(scene, mode)` in Task 3 matches its test.
