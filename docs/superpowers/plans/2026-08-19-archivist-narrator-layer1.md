# Archivist Narrator — Layer 1 Implementation Plan (Store + Director Capabilities)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Director a structured narrative-state store (the Archivist) and the capabilities to write to it — scene facts, events, character states, beats, and secrets — as an atomic, undoable part of each direction turn.

**Architecture:** A new `archivist-store.js` holds typed per-timeline/per-scene records, following the exact conventions of `variables-store.js`. The Director writes to it through new capabilities added to the existing `mechanics-capabilities.js` pipeline — same state fence, same `requests` array, same validation, receipts, and atomic snapshot/rollback. Archivist writes join the mechanics transaction so a failed turn rolls them back and `undoMechanicsTransaction` reverses them. This layer is additive: the Narrator is untouched and nothing user-facing changes yet.

**Tech Stack:** Vanilla ES modules (SillyTavern extension), Jest (ESM via `--experimental-vm-modules`), the `tests/util/st-context-stub.js` settings stub.

**Spec:** `docs/superpowers/specs/2026-08-19-archivist-narrator-design.md` (Layer 1 of the three-layer migration). Layers 2–3 are separate follow-on plans — see "Follow-on Plans" at the end.

## Global Constraints

- Store persistence uses the existing settings pattern: namespace `'remodel'`, `getContext().extensionSettings`, `saveSettingsDebounced()`. Do not add new persistence machinery.
- Archivist settings key is `'storyArchivistV1'`, store version `1`. Do not collide with `variables-store.js`'s `'storyVariablesV3'`.
- Archivist records are scoped per timeline **and** per scene. Every store function takes `(timelineId, sceneId, …)`.
- All archivist capabilities use `authorityPolicy` `'hybrid'` (auto-apply). None defer to user review.
- Capability descriptions and `REQUIRED_ARGUMENTS` are the Director's only teaching surface (the handbook is now an editable Prompt Studio block; `describeCapabilities` in `direction-sources.js:475` renders every dictionary entry). Every required argument MUST be named in a capability's `REQUIRED_ARGUMENTS` entry so it renders into the prompt.
- Test run command, from the repo's `tests/` directory:
  `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json <pattern>`
- Node's `Date.now()`/`Math.random()` are fine in production store code (mirrors `variables-store.js`'s `createId`). Do not use them in test assertions.

---

## File Structure

- **Create `public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js`** — the Archivist store. One responsibility: persist and mutate typed narrative-state records per timeline/scene. Exports CRUD + read helpers + snapshot/restore/delete. No imports from `mechanics-capabilities.js` (dependency points the other way).
- **Modify `public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-capabilities.js`** — add archivist capability names, definitions, required-argument tables, JSON-schema argument fields, `applyRequest` handlers, and fold the archivist store into the transaction's snapshot/rollback/undo.
- **Create `tests/remodel-archivist-store.test.js`** — unit tests for the store in isolation.
- **Create `tests/remodel-archivist-capabilities.test.js`** — tests for the capabilities end-to-end through `executeMechanicsRequest`, including prompt-surface rendering and transaction rollback/undo.

---

## Task 1: Archivist store

**Files:**
- Create: `public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js`
- Test: `tests/remodel-archivist-store.test.js`

**Interfaces:**
- Consumes: `getContext` from `../../../st-context.js` (stubbed in tests by `tests/util/st-context-stub.js`, seeded with `__setExtensionSettings`).
- Produces (all consumed by Task 2 and Task 3):
  - `setSceneFact(timelineId, sceneId, key, value, { establishedMsgId }) → { before, after }`
  - `clearSceneFact(timelineId, sceneId, key) → beforeRecord | null`
  - `listSceneFacts(timelineId, sceneId) → Array<{ key, value, establishedMsgId }>`
  - `recordEvent(timelineId, sceneId, summary, { msgId, turnIndex }) → { id, summary, msgId, turnIndex, seq }`
  - `listEvents(timelineId, sceneId) → Array<event>` (ascending `seq`)
  - `setCharStateFacet(timelineId, sceneId, charId, facet, value) → { before, after }`
  - `clearCharStateFacet(timelineId, sceneId, charId, facet) → beforeRecord | null`
  - `listCharStates(timelineId, sceneId) → Array<{ charId, facets }>`
  - `setBeat(timelineId, sceneId, directive, tone) → { before, after }`
  - `getBeat(timelineId, sceneId) → { directive, tone } | null`
  - `setSecret(timelineId, sceneId, key, value) → { before, after }`
  - `clearSecret(timelineId, sceneId, key) → beforeRecord | null`
  - `listSecrets(timelineId, sceneId) → Array<{ key, value }>`
  - `snapshotArchivistStore() → clonedStore`
  - `restoreArchivistStore(snapshot, { save }) → store`
  - `deleteArchivistForTimeline(timelineId) → void`

