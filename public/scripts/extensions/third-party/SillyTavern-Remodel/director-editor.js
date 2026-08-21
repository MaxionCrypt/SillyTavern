/** True only for the editor mode (narrator drafts, Director reconciles). */
export function isEditorMode(scene) {
    return scene?.liveDirection?.mode === 'editor';
}

/**
 * The Director-editor prompt. The Director is a purely MECHANICAL referee: it
 * reads the narrator's draft and reconciles it with the dice, but authors no
 * prose beyond swapping the exact beat a roll changed (preserve-and-patch).
 *
 * @param {{draft: string, draftReasoning?: string, narrativeState?: string, mechanicsSkill?: string}} input
 * @returns {{role: string, content: string}[]}
 */
export function buildDirectorEditorPrompt({ draft, draftReasoning = '', narrativeState = '', mechanicsSkill = '' }) {
    const hasMechanics = Boolean(String(mechanicsSkill || '').trim());
    const system = [
        'You are the Director — a mechanical referee, not a writer. You are given the narrator\'s DRAFT of this turn. You never invent story or voice; you reconcile the draft with the dice and record what happened.',
        'STEP 1 — Mechanics. Create or update Goals and Variables the fiction now warrants (you author these, not the narrator).',
        'STEP 2 — Rolls. ONLY when an outcome is genuinely in doubt — even the characters do not know if it will work (a real gamble or contest) — request goal.reach for it; the dice are rolled by code, never by you. Do NOT roll for routine actions a character would simply accomplish. Rolls are rare.',
        'STEP 3 — Reconcile (preserve-and-patch). Output the committed narration. Reproduce the narrator\'s draft WORD FOR WORD, changing ONLY the sentence(s) a roll\'s result contradicts. If nothing was rolled, or nothing contradicts the draft, output the draft UNCHANGED. Never rewrite, rephrase, or restyle any part the dice did not touch.',
        'After the committed narration, on its own lines, emit a state fence recording what happened and any mechanics you changed:',
        '```state',
        '{"requests":[{"id":"r1","capability":"event.record","arguments":{"summary":"what happened"},"reason":"why, one line"}],"flow":{"continue":false}}',
        '```',
        String(narrativeState || '').trim() ? `\nCurrent state:\n${narrativeState}` : '',
        hasMechanics ? `\nMechanical board (Variables and Goals, with their numbers — yours, never shown to the narrator):\n${mechanicsSkill}` : '',
    ].filter(Boolean).join('\n');
    const user = [
        `The narrator's draft of this turn:\n${draft}`,
        String(draftReasoning || '').trim() ? `\nThe narrator's private reasoning:\n${draftReasoning}` : '',
    ].filter(Boolean).join('\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}

const STATE_FENCE = /```state\s*\n([\s\S]*?)\n?```/i;

/**
 * Split the Director-editor's reply into the committed prose (before the fence)
 * and the recorded state requests (inside the fence). A missing or malformed
 * fence is not an error — the prose is the whole reply and nothing is recorded.
 *
 * @param {string} raw
 * @returns {{ prose: string, requests: object[] }}
 */
export function parseEditorReply(raw) {
    const text = String(raw ?? '');
    const match = text.match(STATE_FENCE);
    const prose = (match ? text.slice(0, match.index) : text).trim();
    let requests = [];
    if (match) {
        try {
            const parsed = JSON.parse(match[1]);
            if (Array.isArray(parsed?.requests)) requests = parsed.requests;
        } catch { requests = []; }
    }
    return { prose, requests };
}
