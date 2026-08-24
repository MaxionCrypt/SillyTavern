// Pure view-model helpers for the Lorebooks World Sense utility. Keeping these
// detached from DOM and SillyTavern state makes filtering and review rendering
// deterministic and cheap to test.

export function filterWorldSenseWorkspaceEntries({
    entries = [], metadata = [], receipt = null, semanticMatches = [], query = '', type = 'all', status = 'all',
} = {}) {
    const metadataByKey = new Map(metadata.map((item) => [entryKey(item), item]));
    const selectedByKey = new Map((receipt?.selected || []).map((item) => [entryKey(item), item]));
    const rejectedByKey = new Map((receipt?.rejected || []).map((item) => [entryKey(item), item]));
    const semanticByKey = new Map((semanticMatches || []).map((item) => [entryKey(item), item]));
    const needle = normalize(query);

    return entries.map((entry) => {
        const key = entryKey(entry);
        const sidecar = metadataByKey.get(key) || {};
        const receiptItem = selectedByKey.get(key) || rejectedByKey.get(key) || null;
        const semantic = semanticByKey.get(key) || null;
        return {
            ...entry,
            key,
            metadata: sidecar,
            entryType: sidecar.entryType || 'entity',
            revision: Number(sidecar.revision || 1),
            origin: sidecar.origin || 'user',
            protectedFields: sidecar.protectedFields || [],
            links: sidecar.links || [],
            pinned: Boolean(sidecar.worldSense?.pinned),
            excluded: Boolean(sidecar.worldSense?.excluded),
            selected: selectedByKey.has(key),
            score: Number(receiptItem?.score || 0),
            decision: receiptItem?.decision || '',
            reasons: receiptItem?.reasons || [],
            semanticScore: Number.isFinite(Number(semantic?.score)) ? Number(semantic.score) : null,
        };
    }).filter((entry) => {
        const searchable = normalize([entry.name, ...entry.keys, ...entry.secondaryKeys, entry.content].join(' '));
        if (needle && !searchable.includes(needle) && entry.semanticScore == null) return false;
        if (type !== 'all' && entry.entryType !== type) return false;
        if (status === 'selected' && !entry.selected) return false;
        if (status === 'suggested' && entry.decision !== 'suggested') return false;
        if (status === 'excluded' && !entry.excluded) return false;
        if (status === 'pinned' && !entry.pinned) return false;
        return true;
    }).sort((left, right) => {
        if (left.selected !== right.selected) return left.selected ? -1 : 1;
        if (left.semanticScore !== right.semanticScore) return (right.semanticScore ?? -1) - (left.semanticScore ?? -1);
        if (left.score !== right.score) return right.score - left.score;
        return left.name.localeCompare(right.name);
    });
}

export function describeWorldSenseReasons(reasons = []) {
    return reasons.map((reason) => {
        const label = String(reason.channel || 'evidence').replaceAll('.', ' ');
        if (reason.channel === 'semantic' && Number.isFinite(Number(reason.similarity))) return `${label} ${Math.round(Number(reason.similarity) * 100)}%`;
        return label;
    });
}

export function buildWorldSenseDryRun({ entries = [], metadata = [], receipt = null } = {}) {
    const entriesByKey = new Map(entries.map((entry) => [entryKey(entry), entry]));
    const metadataByKey = new Map(metadata.map((item) => [entryKey(item), item]));
    return {
        entries: (receipt?.selected || []).map((selection) => {
            const entry = entriesByKey.get(entryKey(selection));
            const sidecar = metadataByKey.get(entryKey(selection));
            if (!entry) return null;
            return {
                book: entry.book,
                uid: entry.uid,
                name: entry.name,
                revision: Number(sidecar?.revision || 1),
                content: entry.content,
                reasons: describeWorldSenseReasons(selection.reasons),
            };
        }).filter(Boolean),
        budget: receipt?.budget || null,
        degraded: Boolean(receipt?.degraded),
        degradeCause: String(receipt?.degradeCause || ''),
    };
}

export function proposalDiffRows(record = {}) {
    return (record.diff || []).map((item) => ({
        field: String(item.field || item.section || 'entry'),
        before: printable(item.before),
        after: printable(item.after),
    }));
}

function printable(value) {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    return JSON.stringify(value);
}

function entryKey(value) {
    const book = String(value?.book ?? value?.world ?? '').trim();
    const uid = String(value?.uid ?? '').trim();
    return book && uid ? `${book}.${uid}` : '';
}

function normalize(value) {
    return String(value || '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}
