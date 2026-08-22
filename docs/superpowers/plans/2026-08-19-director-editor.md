# Director-as-Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `editor` roleplay mode where the Narrator drafts the whole turn freely, then a purely-mechanical Director reads that draft, creates/rolls mechanics, and **preserve-and-patches** only the beats a roll changed — committing the final version (hold-then-show).

**Architecture:** Additive, like `solo` mode was — a new `scene.liveDirection.mode === 'editor'`. The old Director and `solo` modes stay untouched (all existing tests green). The editor turn = narrator draft (hidden) → `runDirectorEdit` (build editor prompt → transport → parse committed prose + state fence → execute) → commit the committed prose, record state. New pure modules for the prompt/parse/rendering; the live wiring lands last.

**Tech Stack:** Vanilla ES modules (browser), Jest (ESM via `--experimental-vm-modules`), the `tests/util/st-context-stub.js` stub.

**Spec:** `docs/superpowers/specs/2026-08-19-director-editor-design.md`. **Branch: `feature/director`.**

## Global Constraints

- **Repo root:** `C:\Users\RICHARD\Documents\Israel\SillyTavern`. Extension code in `public/scripts/extensions/third-party/SillyTavern-Remodel/`. Tests in `tests/` (flat, `remodel-*.test.js`).
- **Test command** (from `tests/`): `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json <name-substring>`.
- **Additive only.** Editor mode is reached only when `scene.liveDirection.mode === 'editor'`. Never change `director` or `solo` behaviour; the existing suites (`remodel-direction-lifecycle`, `remodel-solo-*`) must stay green.
- **Narrator sees readable state + goals-as-objectives, never numbers/odds.** The Director sees the numbers.
- **Preserve-and-patch:** the Director keeps the narrator's words verbatim and swaps only the beat a roll changed. This is prompt-enforced; fidelity is the top iteration risk (spec §8).
- **Dice are code-rolled** — the Director *requests* `goal.reach`; the mechanics layer rolls. Never roll in JS test code with `Math.random`.
- **Rolls are rare** — only genuine "even the characters don't know" uncertainty.

---

## File Structure

- **Create `public/…/director-editor.js`** — the editor pass, pure/testable: `isEditorMode(scene)`, `buildDirectorEditorPrompt(input)`, `parseEditorReply(raw)`.
- **Modify `public/…/narrator-prompt.js`** — add `buildGoalObjectives(sceneId)` (readable goals-as-objectives, no numbers) for the narrator view.
- **Modify `public/…/live-direction.js`** — extend `setLiveDirectionMode` to accept `'editor'`; add `runDirectorEdit(...)` and wire the editor turn.
- **Create `tests/remodel-director-editor.test.js`** — mode flag, prompt builder, reply parser, goal objectives.
- **Create `tests/remodel-director-editor-integration.test.js`** — a full editor turn through adapters.

---

## Task 1: The `editor` mode flag

**Files:**
- Create: `public/scripts/extensions/third-party/SillyTavern-Remodel/director-editor.js`
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js:314-319`
- Test: `tests/remodel-director-editor.test.js`

**Interfaces:**
- Produces: `isEditorMode(scene) → boolean`; `setLiveDirectionMode(scene, 'editor') → true`.

- [ ] **Step 1: Write the failing test**

```js
// tests/remodel-director-editor.test.js
import { __setExtensionSettings } from './util/st-context-stub.js';
import { isEditorMode } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-editor.js';
import { setLiveDirectionMode } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { createArc, createScene, createTimeline, getScene } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-state.js';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('isEditorMode is true only for the editor mode', () => {
    expect(isEditorMode({ liveDirection: { mode: 'editor' } })).toBe(true);
    expect(isEditorMode({ liveDirection: { mode: 'solo' } })).toBe(false);
    expect(isEditorMode({ liveDirection: {} })).toBe(false);
    expect(isEditorMode(null)).toBe(false);
});

