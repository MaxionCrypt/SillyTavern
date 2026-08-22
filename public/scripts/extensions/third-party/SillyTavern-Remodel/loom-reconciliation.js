export const LOOM_POLICY_V12 = `You are the Loom: the final continuity editor, mechanical referee, and live voice of the scene. You receive the Narrator's private draft before anything becomes visible. Return the complete final prose in the Narrator's voice, preserving it closely except where continuity or mechanics requires a correction.

STEP 1 - State. Record the events, facts, character-state changes, Goals, and Variables the fiction now warrants.
STEP 2 - Rolls. Only request goal.reach when an outcome is genuinely in doubt - a real gamble or contest whose result the characters do not already know. Code rolls the dice, never you. Routine actions do not need rolls.
STEP 3 - Reconcile. Produce the complete version that may become accepted fiction. Preserve the draft when it is sound; revise only what continuity, an authorized roll, or the player's established action requires.`;

export const LOOM_POLICY_DEFAULT = `You are the Loom: the final continuity editor, mechanical referee, and live voice of the scene. You receive the Narrator's private draft before anything becomes visible. Return the complete final prose in the Narrator's voice, preserving it closely except where continuity or mechanics requires a correction.

STEP 1 - Archive. Keep the Archive caught up with only the fiction that this response makes canonical. Record each distinct new event with event.record. Update durable scene facts with scene.set, changed character facets with char_state.set, hidden truths with secret.set, and the unresolved forward beat with beat.set. The Current Archive lists what is already recorded: never duplicate or merely rephrase one of its entries. Do not invent state the prose does not establish.
STEP 2 - Mechanics. Record warranted Goal and Variable changes. Only request goal.reach when an outcome is genuinely in doubt - a real gamble or contest whose result the characters do not already know. Code rolls the dice, never you. Routine actions do not need rolls.
STEP 3 - Reconcile. Produce the complete version that may become accepted fiction. Preserve the draft when it is sound; revise only what continuity, an authorized roll, or the player's established action requires.`;

export const LOOM_OUTPUT_CONTRACT_DEFAULT = `Output the complete final scene prose first, with no preface or commentary. Then output exactly one state fence:
\`\`\`state
{"requests":[{"id":"r1","capability":"event.record","arguments":{"summary":"what happened"},"reason":"why, one line"}],"flow":{"continue":false}}
\`\`\``;

/** True when a scene uses the Narrator draft -> Loom reconciliation pipeline. */
export function usesLoomReconciliation(scene) {
    return scene?.liveDirection?.mode === 'loom';
}

/** Dynamic context blocks available to every Loom recipe. */
export function buildLoomRecipeSources({ draft, draftReasoning = '', narrativeState = '', mechanicsSkill = '' }) {
    return {
        archiveState: String(narrativeState || '').trim()
            ? `Current Archive and objectives:\n${String(narrativeState).trim()}`
            : '',
        mechanicsBoard: String(mechanicsSkill || '').trim()
            ? `Mechanical board (Variables and Goals, with their numbers):\n${String(mechanicsSkill).trim()}`
            : '',
        narratorDraft: `The Narrator's private draft of this turn. Return its complete final version before the state fence:\n${String(draft || '')}`,
        narratorReasoning: String(draftReasoning || '').trim()
            ? `The Narrator's private reasoning:\n${String(draftReasoning).trim()}`
            : '',
    };
}

/**
 * The Loom prompt. The Loom is a purely MECHANICAL referee: it
 * reads the narrator's draft, resolves the dice, and records what happened. It
 * NEVER reproduces or rewrites the draft — preserve-and-patch is done in code.
 * The draft is kept verbatim; the Loom only names the exact span(s) a roll
 * changed, as find/replace swaps the code applies. On a turn where nothing was
 * rolled (the common case), it emits no swaps and the draft stands untouched.
 *
 * @param {{draft: string, draftReasoning?: string, narrativeState?: string, mechanicsSkill?: string}} input
 * @returns {{role: string, content: string}[]}
 */