- [ ] **Step 1: Write the failing test**

Create `tests/remodel-archivist-store.test.js`:

```js
import { __setExtensionSettings } from './util/st-context-stub.js';
import {
    setSceneFact, clearSceneFact, listSceneFacts,
    recordEvent, listEvents,
    setCharStateFacet, clearCharStateFacet, listCharStates,
    setBeat, getBeat,
    setSecret, clearSecret, listSecrets,
    snapshotArchivistStore, restoreArchivistStore, deleteArchivistForTimeline,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';

const T = 'tl-1';
const S = 'sc-1';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('scene facts overwrite in place and clear', () => {
    setSceneFact(T, S, 'location', 'rooftop');
    setSceneFact(T, S, 'location', 'alley');
    expect(listSceneFacts(T, S)).toEqual([{ key: 'location', value: 'alley', establishedMsgId: null }]);
    clearSceneFact(T, S, 'location');
    expect(listSceneFacts(T, S)).toEqual([]);
});

test('events append in seq order', () => {
    recordEvent(T, S, 'Marcus drew his knife');
    recordEvent(T, S, 'Rain began to fall');
    const events = listEvents(T, S);
    expect(events.map((e) => e.summary)).toEqual(['Marcus drew his knife', 'Rain began to fall']);
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
});

test('char state facets overwrite; clearing the last facet drops the record', () => {
    setCharStateFacet(T, S, 'marcus', 'mood', 'calm');
    setCharStateFacet(T, S, 'marcus', 'mood', 'desperate');
    setCharStateFacet(T, S, 'marcus', 'injury', 'cut left arm');
    expect(listCharStates(T, S)).toEqual([{ charId: 'marcus', facets: { mood: 'desperate', injury: 'cut left arm' } }]);
    clearCharStateFacet(T, S, 'marcus', 'injury');
    expect(listCharStates(T, S)).toEqual([{ charId: 'marcus', facets: { mood: 'desperate' } }]);
    clearCharStateFacet(T, S, 'marcus', 'mood');
    expect(listCharStates(T, S)).toEqual([]);
});

test('beat is a singleton the latest set replaces', () => {
    setBeat(T, S, 'Marcus hesitates', 'tense');
    setBeat(T, S, 'Marcus lunges', 'violent');
    expect(getBeat(T, S)).toEqual({ directive: 'Marcus lunges', tone: 'violent' });
});

test('secrets store and clear', () => {
    setSecret(T, S, 'betrayer', 'Marcus works for the guild');
    expect(listSecrets(T, S)).toEqual([{ key: 'betrayer', value: 'Marcus works for the guild' }]);
    clearSecret(T, S, 'betrayer');
    expect(listSecrets(T, S)).toEqual([]);
});

test('records are isolated per timeline and scene', () => {
    setSceneFact(T, S, 'location', 'rooftop');
    setSceneFact(T, 'sc-2', 'location', 'cellar');
    setSceneFact('tl-2', S, 'location', 'ship');
    expect(listSceneFacts(T, S)[0].value).toBe('rooftop');
    expect(listSceneFacts(T, 'sc-2')[0].value).toBe('cellar');
    expect(listSceneFacts('tl-2', S)[0].value).toBe('ship');
});

test('snapshot/restore round-trips and deleteForTimeline removes a timeline', () => {
    setSceneFact(T, S, 'location', 'rooftop');
    const snap = snapshotArchivistStore();
    setSceneFact(T, S, 'location', 'alley');
    restoreArchivistStore(snap, { save: false });
    expect(listSceneFacts(T, S)[0].value).toBe('rooftop');
    deleteArchivistForTimeline(T);
    expect(listSceneFacts(T, S)).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-archivist-store` (from `tests/`)
Expected: FAIL — `Cannot find module '.../archivist-store.js'`.

