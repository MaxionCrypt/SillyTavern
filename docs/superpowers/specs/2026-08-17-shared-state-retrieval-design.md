# Shared state retrieval — design

## Why

Goals and Variables reach the Director by completely different rules, and only
one of them is bounded.

**Variables are selected.** `variables-relevance.js` scores every Variable in
the Timeline across five channels — a linked Lorebook entry activating, a vector
match clearing that Variable's own threshold, a linked subject present in the
cast, the action naming it outright, and continuity from a recent change — gates
each one on its `retrieval.mode`, ranks the survivors, and takes the top
`retrievalLimit` (default 6, hard cap 12). A hundred authored Variables cost
nothing in prompt size.

**Goals are not selected at all.** `mechanics-runtime.js` calls
`getSceneGoals(scene.id, { states: ['active', 'background'] })` and renders every
one, with its title, rate, status, description, holders and targets. Twenty
Goals is twenty Goals in the prompt, on the slowest call in the loop, every
turn. The owner's measured Director calls already run 6–17 seconds on a Timeline
with **one** Goal.

There is also a signal nobody is reading. The Director now keeps a notebook —
typed entries it wrote itself about what matters right now — and retrieval has
never looked at it. It is the best available evidence for what this scene is
actually about, produced free as a side effect of the Director doing its job.

## Decisions

Settled with the project owner before design:

| Decision | Choice |
|---|---|
| Ranking | **One scorer, one shared budget.** Goals and Variables compete in a single ranked set. |
| Cross-linkage | One-directional: a scoring Goal contributes its description as a query source for Variables. Variables do not pull Goals. |
| Recall weight | A **windowed count** — how many of the last N turns an item was retrieved in — not a running total. |
| Weight storage | Computed fresh each turn. Only the recall window is persisted. |
| Notebook evidence | Includes `secret` entries. |
| Cost | No LLM call. Vector queries already happen; Goals add none. |

## The principle

**Retrieval is evidence-driven and free.** Every channel reads data that
already exists — the action, the history, activated lore, the vector index, the
notebook, the stores — and no channel costs a model call. The Director's own
notes become the strongest signal precisely because it wrote them about this
scene, this turn.

## Design

### 1. One scorer over two kinds of item

`retrieveRelevantVariables` becomes `retrieveRelevantState`, taking Goals
alongside Variables and returning one ranked list of tagged items
(`{ kind: 'variable' | 'goal', … }`). `mechanics-runtime.js` reads Goals from
that result instead of calling `getSceneGoals` directly.

**Eligibility differs and must stay differing.** A Variable is gated by its
`retrieval.mode` before score matters — that gate is the Variable system's
contract with the owner and is not up for renegotiation here. A Goal has no
such field and is always eligible; score alone decides whether it makes the cut.
So the two are ranked together but admitted differently, and the implementation
must not collapse that distinction into one rule.

### 2. The channels

The five that exist, unchanged, applying to Variables as they do today. Three
new ones, applying to both kinds:

- **Notebook mention.** The item's name appears in a recent notebook entry.
  Weighted above passive evidence and below the action naming it directly: the
  Director writing "Morale is fraying" is a deliberate statement that Morale
  matters, but the user acting on it now matters more.
- **Goal text pulls Variables.** Directional, and deliberately not symmetric: a
  Goal that scored contributes its **description** as a query source for
  Variable retrieval. Two strengths, because the evidence genuinely differs:
  - the description **names a Variable outright** — a direct, near-certain
    signal, weighted like the action naming it;
  - the description merely reads as semantically close to a Variable's linked
    lore — a weak signal, weighted like any other vector match.

  This replaces the symmetric notebook co-occurrence an earlier draft proposed.
  It is better because it reads a field the Goal already has rather than
  inferring relatedness from prose, it is one-directional so there is no chain
  to bound, and "Wren is looking for her sister at the frat party" is exactly
  the kind of text that should surface a Variable about Wren.

  Variables do not pull Goals in return. A Variable is a bare name and a number;
  it carries no text that could describe a Goal, so the reverse direction would
  be inventing a signal rather than reading one.
- **Windowed recall.** The item was retrieved in some of the last N turns.
  Deliberately the weakest channel and deliberately windowed: an all-time
  counter would make whatever surfaced first keep surfacing, and the set would
  ossify around it. A window decays by construction — stop pulling something and
  its weight is gone.

**Goals get no vector channel.** They have no lore links and no indexed
documents, and indexing them would add an embedding cost on every Goal edit.
Their text is short and distinctive, so name and keyword matching against the
action, the recent history and the notebook is sufficient. Vector-indexing Goals
is a possible later change, not part of this one.

### 3. What is persisted

