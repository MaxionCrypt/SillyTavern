import { addressRequestsByName } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { buildAddressBook, resolveByName } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-address.js';

const book = buildAddressBook([
    { id: 'var-hp', name: "Aiden's HP" },
    { id: 'var-heat', name: 'Faction Heat' },
    // Deliberately named like a synthetic positional ref, to prove name
    // resolution does not get short-circuited by one.
    { id: 'var-v1', name: 'v1' },
    { id: 'goal-survive', name: 'Survive the night' },
]);

test('a plain variableRef resolves to its advertised id', () => {
    const requests = [{ id: 'r1', capability: 'variable.adjust', arguments: { variableRef: "Aiden's HP", delta: -3 } }];
    const { variableRefs, unresolvedReasons } = addressRequestsByName(requests, book, new Map(), new Map());
    expect(variableRefs.get("Aiden's HP")).toBe('var-hp');
    expect(unresolvedReasons).toEqual([]);
});

test('a goalRef resolves into the goal map, not the variable map', () => {
    const requests = [{ id: 'r1', capability: 'goal.shift', arguments: { goalRef: 'Survive the night', direction: 'up', magnitude: 'minor' } }];
    const { variableRefs, goalRefs } = addressRequestsByName(requests, book, new Map(), new Map());
    expect(goalRefs.get('Survive the night')).toBe('goal-survive');
    expect(variableRefs.has('Survive the night')).toBe(false);
});

test('an unadvertised name resolves nothing and its reason is collected, not discarded', () => {
    const requests = [{ id: 'r1', capability: 'variable.adjust', arguments: { variableRef: 'Vitality', delta: 1 } }];
    const { variableRefs, unresolvedReasons } = addressRequestsByName(requests, book, new Map(), new Map());
    expect(variableRefs.has('Vitality')).toBe(false);
    expect(unresolvedReasons).toHaveLength(1);
    expect(unresolvedReasons[0]).toMatch(/not advertised/i);
});

test('a Variable literally named like a synthetic ref is not shadowed by an inherited key', () => {
    // The base map simulates the retrieval layer's own synthetic ref table,
    // where 'v1' already points at some other Variable entirely.
    const baseVariableRefs = new Map([['v1', 'var-someone-else']]);
    const requests = [{ id: 'r1', capability: 'variable.set', arguments: { variableRef: 'v1', value: 5 } }];
    const { variableRefs, unresolvedReasons } = addressRequestsByName(requests, book, baseVariableRefs, new Map());
    // A successful name resolution must win over whatever the key already
    // pointed to — otherwise the request silently lands on the wrong record.
    expect(variableRefs.get('v1')).toBe('var-v1');
    expect(unresolvedReasons).toEqual([]);
});

test('what retrieval advertised travels separately from what a request may address', () => {
    const baseVariableRefs = new Map([['v3', 'var-untouched'], ['v4', 'var-hp']]);
    const requests = [{ id: 'r1', capability: 'variable.adjust', arguments: { variableRef: "Aiden's HP", delta: 1 } }];
    const { variableRefs, retrievedVariableIds } = addressRequestsByName(requests, book, baseVariableRefs, new Map());
    // goal.reach's question — "was this tracked Variable retrieved this pass" —
    // is answered from here, so the whole retrieved set must survive.
    expect(retrievedVariableIds).toEqual(['var-untouched', 'var-hp']);
    // The address table answers a different question, and holds only what a
    // request actually named and resolved. Nothing else is in it at all.
    expect([...variableRefs.keys()]).toEqual(["Aiden's HP"]);
});

test('the address table contains name-resolved entries and nothing else', () => {
    const baseVariableRefs = new Map([['v1', 'var-hp'], ['v2', 'var-heat']]);
    const baseGoalRefs = new Map([['g1', 'goal-survive']]);
    // No request names anything, so nothing may be addressed — even though
    // retrieval advertised three records.
    const { variableRefs, goalRefs, retrievedVariableIds, retrievedGoalIds } =
        addressRequestsByName([], book, baseVariableRefs, baseGoalRefs);
    expect(variableRefs.size).toBe(0);
    expect(goalRefs.size).toBe(0);
    expect(retrievedVariableIds).toEqual(['var-hp', 'var-heat']);
    expect(retrievedGoalIds).toEqual(['goal-survive']);
});

