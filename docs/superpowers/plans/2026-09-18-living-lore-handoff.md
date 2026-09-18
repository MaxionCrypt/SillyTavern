# Living Lore — handoff

Written 2026-09-18. Everything below is on branch `codex/loom-living-lore-lorebooks`,
fully committed and pushed to `origin` (MaxionCrypt/SillyTavern). HEAD is
`ede196364`. Working tree clean.

This document is self-contained: it captures the finished work, the architecture,
a grounded reference for SillyTavern's World Info trigger engine, and the full spec
+ open questions for the remaining UI work (item 5), so a fresh agent can continue
without this conversation.

---

## 0. Working norms (the owner's standing preferences)

- **Execute inline**, task → commit → checkpoint. Do NOT fan work out to subagents
  for sequential implementation; the owner has pushed back on this repeatedly.
- **TDD + mutation-test everything.** Green tests here have certified false
  properties multiple times. After a suite is green, mutate the implementation and
  confirm the tests go red; only then trust them.
- **No legacy toggles / no ceremony.** Implement directly; at most one review pass.
- **CRLF** line endings; Windows host; PowerShell primary shell, Bash available.
- Test command (from `tests/`):
  `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json <suite> --silent`
- Full suite currently: **82 suites / ~1003 tests green.**
- Extension root: `public/scripts/extensions/third-party/SillyTavern-Remodel/`.

Design decisions already locked with the owner (do not relitigate):
- Goals/Variables will become **plot-level annotations = tagged lorebook entries**
  (`goal`/`variable`/`secret` are reserved query keywords). Value state lives in the
  entry content; **code owns dice/math**; the Loom decides/ narrates. (LAST phase.)
- Retrieval scope = timeline's bound book(s) ∪ all active World Info (global +
  character + chat). Reuses **native activation** semantics.
- Import = keyword pull. Typed `loreOps` replaced the old untyped "information report".

Two prior specs/plans already in the repo (read them):
- `docs/superpowers/specs/2026-09-18-living-lore-lorebook-cache-design.md` (architecture; §6 edit/create, §7 goals/vars as entries, §8 prior-scene macro)
- `docs/superpowers/plans/2026-09-18-living-lore-phase1-retrieval.md`
- `docs/superpowers/plans/2026-09-18-living-lore-phase2a-edit-create.md`

---

## 1. Roadmap & where we are

The owner's sequence: **item 2 → item 4 → item 5 → LAST (eviction TBD, secret tags,
Goals/Variables fold).**

| Item | What | Status |
|------|------|--------|
| Phase 1 | Retrieval loop (`loreKeywords` groups → scan → Scene cache → `{{loom.lore}}`) | DONE (earlier commits) |
| Phase 2A | Typed `loreOps` (`lore.edit`/`lore.create`) parsed + applied on commit | DONE (`dd4449374` and predecessors) |
| Phase 2B | **Retire** the untyped information-report intake | DONE (`f3fc1933d`, `e78654c8e`) |
| Item 4 | Prior-Scene keyword macro `{{loom.priorlore}}` (+ `scenes=N`) | DONE (`89ac047f4`, `ede196364`) |
| **Item 5** | **Living Lore / Loom Archive UI** (graph) | **NOT STARTED — spec in §5** |
| LAST | Eviction policy TBD; secret tags; Goals/Variables dissolution + rebuild as tagged entries | Not started |

---

## 2. What's built (with the anchors that matter)

### 2.1 Living Lore cache (Scene-scoped)

