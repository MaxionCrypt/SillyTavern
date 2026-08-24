const META_OPENINGS = [
    /^\s*(?:hmm[,.:]?\s+)?(?:the )?user (?:wants|asked|asks|requested|is asking)\b/i,
    /^\s*(?:we|i) need (?:to )?(?:answer|respond|write|continue|follow|obey|recall|avoid|ensure)\b/i,
    /^\s*looking back\s*:/i,
    /^\s*(?:i(?:'ll| will)|let me) (?:describe|draft|write|respond|create|craft|produce|continue)\b/i,
    /^\s*(?:key|current) (?:constraints|requirements|instructions|physical markers)\s*:/i,
    /^\s*(?:analysis|reasoning|thought process)\s*:/i,
    /^\s*<think>/i,
];

const INSTRUCTION_LINE = /^\s*(?:[-*]\s*)?(?:do not|don't|never|always|you (?:are|must|will|should|can only)|your (?:job|task|role)|this is (?:a collaborative|an interactive)|rules?\s*:|instructions?\s*:|output required\b|the narrator is called\b)/i;
const STATE_OPENING = /^\s*(?:```(?:json)?\s*)?\{\s*"(?:swaps|requests|events|goals|variables|patches)"\s*:/i;

/**
 * Detect text that is non-empty but is not a Narrator draft.
 *
 * This is deliberately an acceptance gate, not a prose editor. A malformed
 * draft is retried in full so private chain-of-thought or copied instructions
 * can never be handed to the Loom as story material.
 */
export function describeNarratorOutput(text) {
    const source = String(text ?? '').trim();
    if (!source) return { malformed: false, cause: '', diagnosis: '' };

    if (STATE_OPENING.test(source)) {
        return failure('protocol-output', 'The Narrator returned Loom/state JSON instead of scene prose.');
    }

    const opening = source.slice(0, 1200);
    if (META_OPENINGS.some((pattern) => pattern.test(opening))) {
        return failure('reasoning-in-content', 'The Narrator placed its private planning in the visible content channel instead of returning scene prose.');
    }

    const leadingLines = opening.split(/\r?\n/).slice(0, 12).filter((line) => line.trim());
    const instructionLines = leadingLines.filter((line) => INSTRUCTION_LINE.test(line)).length;
    if (instructionLines >= 2) {
        return failure('instruction-echo', 'The Narrator copied prompt instructions into its response instead of returning only scene prose.');
    }

    return { malformed: false, cause: '', diagnosis: '' };
}

function failure(cause, diagnosis) {
    return { malformed: true, cause, diagnosis };
}
