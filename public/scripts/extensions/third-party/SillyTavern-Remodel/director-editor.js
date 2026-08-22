/** True only for the editor mode (narrator drafts, Director reconciles). */
export function isEditorMode(scene) {
    return scene?.liveDirection?.mode === 'editor';
}

/**
 * The Director-editor prompt. The Director is a purely MECHANICAL referee: it
 * reads the narrator's draft, resolves the dice, and records what happened. It
 * NEVER reproduces or rewrites the draft — preserve-and-patch is done in code.
 * The draft is kept verbatim; the Director only names the exact span(s) a roll
 * changed, as find/replace swaps the code applies. On a turn where nothing was
 * rolled (the common case), it emits no swaps and the draft stands untouched.
 *
 * @param {{draft: string, draftReasoning?: string, narrativeState?: string, mechanicsSkill?: string}} input
 * @returns {{role: string, content: string}[]}
 */
export function buildDirectorEditorPrompt({ draft, draftReasoning = '', narrativeState = '', mechanicsSkill = '' }) {
    const hasMechanics = Boolean(String(mechanicsSkill || '').trim());
    const system = [
        'You are the Director — a mechanical referee, not a writer. You are given the narrator\'s DRAFT of this turn. You never write prose and you never reproduce the draft; you resolve the dice, record what happened, and — only when a roll changes an outcome — name the exact words to swap.',
        'STEP 1 — Mechanics. Create or update Goals and Variables the fiction now warrants (you author these, not the narrator).',
        'STEP 2 — Rolls. ONLY when an outcome is genuinely in doubt — even the characters do not know if it will work (a real gamble or contest) — request goal.reach for it; the dice are rolled by code, never by you. Do NOT roll for routine actions a character would simply accomplish. Rolls are rare.',
        'STEP 3 — Patch (rare). The draft is KEPT AS WRITTEN — do not rewrite it. ONLY if a roll\'s result in STEP 2 contradicts a specific sentence in the draft, emit a swap: "find" is that sentence copied VERBATIM from the draft (long enough to appear exactly once), "replace" is the corrected sentence in the same voice. Emit a swap only for a beat a roll actually changed. If nothing was rolled, or nothing contradicts the draft, emit an empty "swaps" array — the draft stands untouched.',
        'Write NO narration and NO commentary. Output ONLY the state fence below and nothing else:',
        '```state',
        '{"swaps":[{"find":"exact sentence from the draft","replace":"the corrected sentence"}],"requests":[{"id":"r1","capability":"event.record","arguments":{"summary":"what happened"},"reason":"why, one line"}],"flow":{"continue":false}}',
        '```',
        String(narrativeState || '').trim() ? `\nCurrent state:\n${narrativeState}` : '',
        hasMechanics ? `\nMechanical board (Variables and Goals, with their numbers — yours, never shown to the narrator):\n${mechanicsSkill}` : '',
    ].filter(Boolean).join('\n');
    const user = [
        `The narrator's draft of this turn (keep it verbatim; swap only what a roll changed):\n${draft}`,
        String(draftReasoning || '').trim() ? `\nThe narrator's private reasoning:\n${draftReasoning}` : '',
    ].filter(Boolean).join('\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}

const STATE_FENCE = /```state\s*\n([\s\S]*?)\n?```/i;

/**
 * Parse the Director-editor's reply. The reply is a single ```state fence whose
 * JSON carries preserve-and-patch swaps (find/replace spans the code applies to
 * the draft) and the mechanics requests to execute. Any prose the model leaks
 * outside the fence is ignored — the draft, not the model, owns the narration.
 * A missing or malformed fence is not an error: no swaps, no requests.
 *
 * @param {string} raw
 * @returns {{ swaps: {find: string, replace: string}[], requests: object[] }}
 */
export function parseEditorReply(raw) {
    const text = String(raw ?? '');
    const match = text.match(STATE_FENCE);
    let swaps = [];
    let requests = [];
    if (match) {
        try {
            const parsed = JSON.parse(match[1]);
            if (Array.isArray(parsed?.requests)) requests = parsed.requests;
            if (Array.isArray(parsed?.swaps)) {
                swaps = parsed.swaps.filter((s) => s
                    && typeof s.find === 'string' && s.find.length > 0
                    && typeof s.replace === 'string');
            }
        } catch { swaps = []; requests = []; }
    }
    return { swaps, requests };
}

/**
 * Apply the Director-editor's swaps to the narrator's draft, in code. Each swap
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
