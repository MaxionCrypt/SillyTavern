# Director-as-Editor: Narrator First, Referee After

**Branch:** `feature/director` (off the shared trunk `feature/ui-remodel`). A sibling to `feature/archivist-first` (archivist *before* the narrator) and the trunk's solo-after. This design is the roleplay setup for the `director` line.

**Status:** Design agreed in a co-planning session (2026-08-19). Not yet implemented. This supersedes the old two-agent Director (Director plans → Narrator writes) for this branch: the Director is rebuilt as a **mechanical editor/referee that runs AFTER the narrator**, not a creative planner that runs before.

## 1. The idea in one paragraph

The **Narrator** writes the whole turn freely — full creative responsibility, characters, prose, story direction — as a draft. Then the **Director** runs as a **mechanical referee**: it reads the draft, creates/updates goals and variables, and for the rare genuinely-uncertain action (one even the characters don't know will land) it improvises the odds and code-rolls the dice. If a roll contradicts what the narrator wrote, the Director **preserves the narrator's exact words and swaps only the beat the roll changed** (preserve-and-patch). It also records everything to a private mechanical store (its archivist-like board, *with* the numbers). Only the Director's committed version is ever shown or remembered — the narrator's draft is ephemeral, so there are never two versions to reconcile. The screen holds until the Director finalizes (hold-then-show), so the roll is never spoiled and nothing visibly rewinds.

## 2. Why this shape (and how it differs from the others)

- **Trunk solo-after / archivist-first** make the *narrator the sole creative authority* and resolve mechanics either after (solo-after) or before (archivist-first) the prose. Their weakness: dice can't overrule the story cleanly — archivist-first resolves *before* the narrator writes, which means the narrator must be handed the outcome first.
- **This design** lets the narrator write *first and freely* (best prose), then a referee reconciles mechanics *after*. Dice get real teeth (the referee can overrule an outcome), but the creative voice is never a second mind's — the Director only *patches* the rolled beat, never authors prose.
- **The old Director drifted** because it was a *creative* mind dictating to the narrator. This Director is **purely mechanical** — it creates goals/variables, rolls, patches outcomes, records numbers. It has **zero creative authorship** beyond swapping the specific words a roll changed. That's the safeguard against the old failure.

## 3. The turn, in order

1. **User acts** — types an action — **or hits Continue** with no new action.
2. **Narrator drafts (creative, hidden, ephemeral).** Native generation as the bound narrator card (the trunk's solo narrator, unchanged). It reads the **readable** story/character state (§5) and writes the whole turn, committing outcomes freely. This draft is **never stored** and **never shown**; it is a proposal.
3. **Director runs (mechanical referee + archivist).** A structured call that reads the narrator's draft (and its reasoning, if the model exposed a reasoning channel) and:
   - **Creates/updates goals and variables** as the fiction warrants — the Director invents them (not the user, not the narrator). Improvised.
   - **Rolls the rare genuine uncertainty.** Only when an outcome is truly in doubt — *even the characters don't know if it will work_ (a desperate gambit, a real contest), never routine actions a character would simply accomplish. For those, the Director improvises the odds and **requests a code-rolled dice check** (the mechanics layer rolls the d100; the Director never rolls itself).
   - **Reconciles the draft to the rolls — preserve-and-patch.** If a roll contradicts the draft, the Director reproduces the narrator's words **verbatim** and changes **only** the sentence(s) the roll affected. If nothing was rolled or nothing contradicts, it commits the draft **as-is**.
   - **Records state** to the mechanical store — events, facts, character states, variable/goal changes, the roll results.
4. **Hold-then-show.** Nothing appears on screen until the Director has committed. The user sees **only** the Director's committed version. The narrator's draft is discarded.
5. **Next turn**, the narrator reads the **committed** version (chat history + readable state) — never its own draft. There is only one canonical reality, so no two-versions problem and no drift around outcomes.

The Director **always runs** (2 calls/turn: narrator + Director) — even a Continue with no correction still passes through it to record state and possibly create/roll mechanics; when there is nothing to change it simply commits the draft.

## 4. Roles — a hard split

- **Narrator = pure creative.** Characters, prose, voice, story direction, what happens creatively. Writes the whole turn. **Zero mechanics** — never rolls, never sees a number, never authors state.
- **Director = pure mechanical.** Creates goals/variables, improvises odds, requests code rolls, patches the rolled beat, records the numbers. **Zero creative authorship** beyond the surgical swap. Its committed version is canonical.

Dice stay **code-rolled** (Director *requests*, the mechanics layer *executes*) — the project rule: code owns the math, the AI owns judgment.

## 5. Two views of one store (the information boundary)

The store holds everything, but renders **differently** depending on who reads it:

- **Narrator view (readable, no numbers):** scene facts; character states in words (*"Marissa is wary of Eli, warming slowly"*); the event log ("already on the page"); and **goals as narrative objectives** (*"Eli is trying to win Marissa over"*). This is what the narrator needs to write characters with purpose. It **never** sees odds, variable numbers, or pending rolls — so the prose stays un-gamified and the dice stay a genuine surprise.
- **Director view (mechanical, with numbers):** all of the above **plus** the math — goal odds (30%), variable values (Trust 20/100), rolls, pending checks. The Director's private board.

Secrets remain filtered from the narrator entirely (as in the shipped archivist).

## 6. Locked decisions

| Decision | Choice | Note |
|---|---|---|
| Order | Narrator first, Director after | Best prose first, referee reconciles |
| Correction mechanism | **Director rewrites the words** (preserve-and-patch) | Swappable to *narrator re-writes* later if it drifts |
| Reveal | **Hold-then-show** | No spoiler, no on-screen rewind; costs latency (2 calls before first word) |
| Who authors mechanics | **The Director** (improvised) | Not the user-only, not the narrator |
| When to roll | **Rare** — only genuine "even the characters don't know" uncertainty | Not routine actions |
| Narrator draft | **Ephemeral** — discarded; only the Director's version is stored/shown | Prevents two-versions problem |
| Narrator sees | Readable story/character state **and goals-as-objectives**; **no numbers/odds** | Director holds the numbers privately |
| Edit scope | **Preserve narrator's words verbatim, swap only the rolled beat** | Keeps the narrator's voice canonical |

## 7. What it reuses vs. what's new

**Reuses (from the trunk / shipped):**
- Native narrator generation (the solo narrator — the "draft" pass).
- The archivist store + mechanics capabilities (`goal.create/edit/reach`, `variable.*`, `scene.set`, `event.record`, `char_state.set`, `secret.set`) and `executeDirectionRequests` — the Director authors mechanics and records state through these.
- Code-rolled dice (`goal.reach` → d100 in the mechanics layer).
- The reveal pipeline and `finalizeRunMessage`.

**New for this branch:**
- **The Director-editor pass** — reads the narrator's draft, creates/rolls mechanics, preserve-and-patches the prose, commits + records. Replaces the old creative Director.
- **Two-view rendering** — a readable narrator view (goals-as-objectives, states, no numbers) and a mechanical Director view (with numbers). The narrator view extends the shipped `buildNarratorArchivistSections` with goals-as-objectives and strips all numbers.
- **Hold-then-show reveal** — suppress the narrator's draft entirely; reveal only the Director's committed text. (The trunk streams the narrator live; here the narrator is hidden and only the final committed version streams/appears.)
- **Preserve-and-patch prompting** — instruct the Director to reproduce the draft verbatim except the rolled beat.

## 8. Known risks / iteration points

- **Preserve-and-patch fidelity (highest risk).** Models told "copy this exactly but change one part" tend to quietly paraphrase the rest, which would slowly bleed the Director's voice into the canonical text. This is the spot most likely to need iteration — possibly a diff-style output, or the fallback to *narrator re-writes the changed beat* (decision §6 is swappable).
- **"Genuine uncertainty" judgment.** The Director decides what is rare-and-uncertain enough to roll. Purely prompt-guided; needs tuning so it doesn't roll for trivial actions.
- **Improvised odds consistency.** The Director invents probabilities; they can wobble turn to turn. Acceptable for now (the alternative — user pre-authoring every chance — was rejected).
- **Latency.** Two sequential calls (narrator draft + Director) before any prose appears, plus hold-then-show. Accepted, same class of cost as archivist-first.

## 9. Out of scope (for the first build)

- Ensemble mode (cast-takes-turns) interaction with the editor Director — start with the single-narrator case.
- The scene-close flush and other archivist housekeeping already tracked elsewhere.
- Swapping the correction mechanism to narrator-rewrites — kept as a documented fallback, not built first.
