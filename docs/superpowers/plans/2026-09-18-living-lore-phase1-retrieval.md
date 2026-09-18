# Living Lore Phase 1 — Retrieval Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Loom emits `loreKeywords` as keyword *groups*; each unseen group pulls native World Info entries (scoped to timeline-bound + active books, native-faithful matching, groups scanned separately) into a per-Scene Living Lore cache that renders through `{{loom.lore}}`.

**Architecture:** A new Scene-scoped cache store (`livingLoreCacheV1`) holds per-Scene entry-ref pointers (`{book, uid}`) and the deduped set of keyword groups queried. A new retrieval module reuses the extension's existing native-faithful matcher (`matchEntry`, extracted from `story-world-info.js` into a shared scan module) over an explicit book list — never raw `checkWorldInfo`, which cannot be book-scoped without disturbing the real turn. `live-direction.js` consumes parsed groups after the Loom pass and unions activated refs into the Scene cache; `buildDirectionSnapshot` reads the cache back into `snapshot.livingLore` so the surviving `{{loom.lore}}` macro renders the pulled entries.

**Tech Stack:** Vanilla ES modules (SillyTavern extension); Jest (experimental-vm-modules); native SillyTavern World Info API via `getContext()` and direct imports from `public/scripts/world-info.js`.

**Spec:** `docs/superpowers/specs/2026-09-18-living-lore-lorebook-cache-design.md` (Phase 1 = §4).

## Global Constraints

- **CRLF line endings** on all files (project norm). Use Edit to preserve them; do not convert to LF.
- **No legacy toggles** — this is a live experimental extension; make the change, no feature flags or compat shims.
- **Mutation-test every new assertion** — this repo has certified false properties three times. After a test passes, mutate the implementation (flip a boolean, drop a filter, change a constant) and confirm the test goes red before trusting it.
- **Test command** (from repo root): `cd tests && node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json <suite> --silent`
- **Ref identity is `{book, uid}`** everywhere, matching native `${entry.world}.${entry.uid}` and `loreEntryKey` (`living-lore-model.js:14-19`). `book` is the World Info file name; `uid` is String-coerced.
- **Scope deferred beyond Phase 1** (do NOT build): secret/Narrator split, edit/import/create, Goals/Variables refold, prior-Scene keyword macro, UI, eviction.

## Design decisions locked by research

- **Do not call `checkWorldInfo`/`getWorldInfoPrompt` for the group scan.** They have no book-list parameter (scope comes from module globals `selected_world_info` / `chat_metadata['world_info']` / character card / persona), and even `isDryRun` does not suppress `WORLDINFO_SCAN_DONE`/`WORLDINFO_ENTRIES_LOADED` events, the Author's Note `setExtensionPrompt` mutation, or the global `WorldInfoBuffer.externalActivations` reset. A synthetic per-group scan through them would corrupt the real turn.
- **Reuse `matchEntry`** from `story-world-info.js` (the extension's own native-faithful matcher, called at `story-world-info.js:149`) plus `context.getWorldInfoEntriesForBook(name)` (loads one book's prepared entries WITHOUT global selection or metadata mutation, `world-info.js:4537`). This gives native selective-logic matching (primary `key` OR + `keysecondary` per `selectiveLogic`) — which is exactly requirement 7's "needs multiple keys" — with zero real-turn side effects.
- **Book scope** = active books ∪ the timeline's bound book: GLOBAL `selected_world_info`, CHAT `chat_metadata['world_info']`, CHARACTER `characters[this_chid].data.extensions.world` + `world_info.charLore[…].extraBooks`, plus `getScene(sceneId)`→ timeline `lorebookName`. (These are the confirmed native active-book sources; imported directly from `world-info.js` / read from `getContext()`.)
- **Insertion point** in `live-direction.js`: between `:2377` (the `parseLoomReply` destructure of `loreKeywords`) and `:2397` (the `deferRequests || !requests.length` early-return). The sole live caller passes `deferRequests: true`, so anything after `:2397` never runs live. `scene.id` / `scene.timelineId` are in scope from the `runLoomReconciliation` `scene` param.
- **Render seam**: `{{loom.lore}}` renders `''` today on live turns because `buildDirectionSnapshot:1297` sets `livingLore: testAdapters?.livingLorePacket || null` and nothing populates it. Phase 1 wires this to a packet built from the Scene cache. `formatLivingLorePacket` (`living-lore-proposals.js:79-97`) is the renderer; `buildLivingLorePacket` (`living-lore-proposals.js:35-76`, protocol `living-lore.loom-packet.v1`) is the packet shape.

