import { buildAddressBook, resolveByName } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-address.js';

const items = [
    { id: 'var-1', name: "Aiden's HP" },
    { id: 'var-2', name: 'Faction Heat' },
];

test('resolves an exact name to its id', () => {
    const book = buildAddressBook(items);
    expect(resolveByName(book, "Aiden's HP")).toEqual({ ok: true, id: 'var-1' });
});

test('ignores case and surrounding whitespace', () => {
    const book = buildAddressBook(items);
    expect(resolveByName(book, "  aiden's hp ")).toEqual({ ok: true, id: 'var-1' });
});

test('rejects a name that was not advertised', () => {
    const book = buildAddressBook(items);
    const result = resolveByName(book, 'Vitality');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not advertised/i);
});

test('a duplicated name is unusable rather than ambiguous', () => {
    const book = buildAddressBook([...items, { id: 'var-3', name: "Aiden's HP" }]);
    expect(book.duplicates).toContain("Aiden's HP");
    const result = resolveByName(book, "Aiden's HP");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/more than one/i);
});

test('an empty name is rejected without throwing', () => {
    const book = buildAddressBook(items);
    expect(resolveByName(book, '').ok).toBe(false);
    expect(resolveByName(book, undefined).ok).toBe(false);
});

test('an empty book rejects everything', () => {
    const book = buildAddressBook([]);
    expect(book.entries).toEqual([]);
    expect(resolveByName(book, 'anything').ok).toBe(false);
});
