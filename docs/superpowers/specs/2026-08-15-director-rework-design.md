# Director rework — design

## Why

Directed Roleplay works, but the prose it produces reads flat and its pacing
does not feel dynamic. Investigation found two causes that share a root, plus a
structural problem in where prompts live.

**The performer is carrying the protocol.** At generation time the performing
character receives this, injected as a system note at depth 0 — closer to the
next word than its own character card:

```
[REMODEL LIVE DIRECTION — applies only to this response]
You are the visible performer <name>; never mention the hidden Director or this contract.
Objective: …
Constraints:
- …
Breathing guidance: Insert [[RM:BREATH]] at natural readable beats.
Openings:
- op1: <label>; emit [[RM:OPENING:op1]] at the opportunity.
Mechanical checkpoints:
- cp1: emit [[RM:COMMIT:cp1]] immediately after narrating the establishing fact.
Markers are invisible protocol. Emit only the exact known forms.
They are not prose and must never be explained.
```

So while composing, the model must hold an objective, a constraint list, three
marker formats, specific ids, and two prohibitions. That is clerical load at the
position where creative flow matters most, and *Objective / Constraints* framing
invites task-completion writing rather than someone inhabiting a person.

**Pacing depends on the model doing bookkeeping.** `[[RM:BREATH]]` is what
creates a beat. Absent or mechanically-scattered markers leave the reveal
falling back to a constant character-per-second drip. The scene's rhythm is
therefore hostage to a creative model emitting machine tokens well, in a format
whose effect it cannot observe.

**Prompt ownership is split and half-invisible.** The Director's prompt is a
hardcoded JavaScript template literal (`directionHandbook`), mixing three kinds
of content: protocol (unavoidable), mechanics doctrine (legitimate), and
authorial policy that has no business being in compiled code — "the world may
move without waiting for the user", "keep openings optional", "responses may be
long". The Narrator's prompt is native SillyTavern settings. There is no single
place to see or edit either.

## How the current loop works

Established by reading `live-direction.js`, not by inference.

1. Pending autoplay cancelled; an in-flight autonomous pass is abandoned, an
   in-flight user pass causes outright refusal of the new send.
2. On-screen prose settled — a revealing response is frozen at the exact visible
   character and the remainder discarded.
3. An in-flight lock is taken. Chrome reads *Directing*.
4. A snapshot is assembled: last 40 messages, the typed text, cast, persona,
   Director card, Goals as `g1…`, retrieved Variables as `v1…`.
5. **The Director is called** — `generateRaw`, four hand-built messages, strict
   JSON schema. This bypasses the native Prompt Manager entirely: the user's
   system prompt, jailbreak, author's note and prompt order never reach it. It
   performs its own World Info scan (`getWorldInfoPrompt(scan, maxContext,
   true)` — a dry run over the typed text plus the last 12 messages).
6. Envelope validated: performer must be an advertised unmuted cast member;
   protocol and direction ids are overwritten locally; capability refs must have
   been advertised this pass.
7. Immediate mechanical requests execute; any failure fails the whole turn.
8. **Only now is the user's message inserted into the chat.**
9. The movement is injected as an extension prompt at depth 0.
10. Native generation runs, `force_chid` to the chosen performer. This *does*
    use the full native pipeline.
11. Output is buffered, then revealed at scene pacing (28/45/75 chars-per-second
    or unthrottled). Markers fire as they cross the visible boundary and are
    stripped. Interruption freezes at the visible character.
12. On completion autoplay may schedule another pass, to a limit of three
    autonomous responses per user message.

Note that steps 5 and 10 activate World Info **separately** and can legitimately
resolve different entries for the same turn, since step 5 runs before the user's
message is in the chat.

## Decisions

Settled with the project owner before design:

| Decision | Choice |
|---|---|
| Director output | Free instruction prose plus a small structured tail |
| Performer selection | Removed — the Narrator badge decides who speaks |
| Variable/Goal addressing | Real names, not `v1`/`g1` refs |
| Locked content | Only the Goals/Variables interaction rules |
| Narrator prompt | The existing Roleplay recipe, relabelled |
| Marker load | Removed from the Narrator; beats derived in code |
| Message ordering | Out of scope for this rework |

## Design

### 1. Two recipes, one router

`director` and `narrator` become the Roleplay prompt modes in Prompt Studio.

**Narrator** is today's Roleplay recipe, relabelled and behaviourally unchanged.
It continues to mirror into the native Prompt Manager via `applyRecipeToNative`,
so the performer keeps native group handling, prompt ordering and everything
else core does for it.