`living-lore-cache-store.js` — settings key `livingLoreCacheV1`, per-Scene bucket
`{ sceneId, entryRefs:{ "book.uid":{book,uid} }, keywordGroups:[canonicalGroup] }`.
- Canonical group = trim/dedup/**sort**, joined by ``; so `["a","b"]` and
  `["b","a"]` are one group.
- Exports: `getSceneLivingLore`, `unseenGroups`, `recordKeywordGroups`,
  `addEntryRefs`, `listSceneEntryRefs`, and (item 4) `orderedTimelineSceneIds`,
  `listPriorSceneKeywordGroups`.
- Coexists with the older timeline-scoped `livingLoreV1`; do not conflate.

`living-lore-cache-packet.js` — `buildSceneLivingLorePacket({sceneId,timelineId})`
re-reads each `{book,uid}` ref's CURRENT content from native World Info
(`getWorldInfoEntriesForBook`) at render time (pointers, not snapshots — a Loom edit
shows immediately). Also (item 4) `formatPriorSceneKeywords(groups)` and
`renderPriorSceneKeywords({sceneId,timelineId,scenes})`.

`living-lore-retrieval.js` — `scopedBookNames`, `activateKeywordGroups(groups,{...})`
per-group native-style scan + dedup.

`world-info-scan.js` — extracted matcher (`matchEntry` + helpers) reused for scoped
per-group scanning (native `checkWorldInfo`/`getWorldInfoPrompt` take no book-list
param, so the extension runs its own matcher). `matchEntry` needs `scanDepth ≥ 1`.
`selectiveLogic`: 0=AND_ANY, 1=NOT_ALL, 2=NOT_ANY, 3=AND_ALL.

`living-lore-proposals.js` — now gutted to ONLY `formatLivingLorePacket(packet)`
(the render seam for `{{loom.lore}}`). It renders the packet JSON + the loreOps /
loreKeywords contract text. The old build/validate machinery is gone.

`living-lore-model.js` — KEEP; still used by variables-lore-key,
mechanics-capabilities, story-goals-model.

### 2.2 The Loom fence (typed ops)

`loom-fence-schema.js` — provider-enforced strict schema. Top-level keys now
(exactly five): `swaps`, `requests`, `loreKeywords`, `loreOps`, `flow`. Every
top-level property must be in `required` (strict). `loreOps` items are
`lore.edit` / `lore.create` branches (`LORE_OP_CAPABILITIES`, `LORE_OP_SHAPES`).

`loom-reconciliation.js` — `parseLoomReply` returns
`{prose,swaps,requests,flow,loreKeywords,loreOps}`. `readLoreKeywords` (groups),
`readLoreOps` (normalizes nested `arguments`, drops malformed/unknown). `MAX_LORE_OPS=16`,
`MAX_LORE_KEYWORD_GROUPS=8`, `MAX_LORE_KEYWORDS=8`. STEP 3 of `LOOM_POLICY_PATCH` is
"Living Lore" (lore.edit/lore.create). The FROZEN historical contracts
`LOOM_OUTPUT_CONTRACT_PATCH_V21`/`_PRE_LORE`/`_PRE_PROMOTION` still contain the old
`loreProposals` text ON PURPOSE — they are migration detectors via
`isSupersededLoomPatchContract`. Do not "clean" them.

`living-lore-ops.js` — `applyLoreOps({sceneId,timelineId,ops})` → `{applied,refused}`.
- `lore.edit` refused unless `${book}.${uid}` is in the Scene cache.
- `lore.create` refused if the timeline has no bound book; lands in the timeline's
  primary book; `firstFreeUid`; content capped at `MAX_ENTRY_CHARS=12000`.

**Native World Info write pattern (mandatory, used by `applyLoreOps`):**
`loadWorldInfo(book)` → `structuredClone` to a working copy → mutate
`working.entries[uid]` → `saveWorldInfo(book, working, true)` (immediately=true) →
restore original on save failure. NEVER mutate the object `loadWorldInfo` returns
(it's a live cache by reference). `createWorldInfoEntry`/`deleteWorldInfoEntry` are
imported from `world-info.js` (not on getContext); `deleteWorldInfoEntry(data, uid, {silent:true})`.

`live-direction.js` — the two-pass pipeline. Streaming pass parses + carries to the
envelope; the commit/finalize path (`finalizeRunMessage` → `applyPendingRequests` →
`applyLoomLoreOps(run)`) runs the ops ONCE (guarded by `run.loreOpsApplied`, with a
scene-match check). `compileLoomRequest` builds the Loom recipe `sources` object.

### 2.3 Phase 2B teardown (retired the untyped intake) — DONE

Commits `f3fc1933d` (sever) + `e78654c8e` (delete cluster). Removed `loreProposals`
from the fence/parser/guide, removed the withdrawal + `queueAcceptedLoreProposals` +
`reconcileCurrentChatLoreProposals` machinery from `live-direction.js`, switched the
metadata guide / prompt-instruction-templates / debug-console to a `loreOps` guide,
and **deleted 8 modules** (`living-lore-intake`, `-intake-runtime`, `-writer`,
`-withdrawal`, `-mutations`, `-auto-safe`, `-cultivation`, `-store`) + their tests.
One severance bug was found and fixed: `rerunDirectedRoleplayFromUserMessage` had its
`savedDirections` definition over-removed; restored (minus the withdrawal call).

### 2.4 Item 4 — prior-Scene keyword macro — DONE

Commits `89ac047f4` + `ede196364`. `{{loom.priorlore}}` exposes the deduped union of
`keywordGroups` from Scenes **strictly before** the current one in timeline play order
(`orderedTimelineSceneIds` = arcs in `arcIds` order, then each arc's `sceneIds`).
`scenes=N` bounds the lookback to the N nearest prior Scenes; only a positive integer
limits — omitted/0/NaN/null/'' mean "all" (avoids the `Number(null)→0` coercion trap).
Registered as a template in `prompt-studio-store.js` (`template('priorLore', 'Prior-Scene Keywords', 'system', 'loom.priorlore', {…})`), seeded into the default Loom
recipe (`patchLoomBlocks`), wired as a function source in `compileLoomRequest`
(`sources.priorLore = (args)=>renderPriorSceneKeywords({sceneId,timelineId,scenes:args.scenes})`).
NO forced store-version migration into existing user recipes (they add it from the
picker); new recipes get it. Tests: `tests/remodel-living-lore-prior-scene.test.js`
(store + render) and a wiring test in `tests/remodel-prompt-macros.test.js`.

---

## 3. The prompt-recipe macro seam (how a `{{loom.*}}` macro resolves)

Needed for the UI later and for any new macro. In `prompt-studio-store.js`:
`template(key, label, role, macro, extra)` registers a source; `.macro` is the token
(`loom.priorlore`), `.key` is the source key (`priorLore`). In `prompt-studio.js`,
`getRecipeMacroDefinition` matches a token to a template by `.macro`; the compiler
then resolves `sources[template.key]`. If that source is a **function**, it's called
with the macro's parsed args (so `{{loom.priorlore scenes=3}}` → `sources.priorLore({scenes:3})`).
`sources` is assembled per turn in `live-direction.js` `compileLoomRequest`.

---

## 4. Reference: how SillyTavern's World Info (lorebook) trigger engine works

Grounded in `public/scripts/world-info.js` (line numbers as of this branch). This is
the machinery the UI must visualize and the future "lorebook mechanics" work depends on.

**Stage 0 — the scan buffer (`WorldInfoBuffer.get`, ~L279).** For each entry, a
"haystack" is built from the last N chat messages, N = **scan depth** (global
`world_info_depth`, default 4 (`DEFAULT_DEPTH`, L96); per-entry `scanDepth` overrides).
Optionally folds in persona/character description/personality/scenario/creator-notes/
depth-prompt (per-entry `matchCharacterDescription` etc.), injections, and the
**recursion buffer** (text of entries already activated this pass; excluded during
MIN_ACTIVATIONS).

**Stage 1 — per-entry gate (`checkWorldInfo`, ~L4621; per-entry loop ~L4770–4913).**
First failing check drops the entry, in this order:
1. disabled; 2. character/tag filter; 3. **delay** (suppress); 4. **cooldown**
(suppress unless sticky); 5. **sticky** (force ON); 6. recursion flags
(`delayUntilRecursion`, `excludeRecursion` — L4785–4798); 7. decorators `@@activate`
/`@@dont_activate`; 8. **constant** (always on, no keys); 9. **keywords**: ≥1
**primary key** in the haystack; then, if **secondary keys** exist, combine via
**selective logic** (`matchSecondaryKeys`, L4868): AND_ANY(0) ≥1 present, NOT_ALL(1)
≥1 absent, NOT_ANY(2) none present, AND_ALL(3) all present. Matching per-entry:
case-sensitivity, `matchWholeWords`, or a **regex key** `/…/` which overrides plain
matching (`matchKeys`, L337).

**Stage 2 — winnow (`filterByInclusionGroups`, L5306; `filterGroupsByScoring`, L5210).**
- **Inclusion group** (comma-separated `group` names): normally ONE wins per group per
  pass. Resolution order: (a) any **sticky** member auto-wins and blocks the rest;
  (b) **group scoring** (`useGroupScoring` per-entry or `world_info_use_group_scoring`
  global) — highest **keyword-match count** wins, losers dropped (`getScore`, L434);
  (c) **prioritize** (`groupOverride`) — a flagged member wins outright, ties broken by
  **Order** (`sortFn = (a,b)=>b.order-a.order`, L88, higher wins); (d) else **weighted
  random** by **group weight** (`groupWeight`, default `DEFAULT_WEIGHT=100`, L97) —
  `rollValue = Math.random()*totalWeight` (L5370). If the group already activated
  earlier, the rest are force-dropped.
- **Probability** (`verifyProbability`, L4946): if `useProbability` and
  `probability < 100`, roll d100; sticky skips the reroll.
- **Token budget** (L4937–4995): added in **Order** priority until budget fills;
  `ignoreBudget` bypasses.

**Stage 3 — recursion (scan-state loop, L4691, L5014–5061).** Activated entries'
**content** goes into the recursion buffer and the scan runs again — an entry's text
can contain another's key and trigger it. Flags: global `world_info_recursive`;
`preventRecursion` (can't be a caller); `excludeRecursion` (can't be a recursion
callee); `delayUntilRecursion` (+ level). **Min activations**
(`world_info_min_activations`, L5028) widens depth and rescans until X entries fire or
depth runs out. `scan_state`: NONE 0, INITIAL 1, RECURSION 2, MIN_ACTIVATIONS 3 (L43).

**Insertion (placement, not triggering).** `world_info_position` (L861): before/after
char, EMTop/Bottom, ANTop/Bottom, `atDepth` (+ depth/role), `outlet`. `order` is the
within-position priority AND the group-prio / budget tiebreak.

**The two things the UI derives from this:** shared-keyword **clusters** = entries
whose `key` arrays intersect; recursion **edges** = A→B where A's content contains B's
key (Stage-3 relationship).

---

## 5. Item 5 — the Living Lore / Loom Archive UI (NOT built; spec)

Still called "Loom Archive / Living Lore". It is the dissolved Loom Archive reworked;
it now shows Living Lore entries.

### 5.1 Locked decisions (owner-confirmed)
- **A node graph at ALL sizes** (not a fallback to a list) — so it needs a real
  auto-layout (force-directed or radial) and pan/zoom, since the entry set is dynamic.
- **Clusters = shared keywords** (entries whose `key` lists intersect). Draw as
  regions/hulls; overlapping membership is allowed (a node in two clusters).
- **Edges = direct recursive calls only** (A→B), with **hover-to-highlight the chain**
  (transitively light the downstream recursion path, dim the rest).
- **Edit-in-place**: clicking a node opens an inspector to edit title/content and flip
  flags (`constant`, `secret`, inclusion `group`, weight, keywords). Writes go through
  the native World-Info write pattern (§2.2) — same path as `loreOps`. Flipping
  `secret` = drop/add the `secret` key (no separate promote mechanic).
- **Entries shown = only those activated in the current Scene** (`listSceneEntryRefs`).
  NOT the whole book — that would be redundant.

### 5.2 Target aesthetic (this is the crux — the owner rejected two mocks for looking
like a flat utility widget)
The owner wants a **cinematic AAA skill-tree / constellation** look, referencing:
Assassin's Creed Odyssey ability tree, an ARPG radial "Gate of Fates" constellation,
the Star Wars Jedi: Survivor lightsaber/skill tree, and Watch Dogs: Legion's radial
skills. Common language: **dark cosmic field, glowing orb nodes, luminous
branching edges, colored zones/nebulae per cluster, bloom on hover, a sense of depth
and motion.** It must NOT read like a claude.ai card widget.

IMPORTANT: the earlier attempts used the `visualize`/Artifact "flat, no-glow" house
style and looked wrong. For the REAL extension UI you are NOT bound by that — use full
CSS/canvas/WebGL: gradients, glow (box-shadow / SVG filters / canvas), particles,
animated edges. Consider a proper force-directed or radial layout library, custom
per-entry sigils/icons, animated edge particles, parallax starfield, and a styled
"glass" inspector. Two throwaway HTML mocks were built during discussion (artifact
`https://claude.ai/artifact/RF5fji3vV6uhGdeMXusMcZ`, file was in the session scratchpad
only — not in the repo); both were judged "terrible / flat". Treat them as
anti-examples of polish, though the interaction model (drag, zoom, hover-chain,
click-edit, cluster nebulae, luminous edges) is the right one — it just needs true
game-grade art direction.

### 5.3 Where the UI lives / data
- Data source: `listSceneEntryRefs(sceneId)` → for each ref read the live entry via
  `getWorldInfoEntriesForBook(book)`; `key`/`keysecondary` drive clusters, `content`
  scanned for other entries' keys drives edges, `constant`/`group`/`groupWeight`/the
  `secret` key drive glyphs.
- The Loom Archive is still a per-Scene surface reached from its existing drawer
  button (the button stays; it now opens Living Lore). Whether it becomes a full
  workspace tab as well is an OPEN question (see below).
- Follow the extension's existing UI conventions; check how the dissolved Loom Archive
  drawer/button was wired and how other Remodel workspaces/drawers render.

### 5.4 Open questions to settle with the owner before building
1. **Editing a keyword** changes cluster membership AND edges — recompute the graph
   live on every keystroke, or on blur/commit? (Recommend commit/blur to avoid churn.)
2. **Surface**: existing Loom Archive drawer only, a full workspace tab, or both?
3. **Layout**: force-directed (organic, like Gate of Fates/Watch Dogs) vs radial-tree
   (fanned branches, like the lightsaber tree). The reference set mixes both; pick one
   as the primary.
4. Art direction specifics: per-entry-type icons/sigils? animated edge particles?
   fixed vs physics layout after drag?

The owner was going to "give the plan" for item 5; get that plan (or the answers
above) before implementing, then build inline with TDD + mutation on the data layer
(cluster derivation, edge derivation, the write-through edit path) — the visual layer
is verified in the browser preview.

---

## 6. Backlog after item 5 (LAST, in the design spec §7)

Dissolve `story-goals-store.js`, `variables-store.js`, and the goal/variable capability
verbs in `mechanics-capabilities.js` + their macros/recipes/tests (an archive-style
teardown). Rebuild: a goal = an entry keyed `goal`, a variable = an entry keyed
`variable`; **state on a reserved code-parseable content line** (e.g. `value: 12`,
`rate: 40%`); code owns dice/arithmetic and writes the new value back via the §2.2
edit path; existing roll/math macros become read-only display of the parsed value.
Also: eviction policy for the Scene cache (TBD) and `secret` tag handling
(Narrator render excludes `secret` entries; Loom render includes them — spec §5).
