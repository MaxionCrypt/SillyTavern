# Narrator Authority and Background Loom Experiment

**Status:** Rework in planning. The first experimental implementation was
abandoned; its branch was deleted after persistent Archive, reveal, routing,
and lifecycle failures.

**Historical branch:** `experiment/narrator-authority-background-loom`
(deleted; no runtime code from it is active).

**Baseline:** `72b5b9db1` (`fix(remodel): compact state and rebase lore reviews`)

## 1. Experiment promise

Roleplay narration should begin as soon as the Narrator starts producing prose.
The Narrator becomes the sole visible author. The Loom no longer writes,
replays, or delays that prose; it observes accepted fiction in the background
and maintains the shared Loom Archive and Timeline Web.

Mechanically decisive moments remain authoritative. Either the player or an
AI-controlled actor may initiate an attempt. The Narrator identifies the
attempt and dramatizes its result, but deterministic application code freezes
the relevant state, performs calculations and rolls, and returns a receipt the
same logical Narrator turn must obey.

The experiment succeeds only if it improves perceived latency without losing:

- interruption semantics;
- Goal and Variable integrity;
- long-term Archive and Living Lore growth;
- NPC agency and mechanically initiated actions;
- edit, Retry, regenerate, rollback, and reload safety;
- the Narrator's established prose style.

## 2. Role boundaries

### 2.1 Narrator

The Narrator owns:

- all visible roleplay prose;
- actor choices, including choices made by AI-controlled characters;
- identifying when an action becomes a mechanically meaningful attempt;
- proposing Goal progress and Variable value changes warranted by the scene;
- requesting calculations or rolls and obeying their returned receipts;
- deciding how an authoritative result appears in prose;
- author-level access to secrets, subject to explicit actor-knowledge scopes.

The Narrator does not directly write persistent stores. A retry, edit, or
provider reconnect must never apply the same numeric change twice.

### 2.2 Mechanics engine

Deterministic capability code owns:

- resolving advertised names and references;
- freezing Goal odds, Variable values, modifiers, stakes, actor, and attempt
  index before a calculation;
- random number generation and success/failure calculation;
- validation, clamping, authorization, transaction identity, and receipts;
- exact-once application and rollback.

The Narrator has narrative authority over why a change is warranted; the
mechanics engine remains the physical writer of validated numeric state.

### 2.3 Loom

The Loom becomes a background Timeline Web recorder. It owns:

- Archive events, scene state, character state, unresolved beats, and secrets;
- detecting, creating, relating, closing, retiring, or superseding Goals;
- detecting, creating, relating, closing, or retiring Variables;
- Living Lore proposals and World Sense promotion decisions;
- typed links and provenance across Archive, lore, Goals, and Variables;
- catch-up after interruption, failure, reload, or an unavailable provider.

The Loom may use Narrator-issued mechanics receipts as authoritative evidence.
It must not reinterpret a roll, change its result, produce replacement prose,
or become a second narrator.

### 2.4 World Sense and local inference

World Sense remains semantic attention, not canon authority. The existing
embedding model continues to retrieve relevant Timeline Web material. Optional
small local instruction models may prepare advisory scene packets, but cannot
roll dice, mutate canon, reveal secrets to an actor, or override the Narrator.

## 3. Target turn pipeline

```text
Composer activity
    -> World Sense prefetch
    -> optional local Scene Council prefetch

Send / Continue
    -> assemble native Narrator request
    -> stream Narrator prose directly into the visible message
    -> if a mechanics tool is requested:
         pause the logical Narrator turn
         freeze and execute the local mechanic
         append its authoritative receipt
         resume the same visible Narrator message
    -> user interruption accepts only the visible prefix
    -> finalize accepted prose and mechanics receipts atomically
    -> enqueue one background Loom ingestion job
    -> Loom updates Archive and Timeline Web without touching prose
```

The current turn's Loom job cannot truthfully ingest prose that has not been
written. "Concurrent" therefore means that Loom work is removed from the
visible critical path: it runs while the user reads or types and, where safe,
alongside later Narrator work. Earlier pending jobs may run while the current
Narrator is generating.

## 4. Background ordering contract

Each ingestion job carries:

- Timeline and Scene ids;
- direction and message ids;
- accepted-content hash and accepted character boundary;
- provenance for player action, Narrator prose, and mechanics receipts;
- source Timeline Web revision;
- status: queued, running, applied, stale, failed, or superseded;
- transaction and proposal ids produced by the job.

