# Remodel Roleplay System

This document records the Roleplay architecture implemented by
`SillyTavern-Remodel` and the contracts that current work must preserve. It is
an implementation reference first and a roadmap second. Features that are not
finished are identified explicitly rather than described as if they already
exist.

## 1. Product model

Remodel treats Story and Roleplay as related but distinct writing modes.

- **Story** is a document editor. The user owns cause and consequence; the AI
  is a co-author beneath explicit Story prompts and Scene Beats.
- **Roleplay** is a continuous scene. A hidden directing pass interprets cause
  and consequence, then a selected Narrator or cast member performs the visible
  prose.
- Goals and Variables are durable memory for the fiction. They do not turn a
  scene into a compulsory round structure.
- Initiative, ordered combat rounds, blind planning, and synchronized action
  phases are optional future layers, not the foundation of Roleplay.

All implementation lives under
`public/scripts/extensions/third-party/SillyTavern-Remodel`. Native
SillyTavern data and generation functions remain authoritative, and no core
source file or server endpoint is modified.

## 2. Scene ownership and navigation

A Timeline contains Arcs, and Arcs contain Story or Roleplay Scenes.

- A Story Scene owns a `StoryDoc` and may bind a character, prompt recipe,
  Author Guidance, and a document-specific lorebook.
- A Roleplay Scene points at a native solo or group chat and stores Remodel
  presentation and direction settings around it.
- Opening a Tavern drawer over a Scene leaves that Scene mounted. Closing the
  drawer returns to it.
- Opening another Scene explicitly replaces the previously mounted Scene,
  including direct Scene-to-Scene navigation without first using Back.
- Timeline Goals and Variable instances survive Scene changes. Scene deletion
  removes its links and scene-local presentation state; Timeline deletion owns
  the cascade of Timeline mechanical data.

Roleplay Scenes retain the `free` and `directed` staging boundary:

- **Free** uses SillyTavern's normal send and generation path.
- **Directed** uses Live Direction before an owned native performer request.

## 3. Cast, Narrator, and Roleplay Director

Directed Roleplay uses character cards for recognizable authorial voices while
keeping their responsibilities separate.

### Roleplay Director

The user assigns a character card from the Scene's group as **Roleplay
Director**. The assignment is stored as a stable performer reference and shown
as a compact badge in Cast.

The Director card:

- provides the directing personality and instructions for a hidden structured
  Chat Completion call;
- is excluded from the list of visible performers for that response;
- does not write an ordinary chat message;
- selects an available Narrator or cast member and supplies their movement;
- may propose authorized mechanical requests and visible-fiction checkpoints.

The Roleplay stream may show an extension-owned Director operation card. That
card contains the model's declared summary, beats, observations, intent, and
performer rationale. It is not a raw private reasoning transcript.

### Narrator and performers

The Narrator is bound by stable avatar identity when possible. Other group
members may also perform. A Director-selected performer is validated against
the Scene's current, unmuted cast before generation begins. Native character
indices are resolved only at the moment of generation so card reordering does
not silently redirect the request.

Manual next-speaker selection acts as a one-response performer override. The
Director still determines the movement for that response.

## 4. Live Direction

Live Direction is implemented in `live-direction.js` with protocol
`remodel-direction/1`. A validated direction envelope contains:

```text
performerRef
movement
  objective
  constraints[]
  breathingGuidance
flow
  continueAfter
  hardPauseAfter
openings[]
mechanics
  immediateRequests[]
  checkpoints[]
```

### Directed send flow

For a new user intervention, Remodel:

1. Preserves the draft and attached Goal intents.
2. Builds a read-only snapshot of accepted history, current input, cast,
   persona, native World Info, Goals, Variables, relationships, and recent
   mechanical receipts.
3. Calls the assigned Director through `generateRaw` with a strict JSON schema.
4. Validates the performer, movement, requests, and checkpoint identifiers.
5. Applies only authorized immediate consequences of already accepted fiction.
6. Inserts the original user message through the native chat path.
7. Temporarily injects the movement and marker contract into one owned native
   performer request.
8. Clears temporary injection after generation, including failure paths.

The Director and performer calls are ownership-guarded so summaries, unrelated
extensions, and background generations cannot recursively enter this pipeline.
If direction fails, the draft remains available with **Retry Direction** and
**Send Normally** recovery actions.

### Breathing markers and buffered reveal

Visible performer text may contain:

```text
[[RM:BREATH]]
[[RM:OPENING:id]]
[[RM:COMMIT:id]]
[[RM:HARD_PAUSE]]
```

