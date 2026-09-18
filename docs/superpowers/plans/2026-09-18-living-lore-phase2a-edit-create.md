# Living Lore Phase 2A — Loom edit / create Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: implement task-by-task; each task ends green + mutation-checked + committed. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The Loom can EDIT a cached lore entry's content and CREATE a new entry, by emitting typed `loreOps` in its fence; code writes native World Info (read-modify-write + rollback). Import needs no new op — it's the Phase-1 `loreKeywords` keyword pull.

**Architecture:** A new `loreOps` array in the provider-enforced fence (mirroring `requests`), parsed alongside `loreKeywords`, carried into the run envelope on the streaming pass, and APPLIED ONCE on the commit/finalize path (never eagerly, so retries don't double-write). A new `living-lore-ops.js` module does the native writes with the proven load→clone→mutate→`saveWorldInfo(book, working, true)`→restore-on-fail pattern. `lore.edit` is refused unless its `{book, uid}` is in the Scene cache; `lore.create` writes to the timeline's bound book and enters the cache.

**Tech Stack:** Vanilla ES modules; Jest (experimental-vm-modules); native World Info via `getContext()` (`loadWorldInfo`, `saveWorldInfo`) and direct import of `createWorldInfoEntry`/`deleteWorldInfoEntry` from `world-info.js`.

**Spec:** `docs/superpowers/specs/2026-09-18-living-lore-lorebook-cache-design.md` §6.

**Scope note:** This is Phase **2A** (build the new typed ops). Phase **2B** (retire the untyped information-report intake: `loreProposals` field, `applyLoomLoreReports`, the `living-lore-intake-runtime`/`writer`/`withdrawal`/`intake` cluster + ledger) is a separate plan that follows once 2A is green. During 2A the untyped path stays live and untouched.

## Global Constraints

- **CRLF line endings**; use Edit to preserve. **No legacy toggles.** **Mutation-test every new assertion** (repo has certified false properties). **Test command:** `cd tests && node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json <suite> --silent`.
- Ref identity is `{book, uid}` (strings), = native `${world}.${uid}`.
- **Native write pattern (mandatory):** `const original = await ctx.loadWorldInfo(book); const working = structuredClone(original); …mutate working.entries…; try { await ctx.saveWorldInfo(book, working, true); } catch { await ctx.saveWorldInfo(book, original, true); throw; }`. Never mutate the object `loadWorldInfo` returns (it is the live cache by reference). `immediately=true` is required (the debounced path races a following read).
- `createWorldInfoEntry` / `deleteWorldInfoEntry` are NOT on `getContext()` — import from `../../../world-info.js`. `deleteWorldInfoEntry(data, uid, { silent: true })` — `silent:true` is required or it shows a confirm Popup. (2A does not delete; noted for later.)
- entries object keys are stringified uids; `entry.uid` is a Number. `entry.content`, `entry.key` (array), `entry.keysecondary` (array), `entry.comment` (title).
- Cap written content at 12000 chars (`MAX_ENTRY_CHARS`, matching the existing writer).

## Design decisions (locked)

- **Ops:** `lore.edit` = `{ book, uid, content }` (rewrite content of a cached entry). `lore.create` = `{ name, keys, content, secondaryKeys? }` (new entry).
- **Edit enforcement:** the `{book, uid}` MUST be in `listSceneEntryRefs(scene.id)`; otherwise the op is refused (journalled), never written. (The Loom learns valid `{book,uid}` from the `{{loom.lore}}` render's `target` fields.)
- **Create destination:** the timeline's bound book (`getTimelineStore().timelines[timelineId]?.lorebookName`). If the timeline has no bound book, the create op is **refused + journalled** (2A does not auto-create books). After a successful create, its `{book, uid}` is added to the Scene cache (`addEntryRefs`).
- **Apply timing:** loreOps are parsed on the streaming pass and carried into `run.envelope.loreOps`; they are APPLIED on the commit/finalize path (inside `queueAcceptedLoreProposals`, live-direction.js ~2918, which runs once per committed turn alongside `executeDirectionRequests(pending)` and `applyLoomLoreReports`). NOT applied in `runLoomReconciliation`'s eager window.

## File Structure

- **Create** `living-lore-ops.js` — `applyLoreOps({ sceneId, timelineId, ops })`: native-WI edit + create with rollback and cache update.
- **Modify** `loom-fence-schema.js` — add the `loreOps` array to the strict schema.
- **Modify** `loom-reconciliation.js` — `readLoreOps` parser + `loreOps` in `parseLoomReply`'s destructure/return + `isLoomEnvelope`.
- **Modify** `live-direction.js` — destructure `loreOps`, carry into the envelope, apply on the finalize path.
- **Test** `remodel-living-lore-ops.test.js` (new), additions to `remodel-loom-fence-schema.test.js` and `remodel-loom-keyword-groups.test.js` (or a new `remodel-loom-ops.test.js`), and additions to `remodel-living-lore-phase1-integration.test.js`.

---

### Task 1: `living-lore-ops.js` — native-WI edit + create writer

**Files:**
- Create: `public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-ops.js`
- Test: `tests/remodel-living-lore-ops.test.js`

**Interfaces:**
- Consumes: `getContext()` (`loadWorldInfo`, `saveWorldInfo`); `listSceneEntryRefs`, `addEntryRefs` from `./living-lore-cache-store.js`; `getScene`, `getTimelineStore` from `./timeline-state.js`.
- Produces: `export async function applyLoreOps({ sceneId = '', timelineId = '', ops = [] }) → { applied: Array<{op,book,uid}>, refused: Array<{op,reason}> }`. Each op is `{ op:'lore.edit'|'lore.create', book?, uid?, name?, keys?, secondaryKeys?, content }`. `lore.edit`: refuse unless `${book}.${uid}` ∈ `listSceneEntryRefs(sceneId)`; else load book, rewrite `entries[uid].content` (capped), save, restore-on-fail. `lore.create`: resolve `book = getTimelineStore().timelines[tid]?.lorebookName`; refuse if none; build a native entry (uid via first-free-integer, `key = keys`, `keysecondary = secondaryKeys||[]`, `comment = name`, `content` capped, `selective: keys+secondary needs`, defaults), assign `entries[uid]`, save, then `addEntryRefs(sceneId, [{book, uid}])`.

- [ ] **Step 1: Write failing tests.**

```js
// tests/remodel-living-lore-ops.test.js
import { __setExtensionSettings, __setContextOverrides } from './util/st-context-stub.js';
import { createTimeline, updateTimeline, createArc, createScene } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-state.js';
import { addEntryRefs, listSceneEntryRefs } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-cache-store.js';
import { applyLoreOps } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-ops.js';

function seed({ lorebookName = 'TL' } = {}) {
    __setExtensionSettings({ remodel: {} });
    const tl = createTimeline('T');
    if (lorebookName) updateTimeline(tl.id, { lorebookName });
    const arc = createArc(tl.id, 'A');
    const scene = createScene(arc.id, 'roleplay', 'S');
    return { timelineId: tl.id, sceneId: scene.id };
}
// In-memory native WI book behind loadWorldInfo/saveWorldInfo.
function withBook(entries) {
    const books = { TL: { entries: { ...entries } } };
    __setContextOverrides({
        async loadWorldInfo(name) { return books[name] || null; },
        async saveWorldInfo(name, data) { books[name] = data; },
    });
    return books;
}

test('lore.edit rewrites content of a cached entry', async () => {
    const { sceneId, timelineId } = seed();
    const books = withBook({ 1: { uid: 1, key: ['Rayse'], keysecondary: [], content: 'old' } });
    addEntryRefs(sceneId, [{ book: 'TL', uid: '1' }]);
    const r = await applyLoreOps({ sceneId, timelineId, ops: [{ op: 'lore.edit', book: 'TL', uid: '1', content: 'new content' }] });
    expect(r.applied).toEqual([{ op: 'lore.edit', book: 'TL', uid: '1' }]);
    expect(books.TL.entries[1].content).toBe('new content');
});

test('lore.edit on an entry NOT in the cache is refused, not written', async () => {
    const { sceneId, timelineId } = seed();
    const books = withBook({ 1: { uid: 1, key: ['Rayse'], keysecondary: [], content: 'old' } });
    const r = await applyLoreOps({ sceneId, timelineId, ops: [{ op: 'lore.edit', book: 'TL', uid: '1', content: 'x' }] });
    expect(r.applied).toEqual([]);
    expect(r.refused[0]).toMatchObject({ op: 'lore.edit', reason: 'not-in-cache' });
    expect(books.TL.entries[1].content).toBe('old');
});

test('lore.create adds a new entry to the timeline book and the cache', async () => {
    const { sceneId, timelineId } = seed({ lorebookName: 'TL' });
    const books = withBook({});
    const r = await applyLoreOps({ sceneId, timelineId, ops: [{ op: 'lore.create', name: 'Silvia', keys: ['Silvia'], content: 'a mage' }] });
    expect(r.applied[0]).toMatchObject({ op: 'lore.create', book: 'TL' });
    const uid = r.applied[0].uid;
    expect(books.TL.entries[uid]).toMatchObject({ comment: 'Silvia', key: ['Silvia'], content: 'a mage' });
    expect(listSceneEntryRefs(sceneId)).toContainEqual({ book: 'TL', uid: String(uid) });
});

test('lore.create is refused when the timeline has no bound book', async () => {
    const { sceneId, timelineId } = seed({ lorebookName: '' });
    withBook({});
    const r = await applyLoreOps({ sceneId, timelineId, ops: [{ op: 'lore.create', name: 'X', keys: ['X'], content: 'y' }] });
    expect(r.applied).toEqual([]);
    expect(r.refused[0]).toMatchObject({ op: 'lore.create', reason: 'no-timeline-book' });
});
```

- [ ] **Step 2: Run → fail** (module missing). `remodel-living-lore-ops`.

- [ ] **Step 3: Implement `applyLoreOps`.** Group edits by book (load each book once via `structuredClone` of `ctx.loadWorldInfo(book)`), apply cache-checked content rewrites, save with restore-on-fail; handle creates against the timeline book (first-free-integer uid, native entry template, save, `addEntryRefs`). Cap content at 12000. Return `{applied, refused}`. Follow the mandatory native-write pattern (structuredClone working copy; never mutate the loadWorldInfo object).

- [ ] **Step 4: Run → green.**

- [ ] **Step 5: Mutation check.** Remove the cache-membership guard in `lore.edit` (always apply); confirm the "refused, not written" test reddens. Revert.

- [ ] **Step 6: Commit.**
```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-ops.js tests/remodel-living-lore-ops.test.js
git commit -m "feat(remodel): native World Info edit/create for Living Lore ops"
```

---

### Task 2: Declare `loreOps` in the provider-enforced fence

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/loom-fence-schema.js`
- Test: `tests/remodel-loom-fence-schema.test.js`

**Interfaces:**
- Produces: `getRoleplayLoomGoalSchema().schema.properties.loreOps` = `{ type:'array', maxItems:16, description:…, items:{ anyOf: [editBranch, createBranch] } }`, and `loreOps` added to the top-level `required` list. Each branch is a strict object `{ additionalProperties:false, required:['id','op','arguments','reason'], properties:{ id, op:{type:'string',enum:[cap]}, arguments:{…strict, all listed in required, nullable() for optionals}, reason } }`, mirroring `requestBranch` (lines 64-83). Arg descriptors: `book`/`uid`/`content`/`name` = `{type:'string'}`; `keys`/`secondaryKeys` = `{type:'array', items:{type:'string'}}`. `lore.edit` required = `['book','uid','content']`, optional = `[]`. `lore.create` required = `['name','keys','content']`, optional = `['secondaryKeys']`.

- [ ] **Step 1: Write failing test** in `remodel-loom-fence-schema.test.js`:
```js
test('loreOps declares strict edit and create branches', () => {
    const schema = getRoleplayLoomGoalSchema().schema;
    expect(schema.required).toContain('loreOps');
    const caps = schema.properties.loreOps.items.anyOf.map((b) => b.properties.op.enum[0]).sort();
    expect(caps).toEqual(['lore.create', 'lore.edit']);
    const edit = schema.properties.loreOps.items.anyOf.find((b) => b.properties.op.enum[0] === 'lore.edit');
    expect(edit.properties.arguments.required).toEqual(['book', 'uid', 'content']);
});
```
Also confirm the existing `the whole schema is strict-mode valid` test still passes (the branch must satisfy `strictViolations`).

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement.** Add `LORE_OP_CAPABILITIES = ['lore.edit','lore.create']`, a `LORE_ARG_PROPS` descriptor map, a `LORE_OP_SHAPES` map (required/optional per cap), and a `loreOpBranch(cap)` builder mirroring `requestBranch`. Insert the `loreOps` property between `loreKeywords` and `flow`, and add `'loreOps'` to `required`. Reuse `nullable()` for optionals.

- [ ] **Step 4: Run → green** (new test + `strict-mode valid` + `five state-fence keys` test — NOTE: that test asserts exactly 5 keys; update it to include `loreOps` (now 6) as part of this task, since the fence legitimately grows).

- [ ] **Step 5: Mutation check.** Drop `loreOps` from `required` (leave it only in properties); confirm the `strict-mode valid` test reddens (strict mode requires every property be required). Revert.

- [ ] **Step 6: Commit.**
```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/loom-fence-schema.js tests/remodel-loom-fence-schema.test.js
git commit -m "feat(remodel): add loreOps (edit/create) to the Loom fence schema"
```

---

### Task 3: Parse `loreOps` in `parseLoomReply`

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/loom-reconciliation.js`
- Test: new `tests/remodel-loom-ops.test.js`

**Interfaces:**
- Produces: `export function readLoreOps(value) → Array<{ op, book?, uid?, name?, keys?, secondaryKeys?, content }>` — accept only objects whose `op` ∈ `['lore.edit','lore.create']` with the required args present and typed (string/array-of-string), bounded (content ≤ 2000? use the same MAX as information; keys ≤ 12); drop malformed. `parseLoomReply` returns `loreOps` as a new sibling field; `isLoomEnvelope` recognises `loreOps`.

- [ ] **Step 1: Write failing tests** (`remodel-loom-ops`): a fence with `loreOps: [{op:'lore.edit', arguments:{book:'TL',uid:'1',content:'x'}}, ...]` — decide the wire shape: the schema nests args under `arguments` (like requests), so `readLoreOps` reads `entry.arguments`. Assert `parseLoomReply` surfaces a normalized `{op, book, uid, content}`; malformed ops dropped; a flat/garbage value → `[]`.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `readLoreOps`** (near `readLoreKeywords`), init `let loreOps = []` in `parseLoomReply`, read `loreOps = readLoreOps(parsed?.loreOps)` beside the `loreKeywords` read, add to the return object, and add `|| Array.isArray(value.loreOps)` to `isLoomEnvelope`.

- [ ] **Step 4: Run → green.**

- [ ] **Step 5: Mutation check.** Make `readLoreOps` accept any `op` string (drop the enum guard); confirm a "malformed op dropped" assertion reddens. Revert.

- [ ] **Step 6: Commit.**
```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/loom-reconciliation.js tests/remodel-loom-ops.test.js
git commit -m "feat(remodel): parse loreOps off the Loom fence"
```

---

### Task 4: Apply `loreOps` on the commit path

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js`
- Test: additions to `tests/remodel-living-lore-phase1-integration.test.js`

**Interfaces:**
- Consumes: `applyLoreOps` (Task 1), `readLoreOps` result (Task 3). Carry `loreOps` into `run.envelope.loreOps` on the streaming pass (mirror `run.envelope.loreProposals` at ~2096); apply inside `queueAcceptedLoreProposals` (~2918) via `applyLoreOps({ sceneId: run.sceneId||scene.id, timelineId: run.timelineId||scene.timelineId, ops: run.envelope.loreOps })`, wrapped in try/catch journalling `living-lore.ops.failed`.

- [ ] **Step 1: Write the failing integration test** driving a full turn (mirror `remodel-living-lore-phase1-integration.test.js`'s `runLoomReconciliation` + the finalize path — read how the existing tests reach `queueAcceptedLoreProposals`, e.g. via the streaming/settle flow, and assert): a Loom reply with `loreOps:[{op:'lore.edit', arguments:{book:'TL',uid:'1',content:'edited'}}]` on a cached entry rewrites the native book; a `lore.create` adds an entry + cache ref; an edit on an uncached entry does not write. If the finalize path is not reachable from the existing test harness, assert at the seam `applyLoreOps` is called with the envelope ops (spy), and keep the end-to-end write assertions in the Task-1 unit test.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement.** Add `loreOps = []` to the `parseLoomReply` destructure (~2380); set `run.envelope.loreOps = structuredClone(loreOps || [])` where `loreProposals` is carried (~2096); import `applyLoreOps` from `./living-lore-ops.js`; call it in `queueAcceptedLoreProposals` (~2918-2930) beside the existing `applyLoomLoreReports` (do NOT remove that — 2B does), guarded + journalled. Add `run.envelope.loreOps = []` to the reset/normalize spot if `loreProposals` has one (~2724/3436 area — mirror it).

- [ ] **Step 4: Run → green.**

- [ ] **Step 5: Mutation check.** Make the apply pass `ops: []` regardless of the envelope; confirm the edit/create integration assertion reddens. Revert.

- [ ] **Step 6: Run the full suite** (`remodel-`) — all green.

- [ ] **Step 7: Commit.**
```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js tests/remodel-living-lore-phase1-integration.test.js
git commit -m "feat(remodel): apply loreOps (edit/create) on the committed turn"
```

## Self-review notes

- **Spec coverage:** §6 edit + create (import = Phase-1 `loreKeywords`, no op). Enforcement (edit cached-only; create → timeline book) and non-destructive RMW writes are Tasks 1 + 4. Delete is out of 2A scope (noted for later).
- **Deferred to 2B:** retire the untyped `loreProposals` intake (fence field, `applyLoomLoreReports`, `living-lore-intake-runtime`/`writer`/`withdrawal`/`intake`, the store ledger, and their tests) + reconcile `metadata-guide`/`living-lore-proposals` copy. 2A leaves that path live.
- **Type consistency:** `{book, uid}` strings across ops, cache, and native writes; `applyLoreOps` returns `{applied, refused}` used only for journalling in Task 4.
- **Open confirmation for the executor:** Task 4 Step 1 must find how the existing tests reach `queueAcceptedLoreProposals` (the finalize path); if it is not unit-reachable, fall back to a spy-at-the-seam assertion plus the Task-1 end-to-end write coverage, and note it.