test('setLiveDirectionMode accepts editor alongside director and solo', () => {
    const scene = createScene(createArc(createTimeline('T').id, 'A').id, 'roleplay', 'S');
    expect(setLiveDirectionMode(scene, 'editor')).toBe(true);
    expect(getScene(scene.id).liveDirection.mode).toBe('editor');
    expect(setLiveDirectionMode(scene, 'bogus')).toBe(false);
});
```

- [ ] **Step 2: Run — expect FAIL** (`Cannot find module '.../director-editor.js'`).
Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-director-editor`

- [ ] **Step 3: Create `director-editor.js` with the flag**

```js
/** True only for the editor mode (narrator drafts, Director reconciles). */
export function isEditorMode(scene) {
    return scene?.liveDirection?.mode === 'editor';
}
```

- [ ] **Step 4: Extend the mode setter** — change `live-direction.js:315` from:

```js
    if (!scene || (mode !== 'director' && mode !== 'solo')) return false;
```

to:

```js
    if (!scene || (mode !== 'director' && mode !== 'solo' && mode !== 'editor')) return false;
```

- [ ] **Step 5: Run — expect PASS** (2 tests).

- [ ] **Step 6: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/director-editor.js public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js tests/remodel-director-editor.test.js
git commit -m "feat(remodel): editor mode flag (isEditorMode + setter)"
```

---

## Task 2: Goals-as-objectives for the narrator view

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js`
- Test: `tests/remodel-director-editor.test.js`

**Interfaces:**
- Consumes: `getSceneGoals(sceneId, { includeResolved, states }) → Array<{ title, description, successRate, status }>` from `story-goals-store.js`.
- Produces: `buildGoalObjectives(sceneId) → string` — markdown lines of active goals as objectives (title + description), **no successRate, no status number**. Empty string when none.

- [ ] **Step 1: Write the failing test**

```js
import { buildGoalObjectives } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js';
import { createTimelineGoal } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-store.js';

test('goal objectives render title + description, never the odds or status number', () => {
    createTimelineGoal('tl-obj', {
        title: 'Win Marissa over', description: 'Eli wants her trust', successRate: 30,
        visibility: 'public', holderRefs: [{ kind: 'character', id: 'eli', label: 'Eli' }],
    }, { sceneId: 'sc-obj' });
    const text = buildGoalObjectives('sc-obj');
    expect(text).toContain('Win Marissa over');
    expect(text).toContain('Eli wants her trust');
    expect(text).not.toContain('30');       // no odds
    expect(text).not.toMatch(/%/);          // no percentage
    expect(buildGoalObjectives('sc-empty')).toBe('');
});
```

- [ ] **Step 2: Run — expect FAIL** (`buildGoalObjectives is not a function`).

- [ ] **Step 3: Implement in `narrator-prompt.js`** — add the import and function:

```js
import { getSceneGoals } from './story-goals-store.js';

/**
 * The scene's active goals as narrative OBJECTIVES for the narrator view —
 * what characters are trying to do, never the odds behind it. The odds and
 * status numbers stay the Director's private board.
 */
export function buildGoalObjectives(sceneId) {
    const goals = getSceneGoals(sceneId, { includeResolved: false, states: ['active', 'background'] });
    if (!goals.length) return '';
    const lines = goals.map((goal) => {
        const desc = String(goal.description || '').trim();
        return `- ${goal.title}${desc ? `: ${desc}` : ''}`;
    });
    return `## Objectives\n${lines.join('\n')}`;
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Mutation check** — temporarily append `` ` (${goal.successRate}%)` `` to the line; re-run; the "no odds" assertion goes RED. Revert; GREEN. (Project habit — mutate before trusting green.)

- [ ] **Step 6: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js tests/remodel-director-editor.test.js
git commit -m "feat(remodel): goals-as-objectives for the narrator view (no odds)"
```

---

## Task 3: The Director-editor prompt

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/director-editor.js`
- Test: `tests/remodel-director-editor.test.js`

**Interfaces:**
- Produces: `buildDirectorEditorPrompt({ draft, draftReasoning, narrativeState, mechanicsSkill }) → {role,content}[]` — a 2-message prompt. `narrativeState` and `mechanicsSkill` are pre-rendered strings; `draft` is the narrator's prose; `draftReasoning` is optional.

- [ ] **Step 1: Write the failing test**

