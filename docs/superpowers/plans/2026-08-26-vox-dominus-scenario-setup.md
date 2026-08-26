# Vox Dominus scenario setup and acceptance plan

**Status:** Approved design. Do not populate the live Timeline until this plan
is reviewed once more with the owner.

## 1. Purpose

`Vox Dominus` is the first deliberately small, mixed Story/Roleplay Timeline
used to prove that Living Lore, World Sense, the shared Loom Archive, Timeline
Web consequences, and review controls work as one fiction system.

It is not a pre-written campaign. The starting material must establish a real
social world and one powerful ability while leaving enough uncertainty for the
world to grow through accepted fiction.

## 2. Confirmed creative decisions

- The player character is **Aiden**.
- Aiden has the supernatural vocal-compulsion ability called **the Vox**.
- An unaware listener who gives Aiden's voice close attention is more
  susceptible.
- A listener who knows the Vox is supernatural is more resistant, though not
  immune merely because they know its name.
- The ability's long-term effect is **conditioning**, not infection or a
  transmissible phenomenon.
- Remote delivery through calls, recordings, video, and similar relays is
  possible but weaker and less precise.
- NPCs have lives, pressure, relationships, knowledge, and initiative beyond
  Aiden. They do not exist to validate, oppose, or submit to the player.
- The world follows causal consequences, with neither a success bias nor a
  punishment bias.
- The owner will establish Arc 1's first Story Scene independently. This plan
  must not add or pre-empt that Scene.

## 3. Operating model

```
accepted Story or Roleplay fiction
             |
             v
  shared Loom Archive + Timeline Web
             |
     +-------+--------+
     |                |
     v                v
Goals / Variables   Living Lore proposals
     |                |
     |         owner review in Suggest mode
     +-------+--------+
             v
World Sense ranks only relevant state for the next Scene
```

The Archive records accepted fiction. Goals and Variables may be created or
updated only when a durable unresolved pressure or changing quantity warrants
tracking. Living Lore remains canonical only after the owner accepts a review
proposal. A Story Scene never retrospectively rolls against prose that is
already accepted.

## 4. Global Timeline and World Sense settings

| Setting | Initial value | Reason |
|---|---|---|
| Timeline lorebook | `Vox Dominus` | One isolated canonical book for this Timeline. |
| World Sense mode | `Suggest` | Every proposed lore mutation is visible during the first full test. |
| Local model | `Xenova/all-MiniLM-L6-v2` | Retain the installed lightweight embedding model. |
| Index state | Reindex before the first Scene | Establishes the starting lore baseline. |
| Entry budget | 12 | Current tested default; enough room for a small world without flooding prompts. |
| Token budget | 1800 | Current tested default; protects turn speed. |
| Semantic floor | 0.30 | Keep current calibrated setting until recorder evidence says otherwise. |
| Semantic-only cap | 3 | Prevents vague similarity from crowding out direct evidence. |
| Earlier-scene recall | On for new Scenes | Required to test Story -> Roleplay and Roleplay -> Story continuity. |
| Later recall | On for new Scenes | Allows earlier accepted evidence to be eligible downstream. |
| Auto-safe | Not used in this trial | Revisit only after review-queue behaviour is trusted. |

The Timeline must remain isolated from every other Timeline. No old Archive
records, goals, vectors, or lorebook entries may be used as Vox evidence.

## 5. Entry conventions

All initial entries use native World Info plus Living Lore metadata. They are
not a new hidden database.

Unless a row says otherwise, use:

- enabled (`disable: false`);
- selective keyword matching (`selective: true`, `selectiveLogic: 0`);
- probability enabled at 100%;
- native position `0`, matching the existing Vox entry;
- order `100` unless a constant policy needs earlier priority;
- no recursion exclusion, delay, group scoring, sticky behaviour, or random
  chance;
- World Sense entry type and protected fields as named below.

### 5.1 Revise the existing entry: `The Vox`

**Native keys:** `The Vox`, `Vox`, `Aiden's voice`, `vocal compulsion`

**Entry type:** `seed`

**Native strategy:** selective, non-constant, order `100`, position `0`.
The ability enters prompts when named or semantically relevant; it must not
occupy every mundane scene.

**Protected fields:** `Identity`, `Established`.

**Proposed content:**

