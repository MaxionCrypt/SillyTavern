# Goals as memory — design

## Why

`Roleplay_System.md` contradicts itself about what a Goal is.

§1: *"Goals and Variables are durable memory for the fiction. They do not turn a
scene into a compulsory round structure."*

§5: *"Goals are not automatic clocks. They are addressed when the fiction or an
explicit user action makes them relevant."* And relationships *"do not apply
hidden arithmetic by themselves."*

§8 then specifies a tabletop resolution engine underneath that memory: seven
named opening-rate bands mapped to fixed percentages, four shift magnitudes
mapped to fixed numbers, a code-owned d100, `margin = rate − roll + modifier`,
a four-tier miss-depth penalty table, impact scales converting a hit into
10/20/35/50% of a Variable's maximum, reach-contribution rules, and an
attrition pool with a constitution bite.

The dice are not the problem. **The hardcoded vocabulary is.** `goal.shift`
takes an enum of four band names, and its own schema tells the model: *"Code
converts it to a number; never state a percentage yourself."* The Director is
forbidden from expressing judgement about how far a Goal moved, and can only
select from four magnitudes someone else chose.

There is also a plain gap. §13 records it: **Goals have no human authoring
path.** `createSceneGoal`, `deleteStoryGoal`, `linkGoalToScene`,
`unlinkGoalFromScene`, `createSceneGoalRelation`, `deleteStoryGoalRelation`,
`addStoryGoalEvent`, `getGoalEvents` and `getTimelineGoalEvents` are all
exported and referenced by nothing. `story-goals.js` imports exactly three
store functions. Every write path to a Goal runs through an AI capability
request, and the deck's own empty state says so: *"Goal creation will return
after the timeline-owned system is designed."* That system shipped; the UI
never caught up.

That is backwards from Variables, where the owner authors and the Director
moves what exists.

## The principle

**Code is an oracle the Director calls, not a rulebook that constrains it.**

- What must be **unfakeable** stays in code: the d100, the margin arithmetic,
  hit/miss, clamping, the atomic transaction, the receipt. The Director asks
  and cannot fudge the answer.
- What encodes **judgement** moves into the Director's editable prompt: what
  counts as a favourable chance, how far a meaningful shift moves. The owner
  edits that vocabulary; the Director applies it.

## Decisions

Settled with the project owner before design:

| Decision | Choice |
|---|---|
| Storage | Unchanged. `storyGoalsV3`, Timeline-owned, Scene links. |
| Who creates Goals | Both the owner and the Director. |
| Owner's powers | Full: create, edit, delete, edit values and internal attributes, link to Scene, relate. |
| Director's powers | Read, create, edit, delete — reliably, addressed by name. |
| Opening bands, shift magnitudes | Move to the Director's prompt. `goal.shift` takes a number. |
| Dice and margin math | Stay in code, called by the Director. |
| Miss-depth penalties | Deleted. |
| Impact scales | Deleted. |
| Attrition pool | Deleted. |
| Tracked resolution | Deleted. A Goal is just a Goal. |
| Rate clamp | Keep 5–95 for rollable rates; `achieved` and `impossible` express the absolutes. |
| Owner-initiated rolls | Deferred, not designed here. |

## Design

### 1. What the Director may do

Five capabilities, all addressed **by name** against the set advertised that
turn, exactly as Variables are:

- `goal.create` — a new Goal with title, description, holders, targets,
  visibility and an opening success rate.
- `goal.edit` — change a Goal's attributes, including its success rate, with a
  reason. Replaces the band-constrained `goal.shift`.
- `goal.delete` — remove a Goal.
- `goal.reach` — declare one decisive attempt. Code freezes the rate and
  modifier, rolls the d100, computes the margin, and returns the outcome.
- `goal.relate` — create or update a directional relationship.

`goal.close` folds into `goal.edit`, since status is just an attribute.

**The rate is a number the Director supplies**, informed by prompt guidance
rather than selected from an enum. A shift and an opening rate are the same
kind of value and stop being different operations.

### 2. What the Director is told