- [ ] **Step 3: Write the store**

Create `public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js`:

```js
import { getContext } from '../../../st-context.js';

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'storyArchivistV1';
const STORE_VERSION = 1;
const MAX_EVENTS = 400;

function clone(value) { return value == null ? value : structuredClone(value); }
function createId(prefix) { return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`; }
function emptyStore() { return { version: STORE_VERSION, timelines: {} }; }

export function getArchivistStore() {
    const context = getContext();
    context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
    const namespace = context.extensionSettings[SETTINGS_NAMESPACE];
    const current = namespace[SETTINGS_KEY];
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
        namespace[SETTINGS_KEY] = emptyStore();
        context.saveSettingsDebounced();
    }
    const store = namespace[SETTINGS_KEY];
    if (!store.timelines || typeof store.timelines !== 'object') store.timelines = {};
    return store;
}

export function saveArchivistStore() { getContext().saveSettingsDebounced(); }

function sceneBucket(store, timelineId, sceneId) {
    const tId = String(timelineId || '');
    const sId = String(sceneId || '');
    const timeline = (store.timelines[tId] ??= { timelineId: tId, scenes: {} });
    if (!timeline.scenes || typeof timeline.scenes !== 'object') timeline.scenes = {};
    const scene = (timeline.scenes[sId] ??= { sceneId: sId, facts: {}, events: [], charStates: {}, beat: null, secrets: {}, eventSeq: 0 });
    scene.facts ??= {};
    scene.events ??= [];
    scene.charStates ??= {};
    scene.secrets ??= {};
    if (typeof scene.eventSeq !== 'number') scene.eventSeq = scene.events.length;
    return scene;
}

export function getSceneFact(timelineId, sceneId, key) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    return scene.facts[String(key)] ? clone(scene.facts[String(key)]) : null;
}

export function setSceneFact(timelineId, sceneId, key, value, { establishedMsgId = null } = {}) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    const k = String(key);
    const before = scene.facts[k] ? clone(scene.facts[k]) : null;
    scene.facts[k] = { key: k, value, establishedMsgId: establishedMsgId == null ? null : Number(establishedMsgId) };
    saveArchivistStore();
    return { before, after: clone(scene.facts[k]) };
}

export function clearSceneFact(timelineId, sceneId, key) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    const k = String(key);
    const before = scene.facts[k] ? clone(scene.facts[k]) : null;
    if (before) { delete scene.facts[k]; saveArchivistStore(); }
    return before;
}

export function listSceneFacts(timelineId, sceneId) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    return Object.values(scene.facts).map(clone);
}

export function recordEvent(timelineId, sceneId, summary, { msgId = null, turnIndex = null } = {}) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    const event = {
        id: createId('evt'),
        summary: String(summary || ''),
        msgId: msgId == null ? null : Number(msgId),
        turnIndex: turnIndex == null ? null : Number(turnIndex),
        seq: scene.eventSeq++,
    };
    scene.events.push(event);
    if (scene.events.length > MAX_EVENTS) scene.events.splice(0, scene.events.length - MAX_EVENTS);
    saveArchivistStore();
    return clone(event);
}

export function listEvents(timelineId, sceneId) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    return scene.events.slice().sort((a, b) => a.seq - b.seq).map(clone);
}

export function setCharStateFacet(timelineId, sceneId, charId, facet, value) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    const id = String(charId);
    const record = (scene.charStates[id] ??= { charId: id, facets: {} });
    const before = clone(record);
    record.facets[String(facet)] = value;
    saveArchivistStore();
    return { before, after: clone(record) };
}

export function clearCharStateFacet(timelineId, sceneId, charId, facet) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    const id = String(charId);
    const record = scene.charStates[id];
    if (!record || !(String(facet) in record.facets)) return null;
    const before = clone(record);
    delete record.facets[String(facet)];
    if (!Object.keys(record.facets).length) delete scene.charStates[id];
    saveArchivistStore();
    return before;
}

export function listCharStates(timelineId, sceneId) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    return Object.values(scene.charStates).map(clone);
}

export function setBeat(timelineId, sceneId, directive, tone = '') {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    const before = scene.beat ? clone(scene.beat) : null;
    scene.beat = { directive: String(directive || ''), tone: String(tone || '') };
    saveArchivistStore();
    return { before, after: clone(scene.beat) };
}

