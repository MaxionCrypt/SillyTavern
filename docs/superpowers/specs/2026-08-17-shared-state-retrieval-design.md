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
| Cross-linkage | Falls out of shared ranking rather than needing its own pass. |
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
- **Co-occurrence.** The item shares a notebook entry with something already
  scoring. This is what makes a Goal pull its Variables and a Variable pull its
  Goal, and it is the only cross-linkage available — the explicit Goal-to-
  Variable binding was deliberately deleted, so relatedness is now inferred from
  the Director's own prose rather than read from a field. Applied as a single
  pass over already-scored items, not recursively; a chain of three hops is not
  evidence of anything.
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
- **Co-occurrence is inference, not lookup.** A Goal and a Variable named in one
  entry may be unrelated. One hop bounds the damage; the weight is modest.
- **Recall could still ossify a small Timeline.** With three Variables and two
  Goals everything fits under the budget anyway, so the channel does nothing
  until there is enough state for it to matter — which is the correct failure
  mode, but means it is least tested where it is most active.
- **The scorer becomes the single point of failure for what the Director knows.**
  It already is for Variables; this extends that to Goals. A scoring bug now
  silently hides a Goal rather than an item of numeric state.

## Verification

- Unit-test each new channel in isolation, and mutation-check that removing it
  changes what is selected.
- Unit-test that a Variable failing its `retrieval.mode` gate stays out
  regardless of how well it scores, and that a Goal needs no gate.
- Unit-test that recall is windowed: an item retrieved twenty turns ago and not
  since carries no weight.
- Unit-test that co-occurrence does not chain — A pulling B must not pull C.
- Confirm from a debug export on the owner's Timeline that a Goal the Director
  wrote about is selected and one it has ignored is not.