## File Structure

- **Create** `public/scripts/extensions/third-party/SillyTavern-Remodel/world-info-scan.js` — shared native-faithful matcher extracted from `story-world-info.js` (`matchEntry` and its direct helpers). One responsibility: given an entry + a scan corpus, decide activation + score.
- **Create** `public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-retrieval.js` — `activateKeywordGroups(groups, { sceneId, timelineId })`: enumerate scoped books, load entries, run the matcher per group separately, return deduped refs.
- **Create** `public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-cache-store.js` — the Scene-scoped `livingLoreCacheV1` store.
- **Modify** `story-world-info.js` — import `matchEntry` from `world-info-scan.js` instead of defining it locally.
- **Modify** `loom-fence-schema.js:122-125` — `loreKeywords` items → array-of-strings (groups).
- **Modify** `loom-reconciliation.js:303-311` — `readLoreKeywords` → parse groups.
- **Modify** `living-lore-proposals.js:93-95`, `metadata-guide.js:62-63,243-249` — model-facing copy → groups (propagates to `prompt-instruction-templates.js` + `debug-console.js` guide row).
- **Modify** `live-direction.js` — consume groups after `:2377` (Task 5); feed cache → `snapshot.livingLore` at `:1297` (Task 6).
- **Test** files under `tests/` mirroring each: `remodel-world-info-scan.test.js`, `remodel-living-lore-retrieval.test.js`, `remodel-living-lore-cache-store.test.js`, plus additions to `remodel-loom-fence-schema.test.js`, and a new `remodel-living-lore-phase1-integration.test.js`.

---

### Task 1: Extract the native-faithful matcher into `world-info-scan.js`

Mechanical extraction so both Story WI and Living Lore retrieval share ONE matcher. Move, don't rewrite.

**Files:**
- Create: `public/scripts/extensions/third-party/SillyTavern-Remodel/world-info-scan.js`
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/story-world-info.js`
- Test: `tests/remodel-world-info-scan.test.js`

**Interfaces:**
- Produces: `export function matchEntry(entry, { corpus, recursionText = [], scanDepth = 0, recursion = false, globalScanData, macroOptions }) → { active: boolean, score: number }` — moved verbatim from `story-world-info.js` (currently called at `story-world-info.js:149`). Also move any module-local helpers it calls that are not otherwise used by `story-world-info.js` (identify by reading `matchEntry`'s body and its callees; move the ones exclusively used by matching, re-export or keep shared ones).

- [ ] **Step 1: Read `matchEntry` and its callees in `story-world-info.js`.** List every helper `matchEntry` calls and whether each is used elsewhere in the file. Helpers used ONLY by matching move to `world-info-scan.js`; helpers shared with the activation loop stay in `story-world-info.js` and are imported by `world-info-scan.js` (or vice-versa — choose the direction that yields no circular import; if circular, move the shared leaf helpers too).

- [ ] **Step 2: Write the characterization test (before moving anything).**

```js
// tests/remodel-world-info-scan.test.js
import { matchEntry } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-info-scan.js';

const entry = (over) => ({ uid: 1, world: 'Book', key: ['Rayse'], keysecondary: [], selective: false, selectiveLogic: 0, content: 'x', disable: false, caseSensitive: null, matchWholeWords: null, scanDepth: null, ...over });

test('primary key matches when present in corpus', () => {
    const r = matchEntry(entry({}), { corpus: ['rayse walked in'], globalScanData: {}, macroOptions: {} });
    expect(r.active).toBe(true);
});

test('primary key absent → not active', () => {
    const r = matchEntry(entry({ key: ['Silvia'] }), { corpus: ['rayse walked in'], globalScanData: {}, macroOptions: {} });
    expect(r.active).toBe(false);
});