`live-direction-markers.js` parses complete markers, hides partial markers,
and strips unknown or malformed Remodel markers without executing them. Markers
are never retained in accepted prose.

Remodel buffers native output and reveals sanitized text at the Scene's pacing:

| Pacing | Reveal speed | Adaptive breath | Opening delay |
|---|---:|---:|---:|
| Slow | 28 chars/sec | 700–2200 ms | +750 ms |
| Natural | 45 chars/sec | 400–1400 ms | +600 ms |
| Fast | 75 chars/sec | 150–650 ms | +350 ms |
| Instant | Unthrottled | None | Visual cue only |

Meaningful typing creates a soft hold at the exact visible character. Clearing
the composer resumes the same buffered response. A hard pause waits for the
user regardless of pacing. Openings are opportunities, not permission gates;
the user can intervene at any time.

### Intervention and accepted history

If the user submits while prose is held or revealing, the visible fragment is
authoritative:

1. Freeze the exact accepted visible text.
2. Stop and settle any native stream.
3. Replace the native message and active swipe with only that fragment.
4. Strip all markers and unseen suffix text.
5. Mark the message as interrupted and save the corrected chat.
6. Direct the next response from the fragment plus the new intervention.

An incomplete sentence remains incomplete when that is what the user saw.
Manual Stop follows the same accepted-text rule.

### Continuation and recovery

- Autoplay may request another movement after a fully revealed response.
- The default autonomous limit is three visible responses after one submitted
  user message.
- Typing, Stop, a hard pause, or the safety limit ends automatic chaining.
- Only a submitted user intervention resets the safety counter.
- Natural pacing, autoplay on, and a limit of three are migration defaults for
  Directed Scenes.
- Reveal offsets and direction metadata are persisted at meaningful boundaries.
- Reload recovery sanitizes an unfinished response to the last accepted offset
  and returns in a waiting state; it never resumes an old API request.
- Regenerate reverses checkpoint transactions owned by the replaceable response
  before replaying its saved movement with the same performer.

## 5. Goals as persistent story memory

Goals are Timeline-owned records in `storyGoalsV1`. Scenes contain links to
those Goals rather than owning their lifetime.

A Goal records:

```text
title and description
holderRefs[] and targetRefs[]
visibility: public | secret
successRate: 5–95
resolution: instant | tracked
relationships[]
status: active | achieved | abandoned | impossible
```

- Owners may be characters, personas, groups, factions, objects, locations,
  the Timeline, another Goal, or a recoverable custom identity.
- Public Goals enter normal Roleplay context.
- Secret Goals enter private behavioral context with an instruction not to
  disclose them merely because they are present.
- Sympathetic and antagonistic relationships inform directing judgment. They do
  not apply hidden arithmetic by themselves.
- The Goals board provides the active deck, detail surfaces, manual creation,
  and composer chips for explicit Advance or Attempt intent.
- AI changes reach storage only through validated capability requests.
- User/persona changes require direct authorization or review according to the
  Mechanics profile. Bounded NPC and world changes may apply automatically and
  remain reversible.

Goals are not automatic clocks. They are addressed when the fiction or an
explicit user action makes them relevant.

## 6. Typed Variables

Variables provide structured memory without forcing every entity into the same
numeric template. They are stored in `storyVariablesV1`.

### Definitions and instances

A **Variable definition** describes meaning and behavior:

- key, name, and kind (`resource`, `number`, `enum`, or `boolean`);
- optional lorebook reference;
- summary and constraints;
- enum states and allowed transitions;
- reach contribution rules;
- impact scales and named interpretations.

A **Variable instance** stores one owner's Timeline-specific value, maximum,
interpretation, and modifiers.

Definitions do not impose one universal starting value. For example, one
Vitality definition linked to a physiology entry can expose a human
interpretation and a vampire interpretation with different starting values,
maxima, impact scales, and derived states. The chosen interpretation or an
explicit instance value determines the actual record.

Multiple definitions may link to the same lorebook entry. Remodel stores the
link metadata without editing native World Info. Missing links remain visible
and rebindable.

### Scope and owner identity

- Definitions and templates may be account-wide.
- Runtime instances and AI-proposed definitions belong to a Timeline.
- Character and persona templates are copied on first mechanical use, after
  which Timeline values diverge independently.
- Native owners use stable character avatar, group, or persona identifiers.
- Free-form factions, organizations, objects, and locations use typed custom
  owner references rather than mutable display-name matching.