```text
## Identity
The Vox is Aiden's supernatural ability to exert vocal compulsion. It works
through words, tone, force, timing, and the listener's reception of them.

## Established
Greater vocal force can produce stronger and less subtle pressure. An unaware
listener who is attentive to Aiden's voice is more susceptible. A person who
knows that the Vox is supernatural is more resistant, but knowledge alone is
not immunity.

Light influence may be dismissed consciously while still altering an
assumption, association, inclination, or impulse beneath conscious attention.
Repeated successful exposure can produce conditioning: later influence may
take hold more easily or reach a deeper layer of the same person's mind.
Conditioning is not contagious and does not spread between people by itself.

The Vox can travel through calls, recordings, video, and similar relays, but
the transmission is reduced in strength and precision. The medium, recording
quality, amplitude, timing, and degree of attention all matter.

The Vox does not grant missing knowledge, skills, physical capability, access,
or immunity from ordinary consequences. A command is interpreted through what
the listener heard, understood, believes possible, and is able to do.

## Open threads
The exact duration, personal cost, memory of influence, limits of resistance,
and long-term shape of conditioning are not fully established. Accepted
fiction may establish them; do not invent a universal rule without evidence.
```

### 5.2 Add: `Vox Dominus — scenario premise`

**Native keys:** `Aiden`, `Vox Dominus`, `Halcyon University`, `Bracken House`

**Entry type:** `seed`

**Native strategy:** selective, non-constant, order `95`, position `0`.

**Protected fields:** `Identity`, `Established`.

**Initial content:** Aiden is a student at Halcyon University who shares an
inexpensive apartment in Bracken House with Miles Calder. The Vox is new
enough that its practical limits are uncertain and no public authority accepts
that it exists. The Timeline begins in an ordinary academic term; rent,
classes, jobs, friendships, family, status, and private ambitions remain real
pressures even when supernatural influence enters the picture.

### 5.3 Add: `Halcyon University and Bracken House`

**Native keys:** `Halcyon University`, `Halcyon`, `Bracken House`, `the
apartment`, `campus`

**Entry type:** `setting`

**Native strategy:** selective, non-constant, order `100`, position `0`.

**Initial content:** A contemporary university and its nearby rental district.
Bracken House is a cheap, thin-walled shared apartment close enough to campus
that roommates, neighbours, student work, events, and rumours overlap. The
setting is socially dense, but no institution begins with secret knowledge of
the Vox.

### 5.4 Add: `Miles Calder`

**Native keys:** `Miles Calder`, `Miles`, `roommate`

**Entry type:** `character`

**Native strategy:** selective, non-constant, order `100`, position `0`.

**Initial content:** Miles is Aiden's roommate. He works evening shifts at the
student radio station while competing for an audio-journalism placement. He is
socially capable and observant, avoids conflict until personal autonomy is at
stake, and maintains friendships and obligations outside Aiden's orbit. He is
dealing with a private station-related problem he has not yet chosen to share.
He does not know the Vox exists.

Do not add a rigid "what Miles knows" template. His state should develop from
accepted scenes and Archive records.

### 5.5 Add: `World simulation charter`

**Native keys:** `world simulation`, `character agency`, `consequences`,
`Timeline Web`

**Entry type:** `policy`

**Native strategy:** **constant**, order `10`, position `0`. Keep this compact
enough to justify its always-on prompt cost.

**Initial content:** Characters have independent schedules, relationships,
ambitions, imperfect knowledge, and limits. They may refuse, misunderstand,
interrupt, leave, lie, seek help, change their mind, or act elsewhere. Do not
bias outcomes toward Aiden's success or failure. Resolve events from
established capability, leverage, information, timing, and circumstance. A
victory remains a victory; later consequences must follow from it rather than
secretly erase it. A failure changes the situation rather than merely blocking
play. Offscreen developments must grow from established people, pressures, or
open threads.

### 5.6 Add: `Vox and Timeline Web discipline`

**Native keys:** `Vox consequences`, `conditioning`, `Vox exposure`,
`Timeline Web`

**Entry type:** `policy`

**Native strategy:** selective, non-constant, order `90`, position `0`.