export function getBeat(timelineId, sceneId) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    return scene.beat ? clone(scene.beat) : null;
}

export function setSecret(timelineId, sceneId, key, value) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    const k = String(key);
    const before = scene.secrets[k] ? clone(scene.secrets[k]) : null;
    scene.secrets[k] = { key: k, value };
    saveArchivistStore();
    return { before, after: clone(scene.secrets[k]) };
}

export function clearSecret(timelineId, sceneId, key) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    const k = String(key);
    const before = scene.secrets[k] ? clone(scene.secrets[k]) : null;
    if (before) { delete scene.secrets[k]; saveArchivistStore(); }
    return before;
}

export function listSecrets(timelineId, sceneId) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    return Object.values(scene.secrets).map(clone);
}

export function snapshotArchivistStore() { return clone(getArchivistStore()); }

export function restoreArchivistStore(snapshot, { save = true } = {}) {
    const context = getContext();
    context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
    context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY] = clone(snapshot) || emptyStore();
    if (save) context.saveSettingsDebounced();
    return context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY];
}

export function deleteArchivistForTimeline(timelineId) {
    const store = getArchivistStore();
    if (store.timelines[String(timelineId)]) {
        delete store.timelines[String(timelineId)];
        saveArchivistStore();
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-archivist-store` (from `tests/`)
Expected: PASS — 7 tests.

- [ ] **Step 5: Mutation check (per project habit)**

Temporarily break `setBeat` to not overwrite (e.g. `if (!scene.beat) scene.beat = …`). Re-run the test. Expected: the "beat is a singleton" test goes RED. Revert the break, confirm GREEN. This proves the test actually constrains the behaviour.

- [ ] **Step 6: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js tests/remodel-archivist-store.test.js
git commit -m "feat(remodel): archivist store for structured narrative state"
```

---

## Task 2: Archivist capabilities in the mechanics pipeline

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-capabilities.js`
  - Imports block (after the `./story-goals-model.js` import at line 30)
  - `CAPABILITY_NAMES` (lines 34–38)
  - `CAPABILITIES` (ends before `});` around line 53)
  - `applyRequest` switch (before `default:` at line 300) + new handler functions
  - arguments JSON schema `properties` (within lines 116–171)
  - `REQUIRED_ARGUMENTS` (ends before `});` around line 623)
- Test: `tests/remodel-archivist-capabilities.test.js`

**Interfaces:**
- Consumes from Task 1: all `set*/clear*/record*/list*/get*` store functions.
- Produces (consumed by Task 3's tests and by production `direction-sources.js`): the eight capabilities `scene.set`, `scene.clear`, `event.record`, `char_state.set`, `char_state.clear`, `beat.set`, `secret.set`, `secret.clear`, each advertised via `getCapabilityDictionary()` and executable via `executeMechanicsRequest`.

- [ ] **Step 1: Write the failing test**

Create `tests/remodel-archivist-capabilities.test.js`:

```js
import {
    MECHANICS_PROTOCOL,
    executeMechanicsRequest,
    getCapabilityDictionary,
    REQUIRED_ARGUMENTS,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-capabilities.js';
import { buildDirectionSources } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-sources.js';
import {
    listSceneFacts, listEvents, listCharStates, getBeat, listSecrets,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

const T = 'tl-arch';
const S = 'sc-arch';
const ARCHIVIST_VERBS = ['scene.set', 'scene.clear', 'event.record', 'char_state.set', 'char_state.clear', 'beat.set', 'secret.set', 'secret.clear'];

beforeEach(() => __setExtensionSettings({ remodel: {} }));

function run(requests) {
    return executeMechanicsRequest(
        { protocol: MECHANICS_PROTOCOL, requests },
        { timelineId: T, sceneId: S, variableRefs: new Map(), goalRefs: new Map() },
    );
}
function req(capability, args, id = 'r1') {
    return { id, capability, arguments: args, reason: 'because the scene demands it' };
}

test('the dictionary advertises every archivist verb', () => {
    const names = getCapabilityDictionary().map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(ARCHIVIST_VERBS));
});

test('a batch of archivist requests applies to the store', () => {
    const result = run([
        req('scene.set', { key: 'location', value: 'rooftop' }, 'a'),
        req('event.record', { summary: 'Marcus drew his knife' }, 'b'),
        req('char_state.set', { charId: 'marcus', facet: 'mood', value: 'desperate' }, 'c'),
        req('beat.set', { directive: 'Marcus lunges', tone: 'tense' }, 'd'),
        req('secret.set', { key: 'betrayer', value: 'guild plant' }, 'e'),
    ]);
    expect(result.ok).toBe(true);
    expect(listSceneFacts(T, S)[0]).toMatchObject({ key: 'location', value: 'rooftop' });
    expect(listEvents(T, S).map((e) => e.summary)).toEqual(['Marcus drew his knife']);
    expect(listCharStates(T, S)[0].facets.mood).toBe('desperate');
    expect(getBeat(T, S)).toEqual({ directive: 'Marcus lunges', tone: 'tense' });
    expect(listSecrets(T, S)[0]).toEqual({ key: 'betrayer', value: 'guild plant' });
});

test('a missing required argument is refused, naming the argument', () => {
    const result = run([req('scene.set', { value: 'rooftop' })]); // no key
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('key');
    expect(listSceneFacts(T, S)).toEqual([]);
});

test('every archivist required argument is named in the Director prompt', () => {
    const { mechanicsSkill } = buildDirectionSources(
        { mechanics: { capabilities: getCapabilityDictionary(), goals: [], serializedVariables: '', retrieval: {} } },
        { mechanicsEnabled: true },
    );
    for (const cap of ARCHIVIST_VERBS) {
        for (const [key] of REQUIRED_ARGUMENTS[cap]) {
            expect(`${cap} names ${key}: ${mechanicsSkill.includes(key)}`).toBe(`${cap} names ${key}: true`);
        }
    }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-archivist-capabilities` (from `tests/`)
Expected: FAIL — the dictionary does not contain the archivist verbs; `executeMechanicsRequest` throws "Unsupported capability scene.set".

- [ ] **Step 3: Add the import**

In `mechanics-capabilities.js`, immediately after the `import { STORY_GOAL_STATUSES, STORY_GOAL_VISIBILITIES } from './story-goals-model.js';` line (line 30), add:

```js
import {
    setSceneFact,
    clearSceneFact,
    recordEvent,
    setCharStateFacet,
    clearCharStateFacet,
    setBeat,
    setSecret,
    clearSecret,
} from './archivist-store.js';
```

- [ ] **Step 4: Extend `CAPABILITY_NAMES`**

Change the frozen array (lines 34–38) to append an archivist row before the closing `]`:

```js
const CAPABILITY_NAMES = Object.freeze([
    'goal.create', 'goal.edit', 'goal.delete', 'goal.reach', 'goal.relate',
    'variable.create', 'variable.set', 'variable.adjust', 'variable.transition', 'variable.subvalue.set',
    'modifier.add', 'modifier.remove',
    'scene.set', 'scene.clear', 'event.record', 'char_state.set', 'char_state.clear', 'beat.set', 'secret.set', 'secret.clear',
]);
```

- [ ] **Step 5: Add the `CAPABILITIES` entries**

Inside the `CAPABILITIES` object, after the `'modifier.remove': …` line and before the closing `});`, add:

```js
    'scene.set': capability('Record or update a scene fact the Narrator treats as given — location, time of day, weather, atmosphere. Overwriting the same key replaces it.', ['narrative'], 'hybrid'),
    'scene.clear': capability('Remove a scene fact that no longer holds.', ['narrative'], 'hybrid'),
    'event.record': capability('Append one thing that has just happened to the permanent event log. Append-only — the Narrator reads this as "already written, do not restate".', ['narrative'], 'hybrid'),
    'char_state.set': capability("Set one facet of a character's current state — mood, injury, stance. Overwrites that facet.", ['narrative'], 'hybrid'),
    'char_state.clear': capability("Remove one facet of a character's current state that no longer applies.", ['narrative'], 'hybrid'),
    'beat.set': capability("Set the current beat — what should happen next. Replaces the previous beat. This is the Narrator's forward instruction.", ['narrative'], 'hybrid'),
    'secret.set': capability('Store knowledge the Narrator must not see — a twist or hidden motive. Overwriting the same key replaces it.', ['narrative'], 'hybrid'),
    'secret.clear': capability('Remove a secret, e.g. once it has been revealed.', ['narrative'], 'hybrid'),
