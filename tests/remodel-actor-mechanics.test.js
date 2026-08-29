import { jest } from '@jest/globals';
import {
    ActorMechanicsRefusal,
    buildActorAdvertisement,
    isActorMechanicsEnabled,
    resolveActorAttempt,
    validateActorAttempt,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/actor-mechanics.js';

const GOALS = [
    { title: 'Marisol: covert watch on Piper', status: 'active', successRate: 30, holderRefs: [{ kind: 'character', id: 'marisol' }] },
    { title: 'Piper: reach the gate unseen', status: 'active', successRate: 55, holderRefs: [{ kind: 'character', id: 'piper' }] },
    { title: 'Marisol: old finished business', status: 'achieved', successRate: 90, holderRefs: [{ kind: 'character', id: 'marisol' }] },
];
const VARIABLES = [{ name: 'Piper trust' }];

const applied = (roll = 12, hit = true) => jest.fn(() => ({
    ok: true, transaction: { id: 'tx', status: 'applied' },
    receipts: [{ status: 'applied', roll: { roll, rate: 30, hit } }],
}));

const attempt = (overrides = {}) => resolveActorAttempt({
    actor: 'marisol', tool: 'goal.attempt', target: 'Marisol: covert watch on Piper',
    directionId: 'direction-1', goals: GOALS, variables: VARIABLES,
    timelineId: 't1', sceneId: 's1', listTransactions: () => [], execute: applied(),
    ...overrides,
});

test('the experiment is off unless a Scene opts in', () => {
    expect(isActorMechanicsEnabled(undefined)).toBe(false);
    expect(isActorMechanicsEnabled({ liveDirection: {} })).toBe(false);
    expect(isActorMechanicsEnabled({ liveDirection: { actorMechanics: 'yes' } })).toBe(false);
    expect(isActorMechanicsEnabled({ liveDirection: { actorMechanics: true } })).toBe(true);
});

test('an actor is advertised only the open Goals it holds', () => {
    const advertisement = buildActorAdvertisement({ actor: 'marisol', goals: GOALS, variables: VARIABLES });
    expect(advertisement.goalRefs).toEqual(['Marisol: covert watch on Piper']);
    expect(buildActorAdvertisement({ actor: 'piper', goals: GOALS }).goalRefs)
        .toEqual(['Piper: reach the gate unseen']);
});

test('an actor cannot attempt a Goal it does not hold', () => {
    const result = attempt({ target: 'Piper: reach the gate unseen' });
    expect(result).toMatchObject({ ok: false, refused: true, code: 'not-holder' });
});

test('an actor cannot attempt a Goal that is already closed', () => {
    expect(attempt({ target: 'Marisol: old finished business' })).toMatchObject({ refused: true, code: 'goal-closed' });
});

test('an unavailable object is refused rather than invented', () => {
    expect(attempt({ target: 'A Goal that does not exist' })).toMatchObject({ refused: true, code: 'unavailable-object' });
    expect(attempt({ tool: 'variable.adjust', target: 'No such Variable', value: 1 }))
        .toMatchObject({ refused: true, code: 'unavailable-object' });
});

test('an actor cannot act on an object it does not know', () => {
    const result = attempt({ knownRefs: ['Something else entirely'] });
    expect(result).toMatchObject({ refused: true, code: 'unknown-to-actor' });
});

test('a refusal never reaches the engine', () => {
    const execute = jest.fn();
    attempt({ target: 'Piper: reach the gate unseen', execute });
    expect(execute).not.toHaveBeenCalled();
});

test('a refusal is a narratable outcome, not a thrown fault', () => {
    expect(() => attempt({ actor: '' })).not.toThrow();
    expect(attempt({ actor: '' })).toMatchObject({ refused: true, code: 'no-actor' });
    expect(() => validateActorAttempt({ actor: '', tool: 'goal.attempt', target: 'x' })).toThrow(ActorMechanicsRefusal);
});

test('odds come from the store, never from the model', () => {
    const execute = applied();
    const result = attempt({ execute, odds: 99 });
    // An explicitly supplied odds value is honoured...
    expect(result.frozen.odds).toBe(99);
    // ...but the default is the Goal's own recorded rate, not a model guess.
    expect(attempt({ execute }).frozen.odds).toBe(30);
});

test('a permitted actor attempt reaches the engine through the frozen gateway', () => {
    const execute = applied(12, true);
    const result = attempt({ execute });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].requests[0]).toMatchObject({ capability: 'goal.reach' });
    expect(result).toMatchObject({ ok: true, refused: false });
    expect(result.receipt).toMatchObject({ actor: 'marisol', status: 'applied', outcome: 'hit' });
});

test('competing actors in one turn are independent attempts', () => {
    const execute = applied();
    const first = attempt({ execute });
    const second = resolveActorAttempt({
        actor: 'piper', tool: 'goal.attempt', target: 'Piper: reach the gate unseen',
        directionId: 'direction-1', goals: GOALS, variables: VARIABLES,
        timelineId: 't1', sceneId: 's1', listTransactions: () => [], execute,
    });
    expect(first.frozen.attemptKey).not.toBe(second.frozen.attemptKey);
    expect(second).toMatchObject({ ok: true, refused: false });
    expect(execute).toHaveBeenCalledTimes(2);
});

test('a duplicate request inside one turn applies once and replays its receipt', () => {
    const execute = applied();
    const prior = { status: 'applied', source: { attemptKey: 'direction-1:marisol:goal.attempt:Marisol: covert watch on Piper:0' }, receipts: [{ status: 'applied', roll: { roll: 5, hit: true } }] };
    const result = attempt({ execute, listTransactions: () => [prior] });
    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, reused: true });
});

test('a failed attempt is reported as a miss, not as an error', () => {
    const result = attempt({ execute: applied(88, false) });
    expect(result.ok).toBe(true);
    expect(result.receipt).toMatchObject({ status: 'applied', outcome: 'miss' });
});

test('modifiers travel frozen into the receipt', () => {
    const result = attempt({ execute: applied(), modifiers: ['cover', 'darkness'] });
    expect(result.frozen.modifiers).toEqual(['cover', 'darkness']);
    expect(result.receipt.frozen.modifiers).toEqual(['cover', 'darkness']);
});

test('a proposed value delta is carried for code to validate and apply once', () => {
    const execute = applied();
    const result = attempt({ tool: 'variable.adjust', target: 'Piper trust', value: -2, execute });
    expect(execute.mock.calls[0][0].requests[0]).toMatchObject({
        capability: 'variable.adjust', arguments: { variableRef: 'Piper trust', delta: -2 },
    });
    expect(result.refused).toBe(false);
});