**Initial content:** Record durable accepted effects, not speculation. Create
a Goal only for a meaningful unresolved outcome with a holder, stake, and a
credible path to change. Create a Variable only for a quantity that needs to
persist across scenes. Create target-specific conditioning only after repeated
accepted exposure makes it relevant. Create wider Vox exposure only after
evidence can plausibly escape Aiden's immediate control. Keep secrets for
actual hidden facts, not ordinary uncertainty. Use typed lore links only when
the accepted evidence supports the connection. Make no Timeline tool request
when nothing durable changed.

## 6. Recipe policy additions

Add the following as an editable policy block to the **Loom** recipe for this
Timeline's testing preset. It is a private work checklist, not exposed
reasoning and not a Narrator instruction.

```text
Before composing, silently determine: (1) established facts and genuine
uncertainties; (2) the immediate aims, knowledge, leverage, and limits of
relevant people; (3) what Aiden actually attempted, distinct from the outcome
he wanted; (4) how ordinary causality and the Vox rules bear on that attempt;
and (5) which durable changes, if any, are justified.

Use the minimum Timeline Web operations supported by accepted fiction. Do not
manufacture a Goal, Variable, secret, or lore change merely to demonstrate a
tool. Do not print this checklist or any private analysis. Return only the
required final prose and Loom state contract.
```

The Narrator recipe remains a prose-focused recipe. It receives relevant lore
and recall but does not deliberate aloud, adjudicate hidden mechanics, or
write the Loom protocol.

## 7. Initial Timeline structure

The owner will create Arc 1 and its opening Story Scene. This plan does not
name, write, or alter that Scene.

After that owner-authored Story Scene exists:

1. Create one Roleplay Scene directly after it.
2. Set Aiden as the persona/player character.
3. Add Miles to the cast using a native character card or scene cast record.
4. Keep `Look into earlier scenes` and `Allow later recall` on.
5. Use the Story Scene's accepted evidence as the only initial cross-scene
   continuity source.
6. Do not create a starting Goal or Variable merely because the Timeline is
   new. Let the first meaningful unresolved pressure earn one.

## 8. First full-test journey

Start the recorder before opening the Timeline.

1. Reindex `Vox Dominus`; confirm only the six planned seeds are indexed.
2. Generate or write the owner-planned Arc 1 Story Scene.
3. Confirm Story Archive capture completes and World Sense receipt identifies
   Story mode, selected lore, and no unrelated Timeline source.
4. Inspect Living Lore proposals; accept only evidence-backed changes.
5. Open the following Roleplay Scene; preview the Narrator and Loom prompts.
   Confirm the Story evidence is recalled with provenance.
6. Run one ordinary interaction with Miles before any Vox use.
7. Test one subtle Vox attempt and one direct attempt on a goal the target can
   realistically resist or reinterpret.
8. Inspect Archive, Goals, Variables, and proposal queue. Confirm the system
   recorded only durable justified changes.
9. Use Continue with no user input. Confirm Miles or the surrounding world can
   advance from their own pressure without seizing Aiden's agency.
10. Add a later Story Scene containing an offscreen consequence. Confirm a
    subsequent Roleplay Scene can retrieve it without exposing secrets or
    hidden reasoning.
11. Test Stop, Retry, latest-user-message edit/rerun, and Story regeneration.
    Confirm only accepted prose survives and superseded proposals/consequences
    roll back.
12. Turn off earlier recall or later sharing once; Preview must show the
    missing source. Restore the setting and confirm recall returns.

## 9. Acceptance criteria

- The Timeline begins with enough material to be coherent but no forced plot.
- The Vox retrieves when relevant without consuming mundane scenes.
- NPCs demonstrate independent priorities and non-scripted reactions.
- Successes and failures both produce causal, proportionate developments.
- Story and Roleplay recall each other within this Timeline only.
- Goals, Variables, and links appear only when durable and evidence-backed.
- Every lorebook change is visible for owner review during this trial.
- Debug and recorder evidence make each selected source and mutation
  explainable.
- No Narrator, Loom, or Story output reveals private reasoning/checklist text.

## 10. Deliberately deferred

- Arc 1's content and opening Story Scene, owned by the user.
- Exact duration, cost, and upper limits of the Vox, to be established by
  accepted fiction rather than pre-decided rules.
- Whether to later move from `Suggest` to `Auto-safe`.
- Per-target conditioning Variables until a repeated exposure warrants them.
- Wider public exposure until believable evidence leaves Aiden's control.