test('AND_ALL selective needs both keys in corpus', () => {
    const sel = entry({ key: ['event'], keysecondary: ['Rayse'], selective: true, selectiveLogic: 2 /* AND_ALL */ });
    expect(matchEntry(sel, { corpus: ['an event with Rayse'], globalScanData: {}, macroOptions: {} }).active).toBe(true);
    expect(matchEntry(sel, { corpus: ['an event with Silvia'], globalScanData: {}, macroOptions: {} }).active).toBe(false);
});
```

(If reading `matchEntry` shows its options object differs from the above, adjust the test calls to the real signature discovered in Step 1 — the assertions on active/inactive stay.)

- [ ] **Step 3: Run the test to confirm it fails.** Run: `cd tests && node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-world-info-scan --silent`. Expected: FAIL (module `world-info-scan.js` does not exist).

- [ ] **Step 4: Create `world-info-scan.js` and move `matchEntry` + its match-only helpers into it (verbatim), exporting `matchEntry`.** Update any imports they need (e.g. `world_info_logic` from `../../../world-info.js`, string helpers). Keep CRLF.

- [ ] **Step 5: Update `story-world-info.js` to import `matchEntry` from `./world-info-scan.js`** and delete the moved definitions. Do not change the call site at `:149`.

- [ ] **Step 6: Run the new test AND the existing Story WI suite.** Run: `... remodel-world-info-scan --silent` (PASS) and `... remodel-story-world-info --silent` (still PASS — proves the extraction preserved behavior).

- [ ] **Step 7: Mutation check.** In `matchEntry`, temporarily invert the primary-key hit (e.g. negate the "key found" condition); re-run `remodel-world-info-scan` and confirm it goes RED. Revert.

- [ ] **Step 8: Commit.**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/world-info-scan.js public/scripts/extensions/third-party/SillyTavern-Remodel/story-world-info.js tests/remodel-world-info-scan.test.js
git commit -m "refactor(remodel): extract native-faithful matchEntry into world-info-scan"
```

---

### Task 2: Book-scoped, group-fed retrieval — `living-lore-retrieval.js`

**Files:**
- Create: `public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-retrieval.js`
- Test: `tests/remodel-living-lore-retrieval.test.js`

**Interfaces:**
- Consumes: `matchEntry` (Task 1); `getWorldInfoEntriesForBook(name)` from `getContext()` (returns `[{ uid, world, key, keysecondary, selective, selectiveLogic, content, disable, ... }]`); `getScene(sceneId)` from `./timeline-state.js`; the timeline's `lorebookName`.
- Produces: `export async function activateKeywordGroups(groups, { sceneId = '', timelineId = '' } = {}) → Array<{ book, uid, name, keys, secondaryKeys, content }>` — deduped by `${book}.${uid}`. Also `export function scopedBookNames({ sceneId, timelineId }) → string[]` (the active ∪ timeline-bound book list) so it is independently testable.

- [ ] **Step 1: Write the failing test for `scopedBookNames`.**

```js
// tests/remodel-living-lore-retrieval.test.js
import { __setContext } from './util/st-context-stub.js'; // (use the project's existing context stub; match its real name/path)
import { scopedBookNames, activateKeywordGroups } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-retrieval.js';

test('scopedBookNames unions active books with the timeline book, deduped', () => {
    __setContext({ /* selected_world_info: ['Global'], chatMetadata: { world_info: 'Chat' }, characters: [...], characterId: 0, timeline lorebookName: 'TL' */ });
    const books = scopedBookNames({ sceneId: 's1', timelineId: 't1' });
    expect(new Set(books)).toEqual(new Set(['Global', 'Chat', 'TL']));
});
```

(Fill the stub setup to match how `tests/util/st-context-stub.js` exposes `selected_world_info`, `chat_metadata`, `characters`, and how the timeline store is seeded — read an existing suite such as `remodel-story-world-info.test.js` or `remodel-loom-turn.test.js` for the exact stub API before writing this.)

- [ ] **Step 2: Run → fails** (module missing). Command as above with `remodel-living-lore-retrieval`.

- [ ] **Step 3: Implement `scopedBookNames`.**

```js
import { getContext } from '../../../st-context.js'; // match the real relative path used by sibling modules
import { selected_world_info } from '../../../world-info.js';
import { getScene, getTimelineStore } from './timeline-state.js';

export function scopedBookNames({ sceneId = '', timelineId = '' } = {}) {
    const ctx = getContext();
    const names = new Set();
    for (const n of Array.isArray(selected_world_info) ? selected_world_info : []) if (n) names.add(String(n));
    const chatBook = ctx.chatMetadata?.world_info;
    if (chatBook) names.add(String(chatBook));
    const character = ctx.characters?.[ctx.characterId];
    const charBook = character?.data?.extensions?.world;
    if (charBook) names.add(String(charBook));
    const tid = String(timelineId || getScene(sceneId)?.timelineId || '');
    const tlBook = tid ? getTimelineStore()?.timelines?.[tid]?.lorebookName : '';
    if (tlBook) names.add(String(tlBook));
    return [...names];
}
```

