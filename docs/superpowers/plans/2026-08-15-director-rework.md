# Director Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Director's prompt out of hardcoded JavaScript into an editable Prompt Studio recipe, free the performing character from emitting protocol markers, and address Goals and Variables by their real names.

**Architecture:** Roleplay gains two prompt modes — `director` (compiled to an explicit message array for the raw call) and `narrator` (today's Roleplay recipe, relabelled, still mirrored into SillyTavern's native Prompt Manager). One resolver guarantees a Director recipe never reaches native. The Director returns free instruction prose plus a small structured tail; the Narrator writes clean prose and pacing beats are derived from that text in code.

**Tech Stack:** Vanilla ES modules, no build step. Jest with `--experimental-vm-modules` for tests (`tests/`, run from that directory). SillyTavern core is consumed through `st-context.js`, which is mapped to `tests/util/st-context-stub.js` under test.

**Spec:** `docs/superpowers/specs/2026-08-15-director-rework-design.md`

## Global Constraints

- All product changes live inside `public/scripts/extensions/third-party/SillyTavern-Remodel/`. No core SillyTavern source, server endpoint, or native World Info schema changes.
- Pure logic goes in modules that do **not** import `st-context.js`, so it stays testable offline. `variables-lore-key.js` is the precedent.
- Jest runs from `tests/`: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json <pattern>`.
- `node --check` does NOT reliably catch syntax errors in this ES-module codebase. Use `node --input-type=module --check < file.js`.
- Every commit must leave `git diff --check` clean and CSS braces balanced if `style.css` was touched.
- Director recipes are Chat Completion only. `apiType` is always `'chat'`.
- Existing protocol string `remodel-direction/1` (`DIRECTION_PROTOCOL`) is unchanged.
- Marker parsing in `live-direction-markers.js` stays — reload recovery and old saved messages still contain markers. Only the *instruction to emit them* is removed.

---

### Task 1: Derive pacing beats from finished prose

**Files:**
- Create: `public/scripts/extensions/third-party/SillyTavern-Remodel/direction-beats.js`
- Test: `tests/remodel-direction-beats.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `deriveBeats(text: string): Array<{ offset: number, kind: 'breath' | 'opening' }>` — offsets are character indexes into `text`, ascending, each `<= text.length`. `breath` marks a readable pause; `opening` marks a stronger boundary where the user could interject.

- [ ] **Step 1: Write the failing test**

```js
// tests/remodel-direction-beats.test.js
import { deriveBeats } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-beats.js';

const kinds = (text) => deriveBeats(text).map((beat) => beat.kind);
const offsets = (text) => deriveBeats(text).map((beat) => beat.offset);

test('a breath follows each sentence terminator', () => {
    const text = 'He stopped. She waited.';
    expect(offsets(text)).toEqual([12, 23]);
    expect(kinds(text)).toEqual(['breath', 'breath']);
});

test('a paragraph break is an opening, not a breath', () => {
    const text = 'He stopped.\n\nShe waited.';
    const beats = deriveBeats(text);
    expect(beats.some((beat) => beat.kind === 'opening')).toBe(true);
});

test('abbreviations do not create a beat', () => {
    expect(deriveBeats('Dr. Veyr waited.')).toHaveLength(1);
});

test('an ellipsis is one beat, not three', () => {
    expect(deriveBeats('He hesitated... then moved.')).toHaveLength(2);
});

test('dialogue closing punctuation carries the beat past the quote', () => {
    const text = '"Stop," she said. He did.';
    expect(offsets(text)).toEqual([17, 25]);
});

test('offsets never exceed the text length and always ascend', () => {
    const text = 'One. Two! Three? Four.';
    const list = offsets(text);
    expect(Math.max(...list)).toBeLessThanOrEqual(text.length);
    expect([...list].sort((a, b) => a - b)).toEqual(list);
});

test('text with no terminator yields no beats', () => {
    expect(deriveBeats('a fragment with no end')).toEqual([]);
});

test('empty input is safe', () => {
    expect(deriveBeats('')).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tests && node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-direction-beats`
Expected: FAIL — cannot find module `direction-beats.js`

- [ ] **Step 3: Write the implementation**

