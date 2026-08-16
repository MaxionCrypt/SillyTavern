// The content behind each source block of a Director recipe.
//
// PURE — takes a snapshot, returns strings. Keeping it free of context imports
// means the exact text sent to the Director can be asserted in tests.

/**
 * @param {object} snapshot the direction snapshot
 * @param {{mechanicsEnabled: boolean}} options
 * @returns {{directionProtocol: string, directorCard: string, mechanicsSkill: string, directorSnapshot: string}}
 */
export function buildDirectionSources(snapshot, { mechanicsEnabled = false } = {}) {
    return {
        directionProtocol: PROTOCOL,
        directorCard: snapshot?.director ? describeCard(snapshot.director) : '',
        mechanicsSkill: describeMechanics(snapshot?.mechanics, { mechanicsEnabled }),
        directorSnapshot: describeSnapshot(snapshot),
    };
}

// Contract only. Pacing, autonomy and response length live in the recipe's
// editable style block, not here — that was the point of the rework.
const PROTOCOL = `You are the hidden director of this scene. You never speak in the story and are never quoted.
Write your direction as an instruction to the performer who will write the next response: what they are doing, and what matters about how.
Then close with the required structured fields. Do not describe the protocol, do not mention that you are a director, and do not reveal secret Goals or unrevealed twists.`;

function describeCard(director) {
    return `[DIRECTOR CARD — directing temperament, not dialogue]
The director for this scene is ${director.label}. Use this material as judgment, priorities and genre sense. Never speak as this character.
Description: ${director.description || '(none)'}
Personality: ${director.personality || '(none)'}
Scenario: ${director.scenario || '(none)'}
Creator notes: ${director.creatorNotes || '(none)'}
System prompt: ${director.systemPrompt || '(none)'}
Post-history instructions: ${director.postHistoryInstructions || '(none)'}`;
}

/**
 * Everything the Director may read about persistent state, and — when
 * mechanics are on — everything it may ask to change.
 *
 * Rendered rather than JSON-dumped, and rendered WITHOUT the temporary
 * `v1`/`g1` refs the layers underneath still use as internal keys. Names are
 * the only address now (design §3), so a ref appearing anywhere in this text
 * is an invitation to reply with one.
 *
 * When mechanics are disabled this still renders. It used to return '', which
 * `compilePromptRecipe` then dropped entirely — leaving a Director with no
 * Variables, no Goals, no statement that anything was off, and a schema still
 * demanding a `requests` array it had nothing to fill from.
 */
function describeMechanics(mechanics, { mechanicsEnabled = false } = {}) {
    const goals = Array.isArray(mechanics?.goals) ? mechanics.goals : [];
    // The one place refs are still read: relationships and the user's attached
    // attempts arrive keyed by `g1…gN` (buildMechanicalSnapshot), and both are
    // resolved back to titles here rather than being printed raw. Refless
    // Goals are excluded so an unresolved relationship endpoint — which
    // describeRelations renders as '' — cannot accidentally match one.
    const titleByRef = new Map(goals.filter((goal) => goal.ref && goal.title).map((goal) => [goal.ref, goal.title]));
    const sections = [
        mechanicsEnabled ? section('CAPABILITIES', describeCapabilities(mechanics?.capabilities)) : '',
        section('VARIABLES', mechanics?.serializedVariables || '(none retrieved this turn)', describeRetrieval(mechanics?.retrieval)),
        section('GOALS', goals.map(describeGoal).join('\n') || '(none active)'),
        section('RELATIONSHIPS', describeRelationships(mechanics?.relationships, titleByRef)),
        section('ATTEMPTED THIS TURN', describeAttempts(mechanics?.authorizedGoalRefs, titleByRef)),
    ].filter(Boolean);
    return [heading(mechanicsEnabled), ...sections, closing(mechanicsEnabled, mechanics)].filter(Boolean).join('\n\n');
}

function heading(mechanicsEnabled) {
    const title = '[GOALS AND VARIABLES — persistent memory, not a turn structure]';
    return mechanicsEnabled
        ? `${title}\nAddress each one by the exact name below. A name you were not given will be rejected. Never invent an identifier, never roll dice, never change state yourself — request it and code will validate and apply it.`
        : `${title}\nMechanical automation is unavailable this turn, so everything below is read-only: treat it as established fact your direction must respect, and return an empty requests array. Never roll dice or narrate a change to any value below.`;
}

function closing(mechanicsEnabled, mechanics) {
    if (!mechanicsEnabled) return '';
    const duplicates = mechanics?.addressBook?.duplicates || [];
    return duplicates.length
        ? `Unusable — these names are duplicated in this Timeline and cannot be addressed: ${duplicates.join(', ')}`
        : '';
}

/** A heading with nothing under it tells the Director less than no heading. */
function section(title, body, note = '') {
    const content = String(body || '').trim();
    if (!content) return '';
    // The note is its own paragraph: run up against the last entry it reads as
    // part of that entry rather than as a caveat on the whole list.
    return [`${title}\n${content}`, note].filter(Boolean).join('\n\n');
}