Confirm the exact import names while reading `timeline-state.js`: `getScene` is exported (`timeline-state.js:337`); verify `getTimelineStore` is exported and that a timeline object carries `lorebookName` (research: `timeline-state.js:44-49`). If the store getter has a different exported name, use that one — the shape (`.timelines[tid].lorebookName`) is confirmed.

- [ ] **Step 4: Run → `scopedBookNames` test passes.**

- [ ] **Step 5: Write the failing test for `activateKeywordGroups` (per-group separate scan + dedup).**

```js
test('a group with two keys activates only an AND_ALL entry satisfied within that group', async () => {
    __setContext({ /* one book "TL" with entries:
        uid 1: key ['event'], keysecondary ['Rayse'], selective true, selectiveLogic AND_ALL
        uid 2: key ['Silvia'] */ });
    const refs = await activateKeywordGroups([['event', 'Rayse']], { sceneId: 's1', timelineId: 't1' });
    expect(refs.map(r => r.uid)).toEqual(['1']);
});

test('two separate groups do not cross-activate an AND_ALL entry needing one key from each', async () => {
    __setContext({ /* uid 1: key ['event'], keysecondary ['Silvia'], AND_ALL */ });
    const refs = await activateKeywordGroups([['event', 'Rayse'], ['Rayse', 'Silvia']], { sceneId: 's1', timelineId: 't1' });
    expect(refs).toEqual([]); // event+Silvia never co-occur in one group
});

test('an entry reachable from two groups appears once (dedup)', async () => {
    __setContext({ /* uid 7 key ['Rayse'] in book TL */ });
    const refs = await activateKeywordGroups([['Rayse'], ['Rayse', 'x']], { sceneId: 's1', timelineId: 't1' });
    expect(refs.filter(r => r.uid === '7')).toHaveLength(1);
});
```

- [ ] **Step 6: Run → fails.**

- [ ] **Step 7: Implement `activateKeywordGroups`.**

```js
import { matchEntry } from './world-info-scan.js';

export async function activateKeywordGroups(groups, { sceneId = '', timelineId = '' } = {}) {
    const list = Array.isArray(groups) ? groups.filter(g => Array.isArray(g) && g.length) : [];
    if (!list.length) return [];
    const ctx = getContext();
    const books = scopedBookNames({ sceneId, timelineId });
    // Load each book's prepared entries once (side-effect-free).
    const byBook = new Map();
    for (const name of books) {
        try { byBook.set(name, await ctx.getWorldInfoEntriesForBook(name) || []); }
        catch { byBook.set(name, []); }
    }
    const out = new Map(); // key `${book}.${uid}` -> ref
    for (const group of list) {
        const corpus = [group.join('\n')]; // one scan slot; matchEntry scores keys against corpus text
        for (const [name, entries] of byBook) {
            for (const entry of entries) {
                if (entry.disable === true) continue;
                const key = `${name}.${String(entry.uid)}`;
                if (out.has(key)) continue;
                const m = matchEntry(entry, { corpus, recursionText: [], scanDepth: 0, recursion: false, globalScanData: {}, macroOptions: {} });
                if (!m.active) continue;
                out.set(key, {
                    book: name, uid: String(entry.uid),
                    name: entry.comment || (Array.isArray(entry.key) ? entry.key[0] : '') || `Entry ${entry.uid}`,
                    keys: Array.isArray(entry.key) ? [...entry.key] : [],
                    secondaryKeys: Array.isArray(entry.keysecondary) ? [...entry.keysecondary] : [],
                    content: String(entry.content ?? ''),
                });
            }
        }
    }
    return [...out.values()];
}
```