```js
// public/scripts/extensions/third-party/SillyTavern-Remodel/direction-beats.js

// Pacing beats, derived from finished prose.
//
// The Narrator used to be told to type [[RM:BREATH]] itself, which made the
// scene's rhythm depend on a creative model emitting machine tokens well in a
// format whose effect it could not observe. Reading the text afterwards is
// deterministic, costs the model nothing, and can be tuned without re-prompting.
//
// PURE — no context, no DOM — so it is testable offline.

/** Abbreviations whose full stop does not end a sentence. */
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'sgt', 'lt', 'prof', 'vs', 'etc', 'no']);

/** Closing punctuation that a beat should sit after: quotes and brackets. */
const TRAILING = new Set(['"', "'", '”', '’', ')', ']', '»']);

/**
 * @param {string} source finished prose, markers already stripped
 * @returns {Array<{offset: number, kind: 'breath'|'opening'}>}
 */
export function deriveBeats(source) {
    const text = String(source ?? '');
    if (!text.trim()) return [];
    const beats = [];
    const seen = new Set();
    const push = (offset, kind) => {
        const at = Math.min(Math.max(0, offset), text.length);
        if (seen.has(at)) return;
        seen.add(at);
        beats.push({ offset: at, kind });
    };

    // Paragraph breaks are the strongest boundary the prose offers, so they
    // become openings — the moments where stepping in reads as natural.
    for (const match of text.matchAll(/\n[ \t]*\n/g)) {
        push(match.index, 'opening');
    }

    for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (character !== '.' && character !== '!' && character !== '?') continue;
        // Consume a run so "..." and "?!" are one beat rather than three.
        let end = index;
        while (end + 1 < text.length && '.!?'.includes(text[end + 1])) end++;
        if (isAbbreviation(text, index)) { index = end; continue; }
        // Carry past a closing quote or bracket so the beat lands after it.
        while (end + 1 < text.length && TRAILING.has(text[end + 1])) end++;
        push(end + 1, 'breath');
        index = end;
    }

    return beats.sort((left, right) => left.offset - right.offset);
}

/** True when the full stop at `index` closes a known abbreviation. */
function isAbbreviation(text, index) {
    if (text[index] !== '.') return false;
    let start = index - 1;
    while (start >= 0 && /[A-Za-z]/.test(text[start])) start--;
    const word = text.slice(start + 1, index).toLowerCase();
    return word.length > 0 && ABBREVIATIONS.has(word);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tests && node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-direction-beats`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/direction-beats.js tests/remodel-direction-beats.test.js
git commit -m "feat(remodel): derive pacing beats from prose instead of asking the model for them"
```

---

### Task 2: Address Goals and Variables by name

**Files:**
- Create: `public/scripts/extensions/third-party/SillyTavern-Remodel/direction-address.js`
- Test: `tests/remodel-direction-address.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `buildAddressBook(items: Array<{id: string, name: string}>): { entries: Array<{name: string, id: string}>, duplicates: string[] }` — `duplicates` holds every name appearing more than once; those names are excluded from `entries`.
  - `resolveByName(book, name: string): { ok: true, id: string } | { ok: false, reason: string }` — case-insensitive, whitespace-trimmed. Rejects unknown and duplicate names with a human-readable `reason`.

- [ ] **Step 1: Write the failing test**

```js
// tests/remodel-direction-address.test.js
import { buildAddressBook, resolveByName } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-address.js';

const items = [
    { id: 'var-1', name: "Aiden's HP" },
    { id: 'var-2', name: 'Faction Heat' },
];

test('resolves an exact name to its id', () => {
    const book = buildAddressBook(items);
    expect(resolveByName(book, "Aiden's HP")).toEqual({ ok: true, id: 'var-1' });
});

test('ignores case and surrounding whitespace', () => {
    const book = buildAddressBook(items);
    expect(resolveByName(book, "  aiden's hp ")).toEqual({ ok: true, id: 'var-1' });
});

test('rejects a name that was not advertised', () => {
    const book = buildAddressBook(items);
    const result = resolveByName(book, 'Vitality');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not advertised/i);
});

test('a duplicated name is unusable rather than ambiguous', () => {
    const book = buildAddressBook([...items, { id: 'var-3', name: "Aiden's HP" }]);
    expect(book.duplicates).toContain("Aiden's HP");
    const result = resolveByName(book, "Aiden's HP");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/more than one/i);
});

test('an empty name is rejected without throwing', () => {
    const book = buildAddressBook(items);
    expect(resolveByName(book, '').ok).toBe(false);
    expect(resolveByName(book, undefined).ok).toBe(false);
});

test('an empty book rejects everything', () => {
    const book = buildAddressBook([]);
    expect(book.entries).toEqual([]);
    expect(resolveByName(book, 'anything').ok).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tests && node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-direction-address`