Rules:

1. Jobs are serialized per Timeline. Remote calls may overlap across isolated
   Timelines, but writes to one Timeline apply in accepted-fiction order.
2. Editing, Retry, regenerate, deletion, or rewind marks affected jobs stale
   and rolls back their transactions before replacement work applies.
3. Repeated completion events and reload recovery reuse the same identity and
   cannot apply duplicate operations.
4. A failed job never removes or delays accepted prose. It exposes `Archive
   needs attention` and supports automatic retry plus manual catch-up.
5. If the Narrator outpaces ingestion, contiguous accepted passages may share
   one catch-up request, but the result must retain ordered per-passage
   provenance and transactions.
6. Ordinary future narration may proceed from raw accepted chat while a job is
   pending. A turn that requires state created by that pending transaction must
   join it or use an explicitly declared one-turn-stale fallback.

## 5. Resumable mechanics contract

### 5.1 One logical turn, potentially multiple requests

A local custom mechanic normally requires more than one HTTP exchange:

1. the model requests a tool;
2. Remodel executes it locally;
3. the tool receipt is sent back;
4. the model continues.

The UI treats those exchanges as one direction, one Narrator, one message, and
one interruptible stream. The second request must carry the exact assistant
prefix and structured tool receipt so it continues rather than restarts.

The existing `streamChatPrompt` transport exposes cumulative text and reasoning
only. The experiment must first add an adapter capable of preserving native
prompt/profile behavior while exposing streamed tool-call deltas. A provider
without compatible tool calls falls back safely; it must not receive a fake
claim that a calculation occurred.

### 5.2 Initial mechanic tools

Keep the first vocabulary narrow:

- `goal.attempt`: an actor makes a decisive attempt against an advertised Goal;
- `goal.adjust`: accepted events warrant a non-random progress/odds change;
- `variable.adjust`: accepted events warrant a bounded Variable change;
- `mechanic.check`: a defined Variable/Goal rule requires a calculation that
  does not itself close a Goal.

Every request names the actor, advertised object, stakes, evidence, and proposed
modifier reason. Code supplies the frozen inputs, generated result, applied
change, and receipt id.

AI-controlled actors use the same tools and validation as the player. Actor
identity changes authorization and knowledge, not mathematical truth.

### 5.3 Mid-prose behavior

- Prefer mechanics requests during the Narrator's private planning/opening
  stage so a result is known before contradictory prose becomes visible.
- A legitimate request after visible prose has begun pauses the stream at a
  complete safe boundary, resolves, and resumes the same message.
- If the user interrupts before resolution, abort the tool continuation and do
  not apply an unaccepted result.
- If a receipt applied before interruption, persist it only when the accepted
  prefix establishes the attempt/result; otherwise roll it back.
- A malformed or repeated tool call fails closed and is visible in Debug, not
  converted into invented prose.

## 6. Goal and Variable ownership

Lifecycle and value authority are intentionally separate.

| Operation | Narrative decision | Validation/writer | Persistent interpretation |
| --- | --- | --- | --- |
| Create/relate/close Goal | Loom from accepted fiction | capability code/review policy | Loom |
| Create/relate/retire Variable | Loom from accepted fiction | capability code/review policy | Loom |
| Attempt Goal | Narrator for player or AI actor | mechanics engine | receipt then Loom archive |
| Adjust Goal value/odds | Narrator proposes | mechanics engine | receipt then Loom archive |
| Adjust Variable value | Narrator proposes | mechanics engine | receipt then Loom archive |
| Prose consequence | Narrator | accepted-fiction boundary | Loom records only |

The Loom may repair missing lifecycle records during catch-up. It may not invent
a numeric change unsupported by accepted prose or a Narrator mechanics receipt.

## 7. Secret and actor-knowledge contract

The Narrator may receive author-level secrets so it can construct dramatic
irony and causal behavior. Each secret or retrieved fact must distinguish:

- `authorKnows`;
- actors who `know`;
- actors who `suspect`;
- actors for whom it remains `unknown`;
- whether it may be revealed, foreshadowed, or only influence hidden causality.

An actor cannot speak, reason, or act from author-only knowledge. A local
knowledge scout may classify and format these boundaries, but only explicit
Timeline Web state can grant knowledge.

## 8. Optional Scene Council

The Scene Council divides attention before the main Narrator request. It is an
advisory prefetch layer, not a group of autonomous canon writers.

