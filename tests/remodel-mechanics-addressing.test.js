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
    expect([...variableRefs.values()]).toEqual(expect.arrayContaining(['var-untouched', 'var-hp']));
});
