# Notebook Store Removal + Editor-Turn Replayability

> **For agentic workers:** implement directly with test-green checkpoints (this
> repo's SDD is too slow — see memory `remodel-sdd-too-slow`). Keep the
> mutation-test habit. This is a **behavioral** refactor of retry/continue/
> regenerate that cannot be unit-verified alone — do a manual retry/continue/
> regenerate check in the app before calling it done.

**Goal:** implement the settled editor-turn replayability model and delete the
three remaining two-agent-Director store files (`director-notes-store.js`,
`standing-direction-store.js`, `director-reply.js`).

**Design (settled, do not re-litigate):** memory
`remodel-editor-turn-replayability`. A turn's replayable signal is the last
committed directed narrator message; retry/regenerate removes it, undoes the
turn's mechanics transaction (`checkpointTransactionIds` — which atomically
rolls back the Loom's Archive events + mechanics), and re-runs the narrator
draft + Loom fresh. Continue = run the next turn. The two-agent standing-
direction *replay optimization* is dropped entirely (it only ever existed to
avoid re-spending the expensive Director call; editor has no Director call).

**Context:** editor is the only roleplay engine (two-agent Director already
removed). The Director prompt compile/preview chain is already gone
(commit `1681bee99`). This pass removes the last Director-era stores.

## Global constraints

- Repo root: `C:\Users\RICHARD\Documents\Israel\SillyTavern`. Extension code in
  `public/scripts/extensions/third-party/SillyTavern-Remodel/`. Tests in
  `tests/` (flat, `remodel-*.test.js`).
- Test command (from `tests/`): `node --experimental-vm-modules
  node_modules/jest/bin/jest.js --config jest.config.json <name-substring>`.
  The full `remodel-` run exceeds a 2-min shell limit — run it in the
  background or run targeted subsets.
- Keep the editor path green throughout: `director-editor*`, `editor-lifecycle`,
  `direction-chrome`, `mechanics-undo-growth`.

## File-by-file work

### live-direction.js
- Rewrite the retry/continue/regenerate flow to the editor model:
  - `retryLiveStep` / `continueLiveStep`: collapse the `director`-vs-`narrator`
    step split. Continue → `requestNextDirection` (next turn). Retry → redo the
    last turn (`regenerateLastDirectedResponse`).
  - `describeDirectionStep`: report the step from the last committed directed
    message, not from notebook entries / standing direction.
  - `regenerateLastDirectedResponse`: remove the last directed message, undo its
    mechanics transaction (`run.checkpointTransactionIds`), re-run the narrator
    draft + Loom fresh.
- Remove standing-direction machinery: `readStandingDirectionFor`,
  `restoreStandingDirectionFromMessage`, `forgetStandingDirection`,
  `speakStandingDirection`, and the `standing-direction-store.js` import.
- Remove notebook-turn machinery: `notebookTurnEntries`, `discardNotebookTurn`,
  `abandonDirectorTurn`, and the snapshot's `notebook` field
  (`readAllEntriesForOwner` at the snapshot builder).
- Remove the notebook injection into the narrator prompt (`readNarratorEntries`)
  and drop the `director-notes-store.js` import entirely.
- Sweep now-dead imports/exports and stale comments referencing removed symbols.

### direction-chrome.js
- Rewrite `resolveDirectionActions`: drop the `director`/`narrator` target split;
  the editor has one step. Retry redoes the last turn; Continue advances.

### narrator-prompt.js
- Drop the Director-notes branch from `buildDirectionInjection` (in editor mode
  `directorDirection` is already empty; remove the notebook path so the store
  import can go).

### timeline-spine.js
- Remove the reasoning-bridge block (`readAllEntriesForOwner` +
  `readTurnReasoning` → `setRemodelNativePromptContent('directorNotes', …)`) and
  the two `director-notes-store.js` imports.
- Verify the retry/continue toolbar buttons still resolve through the rewritten
  `resolveDirectionActions`.

### Deletions (once unused)
- `standing-direction-store.js` + `remodel-standing-direction*.test.js`
- `director-notes-store.js` + its tests
- `director-reply.js` + `remodel-director-reply*.test.js` (its only remaining
  importer is `director-notes-store.js`, deleted above; confirm no other importer
  before deleting)

### Tests
- Rewrite/prune `remodel-direction-chrome`, `remodel-direction-actions`, and any
  standing-direction suites to the editor step model.
- Add editor-lifecycle coverage for the new retry/regenerate (message removed +
  transaction undone + re-run) — this also backfills the coverage
  `direction-lifecycle` deletion left thin (mechanics-on-accept, regenerate/undo).

## Execution order (leaf-first, green at each)
1. Rewrite `resolveDirectionActions` (direction-chrome) + `describeDirectionStep`
   / `retryLiveStep` / `continueLiveStep` / `regenerateLastDirectedResponse` to
   the editor model; delete standing-direction + notebook-turn machinery.
2. Remove the notebook injection (live-direction `readNarratorEntries`,
   narrator-prompt, timeline-spine reasoning bridge).
3. Delete `standing-direction-store.js`, `director-notes-store.js`,
   `director-reply.js` + their tests.
4. Rewrite/prune the affected test suites; add editor retry/regenerate tests.
5. Full suite green + a manual retry/continue/regenerate check in the app.

## Deferred (separate pass)
- Prompt Studio Director *mode* removal (`prompt-studio.js` / `prompt-studio-store.js`
  / `direction-sources.js` director sources) — dead but harmless UI cruft; does
  NOT block any store deletion.
