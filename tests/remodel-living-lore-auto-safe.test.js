import { classifyAutoSafeProposals, containsSensitiveMaterial } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-auto-safe.js';

function record(id, operation, confidence = 0.96, overrides = {}) {
    return {
        id, status: 'suggested', evidence: { source: 'accepted-prose' }, source: { directionId: 'd1' },
        proposal: { operation, confidence, target: { book: 'Book', uid: id }, value: `${id} value`, evidence: `${id} evidence` },
        ...overrides,
    };
}

test('auto-safe selects only allowlisted high-confidence accepted-fiction changes', () => {
    const result = classifyAutoSafeProposals([
        record('fact', 'fact.append'), record('retire', 'entry.retire'), record('weak', 'alias.add', 0.7),
    ], { mode: 'auto-safe', autoSafeOperations: ['fact.append', 'alias.add'], autoSafeConfidence: 0.9 });
    expect(result.eligible).toEqual([{ id: 'fact', reason: 'eligible' }]);
    expect(result.review).toEqual(expect.arrayContaining([{ id: 'retire', reason: 'operation-not-allowed' }, { id: 'weak', reason: 'below-confidence' }]));
});

test('owner drafts, untrusted evidence, secrets, and competing current states stay in review', () => {
    const first = record('current-a', 'current.set', 0.99, { proposal: { operation: 'current.set', confidence: 0.99, target: { book: 'Book', uid: 'same' }, value: 'Awake', evidence: 'Awake' } });
    const second = record('current-b', 'current.set', 0.99, { proposal: { operation: 'current.set', confidence: 0.99, target: { book: 'Book', uid: 'same' }, value: 'Asleep', evidence: 'Asleep' } });
    const result = classifyAutoSafeProposals([
        record('owner', 'fact.append', 0.99, { source: { authority: 'owner' } }),
        record('detached', 'fact.append', 0.99, { source: {} }),
        record('prompt', 'alias.add', 0.99, { evidence: { source: 'prompt-log' } }),
        record('secret', 'fact.append', 0.99, { proposal: { operation: 'fact.append', confidence: 0.99, target: { book: 'Book', uid: 'secret' }, value: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz', evidence: 'accepted' } }),
        first, second,
    ], { mode: 'auto-safe', autoSafeConfidence: 0.9 });
    expect(result.eligible).toEqual([]);
    expect(result.review.map((item) => item.reason)).toEqual(expect.arrayContaining(['owner-review', 'missing-accepted-boundary', 'untrusted-evidence', 'sensitive-material', 'ambiguous-current-state']));
});

test('sensitive material detector avoids ordinary fictional uses of password', () => {
    expect(containsSensitiveMaterial('The password was hidden in the old chapel.')).toBe(false);
    expect(containsSensitiveMaterial('api_key=abcdefghijklmnop123456')).toBe(true);
});