Expected: FAIL — cannot find module `direction-address.js`

- [ ] **Step 3: Write the implementation**

```js
// public/scripts/extensions/third-party/SillyTavern-Remodel/direction-address.js

// Addressing Goals and Variables by the names their author gave them.
//
// The previous scheme handed the model opaque refs (v1, g2) and mapped them
// back. The security property was never the opacity — it was that the model can
// only touch what this turn advertised. That property is preserved here: a name
// resolves only if it is in the book built for this turn.
//
// A name that appears twice is refused rather than guessed at, because silently
// writing to the wrong record is worse than failing the request.
//
// PURE — no context, no DOM.

/**
 * @param {Array<{id: string, name: string}>} items
 * @returns {{entries: Array<{name: string, id: string}>, duplicates: string[]}}
 */
export function buildAddressBook(items = []) {
    const counts = new Map();
    for (const item of items) {
        const key = normalize(item?.name);
        if (!key) continue;
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    const duplicates = [];
    const entries = [];
    for (const item of items) {
        const key = normalize(item?.name);
        if (!key || !item?.id) continue;
        if (counts.get(key) > 1) {
            if (!duplicates.includes(item.name)) duplicates.push(item.name);
            continue;
        }
        entries.push({ name: String(item.name), id: String(item.id) });
    }
    return { entries, duplicates };
}

/**
 * @returns {{ok: true, id: string} | {ok: false, reason: string}}
 */
export function resolveByName(book, name) {
    const key = normalize(name);
    if (!key) return { ok: false, reason: 'No name was given.' };
    const match = (book?.entries || []).find((entry) => normalize(entry.name) === key);
    if (match) return { ok: true, id: match.id };
    const duplicated = (book?.duplicates || []).some((item) => normalize(item) === key);
    if (duplicated) return { ok: false, reason: `“${name}” names more than one record in this Timeline; rename one of them.` };
    return { ok: false, reason: `“${name}” was not advertised for this request.` };
}

function normalize(value) {
    return String(value ?? '').trim().toLowerCase();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tests && node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-direction-address`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/direction-address.js tests/remodel-direction-address.test.js