(If Step 1 of Task 1 revealed `matchEntry` needs a non-empty `globalScanData`/`macroOptions` to avoid throwing, pass `defaultGlobalScanData` imported from `world-info.js` and `{}` respectively; adjust and note it. The `corpus` is a `string[]` of scan slots — confirm against `matchEntry`'s corpus handling from Task 1.)

- [ ] **Step 8: Run → the three `activateKeywordGroups` tests pass.**

- [ ] **Step 9: Mutation check.** Change `corpus` to join ALL groups into one slot (`[list.flat().join('\n')]`) instead of per-group; confirm the "two separate groups do not cross-activate" test goes RED (proves groups are scanned separately). Revert.

- [ ] **Step 10: Commit.**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-retrieval.js tests/remodel-living-lore-retrieval.test.js
git commit -m "feat(remodel): book-scoped, per-group Living Lore retrieval"
```

---

### Task 3: Scene-scoped Living Lore cache store — `living-lore-cache-store.js`

**Files:**
- Create: `public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-cache-store.js`
- Test: `tests/remodel-living-lore-cache-store.test.js`

**Interfaces:**
- Produces:
  - `export function getSceneLivingLore(sceneId, { create = true } = {}) → { sceneId, entryRefs: { [key]: { book, uid } }, keywordGroups: string[][] } | null`
  - `export function unseenGroups(sceneId, groups) → string[][]` — the subset of `groups` whose canonical form is not already in the Scene's `keywordGroups` set.
  - `export function recordKeywordGroups(sceneId, groups) → void` — add each new group (deduped, canonicalized) to the Scene's set.
  - `export function addEntryRefs(sceneId, refs) → void` — union `{book, uid}` refs into `entryRefs` keyed `${book}.${uid}`.
  - `export function listSceneEntryRefs(sceneId) → Array<{ book, uid }>`
- Storage: `extensionSettings['remodel']['livingLoreCacheV1'] = { version: 1, scenes: { [sceneId]: bucket } }`. This is a NEW key; do NOT touch `livingLoreV1`. Canonical group form = the group's keywords trimmed, deduped, **sorted**, joined by `` (so `["a","b"]` and `["b","a"]` dedupe to one).

- [ ] **Step 1: Write failing tests.**

```js
// tests/remodel-living-lore-cache-store.test.js
import { __setExtensionSettings } from './util/st-context-stub.js';
import { getSceneLivingLore, unseenGroups, recordKeywordGroups, addEntryRefs, listSceneEntryRefs } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-cache-store.js';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('a fresh Scene has empty refs and groups', () => {
    const b = getSceneLivingLore('s1');
    expect(b).toMatchObject({ sceneId: 's1', entryRefs: {}, keywordGroups: [] });
});

test('recordKeywordGroups dedups order-insensitively', () => {
    recordKeywordGroups('s1', [['a', 'b'], ['b', 'a'], ['c']]);
    expect(getSceneLivingLore('s1').keywordGroups).toHaveLength(2);
});

test('unseenGroups returns only groups not yet recorded', () => {
    recordKeywordGroups('s1', [['a', 'b']]);
    expect(unseenGroups('s1', [['b', 'a'], ['c']])).toEqual([['c']]);
});

test('addEntryRefs unions and dedups by book.uid; is Scene-isolated', () => {
    addEntryRefs('s1', [{ book: 'TL', uid: '1' }, { book: 'TL', uid: '1' }, { book: 'TL', uid: '2' }]);
    expect(listSceneEntryRefs('s1')).toHaveLength(2);
    expect(listSceneEntryRefs('s2')).toEqual([]);
});
```

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Implement the store** (mirror the shape/normalization pattern of `living-lore-store.js:4-34,97-99` — `getContext().extensionSettings['remodel']`, lazy create + normalize, a `save` that writes back; group canonical form as specified in Interfaces). Provide `getSceneLivingLore`, `unseenGroups`, `recordKeywordGroups`, `addEntryRefs`, `listSceneEntryRefs`, and an internal `saveStore()`.

- [ ] **Step 4: Run → passes.**

- [ ] **Step 5: Mutation check.** Change the canonical form to NOT sort (join raw order); confirm the "dedups order-insensitively" test goes RED. Revert.

- [ ] **Step 6: Commit.**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-cache-store.js tests/remodel-living-lore-cache-store.test.js
git commit -m "feat(remodel): Scene-scoped Living Lore cache store"
```

---

### Task 4: `loreKeywords` becomes keyword groups (fence + parser + copy)

All three must change together or the provider-enforced envelope and the instructions disagree.