Initial advisory roles:

- **Actor intent:** current want, pressure, likely move, resistance, and
  plausible escalation for relevant actors;
- **Knowledge gate:** known, suspected, misunderstood, and unavailable facts;
- **Mechanics watcher:** relevant Goals, Variables, and possible tool triggers;
- **Continuity scout:** facts most vulnerable to contradiction;
- **Scene pressure:** offstage movement, interruptions, environmental activity,
  and unresolved beats that could naturally intrude.

Performance rules:

- batch relevant actors into one local instruction-model inference rather than
  launching competing GPU processes;
- select only onstage or strongly relevant actors under a strict budget;
- cache by actor plus Timeline Web revision and recompute only invalidated
  packets;
- begin after accepted turns and debounce against composer changes;
- share World Sense retrieval rather than embedding the same evidence again;
- never hold Send beyond a small configurable join budget;
- use the last valid packet or deterministic fallback when prefetch is late;
- allow an agent to return `no useful guidance` rather than manufacture detail;
- label suggestions as affordances; only knowledge and mechanical receipts are
  hard constraints.

This layer improves attention and omission resistance. It is not expected to
make a weak local model more insightful than the primary Narrator.

## 9. Rebuild method and commit journey

The second implementation must not mutate the working pipeline into its target
shape in place. It uses a repeated **isolate -> characterize -> decompose ->
rebuild -> reconnect -> verify** cycle.

### 9.1 Non-negotiable rebuild rules

1. **Freeze the working behavior.** Before touching a module, capture its input,
   output, events, storage writes, cancellation behavior, and live journeys in
   characterization tests.
2. **Put one adapter around it.** Outside code talks to a small explicit
   contract, not the module's internal variables or DOM.
3. **Leave the legacy implementation intact.** It remains the adapter's default
   implementation and the instant rollback path.
4. **Rebuild beside it.** The replacement receives new files, private state,
   test doubles, and no production callers while it is being decomposed. A
   destructive rewrite is allowed only inside this disconnected replacement.
5. **Reconnect at one seam.** A per-Scene experimental switch selects the new
   implementation. No unrelated caller is edited to know which version runs.
6. **Prove parity before new behavior.** The replacement must first reproduce
   the legacy contract. Only the next bounded commit may change ownership or
   timing.
7. **Run a live gate after every reconnect.** Unit tests alone cannot approve a
   module that touches streaming, profiles, persistence, native generation, or
   DOM lifecycle.
8. **Stop on regression.** Do not begin the next module while the current one
   throws, loses prose, leaves a permanent warning, uses the wrong profile,
   blocks input, or fails reload recovery.
9. **Delete old code last.** Cleanup happens only after the complete experiment
   is accepted. Until then, legacy and replacement implementations remain
   independently callable through the adapter.

The legacy Narrator -> Loom reveal stays active and switchable throughout. No
experimental module may require World Sense, Living Lore, Scene Council, or a
different Scene mode merely to function.

### Commit 0 - Stabilize and freeze the legacy baseline

`fix(remodel): stabilize routes, responsiveness, and UI recovery`

This is a hard gate, not scaffolding for the new pipeline. The experiment does
not begin until the application is already trustworthy.

- profile the current UI before optimizing it: long tasks, render counts,
  transcript serialization, storage writes, indexing, input latency, and hover
  latency;
- remove or schedule proven main-thread stalls, especially full-workspace
  rerenders and diagnostic persistence on hot paths;
- establish a responsiveness receipt in Debug and a repeatable recorder
  journey rather than relying on subjective speed alone;
- resolve the Narrator and Loom profile ids once at the start of each job and
  record the resolved role, profile id, provider, and model with the request;
- a missing or invalid assigned profile fails before sending; it never silently
  falls back to whichever global SillyTavern connection happens to be active;
- Narrator work may activate the Narrator's native profile, but Loom requests
  must use their explicitly assigned route without changing an in-flight
  Narrator route;
- serialize unavoidable global connection mutations and prove that Retry,
  Continue, Story co-authoring, Story Archive, and Roleplay Loom cannot steal
  one another's profile;
- add a versioned UI-location store that restores the last stable top-level
  workspace, Timeline, Arc, Scene, mode-specific view, selected Archive/Debug
  subview, and useful scroll anchor after reload;
- restore only stable navigation state, never a modal, confirmation dialog,
  stale generating flag, request controller, or half-applied transaction;
