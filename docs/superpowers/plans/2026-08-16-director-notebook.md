# Director's Notebook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Director's JSON envelope with a streamed, free-form reply that is parsed into a persistent typed notebook the Narrator reads as a recipe block.

**Architecture:** The Director stops using `generateRawData` + `jsonSchema` (structurally unstreamable, and it discards the provider's reasoning field) and instead streams through `sendOpenAIRequest`. Its reply is split on line-leading `[type]` tags into typed entries stored per Timeline, plus a trailing fenced `state` block carrying Variable/Goal requests validated against the same closed set as today. The Narrator reads recent non-secret entries through a new recipe source, and its chat history is filtered to its own prose.

**Tech Stack:** Vanilla ES modules, no build step. Jest with `--experimental-vm-modules`, run from `tests/`. SillyTavern core APIs: `sendOpenAIRequest` (`../../../openai.js`), `getContext()` (`../../../st-context.js`).

**Spec:** `docs/superpowers/specs/2026-08-16-director-notebook-design.md`

## Global Constraints

- All product changes live inside `public/scripts/extensions/third-party/SillyTavern-Remodel/`. No core SillyTavern source, server endpoint, or native World Info schema changes.
- Pure logic goes in modules that do **not** import `st-context.js`, so it stays testable offline. `direction-sources.js` (zero imports) and `direction-address.js` are the precedents.
- Jest runs from `tests/`: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json <pattern>`.
- `node --check` does NOT reliably catch syntax errors in this ES-module codebase. Use `node --input-type=module --check < file.js`.
- Every commit must leave `git diff --check` clean and CSS braces balanced if `style.css` was touched.
- **The Narrator's recipe mode is `'roleplay'` in code.** `PROMPT_MODES = ['story', 'roleplay', 'director']`. There is no `'narrator'` mode; the spec's prose name maps to `'roleplay'`.
- Director recipes are Chat Completion only. `apiType` is always `'chat'`.
- **Containment is unchanged:** every Variable or Goal name in a request is validated against the set advertised that turn via `buildAddressBook`/`resolveByName` (`direction-address.js`). A name not advertised is rejected.
- **A `secret` entry must never reach the Narrator's prompt.**
- **A missing or unparseable `state` tail is never an error.** The turn proceeds with no state changes and a journal entry, and `flow.continue` defaults to `false`.
- Baseline suite before this plan: **remodel 103/103, full repo 418/418.** Neither may regress.

---

### Task 1: Parse the Director's reply

**Files:**
- Create: `public/scripts/extensions/third-party/SillyTavern-Remodel/director-reply.js`
- Test: `tests/remodel-director-reply.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseDirectorReply(text) -> { entries: Array<{type, text}>, state: {requests: Array<object>, flow: {continue: boolean}}, tailFound: boolean, tailError: string }`. `type` is one of `'note' | 'ruling' | 'result' | 'secret'`.

This module must have **zero import statements**, like `direction-sources.js`.

- [ ] **Step 1: Write the failing tests**

```js
import { parseDirectorReply, ENTRY_TYPES } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-reply.js';

test('splits line-leading tags into typed entries', () => {
    const { entries } = parseDirectorReply('[note] Teo is stalling.\n[secret] He saw the janitor.\n[ruling] If Eli sits, Teo talks.');
    expect(entries).toEqual([
        { type: 'note', text: 'Teo is stalling.' },
        { type: 'secret', text: 'He saw the janitor.' },
        { type: 'ruling', text: 'If Eli sits, Teo talks.' },
    ]);
});

test('untagged leading prose becomes a note rather than being dropped', () => {
    const { entries } = parseDirectorReply('Teo stalls, and the rain starts.\n[result] Eli sat down.');
    expect(entries[0]).toEqual({ type: 'note', text: 'Teo stalls, and the rain starts.' });
    expect(entries[1].type).toBe('result');
});

test('an unknown tag stays literal text inside the current entry', () => {
    const { entries } = parseDirectorReply('[note] Teo stalls.\n[foreshadow] the closet\n[result] Eli sat.');
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe('Teo stalls.\n[foreshadow] the closet');
});

test('reads the LAST state fence, so mid-reply talk about state cannot confuse it', () => {
    const reply = [
        '[note] I considered writing ```state {"requests":[]}``` here but did not.',
        '```state',
        '{"requests":[{"capability":"variable.adjust","name":"Morale","amount":-1}],"flow":{"continue":true}}',
        '```',
    ].join('\n');
    const { state, tailFound } = parseDirectorReply(reply);
    expect(tailFound).toBe(true);
    expect(state.requests).toEqual([{ capability: 'variable.adjust', name: 'Morale', amount: -1 }]);
    expect(state.flow.continue).toBe(true);
});

test('the tail is stripped from the stored entry text', () => {
    const { entries } = parseDirectorReply('[note] Teo stalls.\n```state\n{"requests":[]}\n```');
    expect(entries[0].text).toBe('Teo stalls.');
    expect(JSON.stringify(entries)).not.toContain('state');
});

test('a missing tail is not an error and stops the scene', () => {
    const { state, tailFound, tailError } = parseDirectorReply('[note] Nothing mechanical happened.');
    expect(tailFound).toBe(false);
    expect(tailError).toBe('');
    expect(state.requests).toEqual([]);
    expect(state.flow.continue).toBe(false);
});

test('a malformed tail reports the error, yields no requests, and stops', () => {
    const { state, tailFound, tailError } = parseDirectorReply('[note] Hm.\n```state\n{"requests": [oh no\n```');
    expect(tailFound).toBe(true);
    expect(tailError).not.toBe('');
    expect(state.requests).toEqual([]);
    expect(state.flow.continue).toBe(false);
});

test('exports the four types and only those', () => {
    expect(ENTRY_TYPES).toEqual(['note', 'ruling', 'result', 'secret']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `tests/`: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-director-reply`

Expected: FAIL — cannot find module `director-reply.js`.

- [ ] **Step 3: Write the implementation**

```js
// Parse a Director's free-form reply into typed notebook entries plus the
// machine-readable state tail.
//
// PURE — no imports, so the exact parse can be asserted offline. The Director's
// reply is the only thing standing between the user and a scene, so every
// failure here degrades rather than throws: an unparseable tail costs the turn
// its state changes, never its prose.

export const ENTRY_TYPES = ['note', 'ruling', 'result', 'secret'];

const TAG = /^\[([a-z]+)\]\s?/i;
const STATE_FENCE = /```state\s*\n([\s\S]*?)\n?```/gi;

export function parseDirectorReply(text) {
    const raw = String(text || '');
    const { body, tail, tailFound } = splitTail(raw);
    const { state, tailError } = readState(tail, tailFound);
    return { entries: readEntries(body), state, tailFound, tailError };
}

/**
 * Take the LAST state fence. A Director that discusses the format mid-reply —
 * quoting it, or reasoning about what it will write — must not have that read
 * as its answer.
 */
function splitTail(raw) {
    const matches = [...raw.matchAll(STATE_FENCE)];
    if (!matches.length) return { body: raw, tail: '', tailFound: false };
    const last = matches[matches.length - 1];
    const body = raw.slice(0, last.index) + raw.slice(last.index + last[0].length);
    return { body, tail: last[1], tailFound: true };
}

/** Flow defaults to stopping: a scene that runs away after a parse error is
 *  harder to notice, and harder to undo, than one that waits. */
function readState(tail, tailFound) {
    const empty = { requests: [], flow: { continue: false } };
    if (!tailFound) return { state: empty, tailError: '' };
    try {
        const parsed = JSON.parse(tail);
        return {
            state: {
                requests: Array.isArray(parsed?.requests) ? parsed.requests.filter((item) => item && typeof item === 'object') : [],
                flow: { continue: parsed?.flow?.continue === true },
            },
            tailError: '',
        };
    } catch (error) {
        return { state: empty, tailError: String(error?.message || error) };
    }
}

/**
 * Split on line-leading tags. An unrecognised tag is literal text, not a new
 * entry: a typo must never silently create a type nothing reads. Untagged
 * leading prose becomes a note rather than being discarded — losing the
 * Director's output to a missing tag would be the worst failure available.
 */
function readEntries(body) {
    const entries = [];
    for (const line of String(body).split('\n')) {
        const match = line.match(TAG);
        const type = match && ENTRY_TYPES.includes(match[1].toLowerCase()) ? match[1].toLowerCase() : '';
        if (type) entries.push({ type, text: line.slice(match[0].length) });
        else if (entries.length) entries[entries.length - 1].text += `\n${line}`;
        else if (line.trim()) entries.push({ type: 'note', text: line });
    }
    return entries.map((entry) => ({ ...entry, text: entry.text.trim() })).filter((entry) => entry.text);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-director-reply`
Expected: PASS, 7 tests.

- [ ] **Step 5: Mutation-check the tests**

Green tests in this project have three times certified properties that were false. For each of these, make the change, confirm the named test goes red, then revert:
- Change `matches[matches.length - 1]` to `matches[0]` → the last-fence test must fail.
- Delete the `else if (line.trim())` untagged-prose branch → the untagged test must fail.
- Remove `ENTRY_TYPES.includes(...)` from the type check → the unknown-tag test must fail.
- Change `flow.continue` default to `true` → both the missing-tail and malformed-tail tests must fail.

Record in the report which mutations you ran and that each went red.

- [ ] **Step 6: Verify syntax and commit**

```bash
node --input-type=module --check < public/scripts/extensions/third-party/SillyTavern-Remodel/director-reply.js
git add public/scripts/extensions/third-party/SillyTavern-Remodel/director-reply.js tests/remodel-director-reply.test.js
git commit -m "feat(remodel): parse the Director's reply into typed entries and a state tail"
```

---

### Task 2: The notebook store

**Files:**
- Create: `public/scripts/extensions/third-party/SillyTavern-Remodel/director-notes-store.js`
- Test: `tests/remodel-director-notes-store.test.js`

**Interfaces:**
- Consumes: `ENTRY_TYPES` from `director-reply.js` (Task 1).
- Produces:
  - `appendDirectorEntries(timelineId, {sceneId, turn, entries}) -> Array<StoredEntry>` where `StoredEntry = {id, sceneId, turn, at, type, text}`
  - `readNarratorEntries(timelineId, {sceneId, depth}) -> Array<StoredEntry>` — **never returns `secret`**
  - `readAllEntries(timelineId, {sceneId}) -> Array<StoredEntry>` — includes secrets, for the owner's UI
  - `deleteDirectorEntry(timelineId, entryId)`, `clearDirectorNotes(timelineId)`

This module follows `story-goals-store.js` for persistence shape (it may import `st-context.js` for settings access, like the other stores).

- [ ] **Step 1: Write the failing tests**

```js
import { appendDirectorEntries, readNarratorEntries, readAllEntries, deleteDirectorEntry } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-notes-store.js';

const TL = 'tl-test';

test('secrets are withheld from the Narrator read but kept for the owner', () => {
    appendDirectorEntries(TL, { sceneId: 's1', turn: 1, entries: [
        { type: 'note', text: 'Teo stalls.' },
        { type: 'secret', text: 'He saw the janitor.' },
    ] });
    const narrator = readNarratorEntries(TL, { sceneId: 's1', depth: 10 });
    expect(narrator.map((e) => e.type)).toEqual(['note']);
    expect(JSON.stringify(narrator)).not.toContain('janitor');
    expect(readAllEntries(TL, { sceneId: 's1' }).map((e) => e.type)).toEqual(['note', 'secret']);
});

test('depth counts turns, not entries, so one turn is never half-delivered', () => {
    appendDirectorEntries(TL, { sceneId: 's2', turn: 1, entries: [{ type: 'note', text: 'one-a' }, { type: 'note', text: 'one-b' }] });
    appendDirectorEntries(TL, { sceneId: 's2', turn: 2, entries: [{ type: 'note', text: 'two-a' }] });
    const recent = readNarratorEntries(TL, { sceneId: 's2', depth: 1 });
    expect(recent.map((e) => e.text)).toEqual(['two-a']);
    const both = readNarratorEntries(TL, { sceneId: 's2', depth: 2 });
    expect(both.map((e) => e.text)).toEqual(['one-a', 'one-b', 'two-a']);
});

test('entries carry ids and are individually deletable', () => {
    const [entry] = appendDirectorEntries(TL, { sceneId: 's3', turn: 1, entries: [{ type: 'ruling', text: 'gone soon' }] });
    expect(entry.id).toBeTruthy();
    deleteDirectorEntry(TL, entry.id);
    expect(readAllEntries(TL, { sceneId: 's3' })).toEqual([]);
});

test('an unknown type is rejected rather than stored', () => {
    const stored = appendDirectorEntries(TL, { sceneId: 's4', turn: 1, entries: [{ type: 'foreshadow', text: 'nope' }] });
    expect(stored).toEqual([]);
});
```

- [ ] **Step 2: Run to verify they fail.** Expected: cannot find module.

- [ ] **Step 3: Implement the store**

Follow `story-goals-store.js` for the settings-bucket pattern (`getContext().extensionSettings`, a per-Timeline bucket, `saveSettingsDebounced`). The three rules that matter:

1. **`readNarratorEntries` filters `secret` inside the store**, not at the call site. A future caller cannot forget what it never receives. This is the single property the type exists for.
2. **`depth` counts turns, not entries.** Delivering half of a turn's entries would hand the Narrator a ruling without its result.
3. `appendDirectorEntries` drops entries whose `type` is not in `ENTRY_TYPES`.

- [ ] **Step 4: Run the tests to verify they pass.**

- [ ] **Step 5: Mutation-check.** Remove the `secret` filter from `readNarratorEntries` → the first test must go red. Change depth to count entries → the second must go red. Record both.

- [ ] **Step 6: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/director-notes-store.js tests/remodel-director-notes-store.test.js
git commit -m "feat(remodel): store the Director's typed notebook per Timeline"
```

---

### Task 3: Recipe blocks gain a settings bag

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js` — `normalizeBlock`, `normalizeBlocks`, `createPromptBlock`
- Test: `tests/remodel-prompt-studio-store.test.js` (create if absent)

**Interfaces:**
- Produces: a block may carry `settings: object`. `PROMPT_SOURCE_DEFINITIONS` entries may declare `settings: { <key>: { type: 'number', label, min, max, default } }`. `normalizeBlock` fills defaults from the definition and drops keys the definition does not declare.

- [ ] **Step 1: Write the failing tests**

```js
test('a saved recipe with no settings still normalizes', () => {
    const recipe = normalizeRecipeForTest({ id: 'r1', mode: 'roleplay', apiType: 'chat', blocks: [{ kind: 'source', sourceKey: 'chatHistory', role: 'user', enabled: true }] });
    expect(recipe.blocks[0].settings).toEqual({});
});

test('a declared setting is defaulted when absent', () => {
    const recipe = normalizeRecipeForTest({ id: 'r2', mode: 'roleplay', apiType: 'chat', blocks: [{ kind: 'source', sourceKey: 'directorNotes', role: 'system', enabled: true }] });
    expect(recipe.blocks[0].settings.depth).toBe(3);
});

test('an undeclared setting key is dropped', () => {
    const recipe = normalizeRecipeForTest({ id: 'r3', mode: 'roleplay', apiType: 'chat', blocks: [{ kind: 'source', sourceKey: 'directorNotes', role: 'system', enabled: true, settings: { depth: 5, nonsense: true } }] });
    expect(recipe.blocks[0].settings).toEqual({ depth: 5 });
});

test('a setting outside its declared range is clamped, not rejected', () => {
    const recipe = normalizeRecipeForTest({ id: 'r4', mode: 'roleplay', apiType: 'chat', blocks: [{ kind: 'source', sourceKey: 'directorNotes', role: 'system', enabled: true, settings: { depth: 9999 } }] });
    expect(recipe.blocks[0].settings.depth).toBe(20);
});
```

Export a test seam if `normalizeRecipe` is not already reachable — prefer exporting the existing function over inventing a parallel one.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** `normalizeBlock` looks up its source definition, and for each declared setting reads the saved value, coerces it to the declared type, clamps to `min`/`max`, and falls back to `default`. Undeclared keys are dropped. Blocks whose definition declares no settings get `{}`.

**`normalizeRecipe` is the one funnel every recipe passes through** — fresh creation and recipes loaded back out of persisted settings — so this is the only place defaults belong. Do not default settings at the call site.

- [ ] **Step 4: Run to verify they pass.**

- [ ] **Step 5: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js tests/remodel-prompt-studio-store.test.js
git commit -m "feat(remodel): let recipe blocks carry per-block settings"
```

---

### Task 4: The `directorNotes` source

**Files:**
- Modify: `prompt-studio-store.js` — add to `PROMPT_SOURCE_DEFINITIONS.roleplay`
- Modify: `prompt-studio.js` — `compilePromptRecipe` passes `block.settings` to source resolution
- Modify: `live-direction.js` — build the `directorNotes` source text for the Narrator
- Test: `tests/remodel-director-notes-source.test.js`

**Interfaces:**
- Consumes: `readNarratorEntries` (Task 2), block `settings` (Task 3).
- Produces: source key `'directorNotes'`, label `"Director's Notes"`, role `'system'`, declaring `settings: { depth: { type: 'number', label: 'Turns to include', min: 1, max: 20, default: 3 } }`.

- [ ] **Step 1: Write the failing test**

```js
test('the notes source renders recent non-secret entries and honours depth', () => {
    const text = buildDirectorNotesSource([
        { turn: 4, type: 'note', text: 'Teo stalls.' },
        { turn: 5, type: 'ruling', text: 'If Eli sits, Teo talks.' },
    ]);
    expect(text).toContain('Teo stalls.');
    expect(text).toContain('If Eli sits, Teo talks.');
    expect(text).not.toMatch(/\[secret\]/i);
});

test('no entries renders nothing rather than an empty heading', () => {
    expect(buildDirectorNotesSource([]).trim()).toBe('');
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement.** Render entries grouped by turn, newest last, in the prose style `direction-sources.js` established — a heading and readable lines, never a JSON dump. `compilePromptRecipe` must pass `block.settings` through to source resolution; **settings feed the compile and must never appear in the compiled text.**

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Add the compile-safety test**

```js
test('settings never leak into the compiled prompt', () => {
    const compiled = compilePromptRecipe(recipeWithNotesBlock, { directorNotes: 'Teo stalls.' });
    expect(JSON.stringify(compiled.messages)).not.toContain('depth');
});
```

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(remodel): give the Narrator a Director's Notes recipe block"
```

---

### Task 5: The new Director contract block

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/direction-sources.js` — the `PROTOCOL` constant
- Test: `tests/remodel-direction-sources.test.js` (extend)

**Interfaces:**
- Produces: `PROTOCOL` text teaching the four tags and the `state` fence.

- [ ] **Step 1: Rewrite `PROTOCOL`**

It must state: the Director never speaks in the story; it writes its notebook entries using the four line tags; it ends with a `state` fence if anything mechanical changed; and it addresses Variables and Goals by their exact advertised names. It must **not** contain pacing, autonomy, response-length or style guidance — that belongs to the user's recipe, and putting it here recreates the hardcoded-prompt problem this whole line of work exists to end.

- [ ] **Step 2: Add tests**

```js
test('the protocol teaches all four entry types', () => {
    const { directionProtocol } = buildDirectionSources(snapshot, { mechanicsEnabled: true });
    for (const type of ['note', 'ruling', 'result', 'secret']) expect(directionProtocol).toContain(`[${type}]`);
});

test('the protocol carries no pacing or style policy', () => {
    const { directionProtocol } = buildDirectionSources(snapshot, { mechanicsEnabled: true });
    expect(directionProtocol).not.toMatch(/pacing|rhythm|opening|breath|length/i);
});
```

- [ ] **Step 3: Run, verify, commit**

`direction-sources.js` must still have **zero imports**.

```bash
git commit -m "feat(remodel): teach the Director its notebook contract"
```

---

### Task 6: Stream the Director

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/story-stream.js` — rename the export to a neutral name
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/story-generate.js` — update its call site
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js` — `requestDirectionEnvelope` becomes a streaming call
- Test: `tests/remodel-direction-lifecycle.test.js` (extend)

**Interfaces:**
- Consumes: `parseDirectorReply` (Task 1), `appendDirectorEntries` (Task 2).
- Produces: `requestDirection(scene, snapshot, { onChunk })` returning `{ entries, state, reasoning, raw }`.

`streamStoryProse({prompt, onChunk, signal})` already does exactly what the Director needs — it calls `sendOpenAIRequest('continue', …)`, tolerates a provider that ignores `stream` by returning the whole response, and yields `{text, reasoning}` cumulatively. Rename it `streamChatPrompt` and update Story's call site; do not clone it.

- [ ] **Step 1: Rename the streaming helper and update Story's call site. Run the suite — Story's tests must still pass.**

- [ ] **Step 2: Replace the Director call.** Delete the `jsonSchema` argument, `getDirectionEnvelopeSchema`, and **`withCapturedResponse` — the `globalThis.fetch` monkey-patch is obsolete**, because streaming supplies `state.reasoning` directly. Removing it is a required part of this task, not optional cleanup: leaving a fetch patch in place that nothing needs is a trap for the next reader.

- [ ] **Step 3: Wire the parse and the store.** Parse the streamed text with `parseDirectorReply`, append the entries via `appendDirectorEntries`, and pass `state.requests` into the existing `executeDirectionRequests` path unchanged — the closed-set validation is not modified by this task.

- [ ] **Step 4: Handle an interrupted Director.** A stream aborted mid-reply must store what arrived, marked incomplete, rather than being parsed as though whole.

- [ ] **Step 5: Add the lifecycle test**

```js
test('a streamed Director reply becomes notebook entries and applies its requests', async () => {
    // drive a full pass with a stubbed stream that yields a tagged reply plus a state fence,
    // then assert: entries stored, the named Variable changed, and the raw text never
    // reaches the performer's prompt.
});

test('an unparseable tail costs the turn its requests, not its prose', async () => {
    // assert the entries are stored, no Variable changed, a journal entry exists,
    // and the Narrator still ran.
});
```

- [ ] **Step 6: Run both suites and commit**

```bash
git commit -m "feat(remodel): stream the Director and keep its notebook"
```

---

### Task 7: Post the user's message first

**Files:**
- Modify: `live-direction.js` — `beginDirection` (`insertUser` moves before the Director call), `buildDirectionSnapshot`
- Test: `tests/remodel-direction-lifecycle.test.js` (extend)

- [ ] **Step 1: Write the failing test**

```js
test("the user's action appears exactly once in the Director's prompt", async () => {
    const sources = await capturedDirectorSourcesForAction('I push the door open.');
    const occurrences = sources.directorSnapshot.split('I push the door open.').length - 1;
    expect(occurrences).toBe(1);
});

test("the user's message is in the chat before the Director is called", async () => {
    // assert chat length at the moment the Director stream begins
});
```

- [ ] **Step 2: Run to verify it fails** — currently the action reaches the prompt only via `CURRENT ACTION`, so moving the insert without the exclusion makes this test report 2.

- [ ] **Step 3: Implement.** Move `sendMessageAsUser` before `buildDirectionSnapshot`, and exclude the newest chat entry from `acceptedHistory`. The World Info scan and `buildMechanicalSnapshot` both take `action` as a separate input — they must not now also see it inside `history`, or retrieval scores the same text twice.

- [ ] **Step 4: Run, verify, commit.**

```bash
git commit -m "feat(remodel): post the user's message before the Director runs"
```

---

### Task 8: Filter the Narrator's history

**Files:**
- Modify: `live-direction.js` or a new small module for the prompt-assembly hook
- Test: `tests/remodel-narrator-history.test.js`

- [ ] **Step 1: Write the failing test**

```js
test("the Narrator's assembled prompt contains none of the user's messages", () => {
    const filtered = filterNarratorHistory(chatFixture, { narratorName: 'The Narrator' });
    expect(filtered.every((m) => m.name === 'The Narrator')).toBe(true);
});

test('a secret entry never reaches the Narrator prompt', () => {
    // end-to-end through the notes source; mutation-check by removing the store filter
});
```

- [ ] **Step 2: Implement** at the prompt-assembly boundary (`chat_completion_prompt_ready` / `GENERATE_AFTER_COMBINE_PROMPTS`). **Do not mutate `context.chat`** — it is the true record and other surfaces read it.

- [ ] **Step 3: Run, verify, commit.**

```bash
git commit -m "feat(remodel): narrow the Narrator's history to its own prose"
```

---

### Task 9: Watch the Director think

**Files:**
- Modify: `timeline-spine.js` — the direction card fills live; a notebook surface
- Modify: `style.css`
- Test: manual, in the running app

- [ ] **Step 1: Stream into the card.** The card already inserts above the typing bubble before the performer starts (`ensureLiveDirectionCardInStream`). Have it appear at the *start* of the Director call and fill as chunks arrive. `openStoryStreamPreview`/`updateStoryStreamPreview` are the established pattern for cumulative text plus a reasoning disclosure that un-hides once reasoning is non-empty — follow them rather than inventing a second shape.

- [ ] **Step 2: Show typed entries distinctly**, with `secret` visually marked as withheld from the Narrator.

- [ ] **Step 3: Add a notebook view** for the Timeline: entries by turn, filterable by type, individually deletable.

- [ ] **Step 4: Replace `composing…`.** It is a CSS `:empty::after` rule at `style.css:2792`. With the Director streaming there is real text to show for most of the wait; the placeholder should only cover the gap before the first chunk.

- [ ] **Step 5: Commit.**

```bash
git commit -m "feat(remodel): watch the Director think, and keep its notebook"
```

---

### Task 10: Verify the loop in the running app

**Files:** none — verification only. Requires the owner's live API connection.

- [ ] **Step 1:** Send a message. Confirm it posts as a bubble immediately, before the Director card appears.
- [ ] **Step 2:** Confirm the Director's text streams into its card as it is written.
- [ ] **Step 3:** Export the debug bundle and confirm `instructionChars` is gone and the reply's length is no longer competing with reasoning for the response allowance.
- [ ] **Step 4:** Confirm the Narrator's assembled prompt contains no user-authored message and no `secret` entry. This is the check that matters most; a leak here defeats the entire type.
- [ ] **Step 5:** Write a Director recipe that omits the state fence and confirm the scene still runs, with a journal entry and no state change.
- [ ] **Step 6:** Run two consecutive turns and confirm the prose differs — the original complaint.

---

## Self-review notes

**Spec coverage.** Loop → Tasks 6, 7. Badge contract → Task 5. Parsing → Task 1. Notebook → Task 2. Narrator block → Tasks 3, 4. History filter → Task 8. Deletions (`getDirectionEnvelopeSchema`, `withCapturedResponse`, the depth-0 injection) → Task 6. Streaming UI → Task 9. Risks: secret leakage → Tasks 2, 8, 10; tail fragility → Task 1; partial notes → Task 6 Step 4.

**Known gap, deliberately left.** Notebook growth over a long scene has no pruning policy beyond whatever cap Task 2 sets. The spec puts this out of scope; if a Timeline accumulates hundreds of entries the store will need a trim, and `depth` bounds only what the *Narrator* reads, not what is stored.

**Latency is unchanged by this plan.** The measured 101–202s Director call is a property of the owner's connection and model. This work makes the wait legible and the output useful; it does not make it shorter.