```

- [ ] **Step 6: Add the JSON-schema argument fields**

Inside the arguments schema `properties` object (the block spanning roughly lines 116–171, ending at `endingCondition`), add these fields (the `value` field already exists and is reused for `scene.set`/`char_state.set`/`secret.set`):

```js
                                    key: { type: 'string', description: 'scene.set / scene.clear / secret.set / secret.clear: the fact or secret name — the stable key you address it by.' },
                                    summary: { type: 'string', description: 'event.record only: what just happened, one line. Appended to the permanent log the Narrator reads as already-written.' },
                                    charId: { type: 'string', description: 'char_state.set / char_state.clear: which character, by cast name.' },
                                    facet: { type: 'string', description: 'char_state.set / char_state.clear: which facet of the character\'s current state, e.g. "mood", "injury", "stance".' },
                                    directive: { type: 'string', description: 'beat.set only: what should happen next — the Narrator\'s forward instruction.' },
                                    tone: { type: 'string', description: 'beat.set only, optional: the emotional register of the next beat, e.g. "tense", "tender".' },
```

- [ ] **Step 7: Add the `REQUIRED_ARGUMENTS` entries**

Inside `REQUIRED_ARGUMENTS` (ends before `});` around line 623), after the `'modifier.remove': …` line, add:

```js
    'scene.set': Object.freeze([['key', 'the fact name, e.g. "location"'], ['value', 'the fact itself, e.g. "rain-soaked rooftop"']]),
    'scene.clear': Object.freeze([['key', 'the fact name to remove']]),
    'event.record': Object.freeze([['summary', 'what just happened, one line']]),
    'char_state.set': Object.freeze([['charId', 'the character, by cast name'], ['facet', 'which facet, e.g. "mood"'], ['value', 'the new value, e.g. "desperate"']]),
    'char_state.clear': Object.freeze([['charId', 'the character, by cast name'], ['facet', 'which facet to remove']]),
    'beat.set': Object.freeze([['directive', 'what should happen next, one or two lines']]),
    'secret.set': Object.freeze([['key', 'the secret name'], ['value', 'the secret itself']]),
    'secret.clear': Object.freeze([['key', 'the secret name to remove']]),
