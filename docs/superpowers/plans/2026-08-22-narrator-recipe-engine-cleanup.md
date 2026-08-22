# Narrator Recipe Engine Cleanup

**Status:** Implemented; rendered Preview verification remains pending because the debug Chrome session is stalled during SillyTavern extension initialization.

## Goal

Make Prompt Studio's active Roleplay/Chat recipe the sole authority for the Narrator request while preserving SillyTavern's native generation, character-card, persona, world-info, history, streaming, retry, continue, and interruption paths.

The Loom remains a separate hidden pass with its own selectable recipe. Its Narrator-visible Archive output enters the Narrator request only through an explicit recipe macro.

## Engine invariants

1. A Narrator turn uses SillyTavern's native generation path. Remodel does not compile a second reduced Narrator prompt.
2. User-authored Narrator policy lives in an editable recipe block.
3. Runtime Archive state resolves through `{{narrator.grounding}}` at the position chosen by the recipe.
4. No extension prompt silently appends Narrator instructions outside the recipe.
5. Preview and live generation resolve the same active recipe and the same grounding macro.
6. Runtime grounding is request-scoped and is cleared after prompt assembly.
7. Existing recipe IDs and active scene bindings survive migration.

## Cleanup phases

### 1. Store and migration

- [x] Add the canonical `Narrator Grounding` template and `{{narrator.grounding}}` macro.
- [x] Move append-only and anti-echo behavior into an editable Narrator Policy block with a warning.
- [x] Migrate old Loom Context and Director Notes blocks in place without changing recipe IDs.
- [x] Preserve the user's active Roleplay recipe during migration.
- [x] Seed a selectable `Narrator · Archive-Grounded` recipe as a clean starting point.

### 2. Runtime request assembly

- [x] Resolve the current Narrator-visible Loom Archive into the recipe-owned native prompt.
- [x] Keep the rest of the request on SillyTavern's native Prompt Manager path.
- [x] Clear dynamic grounding after assembly so directed state cannot leak into free play.
- [x] Honor a user's decision to disable or remove the grounding macro.

### 3. Preview and Prompt Log

- [x] Make Preview use the current unsent composer text.
- [x] Resolve the same Archive grounding used by a live directed turn.
- [x] Report when the active recipe has disabled or removed Narrator Grounding.
- [x] Attribute policy and grounding to ordinary recipe/native prompt sources instead of an engine-only source.
- [ ] Re-run rendered Preview verification when debug Chrome completes application initialization.

### 4. Hard cleanup

- [x] Remove the hidden `REMODEL_NARRATOR_CONTEXT` extension-prompt injection.
- [x] Remove the unused custom Narrator compiler and streaming gate.
- [x] Delete superseded native prompt objects when applying a migrated recipe.
- [x] Keep old names only as one-way migration aliases and regression fixtures.

### 5. Verification

- [x] Syntax-check changed runtime modules.
- [x] Test store migration and active-recipe preservation.
- [x] Test native Prompt Manager routing and legacy prompt removal.
- [x] Test live grounding lifecycle and clearing.
- [x] Test streaming/interruption persistence, Loom reconciliation, and roleplay message selection.
- [ ] Inspect one real rendered Preview and one real directed request after the debug browser is available.

## Acceptance check for the next live turn

The Prompt Log for a directed Narrator request should show, in recipe order:

- the selected card/persona/world/history sources;
- the editable Narrator Policy exactly once;
- one `Narrator Grounding` source containing only Narrator-visible Archive sections;
- the current unsent composer message in Preview, or the submitted user message in a live request;
- no `REMODEL_NARRATOR_CONTEXT`, `Director Notes`, or `Loom Context` source.
