export const AUTO_SAFE_OPERATIONS = Object.freeze(['fact.append', 'alias.add', 'entry.link', 'current.set']);

/** Pure policy: classify suggestions without reading settings or saving lore. */
export function classifyAutoSafeProposals(records = [], profile = {}) {
    const enabled = profile.mode === 'auto-safe';
    const allowlist = new Set((profile.autoSafeOperations || AUTO_SAFE_OPERATIONS).filter((item) => AUTO_SAFE_OPERATIONS.includes(item)));
    const threshold = clamp(Number(profile.autoSafeConfidence), 0, 1, 0.92);
    const eligible = [];
    const review = [];
    const currentTargets = new Map();

    for (const record of records || []) {
        const proposal = record?.proposal || {};
        let reason = '';
        if (!enabled) reason = 'mode-disabled';
        else if (record?.status !== 'suggested') reason = 'not-suggested';
        else if (record?.source?.authority === 'owner') reason = 'owner-review';
        else if (!String(record?.source?.directionId || '').trim()) reason = 'missing-accepted-boundary';
        else if (!allowlist.has(proposal.operation)) reason = 'operation-not-allowed';
        else if (Number(proposal.confidence) < threshold) reason = 'below-confidence';
        else if (!['accepted-prose', 'archive'].includes(record?.evidence?.source)) reason = 'untrusted-evidence';
        else if (containsSensitiveMaterial(proposal.value) || containsSensitiveMaterial(proposal.evidence)) reason = 'sensitive-material';

        if (!reason && proposal.operation === 'current.set') {
            const target = `${proposal.target?.book}.${proposal.target?.uid}`;
            if (currentTargets.has(target)) {
                reason = 'ambiguous-current-state';
                const previous = eligible.findIndex((item) => item.id === currentTargets.get(target));
                if (previous >= 0) review.push({ ...eligible.splice(previous, 1)[0], reason });
            } else currentTargets.set(target, record.id);
        }
        if (reason) review.push({ id: record?.id || '', reason });
        else eligible.push({ id: record.id, reason: 'eligible' });
    }
    return { eligible, review, threshold, allowlist: [...allowlist] };
}

export function containsSensitiveMaterial(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    return [
        /\bsk-[a-z0-9_-]{16,}\b/i,
        /\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret)\s*[:=]\s*["']?[a-z0-9_./+=-]{12,}/i,
        /\bauthorization\s*:\s*bearer\s+[a-z0-9_./+=-]{12,}/i,
        /<\|(?:system|assistant|developer)\|>/i,
    ].some((pattern) => pattern.test(text));
}

function clamp(value, minimum, maximum, fallback) { return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback; }
