import { listSceneFacts, listCharStates, getBeat, listSecrets, listEvents } from './archivist-store.js';
import { getSceneGoals, getTimelineGoals } from './story-goals-store.js';
import { buildSceneArchiveProjection, renderArchiveProjection } from './archive-projection.js';
import { getTimelineStore } from './timeline-state.js';
import { listVariableValues, formatVariable } from './variables-store.js';

/**
 * Active Goals for the Loom's readable Archive view. The Narrator receives
 * Goals once through the recipe-owned story.goals macro.
 */
export function buildGoalObjectives(sceneId, { limit = null } = {}) {
    const goals = getSceneGoals(sceneId, { includeResolved: false, states: ['active', 'background'] });
    const selected = boundedTail(goals, limit);
    if (!selected.length) return '';
    const lines = selected.map((goal) => {
        const desc = String(goal.description || '').trim();
        const holders = (Array.isArray(goal.holderRefs) ? goal.holderRefs : [])
            .map((holder) => String(holder?.label || holder?.id || '').trim())
            .filter(Boolean);
        const owner = holders.length ? holders.join(', ') : 'Unassigned';
        return `- ${owner} — ${goal.title}${desc ? `: ${desc}` : ''}`;
    });
    return `## Goals — consequential pressures\n${lines.join('\n')}`;
}

/**
 * Render the archivist's Narrator-visible state as labelled sections.
 *
 * Secrets are excluded by construction: this function never reads the secret
 * store, so a secret cannot leak through a formatting mistake. Returns '' when
 * the scene has no state yet.
 */
