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