The locked block the Director badge contributes gains the vocabulary that used
to be compiled in — the rate bands as reference points, and what sizes of move
are meaningful — phrased as guidance, editable in the recipe like everything
else. It states that code owns the roll and that a reach returns a result the
Director must respect.

Nothing about pacing, style or authorial policy. That belongs to the owner's
recipe; putting it here recreates the problem the Director rework existed to
end.

### 3. What is deleted

From `story-goals-math.js`: `missBand`, `constitutionBite`, `applyBite`,
`isPoolResolved`, `openingRateForBand`, and the shift-magnitude lookup.
`rollD100`, `clampRate`, `margin`, `isHit` and `resolveReach` remain.

From the Goal record: `resolution`, and with it the tracked-Variable binding,
the completion threshold, and `resolution.variableRef` through the capability
layer, `describeResolution` in `mechanics-runtime.js` and
`describeGoalResolution` in `direction-sources.js`.

If the Director wants to treat a Variable as a Goal's constitution it says so
in its notes and reads the value. Nothing binds them in code.

### 4. The deck becomes an authoring surface

`story-goals.js` gains what its store has always exposed: create, edit, delete,
link an existing Timeline Goal into this Scene, unlink it, and relate two
Goals. Every attribute the record holds is editable — title, description,
holders, targets, visibility, success rate, status, relationships.

**Creating and bringing-in are different actions.** Goals are Timeline-owned
and Scenes hold links; the deck's own empty state distinguishes them
("brought into this scene"). Both belong on the deck.

Owner edits go through the store directly. They are not capability requests —
the capability layer exists to constrain a model, not its owner.

**Owner edits are logged to the Goal event ledger**, separately from AI
changes and distinguishable from them. `addStoryGoalEvent`, `getGoalEvents`
and `getTimelineGoalEvents` already exist and have no callers; this is what
they were for. Without it the ledger records only what the Director did, and a
Goal's history reads as though the owner never touched it.

### 5. Migration

Existing Goals carry `resolution`. Dropping the field must not throw, and a
Goal whose resolution pointed at a Variable keeps working as an ordinary Goal.
`normalizeStoryGoal` is the single funnel; the field is dropped there.

No Goal is deleted, retitled, or has its rate changed by this migration.

## Out of scope

- **Owner-initiated rolls.** How the owner rolls a Goal is deferred by explicit
  decision. The code-side roll exists and the Director can call it; the owner's
  path to it is a later design.
- Initiative, ordered combat rounds, synchronized action phases — already
  deferred in §13 and untouched here.
- Automatic Story-mode adjudication.
- Variables. Their store, retrieval and capabilities are unchanged.

## Risks

- **A number is easier to get wrong than an enum.** The four magnitudes made a
  nonsense shift impossible; a free number does not. Mitigated by the clamp and
  by the reason requirement, but a Director that moves a rate 40 points on a
  whim is now expressible. The owner sees it in the receipt.
- **Deleting tracked resolution loses a real idea.** "This Goal is about this
  number" was expressible and now is not, except in prose. Accepted
  deliberately: it wired Goals and Variables together in code where the fiction
  should have done it.
- **The deck grows a lot of surface at once.** Create, edit, delete, link,
  unlink, relate, and per-attribute editing is more UI than the deck has ever
  had, and it is the surface the owner uses most.
- **Owner writes bypass the capability layer**, so they produce no receipts.
  That is correct — the owner is not a model being constrained — and the event
  ledger covers the gap, but an owner edit and an AI change are recorded by
  different machinery and could drift apart in what they capture.

## Verification

- Unit-test the reach path end to end with a supplied rate: frozen inputs, a
  seeded roll, the margin, and the receipt.
- Unit-test that a Goal's rate can only be changed with a reason.
- Unit-test the migration against a Goal carrying a tracked resolution: it
  survives, loses the field, and nothing throws.
- Confirm by execution that a Goal created by the owner is addressable by the
  Director on the next turn, and vice versa.
- Confirm the prompt contains no compiled band table, and that the Director's
  guidance is whatever the recipe says it is.
- A live directed pass remains the only test of whether the Director actually
  uses the vocabulary well.