- preserve unsent Story and Roleplay drafts where their existing ownership
  permits it;
- capture baseline TTFT, visible completion, settlement, Archive completion,
  input latency, long tasks, and memory for later A/B comparison;
- add regression journeys for reload, wrong-profile prevention, rapid profile
  switching, typing during background work, and returning to the exact prior
  workspace.

**Commit 0 gate:** zero known disappearing-chat, stuck generation, permanent
Archive warning, profile-detachment, UI-location reset, or reproducible typing
lag defects remain. Its live recordings become the experiment's baseline.

### Commit 1 - Isolate Roleplay turn orchestration

`refactor(remodel): isolate the directed turn controller`

- define a small turn-controller contract for start, Continue, Retry, Stop,
  interrupt, edit/rerun, finalize, and recover;
- move run identity, accepted boundary, cancellation, and stage events behind
  the contract without changing behavior;
- make the current legacy pipeline the only adapter implementation;
- characterize DOM events, chat writes, Archive handoff, rollback, and reload;
- do not add background behavior or change visible prose ownership.

### Commit 2 - Decompose and rebuild Narrator delivery offline

`refactor(remodel): rebuild canonical Narrator delivery as a closed module`

- create a disconnected Narrator-delivery module with explicit prompt,
  connection-route, stream, accepted-prefix, and completion contracts;
- feed it captured request and streaming fixtures rather than the live turn;
- reserve one message identity and append prose monotonically;
- implement Stop, typed interruption, truncation, reasoning-only recovery,
  empty response, and provider error handling locally;
- make finalize idempotent and prove it cannot erase or duplicate the message;
- keep Loom, Archive, Goals, Variables, Living Lore, and World Sense outside the
  module.

### Commit 3 - Reconnect direct Narrator reveal

`feat(remodel): reconnect immediate canonical Narrator prose`

- select the rebuilt delivery module only through the turn-controller adapter
  and experimental per-Scene mode;
- reuse the established Narrator prompt assembly and strict route from Commit
  0;
- stream prose into the visible message immediately;
- allow the composer and Stop control to remain responsive while streaming;
- preserve pacing modes as reveal policies over the live stream, never as a
  wait for turn settlement;
- keep the legacy implementation one switch away.

**Commit 3 gate:** Narrator text appears before Loom or turn settlement, remains
after finalize and reload, and cuts off in place on Stop or user interruption.
GLM and at least one non-GLM profile must pass before proceeding.

### Commit 4 - Isolate Loom Archive ingestion

`refactor(remodel): isolate Loom Archive ingestion from reconciliation`

- characterize the currently working legacy Archive input, structured output,
  capability application, provenance, retry, and renderer updates;
- define one archive-ingestion contract that accepts accepted prose plus a
  bounded state packet and returns validated Archive operations;
- keep the existing legacy Loom implementation behind the adapter;
- explicitly exclude prose rewriting, swaps, reveal control, World Sense,
  Living Lore proposals, Goal/Variable mutation, and Scene Council;
- prove Story and Roleplay can call the same contract through separate input
  adapters without sharing transient run state.

### Commit 5 - Decompose and rebuild the Archive worker offline

`refactor(remodel): rebuild the Loom Archive worker as a closed unit`

- build the worker and durable per-Timeline queue without connecting it to live
  narration;
- send only the accepted current turn or interrupted prefix, its provenance,
  compact existing Archive context, and the Loom recipe—not the whole chat or
  unrelated World Sense state;
- bind every job immutably to its Loom profile and prompt snapshot;
- implement exact-once job identity, bounded retries, supersession, catch-up,
  reload recovery, timeout, and cancellation tests;
- distinguish pending, actively retrying, failed-repairable, and permanently
  rejected states;
- reserve `Archive needs attention` for a real durable failed job with a visible
  cause and repair action; successful or obsolete jobs must clear it;
- exercise the worker with recorded good, empty, reasoning-only, malformed,
  aborted, slow, and provider-error responses.

### Commit 6 - Reconnect background Archive without holding prose

`feat(remodel): reconnect background Loom Archive ingestion`

- enqueue only after a Narrator prefix becomes accepted;
- begin ingestion independently of reveal pacing and turn-save UI;
- never make visible prose, composer readiness, or UI navigation wait for Loom;
- update the shared Loom Archive only through validated archive operations;
- surface compact pending/saved/failed status and manual Retry/Catch up;
- preserve Story's manual/automatic Archive choice;
- leave Living Lore, World Sense, Goals, and Variables disconnected.

