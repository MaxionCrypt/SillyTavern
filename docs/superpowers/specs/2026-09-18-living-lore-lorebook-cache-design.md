# Living Lore — Lorebook Cache Design

**Date:** 2026-09-18
**Status:** Approved design; implementation begins at Phase 1 (requirement 1).
**Branch:** `codex/loom-living-lore-lorebooks`
**Supersedes:** the dissolved Loom Archive + World Sense recall systems (removed and committed prior to this spec).

---

## 1. Purpose

Replace the just-dissolved Loom Archive / World Sense recall with a single, lorebook-native mechanism: **Living Lore** — a per-Scene cache of native SillyTavern World Info entries that the Loom pulls in by emitting keyword groups, and that the Narrator reads from. Goals and Variables stop being separate code systems and become **tagged lorebook entries** driven by prompting plus code-owned dice/math.

Everything the scene "knows" is a native World Info entry. The Loom curates which entries are on the table (the cache) and edits their contents; the Narrator sees the non-secret subset. There is no bespoke fact/event/goal/variable store.

## 2. Non-goals / explicitly deferred

- **Eviction policy** — entries persist in the cache; settings-driven removal is a defined extension point, **not built now**. The Loom never decides eviction.
- **"New lorebook capabilities"** — out of scope by owner instruction.
- **The Living Lore UI** — the kept per-Scene Loom-Archive button will host the cache view; designed in a later phase once the backend is ready. This spec defines only the data it will render.
- **Migration of existing Archive data** — dropped, not migrated.

## 3. Core model

### 3.1 Entries
An entry is a native World Info entry. No new entry store. Classification is by **reserved primary keywords** the entry carries in its native `key` array:

- `goal` — the entry is a goal.
- `variable` — the entry is a variable.
- `secret` — the entry is hidden from the Narrator (visible to the Loom only).

These are ordinary keywords, so the Loom retrieves "all goals this scene" by querying the keyword `goal`. An entry may carry several (`goal` + `secret` = a hidden goal).

Multi-keyword ("needs more than one key to fire") entries use native selective matching: `key` (primary) + `keysecondary` + `selectiveLogic` (`AND_ALL`/`AND_ANY`/`NOT_ANY`/`NOT_ALL`). No custom matching rule is introduced.

### 3.2 The Living Lore cache (per Scene)
A Remodel-owned **Scene-scoped** sidecar. Today's `livingLoreV1` store is timeline-scoped metadata used by the surviving Living Lore intake/mutation modules — the Scene cache is a **new structure that coexists** with it (a new store or a Scene layer over the same namespace); whether it reuses `livingLoreV1` internals is an implementation choice made in Phase 1, and it must not change the semantics the surviving intake depends on. Per Scene the cache holds:

- `entryRefs` — the set of `{book, uid}` currently pulled into this Scene (pointers, not copies). Native World Info remains the single source of truth; the cache re-reads entry content at render time so a Loom edit is reflected immediately.
- `keywordGroups` — the deduped **set** of keyword groups the Loom has queried this Scene (e.g. `["event","Rayse"]`, `["Rayse","Silvia"]`).

The cache **accumulates** across turns within a Scene and persists. Each Scene has its own independent Living Lore and its own `keywordGroups` set.

### 3.3 Retrieval scope
A query scans the **union** of: the timeline's bound lorebook(s) (`getStoryLorebookNames`) and all natively-active World Info (global + character + chat books).

## 4. Phase 1 — Retrieval loop (requirement 1)

This is the first thing built.

**Fence change:** the Loom emits `loreKeywords` as an array of **groups** (arrays of strings), not a flat list. (Today `loreKeywords` is emitted and parsed but unconsumed.) The provider-enforced schema and the recipe copy are updated accordingly.

**Each Loom pass:**
1. Read the Loom's emitted keyword groups.
2. For each group **not already in this Scene's `keywordGroups` set**, run native activation (`getWorldInfoPrompt` / `checkWorldInfo`) with the group as the scan input, scoped per §3.3. Groups are scanned **separately** so `["event","Rayse"]` + `["Rayse","Silvia"]` never combine to fire an entry that needs `event`+`Silvia`.
3. Union the activated entry refs into the Scene's `entryRefs`; add each new group to `keywordGroups`.
4. Render the cache into the prompt via the surviving `{{loom.lore}}` macro (§5 defines Loom vs Narrator rendering).

A group already queried is skipped (dedup); an entry reachable by two queried groups is present once.

**Verification for Phase 1:** unit tests over the cache store (accumulation, per-Scene isolation, group dedup, group-separate scanning), and integration tests that a Loom reply carrying `loreKeywords` groups populates the Scene cache and that `{{loom.lore}}` renders the pulled entries. Mutation-test the new assertions (project norm).

## 5. Narrator visibility & `secret`

The cache renders in two passes over the same `entryRefs`:
- **Loom render** — all entries, including `secret`.
- **Narrator render** — entries carrying the `secret` key are excluded. `{{loom.lore}}` emits the Narrator-safe subset.

`secret` is binary. To reveal a secret, the Loom edits the entry to drop the `secret` key (an ordinary edit — no separate promote mechanic).

## 6. Loom edit / import / create (requirement 9)

