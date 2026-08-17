# Goals as Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Goals durable memory the owner and the Director both author, with code as an oracle the Director calls rather than a rulebook that constrains it.

**Architecture:** Delete the resolution machinery nobody asked for (miss-depth penalties, impact scales, the attrition pool, tracked resolution). Move the rate vocabulary — seven opening bands, four shift magnitudes — out of `story-goals-math.js` and into the Director's editable prompt, so `goal.shift` becomes `goal.edit` taking a number. Keep the d100, the margin arithmetic and the receipt in code. Give the Goals deck the authoring path its store has always exposed and nothing has ever called.

**Tech Stack:** Vanilla ES modules, no build step. Jest with `--experimental-vm-modules`, run from `tests/`.

**Spec:** `docs/superpowers/specs/2026-08-17-goals-as-memory-design.md`

## Global Constraints

- All product changes live inside `public/scripts/extensions/third-party/SillyTavern-Remodel/`. No core SillyTavern source, server endpoint, or native World Info schema changes.
- Pure logic goes in modules that do **not** import `st-context.js`. `story-goals-math.js`, `direction-sources.js`, `director-reply.js` and `narrator-history.js` are pure and stay pure — `direction-sources.js` has **zero import statements** and must keep zero.
- Jest runs from `tests/`: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json <pattern>`.
- `node --check` does NOT reliably catch syntax errors in this ES-module codebase. Use `node --input-type=module --check < file.js`.
- Every commit must leave `git diff --check` clean and CSS braces balanced if `style.css` was touched.
- **No destructive git commands during mutation testing.** Back up by byte-copy, restore by byte-copy, verify with md5.
- Goal storage is `storyGoalsV3`, Timeline-owned with Scene links. **The storage shape does not change** except for dropping one field (Task 2).
- The Director addresses Goals **by name** against the set advertised that turn, exactly as it does Variables. `buildAddressBook` / `resolveByName` in `direction-address.js` own that; do not fork them.
- Owner writes go direct to the store and are **not** capability requests. AI writes go through the capability layer and produce receipts.
- Baseline suite at plan start: **625/625 full repo.** No task may regress it.

---

### Task 1: Strip the math module to the oracle

**Files:**
- Modify: `public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-math.js`
- Test: `tests/remodel-story-goals-math.test.js` (create if absent)

**Interfaces:**
- Consumes: nothing.
- Produces: `rollD100()`, `clampRate(value)`, `margin(rate, roll, modifier)`, `isHit(marginValue)`, `resolveReach({rate, modifier, roll})`. Everything else is gone.

Delete `missBand`, `constitutionBite`, `applyBite`, `isPoolResolved`, `openingRateForBand` and `shiftForMagnitude`, with their tables.

- [ ] **Step 1: Find every caller first**

```bash
grep -rn "missBand\|constitutionBite\|applyBite\|isPoolResolved\|openingRateForBand\|shiftForMagnitude" public/scripts/extensions/third-party/SillyTavern-Remodel tests
```

Every hit is either deleted with its caller in a later task or must be resolved now. **Report the full list in your report** — a later task's brief depends on knowing where they were.

- [ ] **Step 2: Write the failing tests**

```js
import * as math from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-math.js';

test('the module exposes only the oracle', () => {
    expect(Object.keys(math).sort()).toEqual(['clampRate', 'isHit', 'margin', 'resolveReach', 'rollD100']);
});

test('margin is rate minus roll plus modifier', () => {
    expect(math.margin(60, 40, 0)).toBe(20);
    expect(math.margin(60, 40, -25)).toBe(-5);   // a negative modifier turns a hit into a miss
    expect(math.margin(30, 55, 30)).toBe(5);     // a positive modifier rescues a miss
});

test('a hit is margin >= 0, exactly at the boundary', () => {
    expect(math.isHit(0)).toBe(true);
    expect(math.isHit(-1)).toBe(false);
});

test('rates clamp to 5-95 so a roll always has both outcomes available', () => {
    expect(math.clampRate(0)).toBe(5);
    expect(math.clampRate(100)).toBe(95);
    expect(math.clampRate(50)).toBe(50);
});