The Variables Tavern workspace implements definition browsing, Timeline
instances, owner filters, templates, local-definition review and promotion,
lorebook links, immutable history, and the Mechanics profile. Read-only macros
expose values, derived states, modifiers, and definition prose to prompts.

## 7. Mechanical capability protocol

`mechanics-capabilities.js` implements `remodel-mechanics/1`. The Director sees
only addressable IDs and advertised operations:

```text
goal.create       goal.shift       goal.reach
goal.relate       goal.close
variable.instantiate  variable.propose
variable.adjust      variable.transition
modifier.add      modifier.remove
```

Each request has an ID, capability, typed arguments, and reason. Code validates
the schema, accessible entities, authority, bounds, transition rules, and
dependencies. A batch is atomic: an invalid dependent operation restores the
pre-transaction snapshot. Receipts record validated inputs, before/after state,
rolls, derived states, approval state, and rejection reasons.

Directed Roleplay uses the unified Director call for these requests. The older
separate cast-authored directive protocol and separate Goal Director recipes
are retired. The standalone mechanics runtime remains an internal reusable seam
for explicit diagnostics and non-Live-Direction callers, not a second mandatory
AI call on every directed message.

The Mechanics profile defaults to disabled, a 6,000-token context budget,
hybrid authorization, and pause-on-failure. When disabled, Goals and Variables
remain visible, editable memory and the Director must return no mechanical
requests.

## 8. Success Rate and tracked resolution

Success Rate expresses the chance that a decisive attempt lands from the
current fictional position. It is clamped to 5–95%.

### Opening rates

| Band | Rate |
|---|---:|
| Nearly impossible | 5% |
| Extreme | 15% |
| Difficult | 30% |
| Uncertain | 50% |
| Favorable | 70% |
| Strongly favored | 85% |
| Nearly assured | 95% |

### Position shifts

| Magnitude | Shift |
|---|---:|
| Minor | 3 |
| Meaningful | 7 |
| Major | 12 |
| Decisive | 20 |

Every shift requires its own reason. Setup shifts are applied before a reach in
the same atomic transaction. Each Goal may be reached at most once per
transaction.

Before a reach, code freezes the final rate, selected reach modifier, modifier
value, tracked Variable, direction, threshold, and requested impact magnitude.
Code—not the model—rolls the d100:

```text
final margin = Success Rate - d100 + modifier
```

- Margin `>= 0` is a hit.
- Margin `< 0` is a miss.
- A positive modifier may rescue a miss.
- A negative modifier may turn a narrow hit into a miss.
- Only definitions explicitly configured for reach contribution may supply the
  modifier.

Miss depth changes the Goal's future position:

| Miss depth | Rate change |
|---|---:|
| 1–10 | -2 |
| 11–25 | -5 |
| 26–50 | -10 |
| 51+ | -18 |

On an instant hit, the Goal completes. On a tracked hit, the selected impact is
converted through the bound Variable definition:

- Resource defaults: 10%, 20%, 35%, or 50% of effective maximum.
- Number defaults: 1, 2, 5, or 10.
- Definitions and interpretations may override those scales.
- Enum and Boolean Variables use explicit transitions and are not tracked
  resolution targets in the current version.

The Variable is clamped and derived states are applied in code. The Goal
completes only when its configured threshold is reached. Side effects require
separate validated requests.

Modifiers persist until explicitly removed, until accepted fiction establishes
their configured ending condition, or until their Scene ends when they are
explicitly Scene-scoped. Legacy numeric durations migrate as persistent records
with a visible migration note.

## 9. Mechanical commitment follows visible fiction

Immediate requests may represent only accepted history or the submitted user
intervention. Future consequences use checkpoint IDs.

The visible performer emits `[[RM:COMMIT:id]]` after narrating the fact that
establishes a consequence. A checkpoint executes only when its marker crosses
the visible reveal boundary.

- A checkpoint in unseen or discarded text never mutates state.
- A checkpoint already revealed remains valid after interruption.
- Each checkpoint is an atomic capability transaction tied to its direction and
  message IDs.
- Failure creates a diagnostic receipt for the next Director pass and does not
  erase accepted prose.
- A Goal is rolled only for an explicit user reach or an authorized NPC reach.

This is the bridge between free-flowing prose and durable mechanics: accepted
fiction commits state; speculative buffered prose does not.

## 10. Prompt and World Info integration

Prompt Studio stores named Story and Roleplay recipes by Chat or Text
Completion. Scene-level selectors choose among recipes valid for the active
mode and API boundary.

For Roleplay Chat, active recipes mirror native prompt markers and may include
the linked **Story Goals** source before Chat History. Live Direction reads
native Roleplay context without replacing the native Prompt Manager.