git commit -m "feat(remodel): address Goals and Variables by name instead of opaque refs"
```

---

### Task 3: Add the director prompt mode and its recipe defaults

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js:7` (the `PROMPT_MODES` constant) and its `defaultBlocksFor` / seeding helpers
- Test: `tests/remodel-director-recipe.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `PROMPT_MODES` now includes `'director'`. `defaultBlocksFor('director', 'chat')` returns the block list below, in order. Source keys introduced: `directionProtocol`, `directorCard`, `mechanicsSkill`, `directorSnapshot`.

**Context for the implementer:** a recipe is `{ id, name, mode, apiType, blocks[] }`. A block is `{ id, kind, role, content, sourceKey, enabled, locked, nativeIdentifier }`, created by `createPromptBlock()`. `kind: 'message'` emits `content` verbatim; `kind: 'source'` is filled in at compile time from a supplied map. `locked: true` already exists and is used for blocks that cannot be removed without breaking output.

- [ ] **Step 1: Write the failing test**

```js
// tests/remodel-director-recipe.test.js
import {
    PROMPT_MODES,
    createPromptRecipe,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

beforeEach(() => { __setExtensionSettings({}); });

test('director is a prompt mode', () => {
    expect(PROMPT_MODES).toContain('director');
});

test('a new director recipe carries the expected blocks in order', () => {
    const recipe = createPromptRecipe({ name: 'Test Director', mode: 'director', apiType: 'chat' });
    expect(recipe.mode).toBe('director');
    expect(recipe.blocks.map((block) => block.sourceKey || block.kind)).toEqual([
        'directionProtocol',
        'directorCard',
        'message',
        'mechanicsSkill',
        'directorSnapshot',
    ]);
});

test('the protocol and snapshot blocks are locked, the style block is not', () => {
    const recipe = createPromptRecipe({ mode: 'director', apiType: 'chat' });
    const locked = Object.fromEntries(recipe.blocks.map((block) => [block.sourceKey || 'style', block.locked]));
    expect(locked.directionProtocol).toBe(true);
    expect(locked.directorSnapshot).toBe(true);
    expect(locked.style).toBe(false);
    expect(locked.directorCard).toBe(false);
});

test('the editable style block carries the pacing defaults as text', () => {
    const recipe = createPromptRecipe({ mode: 'director', apiType: 'chat' });
    const style = recipe.blocks.find((block) => block.kind === 'message');
    expect(style.content).toMatch(/without waiting/i);
    expect(style.content.length).toBeGreaterThan(40);
});

test('a director recipe is always chat, never text', () => {
    const recipe = createPromptRecipe({ mode: 'director', apiType: 'text' });
    expect(recipe.apiType).toBe('chat');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tests && node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-director-recipe`
Expected: FAIL — `PROMPT_MODES` does not contain `'director'`

- [ ] **Step 3: Write the implementation**

In `prompt-studio-store.js`, extend the mode list and add the defaults:

```js
export const PROMPT_MODES = ['story', 'roleplay', 'director'];
```

In `createPromptRecipe`, force the api type for director recipes — Live Direction requires a Chat Completion connection, so a Text variant would be a dead option:

```js
    const safeMode = PROMPT_MODES.includes(mode) ? mode : 'story';
    const requestedApiType = PROMPT_API_TYPES.includes(apiType) ? apiType : 'chat';
    const safeApiType = safeMode === 'director' ? 'chat' : requestedApiType;
```

Add the default block list, and wire it into `defaultBlocksFor` so `mode === 'director'` returns it:

```js
/**
 * The Director's default prompt.
 *
 * Only the protocol and the snapshot are locked: remove either and the reply
 * stops being parseable. Everything else — including the pacing and autonomy
 * policy that used to be compiled into directionHandbook — is an ordinary
 * editable block.
 */
function defaultDirectorBlocks() {
    return [
        createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'directionProtocol', enabled: true, locked: true }),
        createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'directorCard', enabled: true, locked: false }),
        createPromptBlock({
            kind: 'message', role: 'system', enabled: true, locked: false,
            content: 'The world may move without waiting for the user. Keep openings optional — the user may intervene anywhere. Responses may be long; give the performer useful guidance on rhythm, and only ask the scene to stop when the fiction is explicitly waiting on the user.',
        }),
        createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'mechanicsSkill', enabled: true, locked: false }),
        createPromptBlock({ kind: 'source', role: 'user', sourceKey: 'directorSnapshot', enabled: true, locked: true }),
    ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tests && node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-director-recipe`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js tests/remodel-director-recipe.test.js
git commit -m "feat(remodel): add a director prompt mode with editable directing style"
```

---