test('clampRate does not read an absent value as zero', () => {
    // Number(null) is 0 and passes isFinite. This codebase has shipped that
    // trap three times: clampNumber in variables-store.js, coerceSettingValue
    // in prompt-studio-store.js, and turn numbering in live-direction.js.
    expect(math.clampRate(null)).not.toBe(5);
    expect(math.clampRate(undefined)).not.toBe(5);
    expect(math.clampRate('')).not.toBe(5);
});

test('resolveReach freezes its inputs and reports them with the outcome', () => {
    const result = math.resolveReach({ rate: 60, modifier: 10, roll: 40 });
    expect(result).toMatchObject({ rate: 60, modifier: 10, roll: 40, margin: 30, hit: true });
});
```

- [ ] **Step 3: Run to verify they fail**

Run from `tests/`: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-story-goals-math`

- [ ] **Step 4: Delete the six functions and their tables, and fix `clampRate`'s absent-value handling if the test above exposes it**

- [ ] **Step 5: Run to verify they pass**

- [ ] **Step 6: Mutation-check**

Each of these must turn its *named* test red; back up by byte-copy first and restore the same way:
- Re-export any deleted function → the surface test.
- Change `isHit` to `> 0` → the boundary test.
- Change the clamp bounds to 0–100 → the clamp test.
- Make `clampRate` read `null` as 0 → the absent-value test.

Report each result. A mutation that stays green is a finding, not something to drop.

- [ ] **Step 7: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-math.js tests/remodel-story-goals-math.test.js
git commit -m "refactor(remodel): cut story-goals-math down to the oracle the Director calls"
```

---

### Task 2: Drop tracked resolution

**Files:**
- Modify: `story-goals-model.js` — `normalizeStoryGoal`, `normalizeGoalResolution`
- Modify: `mechanics-capabilities.js` — the `resolution` argument path
- Modify: `mechanics-runtime.js` — `describeResolution`
- Modify: `direction-sources.js` — `describeGoalResolution`
- Modify: `live-direction.js` — the `args.resolution?.variableRef` translation in `addressRequestsByName`
- Test: `tests/remodel-story-goals-migration.test.js` (create)

**Interfaces:**
- Produces: a Goal record with **no** `resolution` field.

A Goal stops being bindable to a Variable. If the Director wants to treat a Variable as a Goal's constitution it says so in its notes and reads the value.

- [ ] **Step 1: Write the failing migration test**

```js
test('a Goal carrying a tracked resolution survives, loses the field, and keeps everything else', () => {
    const legacy = {
        id: 'goal-1', title: 'Repair the keep', description: 'Before winter',
        successRate: 45, status: 'active', visibility: 'public',
        resolution: { kind: 'tracked', variableId: 'var-9', field: 'value', direction: 'increase', completionThreshold: 100 },
    };
    const normalized = normalizeStoryGoal(legacy);
    expect(normalized.resolution).toBeUndefined();
    expect(normalized).toMatchObject({ title: 'Repair the keep', successRate: 45, status: 'active', visibility: 'public' });
});

test('normalizing a Goal that never had a resolution does not throw', () => {
    expect(() => normalizeStoryGoal({ id: 'goal-2', title: 'Find the ledger' })).not.toThrow();
});
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Remove the field at the single funnel**

`normalizeStoryGoal` is the one place every Goal passes through, on creation and on load from settings. Drop `resolution` there and delete `normalizeGoalResolution`. Do not strip it at call sites.

- [ ] **Step 4: Remove the plumbing the field fed**

Task 1's grep told you where. Additionally: `impactMagnitude` in the capability schema, the tracked branch of `goal.reach`, `describeResolution` in `mechanics-runtime.js`, `describeGoalResolution` in `direction-sources.js`, and the `addResolved(resolvedVariableRefs, 'variable', args.resolution?.variableRef)` line in `live-direction.js`.

**`direction-sources.js` must still have zero imports when you are done.**

- [ ] **Step 5: Run both suites, verify no regression, mutation-check**

- Restore the `resolution` field in `normalizeStoryGoal` → the migration test must go red.

- [ ] **Step 6: Commit**

```bash
git commit -m "refactor(remodel): a Goal is just a Goal"
```

---