**Files:**
- Modify: `loom-fence-schema.js:122-125` (and keep `loreKeywords` in `required` at `:91`)
- Modify: `loom-reconciliation.js:303-311` (`readLoreKeywords`; add a group-count constant)
- Modify: `living-lore-proposals.js:93-95` (Copy #1 — the live macro copy)
- Modify: `metadata-guide.js:62-63, 243-249` (Copy #2/#3 — propagates to `prompt-instruction-templates.js` + `debug-console.js`)
- Modify: `tests/remodel-loom-fence-schema.test.js` (schema shape assertion)
- Test: extend `tests/remodel-loom-reconciliation.test.js` (or the suite that covers `parseLoomReply`/`readLoreKeywords` — locate it first) with group-parsing cases.

**Interfaces:**
- `readLoreKeywords(value) → string[][]` (was `string[]`). Bounds: at most `MAX_LORE_KEYWORD_GROUPS` groups (new const, value `8`), each group at most `MAX_LORE_KEYWORDS` (existing `8`) keywords, each keyword capped at `MAX_LORE_KEYWORD_CHARS` (existing `120`); trim, drop empty keywords, drop empty groups, dedup keywords within a group.

- [ ] **Step 1: Write the failing parser test.**

```js
// in the suite that imports parseLoomReply / readLoreKeywords
import { readLoreKeywords } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-reconciliation.js';

test('readLoreKeywords parses groups (array of arrays) and drops empties', () => {
    expect(readLoreKeywords([['event', 'Rayse'], ['Rayse', ''], [], ['Silvia']]))
        .toEqual([['event', 'Rayse'], ['Rayse'], ['Silvia']]);
});
test('readLoreKeywords returns [] for non-array / flat garbage', () => {
    expect(readLoreKeywords('x')).toEqual([]);
    expect(readLoreKeywords(['flat', 'strings'])).toEqual([]); // flat is no longer valid
});
```

(If `readLoreKeywords` is not exported, export it, or test it via `parseLoomReply(JSON.stringify({ loreKeywords: [[...]] , requests: [], swaps: [], loreProposals: [], flow: {} }))` and assert `.loreKeywords`.)

- [ ] **Step 2: Run → fails** (current parser flattens/String-coerces).

- [ ] **Step 3: Rewrite `readLoreKeywords`** to iterate groups → keywords with the bounds above; add `export const MAX_LORE_KEYWORD_GROUPS = 8;`. Keep `MAX_LORE_KEYWORDS` / `MAX_LORE_KEYWORD_CHARS`.

- [ ] **Step 4: Run → parser tests pass.**

- [ ] **Step 5: Write the failing schema test** in `remodel-loom-fence-schema.test.js`:

```js
test('loreKeywords is an array of string-array groups', () => {
    const kw = getRoleplayLoomGoalSchema().schema.properties.loreKeywords;
    expect(kw.type).toBe('array');
    expect(kw.items.type).toBe('array');
    expect(kw.items.items.type).toBe('string');
});
```

- [ ] **Step 6: Run → fails.**

- [ ] **Step 7: Update the schema** at `loom-fence-schema.js:122-125`:

```js
loreKeywords: {
    type: 'array', maxItems: 8,
    description: 'Keyword GROUPS to pull working lore for the turns that follow. Each group is an array of the exact keys an entry answers to; an entry that needs several keys (e.g. an event tied to a character) is found only when they are named together in one group. Empty for no change.',
    items: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
},
```

Keep `loreKeywords` in `required` (`:91`) and `strict: true` unchanged.

- [ ] **Step 8: Run → schema test + the existing `the whole schema is strict-mode valid` test both pass.**

- [ ] **Step 9: Update model-facing copy to groups** — verbatim edits, kept in lockstep:
  - `living-lore-proposals.js:93` inline example → `{"loreKeywords":[["Queens Lake University"],["event","Marissa"]]}`, and reword L93-95 to describe groups (each inner array is one lookup; multi-key entries need their keys in one group).
  - `metadata-guide.js:62-63` envelope example → `"loreKeywords":[["Queens Lake University"],["event","Marissa"]]` and purpose text → groups.
  - `metadata-guide.js:244` example → `JSON.stringify({ loreKeywords: [['Queens Lake University'], ['event', 'Marissa']] })`; `:246` argument hint → `'array of keyword groups (each an array of exact keys)'`; `:248` note unchanged in intent (adjust wording if it says "array of strings").
  - Read `prompt-instruction-templates.js:167-179` and `debug-console.js:809-813` after the `metadata-guide` edit to confirm they now render groups phrasing (they derive from `guide.lore.keywords` — no separate edit needed, but verify).

- [ ] **Step 10: Run the full affected suites** — `remodel-loom-fence-schema`, `remodel-loom-reconciliation`, `remodel-metadata-guide`, `remodel-prompt-instruction-templates`, `remodel-prompt-studio-store` — all green. Fix any copy assertion that pinned the old flat example.

- [ ] **Step 11: Mutation check.** Make `readLoreKeywords` keep empty groups (drop the empty-group filter); confirm the parser test goes RED. Revert.

- [ ] **Step 12: Commit.**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/loom-fence-schema.js public/scripts/extensions/third-party/SillyTavern-Remodel/loom-reconciliation.js public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-proposals.js public/scripts/extensions/third-party/SillyTavern-Remodel/metadata-guide.js tests/remodel-loom-fence-schema.test.js tests/remodel-loom-reconciliation.test.js
git commit -m "feat(remodel): loreKeywords becomes keyword groups (fence, parser, copy)"
```

---

### Task 5: Consume groups in `live-direction.js` and populate the Scene cache

**Files:**
- Modify: `live-direction.js` (between `:2377` and `:2397`, inside `runLoomReconciliation`)
- Test: `tests/remodel-living-lore-phase1-integration.test.js`

**Interfaces:**
- Consumes: `unseenGroups`, `recordKeywordGroups`, `addEntryRefs` (Task 3); `activateKeywordGroups` (Task 2). `scene.id`, `scene.timelineId` in scope.

- [ ] **Step 1: Write the failing integration test** driving `runLoomReconciliation` via the existing test adapters (read `remodel-loom-turn.test.js` / `remodel-loom-reconciliation.test.js` for how they stub a Loom reply and call the turn). Assert: a Loom reply whose `loreKeywords` = `[["Rayse"]]`, with a stubbed book containing a `Rayse` entry, results in `listSceneEntryRefs(sceneId)` containing that entry's ref, and `getSceneLivingLore(sceneId).keywordGroups` containing the group.

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Add the consume block** immediately after the `parseLoomReply` destructure (`:2377`), before the `deferRequests` return (`:2397`):

```js
if (Array.isArray(loreKeywords) && loreKeywords.length && scene?.id) {
    const fresh = unseenGroups(scene.id, loreKeywords);
    if (fresh.length) {
        try {
            const refs = await activateKeywordGroups(fresh, { sceneId: scene.id, timelineId: scene.timelineId });
            addEntryRefs(scene.id, refs);
            recordKeywordGroups(scene.id, fresh);
        } catch (error) {
            journal('living-lore.retrieval.failed', { error: String(error?.message || error) }, { severity: 'warn' });
        }
    }
}
```

Add the imports at the top of `live-direction.js`: `activateKeywordGroups` from `./living-lore-retrieval.js`; `unseenGroups`, `recordKeywordGroups`, `addEntryRefs` from `./living-lore-cache-store.js`. (`journal` already exists in this file.)

- [ ] **Step 4: Run → integration test passes.**

- [ ] **Step 5: Run the full loom/live-direction suites** (`remodel-loom-turn`, `remodel-loom-reconciliation`, `remodel-loom-reconciliation-integration`, `remodel-narrator-delivery`, `remodel-connection-profile-activation`) — all still green.

- [ ] **Step 6: Mutation check.** Replace `unseenGroups(scene.id, loreKeywords)` with `loreKeywords` (re-query every group every turn); this should NOT change the integration test's final refs but SHOULD break a dedup assertion — add an assertion that a group queried twice across two turns activates its book load once (spy on `getWorldInfoEntriesForBook` call count), then confirm the mutation reddens it. Revert.

- [ ] **Step 7: Commit.**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js tests/remodel-living-lore-phase1-integration.test.js
git commit -m "feat(remodel): Loom keyword groups populate the Scene Living Lore cache"
```

---

### Task 6: Render the cache — feed `snapshot.livingLore` from the Scene cache

Closes the loop so `{{loom.lore}}` shows the pulled entries on a real turn.

**Files:**
- Modify: `live-direction.js:1297` (`buildDirectionSnapshot`)
- Create: `public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-cache-packet.js` — build a `living-lore.loom-packet.v1` packet from the Scene cache (re-reading entry content fresh).
- Test: extend `tests/remodel-living-lore-phase1-integration.test.js`

**Interfaces:**
- Produces: `export async function buildSceneLivingLorePacket({ sceneId, timelineId }) → packet | null` where `packet` matches `buildLivingLorePacket`'s output shape (`living-lore-proposals.js:35-76`): `{ protocol:'living-lore.loom-packet.v1', timelineId, book, bookHash, entries:[{ target:{book,uid,revision}, name, entryType, protectedFields, keys, secondaryKeys, content, selectedBecause }], bounds:{...} }`. Content is re-read from native WI (via `getContext().getWorldInfoEntriesForBook`) so a later edit reflects immediately (pointers, not snapshots).

- [ ] **Step 1: Write the failing render test.** Seed a Scene cache with one ref (book `TL`, uid `1`, whose native entry has content "Rayse is a knight"), then assert `formatLivingLorePacket(await buildSceneLivingLorePacket({ sceneId, timelineId }))` (import `formatLivingLorePacket` from `living-lore-proposals.js`) contains "Rayse is a knight".

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Implement `buildSceneLivingLorePacket`.** Read `listSceneEntryRefs(sceneId)`; for each ref, load its current native entry (`getWorldInfoEntriesForBook(book)` → find `uid`); map to a packet entry (`target:{book,uid,revision:1}`, `name`, `entryType:'entity'`, `protectedFields:[]`, `keys`, `secondaryKeys`, `content`, `selectedBecause:'loom-keywords'`); assemble the packet using `buildLivingLorePacket` from `living-lore-proposals.js` (pass `entries` + `book`=the first ref's book + `timelineId`) so the shape/bounds are reused, not re-derived. Return `null` when there are no refs.

- [ ] **Step 4: Wire the snapshot seam.** In `buildDirectionSnapshot` at `:1297`, replace `livingLore: testAdapters?.livingLorePacket || null` with:

```js
livingLore: testAdapters?.livingLorePacket || await buildSceneLivingLorePacket({ sceneId: scene?.id || '', timelineId: scene?.timelineId || '' }),
```

Confirm `buildDirectionSnapshot` is `async` and `scene` is in scope there (it is — read the surrounding function; if the identity is on a different local, use it). Import `buildSceneLivingLorePacket` at the top.

- [ ] **Step 5: Run → render test passes; then run the full end-to-end integration** (Loom emits groups → cache populated → next snapshot's `livingLore` packet renders the entry through `{{loom.lore}}`). Extend the integration test to assert the round-trip.

- [ ] **Step 6: Run the whole remodel suite** to confirm nothing regressed: `cd tests && node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel- --silent`. Expect all green.

- [ ] **Step 7: Mutation check.** Make `buildSceneLivingLorePacket` ignore `listSceneEntryRefs` and return `null`; confirm the render + round-trip tests go RED. Revert.

- [ ] **Step 8: Commit.**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-cache-packet.js public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js tests/remodel-living-lore-phase1-integration.test.js
git commit -m "feat(remodel): render the Scene Living Lore cache through {{loom.lore}}"
```

---

## Self-review notes

- **Spec coverage:** Phase 1 = spec §4 (requirement 1). Tasks 1-2 = per-group native-faithful retrieval; Task 3 = per-Scene cache + group-set memory (also the substrate for req 7/8 later); Task 4 = grouped `loreKeywords` fence/parser/copy; Task 5 = the consume loop; Task 6 = the `{{loom.lore}}` render seam. Deferred items (secret, edit/import/create, goals/variables, prior-scene macro, UI, eviction) are explicitly out of Phase 1 per Global Constraints.
- **Placeholders:** the only intentional "force-you-to-wire" marker is the `require && null` line in Task 2 Step 3, which Step 3 explicitly instructs to replace with the real `timeline-state.js` getter — not shipped.
- **Type consistency:** ref shape `{book, uid}` (strings) is used identically across Tasks 2, 3, 6; `activateKeywordGroups` returns the richer `{book,uid,name,keys,secondaryKeys,content}` (superset), and the cache stores only `{book,uid}` — Task 6 re-reads content fresh, consistent with the pointers-not-snapshots decision.
- **Open confirmation for the executor:** Task 1 Step 1 must confirm `matchEntry`'s exact option object and `corpus` format; Tasks 2/6 pass `corpus` as `string[]` accordingly. If `matchEntry` proves too entangled to extract cleanly, fall back to a minimal Remodel matcher (primary `key` OR + `keysecondary` per `selectiveLogic` AND_ALL/AND_ANY, case-insensitive substring) — but only after attempting the extraction, and note the divergence from native fidelity.