Story uses a separate isolated World Info resolver. It derives global,
character, persona, and optional document lore from the StoryDoc rather than
the active native chat. Story preview and generation share that resolver.

The separation is intentional: automatic mechanical adjudication currently
runs only in Directed Roleplay. Story may display and manually edit shared
Timeline Goals and Variables, but remains user-authored.

## 11. Diagnostics

The Remodel Debug workspace and Live Direction flight recorder make the
multi-stage pipeline inspectable.

They record structured events for:

- workspace and Scene transitions;
- adopted native UI state;
- Director snapshots, requests, validation, and performer selection;
- native generation ownership and lifecycle;
- marker parsing, reveal state, holds, checkpoints, and recovery;
- mechanical requests, transactions, and receipts;
- errors and relevant API metadata with redaction.

The Debug workspace updates in real time across open tabs through an
extension-owned channel and can export a JSON diagnostic bundle. It is a
development instrument, not a replacement for native logs or browser network
inspection.

## 12. Migration and compatibility

Current normalization and migration code:

- upgrades Directed Scenes with Natural pacing, autoplay, and the three-response
  limit;
- converts legacy Narrator and Director character indices into recoverable
  performer references;
- removes special visible Director-role behavior without deleting the card or
  group membership;
- imports valid legacy stat instances and preserves ambiguous owners in an
  unassigned review list;
- converts embedded tracked pools and legacy stat references into Timeline
  Variable definitions and instances where possible;
- normalizes malformed Goal, relationship, Variable, modifier, and active-scene
  references defensively.

No sample Goals, Variables, definitions, or templates are seeded by the source
code. Disposable runtime fixtures used for API testing remain user data and are
not repository fixtures.

## 13. Current implementation status

### Implemented

- Timeline-owned Goals with Scene links and persistent statuses.
- Typed Variable definitions, interpretations, instances, modifiers, templates,
  lorebook links, derived states, macros, history, and workspace UI.
- Capability validation, atomic transaction rollback, receipts, and code-owned
  d100 resolution.
- Director character assignment, structured direction, performer validation,
  native performer generation, and operation cards.
- Marker parsing, paced reveal, soft holds, hard pauses, Openings, intervention,
  checkpoint commitment, Stop, reload recovery, and autonomous safety limit.
- Prompt Studio integration, isolated Story World Info, full Story document
  editor, and the remodeled Personas, Lorebooks, Timelines, and Roleplay
  workspaces.
- Structured debug journal, Live Direction flight recorder, JSON export, and
  cross-tab live updates.

### Partially implemented and under active hardening

- Buffered reveal behavior across every native streaming provider and every
  group-generation edge case.
- Regeneration and checkpoint reversal across unusual swipe histories.
- Full approval/rejection and undo presentation for all stored transactions.
- Rich Goal editing, relationship authoring, resolved archive, and mechanical
  event-card presentation in the Roleplay stream.
- Narrow-layout refinement for the largest Variables and Goals surfaces.
- Text Completion may display and edit mechanical memory, but automatic Live
  Direction requires a configured Chat Completion connection.

### Deferred

- Initiative, ordered combat rounds, synchronization, and blind action phases.
- Automatic Story-mode adjudication.
- Arbitrary executable lorebook behavior or custom expression languages.
- A per-call model override independent of the configured Chat Completion
  connection.
- Reusable mechanical package import/export and revision history.

## 14. Source map and checks

Primary modules:

```text
live-direction.js              direction and reveal controller
live-direction-markers.js      marker parser and sanitizer
live-direction-diagnostics.js  direction flight recorder
mechanics-capabilities.js      capability registry and transactions
mechanics-runtime.js           reusable mechanical snapshot/preflight seam
story-goals-store.js           Timeline Goal persistence
story-goals-model.js           Goal normalization
story-goals-math.js            rate and reach math
story-goals.js                 Roleplay Goal board and composer integration
story-variables-store.js       definitions, instances, templates, migration
story-variables-ui.js          Variables Tavern workspace
story-stats-macros.js          read-only prompt macros
debug-console.js               structured journal and Debug workspace
timeline-state.js              Scene and Live Direction normalization
timeline-spine.js              workspace and native-chat integration
```

Repository checks cover JavaScript syntax, marker parser fixtures, CSS balance,
whitespace integrity, and Playwright diagnostics around reload recovery and the
disposable directed Scene. Real API sessions remain necessary for provider-
specific streaming, interruption, and group-generation behavior.
