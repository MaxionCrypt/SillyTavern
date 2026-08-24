# Living Lore and World Sense

**Status:** Proposed implementation plan for `feature/loom`.

## 1. Product promise

A Timeline can begin with one small lorebook and a premise. As play establishes
people, places, factions, history, rules, relationships, and unresolved
possibilities, the same lorebook becomes a larger and more useful account of
that world. The system retrieves the right entries during chat, notices when
accepted fiction changes them, and proposes precise additions or revisions.

The lorebook remains the canonical home of Living Lore. World Sense is the
attention, indexing, and change-control layer around it; it is not a second lore
database.

The first version uses a lightweight local Hugging Face embedding model. It does
not ask that small model to become the setting's novelist. The native Narrator
creates fiction and the Loom understands its consequences; local inference
finds which existing lore matters. This adds no third remote API call to an
ordinary turn.

## 2. Decisions

### 2.1 Canon and ownership

- One Timeline-bound lorebook is the writable Living Lore book.
- Global, persona, character, and manually chat-bound books continue through
  native World Info, but are read-only to Living Lore in the first release.
- Canonical facts live in ordinary native lorebook entry fields: content, keys,
  secondary keys, enabled state, insertion settings, and entry title/comment.
- Remodel may keep operational metadata keyed by `book + uid`: entry type,
  provenance, revision, protected fields, last retrieval, proposal history, and
  links. That sidecar is an index and audit record, not a second source of lore.
- Existing user-authored entries remain valid. Living Lore recommends a format;
  it does not rewrite a whole book merely to impose one.
- Goals remain mechanical objects with holders, status, odds, and history.
  Optional typed links (`subject`, `context`, `stake`, `origin`, and
  `consequence`) connect them to durable lore entries without duplicating Goal
  state into lore content. Variables keep their existing linked-but-separate
  relationship to lore entries.

### 2.2 What local AI does

The local model performs semantic attention:

1. embed lore entries when the book changes;
2. embed one bounded query packet per turn;
3. return semantically related candidate entries;
4. combine those candidates with deterministic keyword, continuity, pinned,
   location, cast, Goal, and Archive evidence;
5. rank a small lore packet for native World Info and the Loom.

The model stays warm while a directed Scene is open. Composer input is queried
after a short debounce, cached by query hash, and reused by Preview or Send when
the submitted text still matches. A changed hash invalidates the prefetched
result. This makes background prefetch an optimization, never a source of stale
lore.

Default candidate for the spike: `Xenova/all-MiniLM-L6-v2`, quantized, through
SillyTavern's existing Transformers/vector infrastructure. The exact default is
accepted only after a local benchmark; the adapter and saved model id must be
configurable so the architecture does not depend on one model name.

The local model does **not** freely overwrite entries, invent canon in the
background, resolve mechanics, or decide that speculative model reasoning is
true.

### 2.3 What the Narrator and Loom do

- The Narrator creates the lived fiction as it does today.
- The Loom receives only a bounded packet of relevant writable lore entries.
- Alongside Archive/Goal operations, the Loom may emit typed **lore proposals**
  describing what accepted fiction warrants.
- Proposals are validated and committed only at the same accepted-fiction
  boundary used by the roleplay pipeline.
- A later optional powerful mode may use a selected remote model for deliberate
  world expansion. It is not required by this first architecture.

This division lets a seed grow richly without asking a tiny local model to
author rich prose. The main creative model makes the world real in narration;
Living Lore captures and organizes what became real.

## 3. Entry contract

### 3.1 Entry types

The sidecar recognizes these initial types:

- `entity`: character, place, faction, culture, creature, object, institution;
- `rule`: magic, technology, law, custom, economy, metaphysics;
- `situation`: a changing condition or unresolved world-level pressure;
- `history`: an event whose consequences matter beyond the recent chat window;
- `seed`: premise, plot skeleton, mystery skeleton, or expansion hook.

Types guide retrieval and mutation policy. They do not change native World Info
schema or prompt placement.

### 3.2 Recommended content shape

An AI-managed entry should be concise and organized around one subject:

```text
Identity
What this subject is and the stable facts that define it.

Established
Durable facts the fiction has made canonical.

Current
The latest state that may change during play.

Open threads
Unresolved possibilities, clearly written as possibilities rather than facts.
```