One per-Timeline ring buffer: which item ids were retrieved on which turn,
capped at the recall window. Nothing else. Every other channel is derivable at
retrieval time from data that already exists, so there is no weight store to
keep in sync and nothing that can go stale.

### 4. Secrets

The notebook channel reads `secret` entries. Retrieval feeds the **Director's**
prompt, and the Director owns its own secrets — a `[secret]` noting that Faction
Heat is about to matter should pull Faction Heat. This is safe because the
Narrator never receives Variables or Goals at all; it receives notes, and
`readNarratorEntries` already withholds secrets there. The one place a secret
legitimately shapes selection.

### 5. The budget

One limit covering both kinds, replacing `retrievalLimit`'s Variables-only
meaning. Default 8, hard cap 16, owner-settable as today. The existing
`retrievalLimit` value migrates forward as the shared budget.

**A Goal-poor turn spends the budget on Variables and vice versa**, which is the
point of sharing it — but it also means a scene whose Goals are its whole
subject can in principle arrive with them ranked below Variables. Accepted: the
notebook channel is the mitigation, because a Director that cares about a Goal
will have written about it.

### 6. Diagnostics

The existing `exclusionReason` and `reasons` fields extend to Goals, so the
Retrieval view in the Timeline State drawer shows why a Goal was or was not
sent. Without this the owner cannot tell a Goal that scored badly from a Goal
that was never eligible.

## Out of scope

- Vector-indexing Goals.
- Changing any Variable's `retrieval.mode` semantics.
- The Narrator's prompt. It receives notes, not state, and is untouched.
- Owner-facing tuning of individual channel weights.

## Risks

- **Sharing a budget can starve either kind.** Mitigated by the notebook
  channel and by the budget rising from 6 to 8, not eliminated.
- **A Goal description can pull the wrong Variables.** Long, discursive
  descriptions will match loosely. Bounded by being one-directional and by the
  semantic half carrying only a vector match's weight, but a Goal whose
  description is a paragraph of scene-setting will be a noisy query source.
- **Recall could still ossify a small Timeline.** With three Variables and two
  Goals everything fits under the budget anyway, so the channel does nothing
  until there is enough state for it to matter — which is the correct failure
  mode, but means it is least tested where it is most active.
- **The scorer becomes the single point of failure for what the Director knows.**
  It already is for Variables; this extends that to Goals. A scoring bug now
  silently hides a Goal rather than an item of numeric state.

## As built

Five places where the implementation decided something this design left open
or got wrong. Recorded here because the spec is the durable record.

- **The new channels are evidence, not just weight.** "Out of scope: changing
  any Variable's `retrieval.mode` semantics" was ambiguous about whether a
  notebook mention could satisfy `any` or corroborate. It can, and so can a
  Goal description naming the Variable — each is an independent authored
  statement about that Variable, which is what those modes mean by evidence.
  **Recall cannot**, and is the sole member of `SCORE_ONLY_CHANNELS`, because
  it is circular: an item is recalled because it was retrieved, so letting it
  satisfy a gate would let one lucky turn keep re-qualifying a Variable
  forever. Without that exclusion, recall plus a single activated link reaches
  two distinct links and corroborates.
- **A Goal being attempted this turn bypasses the budget.** Not in the design,
  and necessary: the prompt names it under ATTEMPTED THIS TURN and the
  capability layer will accept a roll against it, so retrieval dropping it
  would advertise a Goal the Director cannot address.
- **`always` Variables carry a floor above evidence-free Goals.** `always` is a
  promise that the Variable is sent every turn. A shared budget with a wall of
  zero-scoring Goals could otherwise break it on an alphabetical tie.
- **Token matching floors at three characters, not four.** Four deletes short
  proper nouns — Rae, Kai, Ana — which are exactly the words that identify a
  Goal. The stopword list carries the cost.
- **Goals reuse `retrievalWindow` as the recall window** rather than adding a
  setting, and the buffer stores 30 turns while reading a slice, so lowering
  the window is a view change and not a deletion.
- **An empty Goal list gets the same treatment the empty Variable list got.**
  `(none active)` claimed "none are relevant" while meaning either that or
  "this Scene has never had one". A Scene with no Goals at all now carries an
  invitation to `goal.create`, suppressed when mechanics are off.

## Verification

- Unit-test each new channel in isolation, and mutation-check that removing it
  changes what is selected.
- Unit-test that a Variable failing its `retrieval.mode` gate stays out
  regardless of how well it scores, and that a Goal needs no gate.
- Unit-test that recall is windowed: an item retrieved twenty turns ago and not
  since carries no weight.
- Unit-test that Goal-to-Variable pull is one-directional, and that a Variable
  named outright in a description outranks one merely semantically near it.
- Confirm from a debug export on the owner's Timeline that a Goal the Director
  wrote about is selected and one it has ignored is not.