### Task 3: Rework the Goal capabilities

**Files:**
- Modify: `mechanics-capabilities.js` — `CAPABILITY_NAMES`, `CAPABILITIES`, the request schema, the apply functions, the `require(...)` argument checks
- Test: `tests/remodel-goal-capabilities.test.js` (create)

**Interfaces:**
- Produces: `goal.create`, `goal.edit`, `goal.delete`, `goal.reach`, `goal.relate`. `goal.shift` and `goal.close` are gone.

`goal.edit` replaces both — a shift and an opening rate are the same kind of value, and status is just an attribute.

**The rate is a number**, not an enum. Delete the `magnitude` enum and the `impactMagnitude` enum from the schema, including the description line that reads *"Code converts it to a number; never state a percentage yourself."*

- [ ] **Step 1: Write the failing tests**

```js
test('goal.edit changes a rate to a supplied number and requires a reason', () => {
    // a request with a rate and no reason is rejected; with a reason it applies
});

test('a rate outside 5-95 is clamped, not rejected', () => {
    // the Director supplying 130 gets 95, and the receipt records what it asked for
});

test('goal.edit changes status, so goal.close is not needed', () => {
    // status: 'achieved' applies through goal.edit
});

test('goal.create and goal.edit address the Goal by name against this turn\'s advertised set', () => {
    // a name that was not advertised is rejected; the advertised one applies
});

test('the capability dictionary names exactly the five verbs', () => {
    expect(getCapabilityDictionary().map((c) => c.name).filter((n) => n.startsWith('goal.')).sort())
        .toEqual(['goal.create', 'goal.delete', 'goal.edit', 'goal.reach', 'goal.relate']);
});
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement**

Keep every request going through the existing validation → transaction → receipt path. **Containment is unchanged**: names resolve against the closed set advertised that turn via `resolveByName`. A Goal created this turn is not addressable this turn — same rule Variables follow, and the transaction rolls back if a request names it.

- [ ] **Step 4: Run, verify, mutation-check**

- Accept a rate with no reason → the reason test red.
- Reject instead of clamping an out-of-range rate → the clamp test red.
- Resolve names against the store instead of the address book → the addressing test red. **This one is the containment property; if it stays green, say so loudly.**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(remodel): let the Director state a Goal's rate instead of picking a band"
```

---

### Task 4: Move the vocabulary into the prompt

**Files:**
- Modify: `direction-sources.js` — the mechanics guidance the Director badge contributes
- Test: `tests/remodel-direction-sources.test.js` (extend)

The seven opening bands and the shift magnitudes become **reference points in editable prompt text**, not a lookup. The Director reads them and states a number.

- [ ] **Step 1: Write the failing tests**

```js
test('the guidance offers rate reference points the Director can reason from', () => {
    const { mechanicsSkill } = buildDirectionSources(snapshotWithGoals, { mechanicsEnabled: true });
    expect(mechanicsSkill).toMatch(/\b5\b/);   // nearly impossible
    expect(mechanicsSkill).toMatch(/\b95\b/);  // nearly assured
});

test('the guidance carries no pacing or style policy', () => {
    const { mechanicsSkill } = buildDirectionSources(snapshotWithGoals, { mechanicsEnabled: true });
    expect(mechanicsSkill).not.toMatch(/pacing|rhythm|prose|length|tone/i);
});

test('no compiled band table survives anywhere in the prompt', () => {
    // the old enum words must not appear as a required vocabulary
    const { mechanicsSkill } = buildDirectionSources(snapshotWithGoals, { mechanicsEnabled: true });
    expect(mechanicsSkill).not.toMatch(/never state a percentage/i);
});
```

- [ ] **Step 2: Run, implement, run**

- [ ] **Step 3: Mutation-check** — insert a pacing word and confirm the no-policy test goes red; remove the rate reference points and confirm the first test goes red.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(remodel): give the Director rate guidance it can reason from"
```

---

### Task 5: Log owner edits to the Goal event ledger

**Files:**
- Modify: `story-goals-store.js` — record an event on owner-initiated writes
- Test: `tests/remodel-goal-events.test.js` (create)

`addStoryGoalEvent`, `getGoalEvents` and `getTimelineGoalEvents` exist and have no callers. This is what they were for.

An owner edit and an AI change must be **distinguishable** in the ledger — the store's write functions already take an `actor` (`createTimelineGoal` defaults it to `'user'`). Use it.

- [ ] **Step 1: Write the failing tests**

```js
test('an owner edit is recorded and marked as the owner\'s', () => {
    // edit a Goal as the owner, read getGoalEvents, assert one event with actor 'user'
});

