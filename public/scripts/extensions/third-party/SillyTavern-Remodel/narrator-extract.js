import { getCapabilityDictionary } from './mechanics-capabilities.js';

// Pass 2 records narrative state only — events, scene facts, character states,
// beat, secrets. These are keyed by string and need no advertised refs, so
// extraction stays a single cheap call with no address book. Variable/goal
// authoring (which needs refs) is deliberately out of v1.
const ARCHIVIST_VERBS = new Set([
    'scene.set', 'scene.clear', 'event.record',
    'char_state.set', 'char_state.clear', 'beat.set',
    'secret.set', 'secret.clear',
]);

/** The archivist verbs and their arguments, for the extraction prompt. */
export function archivistCapabilityGuide() {
    return getCapabilityDictionary()
        .filter((capability) => ARCHIVIST_VERBS.has(capability.name))
        .map((capability) => {
            const args = (capability.requiredArguments || []).map((arg) => `${arg.key} (${arg.hint})`).join(', ');
            return `- ${capability.name}: ${capability.description}${args ? ` — arguments: ${args}` : ''}`;
        })
        .join('\n');
}

/**
 * Build the extraction prompt: read the delivered narration (and the author's
 * reasoning, when available) and record what happened as a state fence. The
 * current recorded state is included so the model does not re-record it. When a
 * `mechanicsSkill` block is supplied (the advertised Variables and Goals, with
 * their capabilities), the extractor may also record numeric/goal consequences
 * against them by their exact advertised name.
 *
 * @param {{prose: string, reasoning?: string, currentState?: string, mechanicsSkill?: string}} input
 * @returns {{role: string, content: string}[]}
 */
export function buildExtractionPrompt({ prose, reasoning = '', currentState = '', mechanicsSkill = '' }) {
    const hasMechanics = Boolean(String(mechanicsSkill || '').trim());
    const system = [
        'You are the Archivist. You do not write story. You read the narration that was just delivered and record, as structured state, only what actually happened or changed in it.',
        'Record each distinct event with event.record. Update changed scene facts with scene.set, character state with char_state.set, and set what should happen next with beat.set. Store information the reader should not yet see with secret.set. Never invent anything the narration did not establish.',
        hasMechanics ? 'You may ALSO record mechanical consequences against the Variables and Goals advertised below, addressing each by its exact advertised name — but only when the narration clearly changed one.' : '',
        'Reply with ONLY a fenced state block and nothing else:',
        '```state',
        '{"requests":[{"id":"r1","capability":"event.record","arguments":{"summary":"what happened"},"reason":"why, one line"}],"flow":{"continue":false}}',
        '```',
        '',
        'Narrative capabilities:',
        archivistCapabilityGuide(),
        hasMechanics ? `\nAdvertised Variables and Goals (with the capabilities that change them):\n${mechanicsSkill}` : '',
        String(currentState || '').trim() ? `\nAlready recorded (do NOT record these again):\n${currentState}` : '',
    ].filter(Boolean).join('\n');
    const user = [
        String(reasoning || '').trim() ? `The narrator's private reasoning for this passage:\n${reasoning}\n` : '',
        `The narration just delivered:\n${prose}`,
    ].filter(Boolean).join('\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}

/**
 * The archivist-first (pre-narration) prompt. Runs BEFORE the narrator: reads
 * the user's new action and the PREVIOUS narration, then (1) records what the
 * previous narration established and (2) resolves the mechanics the user's
 * action sets in motion — requesting goal.reach for attempts (dice are
 * code-rolled) and adjusting Variables the action clearly changes. It decides
 * only facts and numbers, never story, and never sets a beat.
 *
 * @param {{action: string, priorProse?: string, priorReasoning?: string, currentState?: string, mechanicsSkill?: string}} input
 * @returns {{role: string, content: string}[]}
 */
export function buildArchivistPrompt({ action, priorProse = '', priorReasoning = '', currentState = '', mechanicsSkill = '' }) {
    const hasMechanics = Boolean(String(mechanicsSkill || '').trim());
    const hasPrior = Boolean(String(priorProse || '').trim());
    const system = [
        'You are the Archivist. You run BEFORE the narrator. You decide only facts and numbers — never story, and never what happens next.',
        hasPrior ? 'First, record what the PREVIOUS narration established: each distinct event with event.record, changed scene facts with scene.set, character state with char_state.set, and information the reader should not yet see with secret.set. Never invent anything it did not establish.' : '',
        hasMechanics ? 'Then resolve the mechanics the USER\'S ACTION sets in motion: if it attempts a Goal, request goal.reach for that Goal by its exact advertised name — the dice are rolled by code, not by you — and adjust any Variable the action clearly changes. Do NOT resolve mechanics the action does not actually attempt.' : '',
        'Do NOT set beats or decide what happens next — that is the narrator\'s job alone.',
        'Reply with ONLY a fenced state block and nothing else:',
        '```state',
        '{"requests":[{"id":"r1","capability":"event.record","arguments":{"summary":"what happened"},"reason":"why, one line"}],"flow":{"continue":false}}',
        '```',
        '',
        'Narrative capabilities:',
        archivistCapabilityGuide(),
        hasMechanics ? `\nAdvertised Variables and Goals (with the capabilities that change them):\n${mechanicsSkill}` : '',
        String(currentState || '').trim() ? `\nAlready recorded (do NOT record these again):\n${currentState}` : '',
    ].filter(Boolean).join('\n');
    const user = [
        `The user is about to attempt:\n${action}`,
        hasPrior ? `\nThe previous narration (record what it established):\n${priorProse}` : '',
        String(priorReasoning || '').trim() ? `\nThe narrator's private reasoning for that passage:\n${priorReasoning}` : '',
    ].filter(Boolean).join('\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}