// The residual the re-review demonstrated end to end: the previous fix moved
// the base entries under an unguessable placeholder key rather than removing
// them, so `.get('\0retrieved:0')` still hit a real id and still applied a
// write while the diagnostic reported the request refused. Unguessable is not
// unresolvable, and probability is not a validation boundary.
test('no synthetic placeholder key survives into the address table', () => {
    const baseVariableRefs = new Map([['v1', 'var-hp'], ['v2', 'var-heat']]);
    const probes = ['\0retrieved:0', '\0retrieved:1', ' retrieved:0', 'retrieved:0'];
    for (const probe of probes) {
        const { variableRefs, unresolvedReasons } = addressRequestsByName(
            [{ id: 'r1', capability: 'variable.adjust', arguments: { variableRef: probe, delta: -4 } }],
            book, baseVariableRefs, new Map(),
        );
        expect(variableRefs.get(probe)).toBeUndefined();
        expect(unresolvedReasons[0]).toMatch(/not advertised/i);
    }
    // Every key that IS present got there through resolveByName. Asserted as a
    // property of the whole table rather than as a list of rejected probes,
    // because the point is that there is no unguessed key left to try.
    const named = addressRequestsByName(
        [{ id: 'r1', capability: 'variable.adjust', arguments: { variableRef: "Aiden's HP", delta: -4 } }],
        book, baseVariableRefs, new Map(),
    );
    for (const key of named.variableRefs.keys()) {
        expect(resolveByName(book, key).ok).toBe(true);
    }
});

// Everything below is the regression surface for the whole-branch review's
// Critical 1: a ref-shaped string was neither a name nor rejected.
const plainBook = buildAddressBook([
    { id: 'var-hp', name: "Aiden's HP" },
    { id: 'goal-survive', name: 'Survive the night' },
]);

test('a ref-shaped name that names nothing resolves nothing, even when the base map has that key', () => {
    // Exactly the shape production hands in: the retrieval layer's refToId,
    // keyed v1…vN, plus a Loom that typed one of those refs back.
    const baseVariableRefs = new Map([['v1', 'var-hp']]);
    const requests = [{ id: 'r1', capability: 'variable.set', arguments: { variableRef: 'v1', value: 5 } }];
    const { variableRefs, unresolvedReasons } = addressRequestsByName(requests, plainBook, baseVariableRefs, new Map());
    expect(variableRefs.get('v1')).toBeUndefined();
    expect(unresolvedReasons).toHaveLength(1);
    expect(unresolvedReasons[0]).toMatch(/not advertised/i);
});

test('a positional goal ref is no longer a way around name resolution either', () => {
    const baseGoalRefs = new Map([['g1', 'goal-survive']]);
    const requests = [{ id: 'r1', capability: 'goal.close', arguments: { goalRef: 'g1', status: 'achieved' } }];
    const { goalRefs, unresolvedReasons } = addressRequestsByName(requests, plainBook, new Map(), baseGoalRefs);
    expect(goalRefs.get('g1')).toBeUndefined();
    expect(unresolvedReasons[0]).toMatch(/not advertised/i);
});

test('a duplicated name stays refused rather than reachable through its positional ref', () => {
    // design §3: "Duplicates are resolved by rejecting the request with a
    // diagnostic rather than guessing." buildAddressBook excludes both, so
    // resolveByName fails — but both records were still in the base map under
    // v1/v2, which made the protection cosmetic.
    const duplicated = buildAddressBook([
        { id: 'var-a', name: 'Resolve' },
        { id: 'var-b', name: 'Resolve' },
    ]);
    const baseVariableRefs = new Map([['v1', 'var-a'], ['v2', 'var-b']]);
    const requests = [
        { id: 'r1', capability: 'variable.adjust', arguments: { variableRef: 'Resolve', delta: 1 } },
        { id: 'r2', capability: 'variable.adjust', arguments: { variableRef: 'v1', delta: 1 } },
    ];
    const { variableRefs, unresolvedReasons } = addressRequestsByName(requests, duplicated, baseVariableRefs, new Map());
    expect(variableRefs.get('Resolve')).toBeUndefined();
    expect(variableRefs.get('v1')).toBeUndefined();
    expect(variableRefs.get('v2')).toBeUndefined();
    expect(unresolvedReasons[0]).toMatch(/more than one record/i);
});