Not every entry needs all four sections. Existing prose-only entries remain
valid. Mutation operations target sections or individual facts, never an
unstructured full-entry replacement.

### 3.3 Keywords

Primary keys are strong identifiers:

- canonical name;
- aliases, titles, abbreviations, and unique epithets;
- unique place/object/faction terms that should activate the entry directly.

Secondary keys are disambiguators or relationships:

- a parent location, faction, associated person, event, or domain;
- terms that are meaningful only together with a primary key according to the
  entry's native selective-logic setting.

Rules:

- prefer 2-8 precise primary keys over broad words such as `city`, `magic`, or
  `woman`;
- never delete a user-pinned key automatically;
- normalize duplicate casing and whitespace, but preserve intentional aliases;
- keyword proposals identify the evidence that introduced an alias;
- semantic retrieval supplements keys; it does not silently rewrite them;
- an entry can be pinned for one turn, forced always-on by native settings, or
  excluded from World Sense without disabling native World Info.

## 4. What is scanned

World Sense uses different evidence before and after narration.

### 4.1 Before a request: retrieval query

The bounded query packet contains:

- the current user action, or the composer draft during Preview;
- for Continue, the provisional open thread and current Goal pressures;
- a short window of accepted and revealed chat prose;
- current Archive scene facts and character states;
- active Goals;
- active cast, location, and Timeline premise;
- explicit search terms and one-turn pins supplied by the user.

Each source is labelled and length-limited. A giant concatenation of the whole
chat is neither necessary nor desirable.

### 4.2 After a response: change evidence

Mutation proposals may rely on:

- final accepted visible prose;
- the Archive delta actually committed for that turn;
- Goal changes actually committed for that turn;
- the entry revisions that were supplied to the Loom;
- explicit user instructions to grow or revise lore.

### 4.3 What is deliberately not scanned as truth

- private chain-of-thought or provider reasoning;
- the entire assembled API prompt;
- Prompt Log or Debug transcripts;
- unrevealed Narrator draft tails;
- rejected retries, discarded swipes, or failed requests.

Reasoning and prompts contain speculation, alternatives, instructions, and text
the user never accepted. They remain diagnostics. If a reasoning model reaches
a useful conclusion, that conclusion must appear in accepted prose or a valid
committed Archive operation before Living Lore treats it as evidence.

## 5. Retrieval pipeline

Retrieval is hybrid and inspectable:

1. **Scope:** load enabled entries from the Timeline's writable lorebook.
2. **Deterministic activation:** preserve native primary/secondary keyword,
   constant, probability, recursion, and inclusion-group behavior.
3. **Semantic candidates:** query the local embedding index with the bounded
   World Sense packet.
4. **Structural evidence:** boost entries linked to present cast, current
   location, active Goals, recent Archive changes, one-turn pins, and recent
   retrieval continuity.
   A relevant lore entry boosts its linked Goals and Variables; an active Goal
   or retrieved Variable contributes its linked entries back to lore ranking.
5. **Deduplicate:** identity is always `book + uid`; native and semantic matches
   merge into one candidate with multiple reasons.
6. **Budget:** rank into a configurable entry and token budget. Constant and
   explicitly pinned entries bypass rank but still consume prompt tokens.
7. **Activation:** semantically selected native entries are force-activated for
   the next native World Info scan, preserving their configured insertion
   position and role.
8. **Receipt:** record selected and rejected entries, evidence channels, model,
   index revision, elapsed time, and budget decision in Debug.

Lore entries use the native World Info token budget. Goals and Variables retain
their shared mechanics retrieval budget. The evidence graph is shared, but the
delivery budgets are separate so a long lore entry cannot evict a mechanically
essential Goal or Variable.

The existing native Vectors extension already demonstrates the correct
`WORLDINFO_FORCE_ACTIVATE` seam. Remodel will own a Timeline-scoped index and
receipt so behavior does not depend on a separate extension being enabled.

The current directed dry-run and native Narrator generation are two separate
World Info scans. A semantic selection consumed by the dry-run must be
force-activated again for the actual generation. Preview uses the same resolver
but performs no lore mutation.

If local inference is unavailable, loading, or over budget, the turn proceeds
with native deterministic World Info only. World Sense must fail open, never
block roleplay.

## 6. Lore proposal protocol