### Task 4: Route each call to its own recipe, and keep director recipes off native

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio.js` — `getCurrentPromptStudioRecipe`, `applyPromptStudioRuntimeRecipe`, `syncPromptStudioForCurrentMode`
- Test: `tests/remodel-prompt-routing.test.js`

**Interfaces:**
- Consumes: `PROMPT_MODES` including `'director'` (Task 3).
- Produces: `resolveDirectorRecipe(): recipe | null` — the active director recipe, or null. `applyRecipeToNative` is never called with a director recipe; the native sync path considers `'roleplay'` and `'story'` only.

**Context for the implementer:** roleplay and story recipes are *mirrored into SillyTavern's native Prompt Manager* by `applyRecipeToNative`; they are not compiled by Remodel. The director recipe is the opposite — compiled by Remodel, never mirrored. Mixing them would make the performing character generate while reading directing instructions, which is the single worst failure this task exists to prevent.

- [ ] **Step 1: Write the failing test**

```js
// tests/remodel-prompt-routing.test.js
import {
    createPromptRecipe,
    setActivePromptRecipe,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';
import { isNativeApplicableMode, resolveDirectorRecipe } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

beforeEach(() => { __setExtensionSettings({}); });

test('a director recipe is never eligible for native application', () => {
    expect(isNativeApplicableMode('director')).toBe(false);
    expect(isNativeApplicableMode('roleplay')).toBe(true);
    expect(isNativeApplicableMode('story')).toBe(true);
});

test('resolveDirectorRecipe returns the active director recipe', () => {
    const recipe = createPromptRecipe({ name: 'D', mode: 'director', apiType: 'chat' });
    setActivePromptRecipe('director', 'chat', recipe.id);
    expect(resolveDirectorRecipe()?.id).toBe(recipe.id);
});

test('resolveDirectorRecipe returns null when none is configured', () => {
    expect(resolveDirectorRecipe()).toBeNull();
});

test('resolveDirectorRecipe never returns a roleplay recipe', () => {
    const roleplay = createPromptRecipe({ name: 'R', mode: 'roleplay', apiType: 'chat' });
    setActivePromptRecipe('roleplay', 'chat', roleplay.id);
    expect(resolveDirectorRecipe()).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tests && node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-prompt-routing`
Expected: FAIL — `isNativeApplicableMode` is not exported

- [ ] **Step 3: Write the implementation**

```js
/**
 * Which prompt modes may be mirrored into SillyTavern's native Prompt Manager.
 *
 * Director recipes must never be: they are compiled by Remodel for the hidden
 * directing call. Applying one to native would make the performing character
 * generate while reading directing instructions.
 */
export function isNativeApplicableMode(mode) {
    return mode === 'roleplay' || mode === 'story';
}

/** The active Director recipe, or null when none is configured. */
export function resolveDirectorRecipe() {
    const recipe = getActivePromptRecipe('director', 'chat');
    return recipe && recipe.mode === 'director' ? recipe : null;
}
```

Then guard both native paths. In `applyPromptStudioRuntimeRecipe` and `syncPromptStudioForCurrentMode`, before calling `applyRecipeToNative(recipe)`:

```js
    if (!isNativeApplicableMode(recipe?.mode)) return;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tests && node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-prompt-routing`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio.js tests/remodel-prompt-routing.test.js
git commit -m "feat(remodel): route director and narrator recipes separately, never to native"
```

---

### Task 5: Compile the Director prompt from the recipe

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js` — `requestDirectionEnvelope` (around line 629), `directionHandbook` (1622), `directorDoctrine` (1626)
- Create: `public/scripts/extensions/third-party/SillyTavern-Remodel/direction-sources.js`
- Test: `tests/remodel-direction-sources.test.js`

**Interfaces:**
- Consumes: `resolveDirectorRecipe()` (Task 4), `buildAddressBook()` (Task 2).
- Produces: `buildDirectionSources(snapshot, { mechanicsEnabled }): { directionProtocol: string, directorCard: string, mechanicsSkill: string, directorSnapshot: string }` — the map handed to `compilePromptRecipe`. `mechanicsSkill` is `''` when mechanics are disabled, which makes `compilePromptRecipe` drop the block (it skips empty content).

**Context for the implementer:** `compilePromptRecipe(recipe, sources)` already exists in `prompt-studio.js`. It walks `recipe.blocks`, emits `kind: 'message'` content verbatim, and looks up `kind: 'source'` blocks in the `sources` map by `sourceKey`. Empty strings produce no message. `directionHandbook` currently mixes protocol, mechanics doctrine and authorial policy in one string; this task splits the first two into sources and drops the third (Task 3 moved it into an editable block).

- [ ] **Step 1: Write the failing test**

```js
// tests/remodel-direction-sources.test.js
import { buildDirectionSources } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-sources.js';

const snapshot = {
    director: { label: 'The Archivist', description: 'Patient.', personality: 'Dry.', scenario: '', creatorNotes: '', systemPrompt: '', postHistoryInstructions: '' },
    mechanics: {
        addressBook: { entries: [{ name: "Aiden's HP", id: 'var-1' }], duplicates: [] },
        serializedVariables: "Aiden's HP: 12 / 20\nMeaning: capacity to withstand injury.",
        goals: [{ name: 'Survive the night', status: 'active' }],
    },
    currentAction: 'He swings.',
};

test('the protocol source states the reply contract without pacing policy', () => {
    const sources = buildDirectionSources(snapshot, { mechanicsEnabled: false });
    expect(sources.directionProtocol).toMatch(/instruction/i);
    expect(sources.directionProtocol).not.toMatch(/responses may be long/i);
    expect(sources.directionProtocol).not.toMatch(/world may move/i);
});

test('the card source carries the Director card material', () => {
    const sources = buildDirectionSources(snapshot, { mechanicsEnabled: false });
    expect(sources.directorCard).toContain('The Archivist');
    expect(sources.directorCard).toContain('Patient.');
});

test('the mechanics skill names Variables by name and never by ref', () => {
    const sources = buildDirectionSources(snapshot, { mechanicsEnabled: true });
    expect(sources.mechanicsSkill).toContain("Aiden's HP");
    expect(sources.mechanicsSkill).not.toMatch(/\bv1\b/);
    expect(sources.mechanicsSkill).not.toMatch(/\bg1\b/);
});

test('the mechanics skill is empty when mechanics are disabled', () => {
    expect(buildDirectionSources(snapshot, { mechanicsEnabled: false }).mechanicsSkill).toBe('');
});

test('the snapshot source carries the current action', () => {
    const sources = buildDirectionSources(snapshot, { mechanicsEnabled: true });
    expect(sources.directorSnapshot).toContain('He swings.');
});

test('a missing director card degrades to empty rather than throwing', () => {
    const sources = buildDirectionSources({ ...snapshot, director: null }, { mechanicsEnabled: false });
    expect(sources.directorCard).toBe('');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tests && node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-direction-sources`
Expected: FAIL — cannot find module `direction-sources.js`

- [ ] **Step 3: Write the implementation**

Create `direction-sources.js`:

```js
// The content behind each source block of a Director recipe.
//
// PURE — takes a snapshot, returns strings. Keeping it free of context imports
// means the exact text sent to the Director can be asserted in tests.

/**
 * @param {object} snapshot the direction snapshot
 * @param {{mechanicsEnabled: boolean}} options
 * @returns {{directionProtocol: string, directorCard: string, mechanicsSkill: string, directorSnapshot: string}}
 */
export function buildDirectionSources(snapshot, { mechanicsEnabled = false } = {}) {
    return {
        directionProtocol: PROTOCOL,
        directorCard: snapshot?.director ? describeCard(snapshot.director) : '',
        mechanicsSkill: mechanicsEnabled ? describeMechanics(snapshot?.mechanics) : '',
        directorSnapshot: describeSnapshot(snapshot),
    };
}

// Contract only. Pacing, autonomy and response length live in the recipe's
// editable style block, not here — that was the point of the rework.
const PROTOCOL = `You are the hidden director of this scene. You never speak in the story and are never quoted.
Write your direction as an instruction to the performer who will write the next response: what they are doing, and what matters about how.
Then close with the required structured fields. Do not describe the protocol, do not mention that you are a director, and do not reveal secret Goals or unrevealed twists.`;

function describeCard(director) {
    return `[DIRECTOR CARD — directing temperament, not dialogue]
The director for this scene is ${director.label}. Use this material as judgment, priorities and genre sense. Never speak as this character.
Description: ${director.description || '(none)'}
Personality: ${director.personality || '(none)'}
Scenario: ${director.scenario || '(none)'}
Creator notes: ${director.creatorNotes || '(none)'}
System prompt: ${director.systemPrompt || '(none)'}
Post-history instructions: ${director.postHistoryInstructions || '(none)'}`;
}

function describeMechanics(mechanics) {
    const goals = (mechanics?.goals || []).map((goal) => `- ${goal.name}${goal.status ? ` (${goal.status})` : ''}`).join('\n');
    const duplicates = (mechanics?.addressBook?.duplicates || []);
    return `[GOALS AND VARIABLES — persistent memory, not a turn structure]
Address each one by the exact name below. A name you were not given will be rejected. Never invent an identifier, never roll dice, never change state yourself — request it and code will validate and apply it.

VARIABLES
${mechanics?.serializedVariables || '(none retrieved this turn)'}

GOALS
${goals || '(none active)'}
${duplicates.length ? `\nUnusable — these names are duplicated in this Timeline and cannot be addressed: ${duplicates.join(', ')}` : ''}`;
}

function describeSnapshot(snapshot) {
    const { mechanics, director, ...rest } = snapshot || {};
    return `SCENE\n${JSON.stringify(rest)}`;
}
```

Then in `live-direction.js`, replace the hardcoded four-message array in `requestDirectionEnvelope` with a compiled one, keeping a fallback:

```js
    const recipe = resolveDirectorRecipe();
    const sources = buildDirectionSources(snapshot, { mechanicsEnabled: profile.enabled });
    let prompt;
    if (recipe) {
        prompt = compilePromptRecipe(recipe, sources).messages;
    }
    // A recipe that compiles to nothing — emptied, or missing its protocol
    // block — must not silently produce an unusable request.
    if (!prompt?.length || !prompt.some((message) => message.content.includes(sources.directionProtocol.slice(0, 40)))) {
        journal('recipe.fallback', { hadRecipe: Boolean(recipe), messages: prompt?.length || 0 }, { severity: 'warn' });
        prompt = [
            { role: 'system', content: sources.directionProtocol },
            ...(sources.directorCard ? [{ role: 'system', content: sources.directorCard }] : []),
            ...(sources.mechanicsSkill ? [{ role: 'system', content: sources.mechanicsSkill }] : []),
            { role: 'user', content: sources.directorSnapshot },
        ];
    }
```

Delete `directionHandbook` and `directorDoctrine` once nothing references them.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tests && node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-direction-sources`
Expected: PASS, 6 tests

Then confirm nothing broke: `node --input-type=module --check < public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js`

- [ ] **Step 5: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/direction-sources.js public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js tests/remodel-direction-sources.test.js
git commit -m "feat(remodel): compile the Director prompt from its recipe"
```

---

### Task 6: Free the Narrator from emitting markers

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js` — `formatMovementPrompt` (1606), `normalizeEnvelope` (1570), the reveal loop's beat handling, and `executeCheckpoint` (952)
- Test: `tests/remodel-movement-prompt.test.js`

**Interfaces:**
- Consumes: `deriveBeats()` (Task 1).
- Produces: `formatMovementPrompt(envelope)` — no longer takes a performer argument and contains no marker instructions. Mechanical requests carried by `envelope.mechanics.pendingRequests` are applied on acceptance rather than at a marker.

**Context for the implementer:** the reveal loop currently reads markers parsed out of the model's text to decide when to pause and when to fire a checkpoint. After this task it reads `deriveBeats(visibleText)` instead. `live-direction-markers.js` stays in place and keeps stripping markers, because saved messages and reload recovery still contain them — only the *instruction to emit* them is removed.

- [ ] **Step 1: Write the failing test**

```js
// tests/remodel-movement-prompt.test.js
import { formatMovementPrompt } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';

const envelope = {
    directionId: 'direction-1',
    instruction: 'Let him land the blow, then let the room go quiet.',
    mechanics: { pendingRequests: [{ capability: 'variable.adjust', arguments: {} }] },
};

test('the movement prompt is the direction, with no marker instructions', () => {
    const prompt = formatMovementPrompt(envelope);
    expect(prompt).toContain('Let him land the blow');
    expect(prompt).not.toMatch(/\[\[RM:/);
    expect(prompt).not.toMatch(/marker/i);
    expect(prompt).not.toMatch(/checkpoint/i);
    expect(prompt).not.toMatch(/protocol/i);
});

test('it does not tell the performer about the Director', () => {
    expect(formatMovementPrompt(envelope)).not.toMatch(/director/i);
});

test('an empty instruction produces no prompt rather than an empty header', () => {
    expect(formatMovementPrompt({ ...envelope, instruction: '' })).toBe('');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tests && node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-movement-prompt`
Expected: FAIL — `formatMovementPrompt` is not exported, and still emits marker instructions

- [ ] **Step 3: Write the implementation**

Export and rewrite `formatMovementPrompt`:

```js
/**
 * What the performing character is told.
 *
 * Just the direction. It used to also carry an objective/constraint form, three
 * marker formats with ids to remember, and two prohibitions — clerical load at
 * the position closest to the next word, which is what flattened the prose.
 */
export function formatMovementPrompt(envelope) {
    const instruction = String(envelope?.instruction || '').trim();
    if (!instruction) return '';
    return `[Direction for this response only]\n${instruction}`;
}
```

In `normalizeEnvelope`, accept the new shape: `instruction` (string, required) and `flow`, and carry mechanical requests as `mechanics.pendingRequests`. Keep reading `movement.objective` as a fallback so a response mid-flight during upgrade still parses.

In the reveal loop, replace marker-driven beats with derived ones:

```js
        // Beats come from the prose itself now, not from markers the model was
        // asked to type. Derived once per revealed chunk, not per character.
        const beats = deriveBeats(run.visibleText);
```

In `completeVisibleRun`, apply the pending mechanical requests — this is the acceptance point that replaces the commit marker:

```js
    // State changes land when a response is accepted, not at the sentence that
    // established them. An interrupted response applies nothing.
    if (run.envelope.mechanics.pendingRequests?.length) {
        executeDirectionRequests(run.envelope.mechanics.pendingRequests, {
            scene, directionId: run.directionId, checkpointId: 'accepted',
            authorizedGoalIds: run.envelope.authorizedGoalIds,
            variableRefs: run.variableRefs, goalRefs: run.goalRefs,
        });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tests && node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-movement-prompt`
Expected: PASS, 3 tests

Then the whole suite: `cd tests && node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel`
Expected: PASS — all prior tests still green

- [ ] **Step 5: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js tests/remodel-movement-prompt.test.js
git commit -m "feat(remodel): let the Narrator write clean prose"
```

---

### Task 7: Preview the Director and Narrator prompts separately

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-spine.js` — the Roleplay preview action
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/style.css` — tab styling for the preview
- Test: manual, in the running app (this is UI with no pure logic to isolate)

**Interfaces:**
- Consumes: `resolveDirectorRecipe()` (Task 4), `buildDirectionSources()` (Task 5), `compilePromptRecipe()`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add the two-tab preview**

Render two tabs in the existing Roleplay preview surface. The Director tab compiles the active director recipe against a snapshot built for the current scene and shows the resulting messages, role by role. The Narrator tab shows the native prompt as it does today.

```js
const previewTab = (id, label, active) =>
    `<button type="button" data-remodel-rp-preview-tab="${id}" class="${active === id ? 'is-active' : ''}">${label}</button>`;
```

- [ ] **Step 2: Verify in the running app**

Open a directed Roleplay Scene, click Preview, and confirm:
- both tabs render
- the Director tab shows the compiled messages including the editable style block's text
- editing the style block in the Prompts tab changes what the Director tab shows
- the Narrator tab is unchanged from today

- [ ] **Step 3: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-spine.js public/scripts/extensions/third-party/SillyTavern-Remodel/style.css
git commit -m "feat(remodel): preview the Director and Narrator prompts separately"
```

---

### Task 8: Verify the whole loop in the running app

**Files:** none — verification only.

- [ ] **Step 1: Confirm parity before judging quality**

Open the Debug workspace, run one directed pass, export the bundle, and read the `direction.envelope` record. Confirm the compiled Director prompt contains the protocol, the card, the style block and the snapshot, in recipe order.

- [ ] **Step 2: Confirm the director recipe never reached native**

After that pass, check SillyTavern's Prompt Manager entries. None may contain directing text. This is the failure this rework most needs to not have.

- [ ] **Step 3: Confirm the Narrator's prose is clean**

Read the raw performer output in the debug bundle. It must contain no `[[RM:` sequences. If it does, the movement prompt still mentions markers.

- [ ] **Step 4: Confirm beats are being derived**

The `direction` records should show beat counts derived from the text. Compare a long multi-paragraph response against a one-line reply — beat counts must differ.

- [ ] **Step 5: Confirm interruption applies nothing**

With Mechanics enabled and a Goal or Variable request in the direction, interrupt the response early. The Variable must be unchanged. Let a second response complete, and it must change.

- [ ] **Step 6: Commit any fixes found**

```bash
git add -A
git commit -m "fix(remodel): <what the live pass revealed>"
```

## Self-review notes

**Spec coverage.** §1 two recipes and the router → Tasks 3, 4. §2 Director output → Tasks 5, 6 (`instruction` plus `flow` and `pendingRequests`). §3 names not refs → Tasks 2, 5. §4 clean prose and derived beats → Tasks 1, 6. §5 preview → Task 7. Risks: fallback when a recipe compiles to nothing → Task 5 Step 3; duplicate names → Task 2; commit-timing change → Task 6 Step 3.

**Open item deliberately not planned.** The spec records that deleting performer selection changes open scenes — direction would always route to the Narrator. No task implements a replacement, because the decision was left open. If open scenes must hand the floor around, a `performer` name field is added to the structured tail and resolved through `resolveByName` against the cast; that is a change to Tasks 5 and 6, not a new task.