**Commit 6 gate:** run repeated Roleplay and Story turns, reload during every
queue phase, change profiles between jobs, and force malformed/slow replies.
Archive must catch up exactly once, use only its assigned profile, clear its
status, and never delay or erase narration. No later commit starts until this
gate passes in the recorder.

### Commit 7 - Isolate Timeline side effects

`refactor(remodel): isolate Archive consequences from Timeline stores`

- define typed, versioned events emitted after an Archive transaction commits;
- put Goal, Variable, lore, link, and continuity consumers behind independent
  subscribers;
- characterize current transaction, authority, idempotency, and rollback rules;
- a failed subscriber cannot roll back accepted prose or the base Archive;
- keep every subscriber disabled in the new pipeline until its own tests pass.

### Commit 8 - Rebuild Goal and Variable lifecycle projection

`refactor(remodel): rebuild Timeline lifecycle projection from Archive events`

- let Loom-originated lifecycle proposals create, relate, close, or annotate
  Goals and Variables through deterministic validators;
- do not allow the background Loom to roll, rewrite prose, or make unsupported
  numeric changes;
- preserve review authority and exact evidence provenance;
- rebuild and test this projection offline before enabling its subscriber;
- reconnect it with an independent feature switch and rollback receipt.

### Commit 9 - Reconnect Living Lore and World Sense downstream

`refactor(remodel): reconnect lore cultivation after Archive settlement`

- treat committed Archive evidence as input to promotion and proposal logic;
- keep retrieval prefetch off the Archive worker's critical path;
- restore Living Lore proposals, typed links, continuity, and review queues one
  subscriber at a time;
- a World Sense model/index failure must degrade retrieval only; it cannot fail
  Archive ingestion or leave the turn unsettled;
- compare proposals and retrieval receipts against the legacy baseline before
  enabling guarded automation.

### Commit 10 - Isolate resumable mechanics transport

`refactor(remodel): isolate provider mechanics continuation`

- place tool-call detection, ids, finish reasons, continuation, and provider
  capability detection behind a transport adapter;
- retain native prompt construction and the rebuilt Narrator stream contract;
- test GLM and at least one non-GLM profile with captured and live requests;
- do not mutate live Goals or Variables in this commit;
- define a text-only fallback that cannot leak control JSON into prose.

### Commit 11 - Rebuild the frozen mechanics gateway

`feat(remodel): resolve Narrator mechanics through frozen receipts`

- advertise a bounded tool vocabulary;
- freeze actor, objects, current odds/values, modifiers, stakes, and attempt id;
- execute deterministic rolls and exact-once transactions outside the model;
- return compact receipts to the same logical Narrator turn;
- make interruption, Retry, edit/rerun, regenerate, deletion, and reload either
  commit once or roll back cleanly;
- publish committed receipts as downstream Archive evidence.

### Commit 12 - Reconnect actor escalation and value changes

`feat(remodel): reconnect actor-initiated mechanics`

- allow advertised AI-controlled actors as well as the player to initiate an
  attempt;
- validate actor knowledge, ownership, relevant Goals/Variables, and available
  actions;
- let Narrator intent propose value deltas while deterministic code validates
  and applies them once;
- let the background Loom interpret lifecycle consequences afterward;
- test competing actors, failure, refusal, modifiers, duplicate requests,
  unavailable objects, and provider fallback.

### Commit 13 - Isolate and rebuild knowledge scopes

`feat(remodel): project author and actor knowledge explicitly`

- build a typed author-visible versus actor-known/suspected/unknown projection;
- keep projection separate from lore storage and prompt rendering;
- add recipe macros and exact Preview visibility;
- test dialogue, internal reasoning, Continue, Scene transitions, retrieval,
  mechanics, and background ingestion for leaks;
- reconnect through one prompt adapter only after fixture parity.

### Commit 14 - Evaluate the optional Scene Council separately

`feat(remodel): prefetch bounded scene advisory packets`

- begin only after Commits 0-13 are accepted;
- isolate local-model loading, batching, cache, invalidation, cancellation,
  timeout, and fallback from the primary turn;
- first record Actor intent, Knowledge gate, Mechanics watcher, Continuity
  scout, and Scene pressure packets without sending them to Narrator;