export function buildNarratorArchivistSections(timelineId, sceneId, { events: eventLimit = null, archiveProjection = null, archiveQuery = [] } = {}) {
    const facts = listSceneFacts(timelineId, sceneId);
    const charStates = listCharStates(timelineId, sceneId);
    const projection = archiveProjection && (eventLimit === null || eventLimit === undefined || eventLimit === '')
        ? archiveProjection
        : buildSceneArchiveProjection(timelineId, sceneId, { query: archiveQuery, maxEntries: eventLimit });
    const beat = getBeat(timelineId, sceneId);
    const sections = [];
    if (facts.length) {
        sections.push(['Scene', facts.map((f) => `- ${f.key}: ${f.value}`).join('\n')]);
    }
    if (charStates.length) {
        const lines = charStates.map((c) => {
            const facets = Object.entries(c.facets || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
            return `- ${c.charId} — ${facets}`;
        });
        sections.push(['Characters', lines.join('\n')]);
    }
    if (projection.entries.length) {
        sections.push(['What has happened (already written — do NOT narrate this again)', renderArchiveProjection(projection)]);
    }
    if (beat) {
        const tone = beat.tone ? ` (tone: ${beat.tone})` : '';
        sections.push(['Open thread — provisional', `Unresolved momentum, not a required outcome. It never overrides the latest accepted action.\n${beat.directive}${tone}`]);
    }
    return sections.map(([label, body]) => `## ${label}\n${body}`).join('\n\n');
}

/**
 * Render only continuity selected from earlier Timeline Scenes.
 *
 * The current Scene's facts, character states, events, and open thread are
 * intentionally absent: native Chat History already carries the active Scene.
 * World Sense has already applied Look into earlier scenes, Allow later recall,
 * exclusions, pins, and relevance before these recall entries reach us.
 */
export function buildNarratorRecallSections(timelineId, sceneId, { scenes = null, archiveProjection = null } = {}) {
    const requested = normalizeSceneLookback(scenes);
    if (requested === 0) return '';
    const allowedSceneIds = requested === null ? null : previousTimelineSceneIds(timelineId, sceneId, requested);
    const entries = (archiveProjection?.entries || []).filter((entry) => {
        if (entry?.kind !== 'recall') return false;
        if (allowedSceneIds === null) return true;
        return allowedSceneIds.has(String(entry.provenance?.sceneId || ''));
    });
    if (!entries.length) return '';
    return `## Earlier Scene recall — already happened\n${renderArchiveProjection({ entries })}`;
}

// --- Granular Loom state renderers -----------------------------------------
//
// Each is one macro's worth of state, kept separate so a recipe can name
// exactly the slice it wants ({{loom.scene}}, {{loom.goals}}, …) instead of
// the old bundled boards. All return '' when there is nothing to show, so an
// empty section never prints a bare header.

/** {{loom.action}} — the player's authoritative turn input. */
export function renderLoomAction(action) {
    const text = String(action || '').trim();
    if (!text) return '';
    return [
        'CURRENT PLAYER ACTION — AUTHORITATIVE TURN INPUT',
        'This is the player\'s explicit speech, voluntary action, or attempted action for this turn. It outranks conflicting inference in the Narrator draft. Preserve what the player explicitly said or attempted, judge only uncertain outcomes and world reactions, and never invent additional voluntary player speech, thoughts, decisions, or actions.',
        text,
    ].join('\n');
}

/** {{loom.scene}} — the current Scene's recorded facts. */
export function renderLoomScene(timelineId, sceneId) {
    const facts = listSceneFacts(timelineId, sceneId);
    return facts.length ? `## Scene\n${facts.map((fact) => `- ${fact.key}: ${fact.value}`).join('\n')}` : '';
}

/** {{loom.characters}} — the current Scene's character states. */
export function renderLoomCharacters(timelineId, sceneId) {
    const charStates = listCharStates(timelineId, sceneId);
    if (!charStates.length) return '';
    const lines = charStates.map((state) => {
        const facets = Object.entries(state.facets || {}).map(([key, value]) => `${key}: ${value}`).join(', ');
        return `- ${state.charId} — ${facets}`;
    });
    return `## Characters\n${lines.join('\n')}`;
}

/** {{loom.events}} — events recorded for the current Scene only. */
export function renderLoomEvents(timelineId, sceneId, { events = null } = {}) {
    const options = events === null || events === undefined || events === '' ? {} : { maxEntries: events };
    const projection = buildSceneArchiveProjection(timelineId, sceneId, options);
    return projection.entries.length
        ? `## What has happened (already written — do NOT narrate this again)\n${renderArchiveProjection(projection)}`
        : '';
}

/** {{loom.secrets}} — the current Scene's secrets. Loom-only: never place this
 *  macro in a player-facing recipe, or the writing model sees hidden twists. */
export function renderLoomSecrets(timelineId, sceneId) {
    const secrets = listSecrets(timelineId, sceneId);
    if (!secrets.length) return '';
    const lines = secrets.map((secret) => `- ${secret.key}: ${secret.value}`);
    return `## Secrets — hidden from the player\n${lines.join('\n')}`;
}

/** {{loom.goals}} — every open Goal for the Timeline, with its numbers. Secret
 *  Goals are hidden unless secret=true, so this macro is safe in a player-facing
 *  recipe; the Loom recipe passes secret=true to see them. */
export function renderLoomGoals(timelineId, { limit = null, secret = false } = {}) {
    const all = getTimelineGoals(String(timelineId || ''), { includeResolved: false });
    const goals = secret === true ? all : all.filter((goal) => goal.visibility !== 'secret');
    const selected = limit === null || limit === undefined || limit === ''
        ? goals
        : goals.slice(-Math.max(0, Math.floor(Number(limit) || 0)));
    if (!selected.length) return '';
    const lines = selected.map((goal) => {
        const rate = Number.isFinite(Number(goal.successRate)) ? ` — ${Number(goal.successRate)}%` : '';
        const facets = [goal.status, goal.visibility].filter(Boolean).join(', ');
        const holders = (Array.isArray(goal.holderRefs) ? goal.holderRefs : [])
            .map((holder) => holder?.label || holder?.id).filter(Boolean).join(', ');
        const detail = [String(goal.description || '').trim(), holders ? `Held by: ${holders}` : '']
            .filter(Boolean).map((line) => `  ${line}`);
        return [`- ${goal.title}${rate}${facets ? ` (${facets})` : ''}`, ...detail].join('\n');
    });
    return `## Goals\n${lines.join('\n')}`;
}

/** {{loom.variables}} — every Variable for the Timeline, with its value. */
export function renderLoomVariables(timelineId, { limit = null } = {}) {
    const variables = listVariableValues({ timelineId: String(timelineId || '') });
    const selected = limit === null || limit === undefined || limit === ''
        ? variables
        : variables.slice(-Math.max(0, Math.floor(Number(limit) || 0)));
    if (!selected.length) return '';
    const lines = selected.map((variable) => {
        const value = formatVariable(variable);
        const meaning = String(variable.description || '').trim();
        return `- ${variable.name}: ${value}${meaning ? ` — ${meaning}` : ''}`;
    });
    return `## Variables\n${lines.join('\n')}`;
}

/**
 * The Scenes immediately before `sceneId`, in order, with a label each. `count`
 * null means every earlier Scene; otherwise the last `count`. Current excluded.
 */
function orderedPreviousScenes(timelineId, sceneId, count) {
    const store = getTimelineStore();
    const timeline = store.timelines[String(timelineId || '')];
    const ordered = [];
    for (const arcId of timeline?.arcIds || []) {
        const arc = store.arcs[arcId];
        for (const id of arc?.sceneIds || []) {
            const scene = store.scenes[id];
            if (scene?.mode === 'roleplay' || scene?.mode === 'story') {
                ordered.push({ id: String(id), label: [arc?.title, scene?.title].filter(Boolean).join(' · ') || String(id) });
            }
        }
    }
    const targetIndex = ordered.findIndex((scene) => scene.id === String(sceneId || ''));
    if (targetIndex < 0) return [];
    const start = count === null ? 0 : Math.max(0, targetIndex - count);
    return ordered.slice(start, targetIndex);
}

/**
 * {{prev.events N}} — every recorded event of the last N Scenes, current Scene
 * excluded. Read straight from each Scene's Archive (not the relevance-ranked,
 * budget-capped World Sense recall), so nothing that happened in those Scenes
 * is silently dropped. `scenes=0` disables it; omit for all earlier Scenes.
 */
export function renderPrevEvents(timelineId, sceneId, { scenes = null } = {}) {
    const requested = normalizeSceneLookback(scenes);
    if (requested === 0) return '';
    const scenesList = orderedPreviousScenes(timelineId, sceneId, requested);
    const blocks = [];
    for (const scene of scenesList) {
        const events = listEvents(timelineId, scene.id)
            .filter((event) => String(event?.summary || '').trim())
            .slice()
            .sort((left, right) => Number(left.seq || 0) - Number(right.seq || 0));
        if (!events.length) continue;
        blocks.push(`### ${scene.label}\n${events.map((event) => `- ${event.summary}`).join('\n')}`);
    }
    return blocks.length ? `## Earlier Scenes — already happened\n${blocks.join('\n\n')}` : '';
}

function normalizeSceneLookback(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

function previousTimelineSceneIds(timelineId, sceneId, count) {
    const store = getTimelineStore();
    const timeline = store.timelines[String(timelineId || '')];
    const ordered = [];
    for (const arcId of timeline?.arcIds || []) {
        for (const id of store.arcs[arcId]?.sceneIds || []) {
            const scene = store.scenes[id];
            if (scene?.mode === 'roleplay' || scene?.mode === 'story') ordered.push(String(id));
        }
    }
    const targetIndex = ordered.indexOf(String(sceneId || ''));
    if (targetIndex < 0) return new Set();
    return new Set(ordered.slice(Math.max(0, targetIndex - count), targetIndex));
}

function boundedTail(items, requested) {
    if (requested === null || requested === undefined || requested === '') return items;
    const count = Math.max(0, Math.floor(Number(requested) || 0));
    return count > 0 ? items.slice(-count) : [];
}

/**
 * The extra instruction a Narrator retry carries after an empty response.
 *
 * THE DEFECT THIS FIXES: the empty-response path re-sent a BYTE-IDENTICAL
 * request. Captured on the wire — attempts 2 and 3 of one turn produced
 * request bodies that compared equal character for character, 72 seconds
 * apart. Asking a model the identical question it just failed to answer is a
 * repetition, not a retry, and it burned the whole retry budget (and, in three
 * observed turns, the entire turn) on the same failure.
 *
 * The observed failure is specific: the provider spends the response on
 * private reasoning and returns no visible content — 3,000 to 8,000 characters
 * of thinking against an empty `mes`. So the nudge names exactly that, rather
 * than being a generic "try again".
 *
 * Returns '' for a first attempt, so the initial request is never altered.
 *
 * @param {number} attempt 1 for the first try; 2+ for a retry
 * @param {{reasoningLength?: number}} [previous] what the failed attempt returned
 */
export function buildEmptyResponseNudge(attempt, { reasoningLength = 0, failureCause = '' } = {}) {
    const n = Number(attempt);
    if (!Number.isFinite(n) || n < 2) return '';
    const malformed = ['reasoning-in-content', 'instruction-echo', 'protocol-output'].includes(String(failureCause));
    const thought = failureCause === 'reasoning-in-content'
        ? 'The previous attempt exposed private planning in the visible content channel.'
        : failureCause === 'instruction-echo'
            ? 'The previous attempt copied prompt instructions into the response.'
            : failureCause === 'protocol-output'
                ? 'The previous attempt returned state or protocol JSON instead of narration.'
                : Number(reasoningLength) > 0
        ? 'The previous attempt spent its entire response on private reasoning and returned no prose.'
        : 'The previous attempt returned an empty response.';
    return [
        '## Output required',
        thought,
        malformed
            ? 'Return only the scene prose. Do not explain your approach, repeat any instruction, quote the prompt, or emit JSON/protocol data.'
            : 'Write the scene prose itself in your reply, as visible text. Do not answer with reasoning alone, and do not return an empty message.',
    ].join('\n');
}