The Loom does not receive a generic `edit this JSON` tool. It receives bounded,
typed operations:

```json
{
  "operation": "entry.create | fact.append | current.set | thread.add | alias.add | entry.link | entry.retire",
  "target": { "book": "Timeline Book", "uid": "42", "revision": 7 },
  "entryType": "entity",
  "section": "Current",
  "value": "Marissa now suspects Eli can sense her emotions.",
  "evidence": "exact accepted prose or committed Archive fact",
  "confidence": 0.91,
  "reason": "one sentence"
}
```

Validation rules:

- target book must be the Timeline's writable Living Lore book;
- updates require the revision the Loom read, preventing stale overwrite;
- evidence must occur in accepted prose or identify a committed Archive delta;
- protected fields and protected seed sections cannot be changed;
- `fact.append` deduplicates normalized facts;
- `current.set` changes current state, never stable identity;
- `entry.retire` disables or marks superseded; it does not delete;
- arbitrary full content replacement is not a capability;
- a failed operation cannot partially save the rest of its transaction;
- every applied proposal stores before/after data for rollback.

### Automation modes

- **Observe:** retrieval only; no proposals.
- **Suggest** (default): proposals appear in a review queue with field-level
  diffs.
- **Auto-safe:** additive facts, aliases, links, and current-state changes may
  apply when validation and confidence pass; identity, primary premise,
  protected seeds, retirement, and deletion always require review.

No mode automatically deletes entries.

## 7. Interruption, Retry, and Continue

- A fully delivered turn may commit proposals supported by its accepted prose.
- On interruption, only operations whose evidence exists in the accepted
  visible prefix are eligible. Everything based on the hidden tail is dropped.
- If catch-up cannot prove an operation from the accepted prefix, it stays a
  suggestion rather than becoming canon.
- Retry and swipe create a new proposal set; unapplied proposals from the
  superseded generation are invalidated.
- Continue uses recent accepted prose, Archive state, open thread, Goals, and
  current location/cast as its retrieval query. It does not need invented user
  input.
- Preview runs retrieval and shows the exact selected lore packet, but it never
  saves proposals, changes retrieval recall, or edits a lorebook.

## 8. Growing a small skeleton into a large world

A seed entry can mark text as either:

- **protected premise:** fixed unless the user edits or unlocks it;
- **open hook:** intended to be elaborated through play;
- **unknown:** deliberately unanswered;
- **planned possibility:** guidance, not established canon.

Growth happens in three ways:

1. **Emergent capture:** narration establishes a durable person, place, rule, or
   change; the Loom proposes a new entry or a precise update.
2. **Consequence growth:** Goal, faction, location, and relationship changes
   update existing entries and create links between them.
3. **Directed cultivation:** in the Lorebooks workspace the user can select a
   seed or several entries and request a pointed expansion, contradiction
   check, missing-connection search, or field-specific revision.

The system must distinguish elaboration from canon. An expansion drafted from
a seed begins as a proposal. It becomes canonical immediately only in
Auto-safe where the operation is additive and does not assert an event that has
not happened.

This supports a grand world over time without pre-generating a giant setting:
new detail is attached to the subjects play actually touches, while unused open
hooks remain small.

## 9. User interface

The Lorebooks workspace gains a **World Sense** utility, not a separate top-level
world editor.

Required surfaces:

- status: Off / Observe / Suggest / Auto-safe, local model, load/index state;
- semantic search with book/type/status filters;
- exact reasons an entry matched the current scene;
- one-turn Pin and Exclude controls;
- entry type, protection, provenance, revision, and related entries;
- proposal queue with field-level diff, Apply, Apply safe, Reject, and Edit;
- per-entry change history and rollback;
- `Grow this seed`, `Find related lore`, `Check contradictions`, and `Update
  from scene` pointed actions;
- a dry-run panel showing the lore packet that Preview/Narrator/Loom will see.

The Roleplay composer area also shows explicit, non-blocking turn stages:

- `Preparing context`;
- `Retrieving lore`;
- `Narrator drafting`;
- `Loom reconciling`;
- `Revealing`;
- `Saving world`.

Only the currently active stage is emphasized. Completed stages collapse to a
subtle check, failures name the failed stage, and Stop remains available. The
labels describe progress without exposing hidden Narrator prose or private
reasoning.