- activate packets one type at a time behind recipe macros and token budgets;
- never make Narrator TTFT depend on Scene Council completion.

### Commit 15 - Add cutover controls and diagnostics

`feat(remodel): expose modular pipeline diagnostics`

- show the selected implementation for turn controller, Narrator delivery,
  Archive worker, consequence subscribers, mechanics, and Scene Council;
- report immutable request profile/provider/model receipts by role;
- show a per-turn timing waterfall and main-thread responsiveness receipt;
- expose queue job cause, attempts, repair action, and exact accepted source;
- allow module-by-module fallback during development without silently changing
  prose ownership mid-turn.

### Commit 16 - Harden, evaluate, and only then remove superseded code

`test(remodel): validate the rebuilt Narrator authority pipeline`

- long Roleplay, rapid Continue, Stop and typed interruption during every stage,
  Retry, edit/rerun, regenerate, reload, navigation restore, provider failure,
  profile switch, queue backlog, Story ingestion, and cross-Scene continuity;
- mixed Roleplay/Story Timeline Web and review-queue tests;
- Goal/Variable transaction and rollback audits;
- compare legacy and rebuilt p50/p95 TTFT, visible completion, ready-for-next
  turn, Archive lag, tokens, correction rate, input latency, long tasks, and
  memory;
- record an explicit keep/rework/reject decision;
- remove a legacy implementation only in a later cleanup commit after the user
  accepts its replacement in sustained live use.

## 10. Acceptance journeys

1. **Ordinary conversation:** send a non-mechanical action. Narration starts at
   Narrator TTFT, remains unchanged, and the Loom updates Archive later.
2. **Lived-in Continue:** press Continue repeatedly. AI characters act without
   waiting for Loom prose; background jobs remain ordered and catch up.
3. **Player attempt:** select a Goal and act. Code freezes and rolls, the same
   Narrator continues from the receipt, and the result is recorded once.
4. **AI attempt:** an NPC initiates a mechanically meaningful action. It uses
   the same tool and odds path and cannot choose its result.
5. **Mid-prose tool:** a tool request pauses one visible message and resumes
   without repeated or missing prose.
6. **Interruption:** interrupt before and after a mechanics receipt. Only
   consequences established by the accepted prefix survive.
7. **Rapid next turn:** send again while Archive ingestion is pending. Raw chat
   continuity remains correct; a mechanics-sensitive dependency joins or names
   its stale-state fallback rather than silently misreading state.
8. **Retry/edit:** replace an earlier action. Old Loom jobs, lore proposals,
   mechanics receipts, Goals, Variables, and links are superseded or rolled
   back together.
9. **Secret tension:** the Narrator uses a secret for foreshadowing while an
   unaware actor neither states nor acts from it.
10. **Scene Council off:** disable the local model. Roleplay remains fully
    functional through deterministic retrieval and the main Narrator.
11. **Backlog/failure:** disconnect the Loom provider for several turns, then
    restore it. Visible play continues, ordered catch-up applies once, and the
    warning clears.
12. **Mixed mode:** accepted Story consequences and background Roleplay
    consequences continue to share one Timeline Web without sharing prose
    pipelines.

## 11. Evaluation thresholds

The experiment is a candidate to replace legacy reconciliation only if:

- first visible character is gated by the Narrator only;
- ordinary turns incur no synchronous Loom wait;
- no accepted prose disappears, restarts, or changes after display;
- every accepted turn reaches an applied or explicitly failed Archive job;
- queue lag remains bounded under repeated Continue;
- mechanics receipts are deterministic, exact-once, reversible, and obeyed;
- AI actors can initiate meaningful attempts without controlling the result;
- Timeline Web growth is at least as complete as the recorded Vox baseline;
- Scene Council prefetch does not measurably worsen Send latency when warm;
- unsupported providers degrade explicitly rather than hallucinating mechanics;
- the legacy pipeline remains a clean switch-back path until user acceptance.

## 12. Deliberately deferred

- replacing the primary Narrator with a multi-agent prose merger;
- allowing local agents to write canon or calculate random outcomes;
- automatic destructive lore changes;
- unrestricted model-authored tools;
- deleting the legacy Loom reconciliation pipeline;
- changing Story Scene prose ownership;
- choosing a permanent default local instruction model before benchmarks;
- deciding whether every non-random state adjustment needs a tool exchange or
  may use a validated end-of-turn side channel; Commit 10 transport evidence
  and Commit 11 receipt evidence decide this.
