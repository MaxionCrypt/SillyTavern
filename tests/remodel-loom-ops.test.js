import { parseLoomReply, readLoreOps } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-reconciliation.js';

test('readLoreOps normalizes edit and create ops from nested arguments', () => {
    const ops = readLoreOps([
        { id: 'o1', op: 'lore.edit', arguments: { book: 'TL', uid: '1', content: 'new' }, reason: 'r' },
        { id: 'o2', op: 'lore.create', arguments: { name: 'Silvia', keys: ['Silvia'], content: 'a mage' }, reason: 'r' },
    ]);
    expect(ops).toEqual([
        { op: 'lore.edit', book: 'TL', uid: '1', content: 'new' },
        { op: 'lore.create', name: 'Silvia', keys: ['Silvia'], secondaryKeys: [], content: 'a mage' },
    ]);
});

test('readLoreOps drops unknown ops and malformed edits/creates', () => {
    expect(readLoreOps([
        { op: 'lore.delete', arguments: { book: 'TL', uid: '1' } },
        { op: 'lore.edit', arguments: { book: 'TL', content: 'no uid' } },
        { op: 'lore.edit', arguments: { book: 'TL', uid: '1', content: '' } },
        { op: 'lore.create', arguments: { name: 'X', keys: [], content: 'no keys' } },
    ])).toEqual([]);
    expect(readLoreOps('x')).toEqual([]);
    expect(readLoreOps(null)).toEqual([]);
});

test('parseLoomReply surfaces loreOps from the fence', () => {
    const raw = ['```state', JSON.stringify({ requests: [], loreProposals: [], loreOps: [{ id: 'o1', op: 'lore.edit', arguments: { book: 'TL', uid: '1', content: 'edited' }, reason: 'r' }], flow: { continue: false } }), '```'].join('\n');
    expect(parseLoomReply(raw).loreOps).toEqual([{ op: 'lore.edit', book: 'TL', uid: '1', content: 'edited' }]);
});
