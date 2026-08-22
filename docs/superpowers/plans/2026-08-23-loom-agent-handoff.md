# Loom Roleplay Handoff

## Repository state

- Work only on `feature/loom` unless the user explicitly changes scope.
- Remote: `origin/feature/loom`.
- Current handoff commit: `0d170dc2d` (`refactor(remodel): make Narrator prompt recipe-owned`).
- Previous relevant commits:
  - `7c0aed835` — Preview assembles the next Narrator request, including unsent composer text.
  - `3092d8e33` — in-scene Narrator/Loom connection router.
- `.claude/` is untracked user-owned material. Do not add, modify, or delete it.
- Director and Archivist experiments have separate branches. Do not merge or transplant them into Loom without explicit approval.

## Current architecture

The live roleplay pipeline is intentionally asymmetric:

1. SillyTavern assembles and generates the Narrator response through its native generation path. This preserves the selected system prompt, character card, persona, world info, examples, history, provider behavior, Retry, Continue, and native streaming events.
2. The hidden complete Narrator output is available immediately to the turn machinery.
3. The Loom reveals its version over time. The user can interrupt that reveal with meaningful input; only the accepted visible prefix is retained.
4. A smaller Loom/Archive pass reconciles and stores scene state after delivered prose.

Do not reintroduce a hand-built `compileNarratorPrompt()` path. It was removed because it duplicated and reduced the native prompt.

## Prompt ownership

The active Roleplay/Chat recipe is now the sole authority for the Narrator request:

- The editable Narrator Policy carries append-only and anti-echo behavior.
- `{{narrator.grounding}}` resolves the current Narrator-visible Loom Archive at request assembly time.
- `Narrator Grounding` is an ordinary recipe/native Prompt Manager source, so its placement and enabled state belong to the user.
- Runtime grounding is cleared after assembly to prevent directed state leaking into free play.
- `REMODEL_NARRATOR_CONTEXT` and the hidden extension-prompt injection no longer exist.

Store version 14 migrates `{{loom.context}}`, `{{director.notes}}`, `remodel_loom_context`, and `remodel_director_notes` into the canonical grounding source while preserving recipe IDs and active scene bindings. Keep these old strings only in migration aliases and regression fixtures.

The store also contains a selectable `Narrator · Archive-Grounded` recipe. Migration preserves the user's currently active recipe instead of silently switching it.

## Verified behavior

The following suites passed together on 2026-08-22:

- `remodel-prompt-studio-store.test.js`
- `remodel-prompt-routing.test.js`
- `remodel-narrator-prompt.test.js`
- `remodel-narrator-archivist-sections.test.js`
- `remodel-loom-lifecycle.test.js`
- `remodel-loom-reconciliation-integration.test.js`
- `remodel-roleplay-message-list.test.js`

Result: 7 suites, 24 tests passed.

The running browser store was inspected after reload and showed:

- store version 14;
- the existing `Current Roleplay · Chat` recipe still active;
- the new `Narrator · Archive-Grounded` recipe available;
- Narrator Policy exactly once;
- `{{narrator.grounding}}` enabled with `remodel_narrator_grounding`;
- zero legacy macros or identifiers in saved recipe blocks.

## Browser blocker

Rendered Preview verification was not completed. The debug Chrome target at `127.0.0.1:9222` repeatedly remained on SillyTavern's `Initializing…` dialog. Console capture showed ordinary extension activation and a Stable Diffusion activation timeout, but no Remodel exception. Do not treat this as a Narrator failure without new evidence.

The page may report `document.visibilityState === 'hidden'` while the omnibox popup owns focus. Temporary CDP overrides for visibility or `requestAnimationFrame` are diagnostic only and must not be committed to application code.

## First task for the next agent

Once debug Chrome reaches the Remodel UI:

1. Open `Roleplay One` on `feature/loom`.
2. Type a unique sentinel into the composer without sending it.
3. Open Preview.
4. Confirm the raw Narrator request contains the sentinel, the Narrator Policy once, and current Archive content under `Narrator Grounding`.
5. Confirm it contains no `REMODEL_NARRATOR_CONTEXT`, `Director Notes`, `Loom Context`, stale composer text, or duplicated anti-echo instruction.
6. Close Preview and confirm chat count and stored messages are unchanged.
7. Send one directed turn, interrupt during Loom reveal, then inspect Prompt Log and Archive:
   - only the visible accepted prefix should remain;
   - Prompt Log should represent the complete last assembled request;
   - Archive should advance from delivered prose and contain no hidden tail.

If that fails, capture the Prompt Log JSON and Live Direction flight-recorder JSON before changing code. Diagnose whether the defect is prompt assembly, native streaming events, reveal state, finalization, or Archive reconciliation; these are separate seams.

## Relevant files

- `prompt-studio-store.js` — recipes, templates, v14 migration, default Narrator policy.
- `prompt-studio.js` — native Prompt Manager application, macro resolution, Prompt Log.
- `timeline-spine.js` — roleplay UI, Preview dry run, current scene grounding setup.
- `live-direction.js` — native Narrator generation, reveal/interruption lifecycle, Archive handoff.
- `narrator-prompt.js` — Narrator-visible Archive section formatter only.
- `docs/superpowers/plans/2026-08-22-narrator-recipe-engine-cleanup.md` — cleanup invariants and acceptance criteria.