Native World Info write APIs (`saveWorldInfo`, `createWorldInfoEntry`, `deleteWorldInfoEntry`), all exposed on `context`, back these operations.

- **Edit** — only entries currently in the Scene cache. The Loom emits an operation naming `{book, uid}` + the new content; code writes via `saveWorldInfo`. This is also the write path for goal/variable value changes (§7).
- **Import** — to touch an entry not cached, the Loom imports it by name; its ref joins the Scene cache, making it Loom-visible **and** injected for the Narrator. Loom and Narrator stay in sync on what is on the table.
- **Create** — `createWorldInfoEntry` into the **timeline's primary bound book**; the new entry enters the cache.
- **Enforcement (code):** a mutate op is refused unless its target is in the Scene cache, or is being imported/created in the same turn.

Writes must preserve the rest of the entry and the user's other entries in the book (read-modify-write a single `uid`, then `saveWorldInfo`), never clobber a book wholesale.

## 7. Goals & Variables as tagged entries

**Teardown (a dissolution like the archive one):** remove `story-goals-store.js`, `variables-store.js`, the goal/variable capability verbs in `mechanics-capabilities.js`, and their macros/recipe registrations and tests. (Separate build phase; sequenced after the cache exists.)

**Reconstruction:**
- A goal = an entry keyed `goal`; a variable = an entry keyed `variable`.
- **State lives in the entry content** behind a reserved, code-parseable line (e.g. `value: 12`, `rate: 40%`) — the rest of the content is free prose the Narrator reads.
- **Code owns dice and arithmetic.** The Loom emits a roll/add/subtract/set operation targeting a `goal`/`variable` entry; code parses the reserved value line, performs the RNG/arithmetic, writes the new value back into the entry (§6 edit path). The Loom transcribes nothing numeric — it decides whether/when and narrates the *why*.
- Existing roll/math macros become **read-only display** of the current parsed value in the prompt.
- The provider-enforced fence + recipe define the available operations and how `goal`/`variable` entries are presented.

## 8. Prior-Scene keyword macro (requirements 7–8)

Each Scene stores its `keywordGroups` set. A new macro exposes the **deduped union of groups used in prior Scenes** of the timeline (each distinct group once), letting the Loom replay what earlier Scenes established. Macro name is cosmetic (TBD at implementation).

## 9. Native API surface this builds on

Confirmed present in `public/scripts/world-info.js` and exposed via `getContext()`:
- Read: `loadWorldInfo(name)`, `getWorldInfoEntriesForBook`.
- Write: `saveWorldInfo(name, data)`, `createWorldInfoEntry(name, data)`, `deleteWorldInfoEntry(data, uid)`, `duplicateWorldInfoEntry`.
- Activation: `getWorldInfoPrompt(chat, maxContext, isDryRun, globalScanData)`, `checkWorldInfo(...)` — both take a scan input we supply as the keyword group.
- Entry schema fields used: `key`, `keysecondary`, `selective`, `selectiveLogic` (`world_info_logic`), `comment`, `content`, `constant`.

## 10. Build order (phases)

1. **Retrieval loop + Scene-scoped cache + grouped `loreKeywords`** (requirement 1). ← first
2. **Narrator/`secret` visibility split** in rendering.
3. **Loom edit / import / create** against native World Info (requirement 9).
4. **Goals & Variables:** teardown of the old stores/verbs + reconstruction as tagged entries with code-owned math.
5. **Prior-Scene keyword macro** (requirements 7–8).
6. **Living Lore UI** in the kept per-Scene Loom-Archive button.
7. **Eviction** — deferred; wire settings when specified.

## 11. Requirement traceability

| Owner requirement | Covered by |
|---|---|
| 1. Loom emits its own activation keyword list | §4 (grouped `loreKeywords` → native activation → cache) |
| 2. "New lorebook capabilities" TBD | §2 (out of scope) |
| 3. Existing Archive data dropped | §2 (no migration) |
| 4. Keywords → entries → cache = Living Lore (Narrator-visible) | §3, §4, §5 |
| 5. UI lives in the per-Scene Loom-Archive button | §2, §10 phase 6 |
| 6. `secret` entries hidden from Narrator | §5 |
| 7. Per-Scene Living Lore + remembered keyword AND-groups | §3.2, §4 |
| 8. Macro for prior-Scene keyword orders, deduped as a set | §8 |
| 9. Loom edits cached entries; imports to edit others; can create | §6 |
| 10. Persistent cache + settings-driven eviction (Loom doesn't decide) | §2, §10 phase 7 |
| (new) Remove Goals & Variables, refold as pseudo-systems | §7 |

## 12. Open technical risks (resolve during implementation)

- **Feeding groups to native activation:** confirm `getWorldInfoPrompt`/`checkWorldInfo` return the activated entry set (not just the assembled string) when handed a synthetic scan input, and that per-group calls can be scoped to the union in §3.3 without mutating the user's live activation for the real turn.
- **Non-destructive writes:** read-modify-write a single `uid` and `saveWorldInfo` without disturbing sibling entries or the editor's open state.
- **Value-line parsing:** the reserved `goal`/`variable` value convention must be robust to user-authored prose around it (anchor on a strict line format).
- **Render freshness:** the cache holds refs, not snapshots — the render path must re-read current entry content each turn so an edit lands immediately.