The ordinary native entry editor remains the source editor. World Sense augments
it with metadata and proposals rather than replacing it.

## 10. Diagnostics and performance budgets

Debug records use a `world-sense` category correlated with `directionId`:

- index begin/end/failure and changed entry count;
- query sources by label and character count, not hidden content by default;
- candidates, reasons, selected budget, and fallback mode;
- force-activation before dry-run and before native generation;
- proposal parsed/validated/queued/applied/rejected/stale;
- lorebook revision before and after a transaction;
- elapsed milliseconds for embedding, query, ranking, and saving.

Prompt and response bodies continue through the existing sensitive transcript
controls.

Performance rules:

- index only changed entry hashes and do it after edits or while idle;
- keep the selected local model warm while a directed Scene is open;
- debounce composer queries and reuse them only when their query hash matches;
- one query embedding per turn, shared by retrieval consumers;
- cap candidates before any Loom prompt is assembled;
- cache by query hash for Preview followed by Send;
- abort local work when the direction is superseded;
- after model warm-up, target under 500 ms at the initial supported book size;
- record p50/p95 locally and keep the threshold configurable;
- model download and first load are explicit UI states, never a frozen chat;
- timeout falls back to native keywords without failing the turn.

## 11. Commit sequence

Each stage is intended to be independently reviewable and revertible.

### Commit 0 - Freeze the design

`docs(remodel): define Living Lore and World Sense`

- this plan;
- architecture vocabulary and non-negotiable safety boundaries;
- no runtime behavior.

### Commit 1 - Pure lore identity and metadata

`feat(remodel): add Living Lore entry metadata`

- pure `book + uid` identity;
- entry types, revision, protected fields, origin, and links;
- extension-owned versioned store and migrations;
- tests proving existing native entries remain unchanged.

### Commit 2 - Read-only Timeline lore adapter

`feat(remodel): expose Timeline lore to World Sense`

- enumerate only the Timeline-bound writable book;
- normalize keys, secondary keys, content, native flags, and hashes;
- cache invalidation on World Info events;
- no prompt changes and no writes.

### Commit 3 - Local model spike and benchmark gate

`feat(remodel): add local World Sense embeddings`

- configurable Hugging Face model adapter;
- incremental Timeline collection indexing;
- cold-load, warm-query, memory, and representative-book benchmark screen;
- deterministic fallback and explicit model-unavailable state;
- accept or replace the proposed MiniLM default based on measured results.

### Commit 4 - Roleplay stage feedback

`feat(remodel): show directed turn progress`

- one run-scoped stage state machine for context, lore, Narrator, Loom, reveal,
  and save;
- compact composer-area feedback with duration diagnostics and Stop preserved;
- recovery and failure states cannot leave a stale stage on screen;
- no generation or prompt behavior changes.

### Commit 5 - Hybrid retrieval and receipts

`feat(remodel): rank Living Lore for each scene`

- bounded query packet;
- keyword, semantic, cast/location, Archive, Goal, pin, and continuity evidence;
- typed Goal-to-lore and existing Variable-to-lore relevance propagation;
- background composer prefetch with strict query-hash reuse;
- one ranking/token budget and pure diagnostics;
- tests for deduplication, ranking, budget, fallback, and Continue queries;
- Debug receipts, still with no prompt activation.

### Commit 6 - Native World Info activation

`feat(remodel): activate World Sense lore natively`

- force selected entries through native World Info;
- repeat activation for directed dry-run and actual native generation;
- Preview parity and Preview non-mutation;
- preserve entry role/position, recursion, probability, and inclusion behavior;
- integration tests for duplicate suppression and model failure fallback.

This is the first commit that changes what the Narrator can see.

### Commit 7 - Loom lore packet and proposal schema

`feat(remodel): let Loom propose typed lore changes`

- bounded selected-entry packet with revisions;
- typed proposal operations and strict parser;
- no lorebook writes yet;
- prompt-log and Debug visibility;
- tests rejecting arbitrary replacement, wrong books, and stale refs.

### Commit 8 - Transactional lore mutations

`feat(remodel): validate and apply Living Lore proposals`

- field-level mutation engine;
- evidence, protection, deduplication, revision, and token validation;
- atomic native `saveWorldInfo` transaction;
- before/after audit history and rollback;
- Suggest mode only.