test('an AI change is recorded and distinguishable from an owner edit', () => {
    // the two must not be indistinguishable in the ledger
});

test('the ledger records what changed, not merely that something did', () => {
    // an event with no before/after is unreadable six turns later
});
```

- [ ] **Step 2: Run, implement, run, mutation-check** — stop recording owner edits and confirm the first test goes red.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(remodel): record owner edits in the Goal ledger"
```

---

### Task 6: The deck becomes an authoring surface

**Files:**
- Modify: `story-goals.js` — the Roleplay Goal board
- Modify: `style.css`
- Test: manual, plus any pure helpers extracted

Today `story-goals.js` imports exactly three store functions and the deck's empty state reads *"Goal creation will return after the timeline-owned system is designed."* That system shipped. The **+ New Story Goal** button sits above copy explaining why it does not work.

- [ ] **Step 1: Wire the authoring the store already exposes**

Create, edit, delete, link an existing Timeline Goal into this Scene, unlink it, relate two Goals. The unreferenced exports are `createSceneGoal`, `deleteStoryGoal`, `linkGoalToScene`, `unlinkGoalFromScene`, `createSceneGoalRelation`, `deleteStoryGoalRelation`.

- [ ] **Step 2: Make every attribute editable**

Title, description, holders, targets, visibility (`public` | `secret`), success rate, status (`active` | `achieved` | `abandoned` | `impossible`), relationships.

- [ ] **Step 3: Distinguish creating from bringing in**

Goals are Timeline-owned and Scenes hold links. Creating a Goal and pulling an existing Timeline Goal into this Scene are different actions and both belong on the deck — the empty state already says "brought into this scene".

- [ ] **Step 4: Replace the empty state's copy.** It currently explains why creation is unavailable. It will be available.

- [ ] **Step 5: Verify what can be verified offline**

No live API, and the app cannot be opened. Run both suites, the syntax check, brace balance. **CSS must not hardcode how many Goals or attributes exist** — this codebase has broken repeatedly because a rule counted its children or enumerated ids, and the new element was always the one the old rule did not know about. Derive from the children.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(remodel): let the owner author Goals on the deck"
```

---

### Task 7: Verify in the running app

**Files:** none — verification only. Requires the owner's live API connection.

- [ ] **Step 1:** Create a Goal by hand on the deck. Edit its rate, visibility and status. Delete one.
- [ ] **Step 2:** Confirm the Director sees an owner-created Goal by name on the next turn.
- [ ] **Step 3:** Confirm a Director-created Goal appears on the deck and is editable there.
- [ ] **Step 4:** Run a directed pass where a Goal should move. Confirm the receipt records a rate the Director chose, with its reason — not a band name.
- [ ] **Step 5:** Confirm the Goal ledger shows owner edits and AI changes, distinguishably.
- [ ] **Step 6:** Confirm an existing Goal that used to carry a tracked resolution still works.

---

## Self-review notes

**Spec coverage.** Principle (code as oracle) → Tasks 1, 3. Vocabulary to prompt → Task 4. Deletions → Tasks 1, 2. Owner authoring → Task 6. Ledger → Task 5. Migration → Task 2. Deferred owner rolls → not planned, by decision.

**Ordering matters.** Task 1's grep is what tells Task 2 and Task 3 where the deleted functions were called. Do not reorder them.

**Known gap, deliberate.** How the *owner* rolls a Goal is out of scope. The code-side roll exists and the Director can call it; the owner's path to it is a later design, and Task 6 should not invent one.

**The risk the spec names and this plan cannot remove:** a free number is easier to get wrong than an enum. The clamp and the reason requirement bound it; a Director swinging a rate 40 points on a whim is now expressible, and the owner sees it in the receipt.
