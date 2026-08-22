# Editor-Mode Real-Time Narration Interrupt

**Status:** DEFINITIVE design for interrupting a revealing narration in the
editor roleplay engine (`feature/director`). Depends on the editor engine
(narrator drafts → Loom reconciles), which is the only roleplay engine after
the two-agent Director removal. Related decisions: editor-turn replayability
(memory `remodel-editor-turn-replayability`) and the pending
`director-notes-store.js` removal.

## 1. The idea in one paragraph

While the Loom's committed narration is streaming onto the page, the user can
cut in: the moment they start typing their next action the reveal **pauses**,
and when they **send**, the narration is split at the pause point. The revealed
half becomes the committed message; the unrevealed "other half" is handed to
the next narrator draft as private continuity ("you were about to say: …"); and
the interrupted narration's mechanical/Archive consequences **never land**. The
story re-derives from what the user actually saw plus what they did. This mirrors
the old two-agent Director's cut-off handling, adapted to the editor engine.

## 2. Why

A revealing narration is not yet fully "real" to the user until they have read
it. Letting them act mid-reveal — especially to head off where a beat is going —
makes the scene feel live and keeps their agency ahead of the fiction. The old
Director engine already had this (typing held the reveal; an interruption record
told the next pass "the performer was cut off, and here is what it was about to
say"). The editor engine kept the reveal pipeline but lost the wiring; this
design restores it and settles the editor-specific edges.

## 3. Prerequisite: hold-then-show turn restructure

Interruption acts on the **Loom's committed** prose, so the reveal must show
that, not the raw draft. The editor turn becomes:

1. User submits an action.
2. Narrator drafts the turn **hidden** (no reveal yet).
3. Loom reconciles: produces the committed prose (preserve-and-patch swaps) **and**
   its state fence (events, rolls, variable/goal changes).
4. The committed prose **reveals gradually** through the existing reveal pipeline
   (`scheduleReveal`/`revealStep`).
5. **The Loom's state fence is held, not applied yet** — it lands only when the
   reveal completes uninterrupted (§5).

This finishes the Task-7 "reveal-hold" (the draft never appears on screen) and
adds the new step of deferring state application. It relocates the Loom pass
(`runDirectorEdit`) from *after* the draft reveal (today's
`completeVisibleRun`) to *before* the committed reveal.

## 4. The interrupt

### 4.1 Window

Only during the gradual reveal of the committed prose (step 4). Not during the
hidden draft or the Loom pass. Moot at `instant` pacing, which reveals the whole
message in one frame and leaves no interruptible window — interrupt is simply
unavailable there.

### 4.2 Trigger — type-to-pause, send-to-commit

- The moment the user starts typing in the composer, the reveal **pauses/freezes**
  at its current offset (reuse the existing `holdReason: 'typing'` /
  "Held while you write" path).
- If the user **clears** the composer, the reveal **resumes** from the frozen
  offset (existing behavior). No interrupt occurred; if it then finishes, state
  lands normally (§5).
- If the user **sends**, the interrupt **commits** (§4.3), splitting the
  narration at the frozen offset.

### 4.3 On commit

- **Committed message:** the revealed-so-far prose, trimmed to the last complete
  **word** at the frozen offset (never a mid-character cut), becomes the final
  message written to chat.
- **The other half:** the unrevealed remainder is captured and handed to the
  **next narrator draft** as private continuity context, e.g. *"Your last
  narration was cut off. You were about to say: «remainder». Weave the user's
  interruption in naturally."* It is **purely internal** — never shown to the
  user, never written to the transcript.
- **State fence discarded:** the held state fence for this turn is thrown away.
  No events, rolls, or variable/goal changes land — the cut-off narration's
  consequences never happened, because the user preempted them.
- **Next input:** the user's typed action becomes the next turn's input.

### 4.4 The next turn

The narrator drafts normally, seeing: the revealed message in chat history, the
remainder as private continuity (§4.3), and the user's interruption as the new
action. The Loom then reconciles that draft and records state **fresh** — so the
Archive reflects how the scene actually went, not the discarded narration.

## 5. Uninterrupted completion

When the reveal finishes without an interrupt, the held state fence is **applied**
(events/mechanics/rolls land via `executeDirectionRequests`, one atomic
transaction) and the turn settles ("Waiting for you"). This is the normal editor
turn; the only change from today is that state application moved from inside the
Loom pass to reveal-completion.

## 6. Reuse vs. new

**Reuse (already present from the Director era):**
- `interruptLiveDirection({ preserveForIntervention })` and the typing-hold that
  sets `holdReason: 'typing'` / "Held while you write".
- The interruption record on the message (`readInterruptionRecord`) that carries
  "cut off + what it was about to say" to the next pass — repointed from the
  Director to the next narrator draft.
- The reveal pipeline (`scheduleReveal`/`revealStep`/`acceptNativeBuffer`) and its
  `rawBufferedText`/`rawOffset` split point.

**New:**
- Deferring the Loom's state fence application from the Loom pass to
  reveal-completion (hold-then-apply), and discarding it on interrupt.
- Revealing the Loom's committed prose rather than the draft (hold-then-show).
- Trimming the split to a word boundary at the pause offset.

## 7. Edge cases

- **Instant pacing:** no interrupt window; the message and state land together.
- **Empty revealed half:** if the user interrupts before any prose has revealed,
  the committed message is empty → treat as a normal empty/withheld turn (the
  turn produced nothing visible), and the whole narration's remainder is the
  continuity handoff. (Follow the existing empty-response handling.)
- **Resume without send:** clearing the composer resumes; a completed resume lands
  state normally. Only `send` discards the fence.
- **Autoplay:** an interrupt cancels any queued autonomous continuation — the user
  has taken the wheel.

## 8. Testing

- Type-to-pause freezes the reveal at the current offset; clearing resumes it.
- Send mid-reveal: the committed message is the revealed half trimmed to a word;
  the remainder reaches the next narrator draft's context; the turn's state fence
  did **not** apply (no events/variable changes landed).
- Uninterrupted completion applies the state fence exactly once.
- Instant pacing lands message + state together with no interrupt path.
- The next turn records state fresh (the discarded narration's events are absent).

## 9. Out of scope / deferred

- The `director-notes-store.js` removal and the editor-turn replayability
  implementation (separate, already-decided passes) — this design assumes the
  editor engine but does not depend on those landing first, except that both
  touch the same turn lifecycle and should be sequenced to avoid churn.
- Showing the remainder to the user (explicitly rejected: purely internal).
- Rolling back an already-applied fence (rejected in favor of hold-then-apply).