export function buildLoomPrompt({ draft, draftReasoning = '', narrativeState = '', mechanicsSkill = '' }) {
    const sources = buildLoomRecipeSources({ draft, draftReasoning, narrativeState, mechanicsSkill });
    const system = [LOOM_POLICY_DEFAULT, sources.archiveState, sources.mechanicsBoard, LOOM_OUTPUT_CONTRACT_DEFAULT].filter(Boolean).join('\n\n');
    const user = [sources.narratorDraft, sources.narratorReasoning].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}

const STATE_FENCE = /```state\s*\n([\s\S]*?)\n?```/i;
const STATE_FENCE_START = /(?:^|\n)```state\b/i;

/** Return only the prose portion of a cumulative Loom response. While the
 * response is still streaming, withhold a partial state-fence opener so its
 * backticks can never flash into the roleplay manuscript. */
export function readLoomProse(raw, { final = false } = {}) {
    const text = String(raw ?? '');
    const match = STATE_FENCE_START.exec(text);
    let prose = match ? text.slice(0, match.index) : text;
    if (!match && !final) {
        const partialFence = prose.match(/\n?`{1,3}(?:s(?:t(?:a(?:t(?:e)?)?)?)?)?$/i);
        if (partialFence) prose = prose.slice(0, -partialFence[0].length);
    }
    prose = prose.replace(/^\s+/, '');
    return final ? prose.trimEnd() : prose;
}

/**
 * Parse the Loom's reply. The reply is a single ```state fence whose
 * JSON carries preserve-and-patch swaps (find/replace spans the code applies to
 * the draft) and the mechanics requests to execute. Any prose the model leaks
 * outside the fence is ignored — the draft, not the model, owns the narration.
 * A missing or malformed fence is not an error: no swaps, no requests.
 *
 * @param {string} raw
 * @returns {{ swaps: {find: string, replace: string}[], requests: object[], flow: {continueAfter: boolean, hardPauseAfter: boolean}|null }}
 */
export function parseLoomReply(raw) {
    const text = String(raw ?? '');
    const prose = readLoomProse(text, { final: true });
    const match = text.match(STATE_FENCE);
    let swaps = [];
    let requests = [];
    let flow = null;
    if (match) {
        try {
            const parsed = JSON.parse(match[1]);
            if (Array.isArray(parsed?.requests)) requests = parsed.requests;
            if (parsed?.flow && typeof parsed.flow === 'object') {
                flow = {
                    continueAfter: Boolean(parsed.flow.continue ?? parsed.flow.continueAfter),
                    hardPauseAfter: Boolean(parsed.flow.hardPause ?? parsed.flow.hardPauseAfter),
                };
            }
            if (Array.isArray(parsed?.swaps)) {
                swaps = parsed.swaps.filter((s) => s
                    && typeof s.find === 'string' && s.find.length > 0
                    && typeof s.replace === 'string');
            }
        } catch { swaps = []; requests = []; flow = null; }
    }
    return { prose, swaps, requests, flow };
}

/**
 * Apply the Loom's swaps to the Narrator's draft, in code. Each swap
 * replaces the FIRST exact occurrence of its `find` span with `replace`. A swap
 * whose `find` is not present in the (progressively patched) draft is skipped —
 * never corrupt the prose over a paraphrased anchor. Returns the patched prose
 * and how many swaps actually landed.
 *
 * @param {string} draft
 * @param {{find: string, replace: string}[]} swaps
 * @returns {{ prose: string, applied: number }}
 */
export function applySwaps(draft, swaps) {
    let prose = String(draft ?? '');
    let applied = 0;
    for (const swap of Array.isArray(swaps) ? swaps : []) {
        if (!swap || typeof swap.find !== 'string' || !swap.find) continue;
        if (typeof swap.replace !== 'string') continue;
        if (!prose.includes(swap.find)) continue;
        prose = prose.replace(swap.find, swap.replace);
        applied += 1;
    }
    return { prose, applied };
}
