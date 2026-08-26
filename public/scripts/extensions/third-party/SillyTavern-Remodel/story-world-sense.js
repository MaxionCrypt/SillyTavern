const STORY_QUERY_TAIL_CHARS = 6000;
const STORY_QUERY_HISTORY_ITEMS = 8;

/**
 * Build the Story-mode World Sense query from accepted fiction and explicit
 * scene intent only. Author guidance, compiled prompts, reasoning, discarded
 * generations, and Archive secrets never enter this packet.
 */
export function buildStoryWorldSenseOptions({ doc = null, mode = 'continue', beat = '', passage = '', cast = [] } = {}) {
    const history = storyHistory(doc?.body || '');
    const acceptedPassage = String(passage || '').trim();
    const requestedBeat = String(beat || '').trim();
    const fallback = history.at(-1)?.content || '';
    const action = acceptedPassage
        || requestedBeat
        || fallback
        || (mode === 'continue' ? 'Continue the accepted Story manuscript.' : 'Develop the next accepted Story passage.');
    return {
        action,
        history,
        cast: (Array.isArray(cast) ? cast : [cast]).filter(Boolean),
        searchTerms: [],
    };
}

/** A native Story World Info resolver consumes identities, never copied lore. */
export function storyWorldSenseLoreSelection(result) {
    return {
        book: String(result?.book || ''),
        selected: (result?.selected || []).filter((item) => item?.kind !== 'continuity' && item?.uid != null),
    };
}

/** Deliver prior-scene evidence as a bounded, provenance-labelled Story source. */
export function formatStoryWorldSenseContinuity(result) {
    const selected = (result?.continuity || result?.selected || []).filter((item) => item?.kind === 'continuity');
    if (!selected.length) return '';
    const rows = selected.map((item) => {
        const record = item.record || item;
        const provenance = [record.arcTitle, record.sceneTitle, record.recordType].filter(Boolean).join(' / ');
        return `- [${provenance || 'Earlier Timeline Scene'}] ${String(record.text || '').trim()}`;
    }).filter((row) => row.trim() !== '- []');
    return rows.length ? `=== WORLD SENSE RECALL ===\nAccepted evidence recalled from earlier Timeline Scenes:\n${rows.join('\n')}` : '';
}

function storyHistory(body) {
    const tail = String(body || '').slice(-STORY_QUERY_TAIL_CHARS);
    return tail.split(/\n\s*\n|\r?\n/)
        .map((content) => content.trim())
        .filter(Boolean)
        .slice(-STORY_QUERY_HISTORY_ITEMS)
        .map((content) => ({ role: 'assistant', name: 'Story manuscript', content }));
}