### Commit 9 - Roleplay lifecycle safety

`fix(remodel): bind lore commits to accepted fiction`

- completion, interruption, catch-up, Retry, swipe, failure, and recovery rules;
- accepted-prefix evidence checks;
- idempotency by direction/message/proposal id;
- reload recovery without duplicate application;
- recorder-driven browser scenarios.

### Commit 10 - Lorebooks workspace UI

`feat(remodel): add World Sense to Lorebooks`

- status/model/index controls;
- semantic search and retrieval explanations;
- metadata/protection editor;
- proposal review, field diff, history, and rollback;
- responsive and keyboard-accessible browser validation.

### Commit 11 - Seed cultivation tools

`feat(remodel): grow Living Lore from authored seeds`

- seed section/protection controls;
- pointed search and edit actions;
- create/link/update proposal previews;
- contradiction checks and duplicate candidate warnings;
- no automatic remote-model dependency.

### Commit 12 - Auto-safe and hardening

`feat(remodel): add guarded automatic lore upkeep`

- opt-in Auto-safe allowlist and confidence threshold;
- book-size and latency stress tests;
- model download/offline/corrupt-index recovery;
- secret-leak, prompt-budget, concurrent-edit, and migration tests;
- end-to-end Debug recordings and user documentation.

## 12. Acceptance scenarios

1. **Small premise:** bind a book with a premise and three seed entries. After
   several turns, newly established people and places appear as reviewable
   proposals with evidence and links; protected premise text is unchanged.
2. **Keyword miss:** mention an alias absent from keys. Semantic retrieval finds
   the right entry, Debug explains why, and an alias proposal is offered.
3. **Specific search:** search for `who controls shipping near the old harbor`;
   receive a ranked, explained set and edit one exact field without touching
   unrelated entries.
4. **Continue:** with no user text, Continue retrieves from open thread, Goals,
   location, cast, Archive, and recent accepted prose; the world advances using
   relevant lore rather than random entries.
5. **Interruption:** interrupt after half a revelation. No proposal based only
   on the hidden tail applies.
6. **Retry:** retry a completed draft before applying its suggestions. Old
   suggestions become stale and cannot overwrite the new turn.
7. **Offline local model:** disable or remove the local model. Native keyword
   World Info and roleplay continue; Debug records deterministic fallback.
8. **Manual protection:** lock identity and primary keys, then ask to grow the
   entry. Additive sections may be proposed; locked fields remain unchanged.
9. **Concurrent edit:** manually edit an entry after the Loom read it. The stale
   revision is rejected and shown as a merge conflict, never silently saved.
10. **Large book:** unchanged entries are not re-embedded, the prompt respects
    the lore budget, and warm retrieval stays within the measured target.

## 13. Questions answered and deferred

Answered now:

- **Does everything revolve around lorebook entries?** Yes. Content canon lives
  there; sidecar state exists only for indexing, safety, and history.
- **Do we define how keywords work?** Yes: strong primary identifiers, secondary
  disambiguators, pinned-key protection, evidence-backed alias proposals.
- **Do we scan reasoning and prompts to decide relevance?** No. Retrieval uses
  labelled story state and accepted prose. Reasoning and full prompts are
  diagnostics, not canon.
- **Can a tiny starting book become grand?** Yes, through emergent capture,
  consequence updates, links, and deliberate seed cultivation.
- **Can a plot skeleton improve over time?** Yes, while protected premise and
  established-vs-possible distinctions prevent the AI from quietly rewriting
  the intended plot.
- **Can searches and edits be specific?** Yes. Search returns entry-level
  reasons; mutations target one field/section with a revision and diff.
- **How do Goals join Living Lore?** Through typed links while remaining the
  sole home of live odds and status. Relevance flows both ways; state is never
  duplicated into lorebook prose.
- **Does local retrieval wait for Send?** No. Background composer prefetch is
  the default, with query-hash validation preventing stale reuse.

Deferred until the model spike or first UI review:

- final default Hugging Face model after real hardware measurements;
- initial supported lorebook size for the 500 ms warm-query target;
- default semantic/top-K thresholds after recorder evidence;
- whether Auto-safe ships enabled as an option in the first public release or
  remains behind an experimental switch;
- whether a later powerful expansion mode calls the Loom connection or receives
  its own selectable connection/recipe.