**Director** is a new recipe compiled to an explicit message array by the
existing `compilePromptRecipe(recipe, sources)`, which already resolves
`message` blocks verbatim and `source` blocks from a supplied map.

One resolver owns which recipe serves which call, enforcing:

- a `director` recipe is **never** passed to `applyRecipeToNative`
- the native sync path considers `narrator` recipes only

This is the hazard the split creates: a Director recipe reaching native would
make the performer generate while reading directing instructions. The rule lives
in one function rather than in convention.

Director recipes are Chat Completion only — Live Direction already requires a
Chat Completion connection, so a Text variant would be a dead option.

### 2. What the Director returns

Free instruction prose, shaped entirely by the Director recipe, plus a short
structured tail:

- **flow** — continue, or wait for the user
- **requests** — Goal and Variable changes, addressed by name

Performer selection is deleted. With the Narrator badge deciding who speaks,
there is no model choice to validate, no substitution path when it names an
absent character, and no performer-ref plumbing through the run lifecycle.

The prose half becomes the instruction attached to the Narrator. The structured
half is the only part code reads.

### 3. Goals and Variables addressed by name

The single locked block the Director badge contributes. It states the
interaction rules and lists what is addressable this turn in readable form:

```
Aiden's HP: 12 / 20
Meaning: Aiden's present capacity to withstand injury.
```

Requests name the Variable. Code validates the name against the set advertised
this turn and rejects anything else — the same containment property the `v1`
refs provided, since the security guarantee was never the opacity of the id but
the closed set of what was offered.

Two edges to handle explicitly:

- **Name collisions.** Names must be unique within a Timeline for addressing to
  be unambiguous. Duplicates are resolved by rejecting the request with a
  diagnostic rather than guessing.
- **Renames mid-turn.** A name that no longer resolves fails cleanly; it must
  never fall through to a different record.

### 4. The Narrator writes clean prose

The Narrator is told nothing about markers, ids, or the Director's existence. It
receives the direction as instruction text and writes.

Pacing beats are derived from the finished text in code — sentence terminators,
paragraph breaks, dialogue turns, em-dashes. Deterministic, unaffected by model
compliance, and adjustable without re-prompting.

**Consequence, accepted deliberately:** without a commit marker, a Goal or
Variable change can no longer land at the exact sentence that establishes it.
Changes instead apply **when a response is accepted** — fully revealed, or
frozen by user interruption. An early interruption applies nothing. This
preserves the principle that only fiction the user actually read may change
stored state, at coarser granularity than before.

### 5. Preview

The Roleplay preview gains two tabs — the Director's compiled message array and
the Narrator's native prompt — each showing what would actually be sent.

## Out of scope

- **Message ordering.** The user's message still will not appear until the
  Director has finished. Independent change, deliberately excluded.
- **Story mode.** Untouched.
- **The mechanical layer itself.** Capabilities, transactions and resolution are
  unchanged apart from name-based addressing.
- **Initiative, combat rounds, automatic Story adjudication** — already deferred.

## Risks

- **Derived beats could pace worse than good markers did.** Mitigated by being
  deterministic and tunable; the failure mode is uniform rather than erratic.
- **Deleting performer selection changes open scenes, not just duet ones.** In a
  two-seat `duet` Scene the Narrator badge is the only performer, so nothing is
  lost. In an `open` Scene with several cast members, direction would always
  route to the Narrator and other members could speak only through the manual
  next-speaker override. If open scenes are expected to hand the floor around by
  themselves, performer choice must survive in some form — as a named field in
  the structured tail, addressed by character name like Variables are.
- **The decision is one-way.** If per-response performer choice returns later it
  arrives as a Director capability rather than a restored core field.
- **A user can author a Director recipe that produces nothing usable.** The
  compiled prompt must fall back to a built-in default when no recipe resolves
  or the locked block is absent, and say so in the journal.

## Verification

- Compile a Director recipe and diff the resulting messages against the current
  hardcoded four, to establish parity **before** any wording changes.
- Unit-test beat derivation against prose fixtures: dialogue, long paragraphs,
  em-dash interruptions, single-sentence replies.
- Unit-test name addressing: exact match, collision, rename, unadvertised name.
- Confirm in the running app that a `director` recipe never reaches native, by
  asserting the applied native prompt after a directed pass.
- A real directed pass on a live connection remains the only test of the whole
  loop; the mechanical layer has still never executed end to end.
