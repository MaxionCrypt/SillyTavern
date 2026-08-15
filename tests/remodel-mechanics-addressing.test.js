import { addressRequestsByName } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { buildAddressBook } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-address.js';

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

test('a nested resolution.variableRef resolves — goal.create with a tracked resolution', () => {
    const requests = [{
        id: 'r1', capability: 'goal.create',
        arguments: { title: 'Win the duel', resolution: { kind: 'tracked', variableRef: 'Faction Heat', completionThreshold: 100 } },
    }];
    const { variableRefs, unresolvedReasons } = addressRequestsByName(requests, book, new Map(), new Map());
    expect(variableRefs.get('Faction Heat')).toBe('var-heat');
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

test('the base map is preserved for goal.reach\'s "was this retrieved" check, not replaced', () => {
    const baseVariableRefs = new Map([['v3', 'var-untouched']]);
    const requests = [{ id: 'r1', capability: 'variable.adjust', arguments: { variableRef: "Aiden's HP", delta: 1 } }];
    const { variableRefs } = addressRequestsByName(requests, book, baseVariableRefs, new Map());
    // goal.reach reads exactly two things off this Map — `.size` and
    // `.values()` (mechanics-capabilities.js:392-396). Both must survive.
    expect(variableRefs.size).toBe(2);
    expect([...variableRefs.values()]).toEqual(expect.arrayContaining(['var-untouched', 'var-hp']));
    // ...but the retrieval layer's own positional key must NOT be a second,
    // unvalidated way in. It was: `resolveVariableReference` does
    // `runtime.variableRefs.get(ref)`, so an inherited 'v3' answered.
    expect(variableRefs.get('v3')).toBeUndefined();
});

// Everything below is the regression surface for the whole-branch review's
// Critical 1: a ref-shaped string was neither a name nor rejected.
const plainBook = buildAddressBook([
    { id: 'var-hp', name: "Aiden's HP" },
    { id: 'goal-survive', name: 'Survive the night' },
]);

test('a ref-shaped name that names nothing resolves nothing, even when the base map has that key', () => {
    // Exactly the shape production hands in: the retrieval layer's refToId,
    // keyed v1…vN, plus a Director that typed one of those refs back.
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