```js
import { buildDirectorEditorPrompt } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-editor.js';

test('the editor prompt: preserve-and-patch, roll only genuine uncertainty, output prose then a fence', () => {
    const messages = buildDirectorEditorPrompt({
        draft: 'Eli leans in and Marissa melts into him.',
        draftReasoning: 'He goes for the kiss.',
        narrativeState: '## Scene\n- location: cafe',
        mechanicsSkill: '- Goal "Win Marissa over" (30%)',
    });
    const system = messages.find((m) => m.role === 'system').content;
    const user = messages.find((m) => m.role === 'user').content;
    expect(system).toMatch(/verbatim|word.for.word|only the .*(beat|sentence)/i); // preserve-and-patch
    expect(system).toMatch(/goal\.reach/i);                                       // rolls via goal.reach
    expect(system).toMatch(/even the characters|genuinely.*doubt|do not roll.*routine/i); // rare uncertainty
    expect(system).toContain('```state');                                         // fence after prose
    expect(system).toContain('Win Marissa over');                                 // mechanical state (with numbers) for the Director
    expect(user).toContain('Eli leans in and Marissa melts into him.');           // the draft
    expect(user).toContain('He goes for the kiss.');                              // draft reasoning
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `buildDirectorEditorPrompt`** in `director-editor.js`:

