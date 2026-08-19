# Recursive Narrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the notebook-based Director-to-Narrator creative channel with raw reasoning tokens, so the Narrator writes prose from the Director's actual thinking rather than from lossy tagged journal entries.

**Architecture:** The Director call (call 1) is unchanged. Its reasoning tokens — previously captured but discarded — are framed with a one-line role-awareness header and delivered to the Narrator (call 2) through the existing `directorNotes` recipe block. The notebook stays for Director self-memory and UI; it stops being the Narrator's creative channel. Models without reasoning tokens fall back to the current notebook-based path.

**Tech Stack:** JavaScript (ESM), Jest (with `--experimental-vm-modules` via `NODE_OPTIONS`), SillyTavern extension API.

**Spec:** `docs/superpowers/specs/2026-08-18-recursive-narrator-design.md`

## Global Constraints

- All tests run from the `tests/` directory: `cd tests && NODE_OPTIONS="--experimental-vm-modules" npx jest <file> --verbose`
- On Windows with PowerShell: `$env:NODE_OPTIONS="--experimental-vm-modules"; cd tests; npx jest <file> --verbose`
- `live-direction.js` is ~2900 lines. Read only the sections you modify.
- `buildDirectorNotesSource` and `formatDirectorNotesPrompt` are NOT deleted — they become the non-reasoning fallback.
- `filterNarratorHistory` in `narrator-history.js` is unchanged (already strips user messages).
- The `directorNotes` recipe block key, `nativeIdentifier`, and all Prompt Studio wiring stay the same.
- The existing 769-test suite must stay green throughout.

---

### Task 1: `frameDirectorReasoning` — the pure framing function

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js` (add function near line 2776, next to `buildDirectorNotesSource`)
- Test: `tests/remodel-narrator-notes-framing.test.js` (add new tests)

**Interfaces:**
- Consumes: nothing from other tasks
- Produces: `frameDirectorReasoning(reasoning: string): string` — returns the framing header prepended to the raw reasoning, or empty string if reasoning is falsy. Used by Tasks 2 and 3.

- [ ] **Step 1: Write the failing tests**

Add to the bottom of `tests/remodel-narrator-notes-framing.test.js`:

```js
import { frameDirectorReasoning } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';

test('frameDirectorReasoning prepends the director-awareness header to raw reasoning', () => {
    const reasoning = 'Teo has been dodging for three turns and Eli is about to snap.';
    const result = frameDirectorReasoning(reasoning);

    expect(result).toContain('scene director');
    expect(result).toContain('creative thinking');
    expect(result).toContain('Ignore any technical references');
    expect(result).toContain(reasoning);
});

test('frameDirectorReasoning returns empty string for falsy reasoning', () => {
    expect(frameDirectorReasoning('')).toBe('');
    expect(frameDirectorReasoning(null)).toBe('');
    expect(frameDirectorReasoning(undefined)).toBe('');
});