/**
 * One Goal, with the fields the capability dictionary actually acts on.
 *
 * `successRate` above all: `goal.shift` exists to move exactly this number by
 * a named band, and the Director was previously shown only title and status —
 * asked to shift a value it could not read.
 */
function describeGoal(goal) {
    const facets = [goal.status, goal.visibility].filter(Boolean).join(', ');
    const rate = Number.isFinite(Number(goal.successRate)) ? ` — ${Number(goal.successRate)}%` : '';
    const detail = [
        goal.description,
        describeOwners('Held by', goal.holderRefs),
        describeOwners('Against', goal.targetRefs),
        describeGoalResolution(goal.resolution),
    ].filter(Boolean).map((line) => `  ${line}`);
    return [`- ${goal.title}${rate}${facets ? ` (${facets})` : ''}`, ...detail].join('\n');
}

function describeOwners(label, refs) {
    const names = (Array.isArray(refs) ? refs : []).map((ref) => ref?.label).filter(Boolean);
    return names.length ? `${label}: ${names.join(', ')}` : '';
}

/**
 * What a tracked Goal tracks, named the way everything else is now.
 *
 * `variableName` is supplied by mechanics-runtime.js's describeResolution; it
 * used to be `variableRef`, which would have reintroduced `v1` into the prompt
 * the moment this block started rendering resolutions at all.
 */
function describeGoalResolution(resolution) {
    if (!resolution || resolution.kind !== 'tracked') return '';
    if (!resolution.variableName) return `Tracks a Variable that was not retrieved this turn${resolution.note ? ` — ${resolution.note}` : ''}.`;
    const direction = resolution.direction === 'decrease' ? 'down to' : 'up to';
    const threshold = resolution.completionThreshold ?? null;
    const field = resolution.field && resolution.field !== 'value' ? ` (${resolution.field})` : '';
    return `Tracks ${resolution.variableName}${field}, achieved when it goes ${direction} ${threshold}.`;
}

function describeRelationships(relationships, titleByRef) {
    return (Array.isArray(relationships) ? relationships : []).map((relation) => {
        const from = titleByRef.get(relation.fromRef);
        const to = titleByRef.get(relation.toRef);
        if (!from || !to) return '';
        return `- ${from} → ${to} (${relation.type || 'related'})${relation.reason ? `: ${relation.reason}` : ''}`;
    }).filter(Boolean).join('\n');
}

/**
 * The Goal attempts the user attached to this action.
 *
 * `isAuthorizedGoal` still gates persona-held Goals on exactly these, and the
 * Roleplay preview still promises the user they "will be assessed by the
 * hidden Game Director when sent" — so the Director has to be told which ones.
 */
function describeAttempts(authorizedGoalRefs, titleByRef) {
    const titles = (Array.isArray(authorizedGoalRefs) ? authorizedGoalRefs : [])
        .map((ref) => titleByRef.get(ref)).filter(Boolean);
    if (!titles.length) return '';
    return [
        'The user attached these Goal attempts to the current action. Judge them in this direction.',
        ...titles.map((title) => `- ${title}`),
    ].join('\n');
}

/**
 * Retrieval that fell back is a caveat on the Variable list, not a section.
 *
 * Deliberately no `retrieval.warning`. That field holds a raw transport error
 * — observed reaching the Director as "Failed to parse URL from
 * /api/vector/list" — which tells the model nothing it can act on and asks it
 * to parse machine text mid-prompt. What it needs is the consequence: this
 * list may be short. The error itself is already journalled by
 * variables-context.js (`retrieval.resolved`, `degradeCause`), which is where
 * it is useful, and it stays on the snapshot for the debug surfaces.
 */
function describeRetrieval(retrieval) {
    if (!retrieval?.degraded) return '';
    return 'Semantic retrieval was unavailable this turn, so this list was selected by direct reference alone and may be missing Variables that are relevant.';
}

/**
 * The verbs a Director's `requests` may name, spelled out rather than left
 * for the model to infer from a record's shape. Without this list a Director
 * can see a Variable or Goal in the snapshot above and have no idea what may
 * be asked of it — the dictionary existed for exactly this before the
 * compiled-recipe rework dropped it.
 *
 * Read from the snapshot rather than imported from mechanics-capabilities.js
 * directly: that module pulls in variables-store.js/story-goals-store.js,
 * which import st-context.js, and this module must not. mechanics-runtime.js
 * puts `getCapabilityDictionary()`'s output into `mechanics.capabilities` for
 * exactly this reason.
 */
function describeCapabilities(capabilities) {
    return (Array.isArray(capabilities) ? capabilities : [])
        .map((capability) => `- ${capability.name} (${capability.applicableKinds.join(', ')}): ${capability.description}`)
        .join('\n');
}

function describeSnapshot(snapshot) {
    const { mechanics, director, ...rest } = snapshot || {};
    return `SCENE\n${JSON.stringify(rest)}`;
}