```js
/**
 * The Director-editor prompt. The Director is a purely MECHANICAL referee: it
 * reads the narrator's draft and reconciles it with the dice, but authors no
 * prose beyond swapping the exact beat a roll changed (preserve-and-patch).
 *
 * @param {{draft: string, draftReasoning?: string, narrativeState?: string, mechanicsSkill?: string}} input
 * @returns {{role: string, content: string}[]}
 */
export function buildDirectorEditorPrompt({ draft, draftReasoning = '', narrativeState = '', mechanicsSkill = '' }) {
    const hasMechanics = Boolean(String(mechanicsSkill || '').trim());
    const system = [
        'You are the Director — a mechanical referee, not a writer. You are given the narrator\'s DRAFT of this turn. You never invent story or voice; you reconcile the draft with the dice and record what happened.',
        'STEP 1 — Mechanics. Create or update Goals and Variables the fiction now warrants (you author these, not the narrator).',
        'STEP 2 — Rolls. ONLY when an outcome is genuinely in doubt — even the characters do not know if it will work (a real gamble or contest) — request goal.reach for it; the dice are rolled by code, never by you. Do NOT roll for routine actions a character would simply accomplish. Rolls are rare.',
        'STEP 3 — Reconcile (preserve-and-patch). Output the committed narration. Reproduce the narrator\'s draft WORD FOR WORD, changing ONLY the sentence(s) a roll\'s result contradicts. If nothing was rolled, or nothing contradicts the draft, output the draft UNCHANGED. Never rewrite, rephrase, or restyle any part the dice did not touch.',
        'After the committed narration, on its own lines, emit a state fence recording what happened and any mechanics you changed:',
        '```state',
        '{"requests":[{"id":"r1","capability":"event.record","arguments":{"summary":"what happened"},"reason":"why, one line"}],"flow":{"continue":false}}',
        '```',
        String(narrativeState || '').trim() ? `\nCurrent state:\n${narrativeState}` : '',
        hasMechanics ? `\nMechanical board (Variables and Goals, with their numbers — yours, never shown to the narrator):\n${mechanicsSkill}` : '',
    ].filter(Boolean).join('\n');
    const user = [
        `The narrator's draft of this turn:\n${draft}`,
        String(draftReasoning || '').trim() ? `\nThe narrator's private reasoning:\n${draftReasoning}` : '',
    ].filter(Boolean).join('\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/director-editor.js tests/remodel-director-editor.test.js
git commit -m "feat(remodel): Director-editor prompt (preserve-and-patch + rare rolls)"
```

---

## Task 4: Parse the editor reply (committed prose + state fence)

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/director-editor.js`
- Test: `tests/remodel-director-editor.test.js`

**Interfaces:**
- Produces: `parseEditorReply(raw) → { prose: string, requests: object[] }` — `prose` is everything before the first ```` ```state ```` fence (trimmed); `requests` is that fence's `requests` array (empty on missing/invalid fence).

- [ ] **Step 1: Write the failing test**

```js
import { parseEditorReply } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-editor.js';

test('parseEditorReply splits committed prose from the state fence', () => {
    const raw = [
        'Eli leans in, but Marissa turns her cheek at the last second.',
        '',
        '```state',
        '{"requests":[{"id":"r1","capability":"event.record","arguments":{"summary":"Eli tried to kiss Marissa; she pulled back"},"reason":"seduction roll failed"}],"flow":{"continue":false}}',
        '```',
    ].join('\n');
    const { prose, requests } = parseEditorReply(raw);
    expect(prose).toBe('Eli leans in, but Marissa turns her cheek at the last second.');
    expect(requests).toHaveLength(1);
    expect(requests[0].capability).toBe('event.record');
});

test('parseEditorReply with no fence returns all prose and no requests', () => {
    const { prose, requests } = parseEditorReply('Just prose, nothing rolled.');
    expect(prose).toBe('Just prose, nothing rolled.');
    expect(requests).toEqual([]);
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `parseEditorReply`** in `director-editor.js` (reuse the fence shape from `director-reply.js:84`):

```js
const STATE_FENCE = /```state\s*\n([\s\S]*?)\n?```/i;

/**
 * Split the Director-editor's reply into the committed prose (before the fence)
 * and the recorded state requests (inside the fence). A missing or malformed
 * fence is not an error — the prose is the whole reply and nothing is recorded.
 *
 * @param {string} raw
 * @returns {{ prose: string, requests: object[] }}
 */
export function parseEditorReply(raw) {
    const text = String(raw ?? '');
    const match = text.match(STATE_FENCE);
    const prose = (match ? text.slice(0, match.index) : text).trim();
    let requests = [];
    if (match) {
        try {
            const parsed = JSON.parse(match[1]);
            if (Array.isArray(parsed?.requests)) requests = parsed.requests;
        } catch { requests = []; }
    }
    return { prose, requests };
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/director-editor.js tests/remodel-director-editor.test.js
git commit -m "feat(remodel): parseEditorReply — committed prose + state fence"
```

---

## Task 5: `runDirectorEdit` — execute the editor pass

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js`
- Test: `tests/remodel-director-editor-integration.test.js`

**Interfaces:**
- Consumes: `buildDirectorEditorPrompt`, `parseEditorReply` (Task 3/4); `buildGoalObjectives` (Task 2); `buildNarratorArchivistSections` (shipped); `buildDirectionSources` (shipped, gives `mechanicsSkill` WITH numbers); `executeDirectionRequests` (shipped); `streamChatPrompt` (shipped); the `testAdapters.directorEdit` hook.
- Produces: `runDirectorEdit({ scene, snapshot, draft, draftReasoning }) → { committedProse: string, result: object|null }` — builds the editor prompt, runs the transport (adapter or `streamChatPrompt`), parses, executes the requests against the address book, and returns the committed prose. Never throws; a transport/apply failure returns `{ committedProse: draft, result: null }` (fall back to the draft unchanged).

- [ ] **Step 1: Write the failing integration test**

```js
// tests/remodel-director-editor-integration.test.js
import { test, expect, beforeEach, afterEach } from '@jest/globals';
import {
    initLiveDirection, setLiveDirectionTestAdapters, runDirectorEdit,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { listEvents } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';
import { createVariableValue, getVariableValue, updateMechanicsProfile } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

const scene = { id: 'sc-ed', timelineId: 'tl-ed' };

beforeEach(() => {
    __setExtensionSettings({});
    updateMechanicsProfile({ enabled: true });
    createVariableValue({
        timelineId: 'tl-ed', name: "Marissa's Trust", valueType: 'number', value: 20,
        description: 'how much she trusts Eli', authority: 'world', retrieval: { mode: 'always' },
    });
    initLiveDirection({
        getActiveScene: () => scene, getCast: () => [], getPersona: () => null,
        ensureSceneReady: async () => true, getComposerDraft: () => '', clearComposer: () => {},
        sendNormally: () => {}, onStateChange: () => {}, onSettled: () => {}, onFailure: () => {},
        setNativePromptContent: () => {},
    });
});
afterEach(() => setLiveDirectionTestAdapters(null));

test('runDirectorEdit commits the patched prose and records the state', async () => {
    const committedFence = JSON.stringify({
        requests: [
            { id: 'r1', capability: 'event.record', arguments: { summary: 'Eli tried to kiss Marissa; she pulled back' }, reason: 'roll failed' },
            { id: 'r2', capability: 'variable.adjust', arguments: { variableRef: "Marissa's Trust", delta: -2 }, reason: 'he overstepped' },
        ],
        flow: { continue: false },
    });
    setLiveDirectionTestAdapters({
        directorEdit: async () => ['Eli leans in, but Marissa turns her cheek.', '', '```state', committedFence, '```'].join('\n'),
    });
    const snapshot = await (await import('../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js')).__buildEditorSnapshot(scene);
    const { committedProse } = await runDirectorEdit({ scene, snapshot, draft: 'Eli leans in and Marissa melts into him.', draftReasoning: 'goes for the kiss' });
    expect(committedProse).toBe('Eli leans in, but Marissa turns her cheek.');
    expect(listEvents(scene.timelineId, scene.id).map((e) => e.summary)).toEqual(['Eli tried to kiss Marissa; she pulled back']);
    const v = getVariableValue([...Object.values((await import('../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-store.js')).getVariableStore().timelines['tl-ed'].variables)][0].id, 'tl-ed');
    expect(Number(v.value)).toBe(18);
});
```

Note: the test uses a small exported helper `__buildEditorSnapshot(scene)` (Step 3) to get the mechanics snapshot + address book without the full turn. If a simpler snapshot accessor already fits, use it and drop the helper.

- [ ] **Step 2: Run — expect FAIL** (`runDirectorEdit is not a function`).

- [ ] **Step 3: Implement `runDirectorEdit` + `__buildEditorSnapshot`** in `live-direction.js`. Add imports at the top with the other local imports:

```js
import { isEditorMode, buildDirectorEditorPrompt, parseEditorReply } from './director-editor.js';
import { buildGoalObjectives } from './narrator-prompt.js';
```

Add a thin snapshot accessor (reuse `buildMechanicalSnapshot` from `mechanics-runtime.js`, already imported) and the editor runner near `runArchivistPass`'s sibling area / after `extractStateFromProse`:

```js
// Test/int helper: the mechanics snapshot (advertised Variables/Goals + address
// book) the editor resolves its requests against, without running a full turn.
export async function __buildEditorSnapshot(scene) {
    const mechanics = await buildMechanicalSnapshot(scene, '', [], null, [], {});
    return { mechanics };
}

/**
 * Run the Director-editor pass over the narrator's draft: build the editor
 * prompt (draft + reasoning + readable narrative state + the mechanical board
 * WITH numbers), transport it, parse the committed prose + state fence, and
 * execute the requests against the address book. Returns the committed prose to
 * post. Never throws — a failure falls back to the draft unchanged.
 */
export async function runDirectorEdit({ scene, snapshot, draft, draftReasoning = '', token = null }) {
    const narrativeState = [
        buildNarratorArchivistSections(scene.timelineId, scene.id),
        buildGoalObjectives(scene.id),
    ].filter((part) => String(part || '').trim()).join('\n\n');
    let mechanicsSkill = '';
    if (snapshot?.mechanics && getMechanicsProfile().enabled) {
        try { mechanicsSkill = buildDirectionSources({ mechanics: snapshot.mechanics }, { mechanicsEnabled: true }).mechanicsSkill || ''; } catch { mechanicsSkill = ''; }
    }
    const prompt = buildDirectorEditorPrompt({ draft, draftReasoning, narrativeState, mechanicsSkill });
    let raw = '';
    try {
        if (testAdapters?.directorEdit) {
            raw = String(await testAdapters.directorEdit({ scene, draft, prompt }) || '');
        } else if (testAdapters) {
            return { committedProse: draft, result: null }; // opt-in for tests
        } else {
            const out = await streamChatPrompt({ prompt, signal: token?.controller?.signal });
            raw = String(out?.text || '');
        }
    } catch (error) {
        journal('editor.failed', { phase: 'generate', error: String(error?.message || error) }, { severity: 'warn' });
        return { committedProse: draft, result: null };
    }
    const { prose, requests } = parseEditorReply(raw);
    const committedProse = prose || draft;
    if (!requests.length) return { committedProse, result: null };
    try {
        const result = executeDirectionRequests(requests, {
            scene: { id: scene.id, timelineId: scene.timelineId },
            addressBook: snapshot?.mechanics?.addressBook,
            variableRefs: snapshot?.mechanics?.variableRefs,
            goalRefs: snapshot?.mechanics?.goalRefs,
            authorizedGoalIds: [],
        });
        journal('editor', { requestCount: requests.length, ok: result.ok, patched: committedProse !== draft }, { summary: 'Director-editor committed + recorded' });
        return { committedProse, result };
    } catch (error) {
        journal('editor.failed', { phase: 'apply', error: String(error?.message || error) }, { severity: 'warn' });
        return { committedProse, result: null };
    }
}
```

- [ ] **Step 4: Run — expect PASS** (committed prose is the patched version; event recorded; Trust 20→18).
Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-director-editor-integration`

- [ ] **Step 5: Run the full sweep for no regression.**
Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json "remodel-(direction|director|solo|narrator|archivist|goal|variable|mechanic)"`
Expected: all pass (editor is additive; `director`/`solo` untouched).

- [ ] **Step 6: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js tests/remodel-director-editor-integration.test.js
git commit -m "feat(remodel): runDirectorEdit — editor pass commits patched prose + records state"
```

---

## Task 6: Wire the editor turn (narrator draft hidden → edit → commit)

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js`
- Test: `tests/remodel-director-editor-integration.test.js`

**Interfaces:**
- Consumes: `isEditorMode` (Task 1), `runDirectorEdit` (Task 5), the existing turn machinery (`beginDirection`, performer generation, `finalizeRunMessage`).
- Produces: an editor-mode turn — the narrator's draft is generated but **not** committed as-is; the Director-editor's committed prose is what lands in the message; the narrator draft never shows (hold-then-show).

**Approach:** In editor mode, after the narrator produces its text (the "draft"), do NOT finalize it directly. Instead capture the draft, call `runDirectorEdit`, and write the **committed** prose as the final message. The seam is `finalizeRunMessage` / `completeVisibleRun`: in editor mode, the accepted narrator text is the *draft*, and the committed prose replaces it before `saveChat`.

- [ ] **Step 1: Write the failing adapter-driven turn test**

```js
test('an editor turn posts the Director-committed prose, never the raw draft', async () => {
    // Reuse the solo-lifecycle harness shape: a scene in editor mode, a
    // generatePerformer adapter that pushes the DRAFT, and a directorEdit
    // adapter that returns committed prose + fence. Assert the chat's final
    // message is the committed prose, not the draft.
    // (Full harness: copy beforeEach/afterEach from remodel-solo-lifecycle.test.js,
    //  set scene.liveDirection.mode = 'editor', add the directorEdit adapter.)
    // draft pushed by generatePerformer: 'Eli kisses her and she melts.'
    // directorEdit returns: 'Eli leans in; she turns away.' + a state fence.
    // await requestNextDirection(scene); wait for 'Waiting for you';
    // expect(__getChat().at(-1).mes).toBe('Eli leans in; she turns away.');
});
```

Flesh this out by copying the harness from `tests/remodel-solo-lifecycle.test.js` (its `scene`, `speak`, `until`, `beforeEach`/`afterEach`), setting `mode: 'editor'`, making `speak()` push the DRAFT text, and adding a `directorEdit` adapter returning the committed prose + a fence. Assert the last chat message equals the committed prose.

- [ ] **Step 2: Run — expect FAIL** (the raw draft is posted, not the committed prose).

- [ ] **Step 3: Add the editor branch to the finalize path.** In `completeVisibleRun` (where the accepted prose is finalized), before `finalizeRunMessage`, when `isEditorMode(hooks.getActiveScene())`, run the editor over the accepted draft and swap the committed prose in:

```js
if (isEditorMode(hooks.getActiveScene())) {
    const draft = acceptedProse(run);
    const snapshot = run.editorSnapshot || await __buildEditorSnapshot({ id: run.sceneId, timelineId: run.timelineId });
    const { committedProse } = await runDirectorEdit({
        scene: { id: run.sceneId, timelineId: run.timelineId },
        snapshot, draft, draftReasoning: narratorReasoning(run),
    });
    run.acceptedVisibleText = committedProse; // the committed version is what finalizeRunMessage writes
}
```

Place this immediately before the existing `await finalizeRunMessage(run, { state: 'complete' })` call. `acceptedProse` and `finalizeRunMessage` are existing functions; `narratorReasoning(run)` reads `message.extra.reasoning`.

- [ ] **Step 4: Run — expect PASS** (the committed prose is posted).

- [ ] **Step 5: Run the full sweep — no regression.**
Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json "remodel-(direction|director|solo|narrator|archivist|goal|variable|mechanic)"`

- [ ] **Step 6: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js tests/remodel-director-editor-integration.test.js
git commit -m "feat(remodel): editor turn commits the Director-edited prose (hold-then-show logic)"
```

---

## Task 7 (browser-verified): hold-then-show reveal + a mode toggle option

**Files:** `public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js`, `public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-spine.js`

This task is **live-verified**, not unit-tested — it touches the reveal pipeline and the toolbar.

- [ ] **Reveal suppression.** In editor mode the narrator's draft must not visibly stream/commit before the Director edits it. Task 6 already makes the *final message* correct; this step ensures the *reveal* holds: while the editor pass runs, keep the run in a transient "Editing…" state (reuse the pre-narrator transient label pattern) and only reveal `acceptedVisibleText` after `runDirectorEdit` returns. Verify in the debug Chrome (`dev-tools/launch-debug-chrome.bat`, port 9222) that the draft never appears and only the committed version shows.
- [ ] **Toolbar.** Add `Editor` to the Engine mode control beside `Director`/`Solo` (the control that calls `setLiveDirectionMode`). Verify switching to Editor and running a turn.
- [ ] Commit with message `feat(remodel): editor-mode reveal hold + toolbar option`.

---

## Self-Review

**Spec coverage (design §3–§6):**
- Narrator drafts first, hidden, ephemeral → Task 6 (draft captured, committed prose replaces it; draft never stored). ✅
- Director purely mechanical: creates goals/variables, rolls rare uncertainty (code-rolled), records → Task 3 prompt + Task 5 `executeDirectionRequests`. ✅
- Preserve-and-patch → Task 3 prompt instruction (`verbatim`, `only the beat`), verified present by Task 3 test; fidelity flagged as iteration risk (spec §8). ✅
- Hold-then-show → Task 6 logic (final message is committed) + Task 7 reveal. ✅
- Two views: narrator readable + goals-as-objectives (no numbers) → Task 2; Director mechanical board WITH numbers → Task 3/5 (`mechanicsSkill`). ✅
- Director always runs; nothing-to-change commits the draft → Task 5 (`committedProse = prose || draft`, empty requests path). ✅
- Additive `editor` mode, `director`/`solo` untouched → Task 1 + full-sweep gates in Tasks 5/6. ✅
- Dice code-rolled → `goal.reach` via `executeDirectionRequests`; no `Math.random` in tests. ✅

**Deferred (spec §9, not gaps):** ensemble interaction, scene-close flush, the narrator-rewrites fallback.

**Placeholder scan:** No TBD/TODO. Task 6/7 reference copying the solo-lifecycle harness rather than repeating ~80 lines — the harness is named and the required deltas (mode `editor`, draft-pushing `speak`, `directorEdit` adapter, the one assertion) are spelled out; Task 7 is explicitly browser-verified, not a code placeholder.

**Type consistency:** `isEditorMode(scene)→boolean`, `buildGoalObjectives(sceneId)→string`, `buildDirectorEditorPrompt({draft,draftReasoning,narrativeState,mechanicsSkill})→messages`, `parseEditorReply(raw)→{prose,requests}`, `runDirectorEdit({scene,snapshot,draft,draftReasoning})→{committedProse,result}`, `__buildEditorSnapshot(scene)→{mechanics}` — each defined once and consumed with those exact shapes downstream.