```

Note: `beat.set`'s `tone` is optional, so it is deliberately not listed here.

- [ ] **Step 8: Add the `applyRequest` cases and handlers**

In `applyRequest` (line 285), add these cases immediately before `default:` (line 300):

```js
        case 'scene.set': return applySceneSet(request, args, runtime);
        case 'scene.clear': return applySceneClear(request, args, runtime);
        case 'event.record': return applyEventRecord(request, args, runtime);
        case 'char_state.set': return applyCharStateSet(request, args, runtime);
        case 'char_state.clear': return applyCharStateClear(request, args, runtime);
        case 'beat.set': return applyBeatSet(request, args, runtime);
        case 'secret.set': return applySecretSet(request, args, runtime);
        case 'secret.clear': return applySecretClear(request, args, runtime);
```

Then add the handler functions immediately after `applyRequest`'s closing brace (after line 302), reusing the existing `receipt(runtime, request, before, after)` helper:

```js
function applySceneSet(request, args, runtime) {
    const { before, after } = setSceneFact(runtime.timelineId, runtime.sceneId, args.key, args.value, { establishedMsgId: runtime.messageId });
    return receipt(runtime, request, before, after);
}
function applySceneClear(request, args, runtime) {
    return receipt(runtime, request, clearSceneFact(runtime.timelineId, runtime.sceneId, args.key), null);
}
function applyEventRecord(request, args, runtime) {
    return receipt(runtime, request, null, recordEvent(runtime.timelineId, runtime.sceneId, args.summary, { msgId: runtime.messageId, turnIndex: null }));
}
function applyCharStateSet(request, args, runtime) {
    const { before, after } = setCharStateFacet(runtime.timelineId, runtime.sceneId, args.charId, args.facet, args.value);
    return receipt(runtime, request, before, after);
}
function applyCharStateClear(request, args, runtime) {
    return receipt(runtime, request, clearCharStateFacet(runtime.timelineId, runtime.sceneId, args.charId, args.facet), null);
}
function applyBeatSet(request, args, runtime) {
    const { before, after } = setBeat(runtime.timelineId, runtime.sceneId, args.directive, args.tone || '');
    return receipt(runtime, request, before, after);
}
function applySecretSet(request, args, runtime) {
    const { before, after } = setSecret(runtime.timelineId, runtime.sceneId, args.key, args.value);
    return receipt(runtime, request, before, after);
}
function applySecretClear(request, args, runtime) {
    return receipt(runtime, request, clearSecret(runtime.timelineId, runtime.sceneId, args.key), null);
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-archivist-capabilities` (from `tests/`)
Expected: PASS — 4 tests.

- [ ] **Step 10: Run the existing capability-arguments test for no regression**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-capability-arguments` (from `tests/`)
Expected: PASS — the shared-table invariant (validator and prompt agree) now covers the archivist verbs too.

- [ ] **Step 11: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-capabilities.js tests/remodel-archivist-capabilities.test.js
git commit -m "feat(remodel): Director capabilities for archivist narrative state"
```

---

## Task 3: Archivist writes join the transaction's atomic undo

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-capabilities.js`
  - Imports block (the `./archivist-store.js` import added in Task 2)
  - `executeMechanicsRequest` snapshot (lines 180–181), undo record (line 235), catch restore (lines 239–240)
  - `undoMechanicsTransaction` (line 277)
- Test: extend `tests/remodel-archivist-capabilities.test.js`

**Interfaces:**
- Consumes from Task 1: `snapshotArchivistStore`, `restoreArchivistStore`.
- Produces: archivist state is captured in `transaction.undo.archivist`; a rolled-back or explicitly undone transaction reverses archivist writes alongside variables and goals.

- [ ] **Step 1: Write the failing tests**

Append to `tests/remodel-archivist-capabilities.test.js`:

```js
import { undoMechanicsTransaction } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-capabilities.js';

test('a failed batch rolls back archivist writes', () => {
    // scene.set applies, then variable.set on an unadvertised ref throws and
    // rolls the whole transaction back — the scene fact must not survive.
    const result = run([
        req('scene.set', { key: 'location', value: 'rooftop' }, 'a'),
        req('variable.set', { variableRef: 'Ghost', value: 5 }, 'b'),
    ]);
    expect(result.ok).toBe(false);
    expect(listSceneFacts(T, S)).toEqual([]);
});

test('undoing a transaction restores the prior archivist state', () => {
    run([req('scene.set', { key: 'location', value: 'rooftop' }, 'a')]);
    const second = run([req('scene.set', { key: 'location', value: 'alley' }, 'b')]);
    expect(listSceneFacts(T, S)[0].value).toBe('alley');
    expect(undoMechanicsTransaction(second.transaction)).toBe(true);
    expect(listSceneFacts(T, S)[0].value).toBe('rooftop');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-archivist-capabilities` (from `tests/`)
Expected: FAIL — "a failed batch rolls back archivist writes" finds the scene fact still present (rollback does not yet include the archivist); the undo test finds `alley` (undo does not yet restore the archivist).

- [ ] **Step 3: Update the import to add snapshot/restore**

In the `./archivist-store.js` import block (added in Task 2), add `snapshotArchivistStore` and `restoreArchivistStore` to the named imports.

- [ ] **Step 4: Snapshot the archivist at transaction start**

After line 181 (`const goalSnapshot = snapshotStoryGoalsStore();`), add:

```js
    const archivistSnapshot = snapshotArchivistStore();
```

- [ ] **Step 5: Record the archivist snapshot in the transaction's undo**

Change the undo object (line 235) from:

```js
            undo: { variables: variableSnapshot, goals: goalSnapshot },
```

to:

```js
            undo: { variables: variableSnapshot, goals: goalSnapshot, archivist: archivistSnapshot },
```

- [ ] **Step 6: Restore the archivist on rollback**

In the `catch` block, after line 240 (`restoreStoryGoalsStore(goalSnapshot, { save: false });`), add:

```js
        restoreArchivistStore(archivistSnapshot, { save: false });
```

- [ ] **Step 7: Restore the archivist in `undoMechanicsTransaction`**

`undoMechanicsTransaction` (line 277) guards on `transaction.undo.variables`/`goals`, then restores both. After the `restoreStoryGoalsStore(transaction.undo.goals, { save: false });` line inside that function, add a back-compatible restore (old transactions predating this field simply skip it):

```js
    if (transaction.undo.archivist) restoreArchivistStore(transaction.undo.archivist, { save: false });
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-archivist-capabilities` (from `tests/`)
Expected: PASS — all 6 tests.

- [ ] **Step 9: Run the mechanics/goal suites for no regression**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json "remodel-(goal|mechanics|variable|story-goals)"` (from `tests/`)
Expected: PASS — the undo-record shape change (`archivist` added) does not disturb existing variable/goal undo, which still reads `undo.variables`/`undo.goals`.

- [ ] **Step 10: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-capabilities.js tests/remodel-archivist-capabilities.test.js
git commit -m "feat(remodel): fold archivist writes into mechanics transaction undo"
```

---

## Self-Review

**Spec coverage (Layer 1 scope):**
- Archivist store with `scene_fact`, `event`, `char_state`, `beat`, `secret` records → Task 1. ✅ (Spec "Component 1".)
- Store follows `variables-store.js` conventions, per-timeline keying, snapshot/restore, `deleteArchivistForTimeline` → Task 1. ✅
- Events append-only; char_state holds current facets; beat singleton; secrets held separately → Task 1 tests assert each. ✅
- Director capabilities `scene.set/clear`, `event.record`, `char_state.set/clear`, `beat.set`, `secret.set/clear`, all `hybrid`, added to `CAPABILITY_NAMES`/`CAPABILITIES`/`REQUIRED_ARGUMENTS`, slotting into the same state fence → Task 2. ✅ (Spec "Component 2".)
- Capabilities render into the Director's prompt via the existing dictionary → Task 2 Step 1's prompt-surface test. ✅
- Director's whole turn is one atomic, undoable transaction including archivist writes → Task 3. ✅ (Spec data-flow step 2; risk row "hybrid auto-apply".)
- Secret-holding boundary (Narrator filtered) → the `secret` record type exists here (Task 1/2); the *filtering* happens in the Narrator compile, which is Layer 2. In scope for Layer 1: secrets are stored distinctly from Narrator-visible records. ✅

**Deferred to follow-on plans (not gaps):** custom Narrator generation path, archivist→Narrator formatter, `compileNarratorPrompt`, notebook removal, reasoning-bridge storage relocation. See below.

**Placeholder scan:** No TBD/TODO. Every code step contains full code; every test step contains full assertions; every run step names the exact command and expected result. ✅

**Type consistency:** Store function names and signatures in Task 1's "Produces" are used verbatim in Task 2's handlers and Task 3's imports (`setSceneFact`, `clearSceneFact`, `recordEvent`, `setCharStateFacet`, `clearCharStateFacet`, `setBeat`, `setSecret`, `clearSecret`, `snapshotArchivistStore`, `restoreArchivistStore`). `setSceneFact`/`setCharStateFacet`/`setBeat`/`setSecret` return `{ before, after }`; the handlers destructure exactly that. `clear*`/`recordEvent` return a single record; the handlers pass it as the single `before`/`after` argument to `receipt`. Consistent. ✅

---

## Follow-on Plans (out of scope for this plan)

Layer 1 ships independently: the Director records structured narrative state, fully unit-tested, with the Narrator unchanged and no user-facing behaviour change. The remaining spec layers are their own plans because they carry materially different risk and testability:

- **Layer 2 — Custom Narrator generation path.** Replaces native `generateDirectedPerformer` (`context.generate()` / `generateGroupWrapper`) with `compileNarratorPrompt` + `streamChatPrompt`, and builds the archivist→Narrator formatter (secrets filtered), the voice window, the beat, and the framed reasoning bridge. This rewrites the live generation core the reveal/pacing/interruption pipeline (`activeRun`, `scheduleReveal`, message insertion) is built on — it is integration-heavy and largely browser-verified rather than unit-tested. **It warrants its own investigation pass** (how `activeRun` buffers are populated during streaming, how a message is created and streamed into, how interruption hooks attach) before its tasks can be written without placeholders.
- **Layer 3 — Notebook removal.** Retires `director-notes-store.js` and the notebook-reading paths once Layer 2 is stable, and relocates the reasoning-bridge's per-turn storage off the notebook onto the archivist. Pure cleanup, gated on Layer 2.

Recommended sequence: ship Layer 1 → brainstorm/investigate Layer 2 → plan and ship Layer 2 → plan and ship Layer 3.
