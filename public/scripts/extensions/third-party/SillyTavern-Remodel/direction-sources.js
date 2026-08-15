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
        mechanicsSkill: mechanicsEnabled ? describeMechanics(snapshot?.mechanics) : '',
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

function describeMechanics(mechanics) {
    // goal.title, not goal.name: buildMechanicalSnapshot's listed goals carry
    // a title field, never a name field. Reading .name here would render
    // "undefined" for every Goal.
    const goals = (mechanics?.goals || []).map((goal) => `- ${goal.title}${goal.status ? ` (${goal.status})` : ''}`).join('\n');
    const duplicates = (mechanics?.addressBook?.duplicates || []);
    return `[GOALS AND VARIABLES — persistent memory, not a turn structure]
Address each one by the exact name below. A name you were not given will be rejected. Never invent an identifier, never roll dice, never change state yourself — request it and code will validate and apply it.

CAPABILITIES
${describeCapabilities(mechanics?.capabilities)}

VARIABLES
${mechanics?.serializedVariables || '(none retrieved this turn)'}

GOALS
${goals || '(none active)'}
${duplicates.length ? `\nUnusable — these names are duplicated in this Timeline and cannot be addressed: ${duplicates.join(', ')}` : ''}`;
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
