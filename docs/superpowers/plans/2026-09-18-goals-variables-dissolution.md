# Goals & Variables dissolution — teardown plan

Owner decision (2026-09-18): Goals and Variables stop being bespoke systems.
They become ordinary Living Lore entries carrying a reserved `goal` / `variable`
keyword — exactly like `secret`, a tag that "puts them aside". What happens with
them (rolling, math, presentation) is the user's recipe macro + the provider JSON
schema + the model's reasoning, NOT dedicated code. Code-owned dice/math is a
possible LATER add-on, explicitly not needed for this fold.

Both forks confirmed by the owner:
- The fence's whole `requests` mechanics array goes away ENTIRELY (including
  event.record / beat.set — everything, not just goal/variable verbs).
- The Variables and Goals drawers are removed too.

Execute leaf-first, each phase a green commit (mirrors the archive dissolution
and Phase 2B). Full suite must stay green at every commit.

## Modules to DELETE (19)

Goals: `story-goals.js`, `story-goals-store.js`, `story-goals-model.js`,
`story-goals-math.js`, `story-goals-markup.js`, `story-goals-prompt.js`,
`story-stats-macros.js`.
Variables: `variables-store.js`, `variables-context.js`, `variables-relevance.js`,
`variables-vector.js`, `variables-lore.js`, `variables-lore-key.js`,
`variables-ui.js`.
Mechanics: `mechanics-capabilities.js`, `mechanics-gateway.js`,
`mechanics-runtime.js`, `actor-mechanics.js`, `mechanics-transport.js`.

KEEP `living-lore-model.js` (used elsewhere) — but drop its goal-only exports
(`GOAL_LORE_LINK_TYPES`, `normalizeGoalLoreLink`) once nothing imports them.

## Consumers to REWIRE (keep the file, remove cluster usage)

- `timeline-spine.js` — Goals drawer, Variables Codex drawer, composer goal chips,
  the goal-intent → `authorizedGoalIds` send flow (`handleGoalAwareRoleplaySend`,
  `getStoryGoalComposerIntents`), lorebook Variable-link badges, story-goal stream
  decoration, `storyGoals` native source, `toggle-codex` action, `bindVariablesSurfaces`.
- `live-direction.js` — the mechanics snapshot/execution: `buildMechanicalSnapshot`,
  `previewMechanicalContext`, `executeDirectionRequests`, `applyPendingRequests`
  (requests half), `buildLoomSkill`, `buildGoalObjectives`, `snapshot.mechanics`,
  `authorizedGoalIds` threading, `sources.loomGoals`/`loomVariables`, and
  `routeUniversalStateMacros`.
- `narrator-prompt.js` — remove `getSceneGoals/getTimelineGoals`,
  `listVariableValues/formatVariable`, `renderLoomGoals`, `renderLoomVariables`,
  `buildGoalObjectives`. KEEP `renderLoomAction` (loom.action = current player
  action, not goal/variable).
- `loom-fence-schema.js` — remove the `requests` property + `getMechanicsRequestSchema`
  import; fence drops to swaps/loreKeywords/loreOps/flow.
- `loom-reconciliation.js` — `parseLoomReply` stops returning `requests`;
  `describeLoomReply` drops `requestCount`/`capabilities`; `buildLoomRecipeSources`
  drops `mechanicsBoard`/`archiveState` if goal-only.
- `metadata-guide.js` — drop the capabilities table + Narrator tools section.
- `debug-console.js` — drop `getMechanicsProfile` usage + the mechanics guide render.
- `prompt-instruction-templates.js` — drop the operation.* + narrator.* templates.
- `prompt-studio-store.js` — remove `loom.goals`/`loom.variables`/`story.goals`
  templates + seedings + the goal operations manual + the mechanics-tools template;
  migrations that reference them.
- `timeline-state.js` — drop the `detachStoryGoalsFromScene` /
  `deleteStoryGoalsForTimeline` / `deleteVariablesForTimeline` cleanup calls.
- `pipeline-runtime.js`, `native-narrator-runtime.js`, `story-stream.js` — remove
  the Narrator mechanics tool-calling (`mechanics-transport`, `actor-mechanics`,
  `NARRATOR_MECHANIC_TOOLS`).

## Phase order (each a green commit)

1. **Drawers/UI** — timeline-spine Goals + Variables Codex drawers, composer goal
   chips + goal-intent send flow, lorebook Variable badges; delete `variables-ui.js`,
   `story-goals.js`, `story-goals-markup.js`, `story-goals-prompt.js`. Thread out
   `authorizedGoalIds` from the send flow (directed turns no longer take it).
2. **Narrator-side mechanics** — `narrator-prompt` goals/variables; the
   `NARRATOR_MECHANIC_TOOLS` tool-calling in `pipeline-runtime`,
   `native-narrator-runtime`, `story-stream`; delete `actor-mechanics.js`,
   `mechanics-transport.js`.
3. **Loom-side fence `requests`** — remove the `requests` field end to end:
   `loom-fence-schema`, `loom-reconciliation` parse/describe, `live-direction`
   execution + snapshot.mechanics + buildLoomSkill + buildGoalObjectives +
   authorizedGoalIds, `metadata-guide`, `debug-console`,
   `prompt-instruction-templates`; delete `mechanics-capabilities.js`,
   `mechanics-gateway.js`, `mechanics-runtime.js`.
4. **Macros/recipes** — `prompt-studio-store` loom.goals/variables/story.goals
   templates + seedings + operations manual + mechanics-tools; `timeline-state`
   cleanup calls.
5. **Delete data stores** — all remaining `story-goals-*` + `variables-*` +
   `story-stats-macros`; trim `living-lore-model` goal-only exports.
6. **Reserved keywords** — add `goal`/`variable` beside `SECRET_KEYWORD` (no
   behavior; optionally badge/strip in the archive like `secret`). Final suite sweep.

## Test impact

Dozens of suites: remodel-story-goals-*, remodel-variables-*, remodel-mechanics-*,
remodel-actor-mechanics, remodel-metadata-guide, remodel-loom-fence-schema,
remodel-loom-reconciliation*, remodel-prompt-studio-store,
remodel-prompt-instruction-templates, remodel-loom-lifecycle, and the
reconciliation-integration/turn suites (which exercise requests). Delete
pure-cluster suites; rework shared ones to drop requests/goal/variable assertions.