test('frameDirectorReasoning passes the full reasoning without truncation or filtering', () => {
    const mechanical = '[ruling] If Eli sits, Teo talks.\n|||STATE_FENCE|||\nvariable.adjust: mood +2\n|||END_FENCE|||';
    const result = frameDirectorReasoning(mechanical);

    expect(result).toContain('[ruling]');
    expect(result).toContain('|||STATE_FENCE|||');
    expect(result).toContain('variable.adjust: mood +2');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tests && NODE_OPTIONS="--experimental-vm-modules" npx jest remodel-narrator-notes-framing.test.js --verbose`

Expected: FAIL — `frameDirectorReasoning` is not exported / not defined.

- [ ] **Step 3: Implement `frameDirectorReasoning`**

In `live-direction.js`, near `buildDirectorNotesSource` (around line 2776), add:

```js
const SCENE_DIRECTION_HEADER = `[A scene director has reviewed the full context of this conversation — the user's messages, the world's mechanics, and the story so far — and worked out what should happen next. Below is their creative thinking. Write the narrative from it. Ignore any technical references you don't recognise.]`;

export function frameDirectorReasoning(reasoning) {
    const text = String(reasoning || '').trim();
    if (!text) return '';
    return `${SCENE_DIRECTION_HEADER}\n\n${text}`;
}
```

Add `frameDirectorReasoning` to the module's exports (it's already exported by `export function`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tests && NODE_OPTIONS="--experimental-vm-modules" npx jest remodel-narrator-notes-framing.test.js --verbose`

Expected: ALL PASS (both old framing tests and the three new ones).

- [ ] **Step 5: Run full suite to verify no regressions**

Run: `cd tests && NODE_OPTIONS="--experimental-vm-modules" npx jest --verbose`

Expected: 769+ tests pass.

- [ ] **Step 6: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js tests/remodel-narrator-notes-framing.test.js
git commit -m "feat(remodel): add frameDirectorReasoning — the reasoning-to-Narrator bridge"
```

---

### Task 2: Store reasoning per notebook turn

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/director-notes-store.js:60-87` (extend `appendDirectorEntries`)
- Modify: `tests/remodel-director-notes-store.test.js` (add reasoning storage tests)

**Interfaces:**
- Consumes: nothing from other tasks
- Produces: `appendDirectorEntries(timelineId, { sceneId, turn, entries, reasoning })` — gains an optional `reasoning` string field. `readNarratorEntries` is unchanged. A new export `readTurnReasoning(timelineId, { sceneId, turn }): string` returns the stored reasoning for a specific turn.

- [ ] **Step 1: Write the failing tests**

Add to `tests/remodel-director-notes-store.test.js`:

```js
import { appendDirectorEntries, readAllEntriesForOwner } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-notes-store.js';

// If readTurnReasoning is not yet exported, import it after adding. For now,
// these tests check the storage path — read it back via the store internals.
import { readTurnReasoning } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-notes-store.js';

test('appendDirectorEntries stores reasoning alongside entries for the same turn', () => {
    appendDirectorEntries('t1', {
        sceneId: 's1',
        turn: 3,
        entries: [{ type: 'note', text: 'A quiet scene.' }],
        reasoning: 'The tension needs to build slowly here.',
    });

    const reasoning = readTurnReasoning('t1', { sceneId: 's1', turn: 3 });
    expect(reasoning).toBe('The tension needs to build slowly here.');
});

test('readTurnReasoning returns empty string when no reasoning was stored', () => {
    appendDirectorEntries('t1', {
        sceneId: 's1',
        turn: 4,
        entries: [{ type: 'note', text: 'No reasoning.' }],
    });

    const reasoning = readTurnReasoning('t1', { sceneId: 's1', turn: 4 });
    expect(reasoning).toBe('');
});

test('readTurnReasoning returns empty string for a nonexistent turn', () => {
    expect(readTurnReasoning('t1', { sceneId: 's1', turn: 999 })).toBe('');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tests && NODE_OPTIONS="--experimental-vm-modules" npx jest remodel-director-notes-store.test.js --verbose`

Expected: FAIL — `readTurnReasoning` is not exported.

- [ ] **Step 3: Implement reasoning storage**

In `director-notes-store.js`:

**3a.** Inside `appendDirectorEntries` (around line 78, after the entries are stored), add reasoning storage:

```js
if (typeof reasoning === 'string' && reasoning.trim()) {
    bucket.reasoning ??= {};
    bucket.reasoning[`${scene}:${turnNumber}`] = reasoning.trim();
}
```

The `reasoning` parameter is added to the function signature's destructured options: change `{ sceneId, turn, entries }` to `{ sceneId, turn, entries, reasoning }`.

**3b.** Add `readTurnReasoning` export:

```js
export function readTurnReasoning(timelineId, { sceneId, turn } = {}) {
    const bucket = getTimelineNotesState(String(timelineId || ''), { create: false });
    if (!bucket?.reasoning) return '';
    const key = `${String(sceneId || '')}:${Math.floor(Number(turn)) || 0}`;
    return String(bucket.reasoning[key] || '');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tests && NODE_OPTIONS="--experimental-vm-modules" npx jest remodel-director-notes-store.test.js --verbose`

Expected: ALL PASS.

- [ ] **Step 5: Run full suite**

Run: `cd tests && NODE_OPTIONS="--experimental-vm-modules" npx jest --verbose`

Expected: 769+ tests pass (no existing test passes reasoning, so the new field is inert).

- [ ] **Step 6: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/director-notes-store.js tests/remodel-director-notes-store.test.js
git commit -m "feat(remodel): store Director reasoning per notebook turn"
```

---

### Task 3: Wire reasoning into `beginDirection` and `generateDirectedPerformer`

This is the core change: the Director's reasoning flows from `requestDirection` through the envelope to `generateDirectedPerformer`, which delivers it to the Narrator instead of notebook entries.

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js:872` (`buildDirectionEnvelope` — add reasoning field)
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js:1657` (`generateDirectedPerformer` — swap delivery)
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js:840-890` (`beginDirection` — pass reasoning to `appendDirectorEntries` and `buildDirectionEnvelope`)
- Test: `tests/remodel-director-notes-source.test.js` (update delivery assertions)

**Interfaces:**
- Consumes: `frameDirectorReasoning(reasoning)` from Task 1, `appendDirectorEntries(timelineId, { ..., reasoning })` from Task 2
- Produces: the envelope gains `reasoning: string`. `generateDirectedPerformer` delivers framed reasoning (or notebook fallback) via `hooks.setNativePromptContent`.

- [ ] **Step 1: Write the failing test**

In `tests/remodel-director-notes-source.test.js`, find the lifecycle test that checks what the generation-seam hook delivers. It currently asserts that `nativePromptCapture.get('directorNotes')` contains notebook entries. Add a new test that checks reasoning delivery:

```js
test('when the Director returns reasoning, the generation-seam delivers framed reasoning instead of notebook entries', async () => {
    const capture = { value: undefined };
    const performer = capturingPerformer(capture);
    const scene = buildScene();

    await speakInLifecycle(scene, {
        directorReply: { text: '[note] Quiet scene.\n|||STATE_FENCE|||\n{"continue":true}\n|||END_FENCE|||', reasoning: 'The silence here is doing the heavy lifting.' },
        performer,
    });

    expect(capture.value).toContain('scene director');
    expect(capture.value).toContain('The silence here is doing the heavy lifting.');
    expect(capture.value).not.toContain('DIRECTOR\'S NOTES');
});

test('when the Director returns no reasoning, the generation-seam falls back to notebook entries', async () => {
    const capture = { value: undefined };
    const performer = capturingPerformer(capture);
    const scene = buildScene();

    await speakInLifecycle(scene, {
        directorReply: { text: '[note] Quiet scene.\n|||STATE_FENCE|||\n{"continue":true}\n|||END_FENCE|||', reasoning: '' },
        performer,
    });

    expect(capture.value).toContain('DIRECTOR\'S NOTES');
    expect(capture.value).toContain('Quiet scene.');
});
```

The `speakInLifecycle` helper and `buildScene` already exist in this test file. The `directorReply` object may need to support a `reasoning` field — check the `testAdapters.requestDirection` handler in `requestDirection()` (line 1407-1411): it reads `answer.reasoning`, so passing `{ text, reasoning }` from the test adapter works already.

- [ ] **Step 2: Run tests to verify the new tests fail**

Run: `cd tests && NODE_OPTIONS="--experimental-vm-modules" npx jest remodel-director-notes-source.test.js --verbose`

Expected: the "framed reasoning" test FAILS (it still gets notebook entries). The "fallback" test may PASS already.

- [ ] **Step 3: Add reasoning to the envelope**

In `live-direction.js`, modify `buildDirectionEnvelope` (line 1467):

```js
function buildDirectionEnvelope(reply, turn) {
    const requests = getMechanicsProfile().enabled ? usableRequests(reply.state.requests) : [];
    return {
        protocol: DIRECTION_PROTOCOL,
        directionId: createId('direction'),
        notebookTurn: turn,
        reasoning: reply.reasoning || '',
        flow: {
            continueAfter: reply.state.flow.continue === true,
            hardPauseAfter: reply.state.flow.continue !== true,
        },
        requests,
    };
}
```

- [ ] **Step 4: Pass reasoning to `appendDirectorEntries`**

In `beginDirection`, at line 848-852, the existing call is:

```js
const stored = appendDirectorEntries(scene.timelineId, {
    sceneId: scene.id,
    turn,
    entries: markSeveredEntry(reply.entries, reply.interrupted),
});
```

Add `reasoning: reply.reasoning` to the options object:

```js
const stored = appendDirectorEntries(scene.timelineId, {
    sceneId: scene.id,
    turn,
    entries: markSeveredEntry(reply.entries, reply.interrupted),
    reasoning: reply.reasoning,
});
```

- [ ] **Step 5: Change `generateDirectedPerformer` to deliver reasoning**

In `generateDirectedPerformer` (line 1657), replace:

```js
hooks.setNativePromptContent('directorNotes', formatDirectorNotesPrompt(scene));
```

with:

```js
const reasoningBridge = frameDirectorReasoning(envelope.reasoning);
hooks.setNativePromptContent(
    'directorNotes',
    reasoningBridge || formatDirectorNotesPrompt(scene),
);
```

This is the one-branch fallback: if reasoning exists, use it; otherwise, fall back to notebook entries.

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `cd tests && NODE_OPTIONS="--experimental-vm-modules" npx jest remodel-director-notes-source.test.js --verbose`

Expected: ALL PASS — both new tests and all existing tests.

- [ ] **Step 7: Run the full suite**

Run: `cd tests && NODE_OPTIONS="--experimental-vm-modules" npx jest --verbose`

Expected: 769+ tests pass. Pay special attention to:
- `remodel-director-notes-source.test.js` — the delivery tests
- `remodel-direction-lifecycle.test.js` — the full lifecycle
- `remodel-narrator-history.test.js` — history filtering
- `remodel-narrator-notes-framing.test.js` — the framing function
- `remodel-standing-direction.test.js` — standing direction replay (envelope carries reasoning now)

- [ ] **Step 8: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js tests/remodel-director-notes-source.test.js
git commit -m "feat(remodel): deliver Director reasoning to Narrator, notebook entries as fallback"
```

---

### Task 4: Update the idle-state mirror in `timeline-spine.js`

The idle-state mirror in `renderRoleplayScene` (timeline-spine.js line 10640) currently calls `formatDirectorNotesPrompt(activeRoleplayScene)`. This needs the same reasoning-first fallback: if the most recent turn has stored reasoning, use it; otherwise, fall back to notebook entries.

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-spine.js:10640` (update the idle-state mirror)
- Test: existing suite covers the idle mirror path — verify no regression

**Interfaces:**
- Consumes: `frameDirectorReasoning(reasoning)` from Task 1, `readTurnReasoning(timelineId, { sceneId, turn })` from Task 2
- Produces: the idle-state mirror delivers framed reasoning when available

- [ ] **Step 1: Read the idle-state mirror context**

Read `timeline-spine.js` around line 10630-10650 to see the full context of the call.

- [ ] **Step 2: Add imports**

In `timeline-spine.js`, add `frameDirectorReasoning` to the import from `live-direction.js` (it already imports `formatDirectorNotesPrompt`). Add `readTurnReasoning` to the import from `director-notes-store.js`.

- [ ] **Step 3: Update the idle-state mirror**

At line 10640, replace:

```js
setRemodelNativePromptContent('directorNotes', formatDirectorNotesPrompt(activeRoleplayScene));
```

with:

```js
const idleReasoning = activeRoleplayScene?.timelineId
    ? readTurnReasoning(activeRoleplayScene.timelineId, {
        sceneId: activeRoleplayScene.id,
        turn: latestNotebookTurn(activeRoleplayScene),
    })
    : '';
setRemodelNativePromptContent(
    'directorNotes',
    frameDirectorReasoning(idleReasoning) || formatDirectorNotesPrompt(activeRoleplayScene),
);
```

Check whether a `latestNotebookTurn(scene)` helper already exists. If not, use the scene's `liveDirection.directionLog` to find the most recent turn number:

```js
const latestTurn = (activeRoleplayScene?.liveDirection?.directionLog || [])
    .filter(Boolean)
    .reduce((max, entry) => Math.max(max, Number(entry.notebookTurn) || 0), 0);
```

Inline this if there's no existing helper.

- [ ] **Step 4: Run the full suite**

Run: `cd tests && NODE_OPTIONS="--experimental-vm-modules" npx jest --verbose`

Expected: 769+ tests pass.

- [ ] **Step 5: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-spine.js
git commit -m "feat(remodel): idle-state mirror delivers reasoning when available"
```

---

### Task 5: Journal logging for reasoning path selection

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js:1657` (add journal entry near the delivery site)

**Interfaces:**
- Consumes: the reasoning-or-fallback branch from Task 3
- Produces: a journal entry `notes.bridge` that records which path was taken

- [ ] **Step 1: Add journal logging**

In `generateDirectedPerformer`, right after the reasoning-or-fallback delivery (the code from Task 3 Step 5), add:

```js
journal('notes.bridge', {
    directionId: envelope.directionId,
    path: reasoningBridge ? 'reasoning' : 'notebook',
    reasoningLength: (envelope.reasoning || '').length,
}, { correlationId: envelope.directionId });
```

- [ ] **Step 2: Run the full suite**

Run: `cd tests && NODE_OPTIONS="--experimental-vm-modules" npx jest --verbose`

Expected: 769+ tests pass.

- [ ] **Step 3: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js
git commit -m "feat(remodel): journal which creative bridge path is taken per turn"
```

---

Plan complete and saved to `docs/superpowers/plans/2026-08-19-recursive-narrator.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?