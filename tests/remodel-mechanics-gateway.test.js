import { jest } from '@jest/globals';
import {
    buildProviderToolDefinitions,
    MechanicsGatewayError,
    NARRATOR_MECHANIC_TOOLS,
    buildNarratorToolAdvertisement,
    findCommittedAttempt,
    freezeMechanicsAttempt,
    resolveMechanicsAttempt,
    toCompactReceipt,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-gateway.js';

const ADVERTISEMENT = buildNarratorToolAdvertisement({
    goals: [
        { title: 'Marisol: covert watch on Piper', status: 'active' },
        { title: 'Old finished business', status: 'achieved' },
    ],
    variables: [{ name: 'Piper trust' }],
});

const frozenAttempt = (overrides = {}) => freezeMechanicsAttempt({
    tool: 'goal.attempt',
    actor: 'marisol',
    target: 'Marisol: covert watch on Piper',
    stakes: 'discovery',
    directionId: 'direction-1',
    advertisement: ADVERTISEMENT,
    odds: 30,
    ...overrides,
});

test('the advertised vocabulary is bounded and excludes terminal Goals', () => {
    expect(NARRATOR_MECHANIC_TOOLS).toEqual(['goal.attempt', 'goal.adjust', 'variable.adjust', 'mechanic.check']);
    expect(ADVERTISEMENT.goalRefs).toEqual(['Marisol: covert watch on Piper']);
    expect(ADVERTISEMENT.variableRefs).toEqual(['Piper trust']);
    expect(ADVERTISEMENT.tools.map((tool) => tool.capability))
        .toEqual(['goal.reach', 'goal.edit', 'variable.adjust', null]);
});

test('a tool outside the bounded vocabulary is refused before anything freezes', () => {
    expect(() => freezeMechanicsAttempt({ tool: 'goal.create', actor: 'a', target: 'b', directionId: 'd' }))
        .toThrow(MechanicsGatewayError);
});

test('an unadvertised target is refused before anything freezes', () => {
    expect(() => frozenAttempt({ target: 'A Goal nobody advertised' }))
        .toThrow('was not advertised this turn');
});

test('actor, target and directionId are all required to freeze an attempt', () => {
    expect(() => frozenAttempt({ actor: '  ' })).toThrow('an actor is required');
    expect(() => frozenAttempt({ target: '' })).toThrow('a target is required');
    expect(() => frozenAttempt({ directionId: '' })).toThrow('exactly-once');
});

test('the attempt key is stable for one attempt and distinct across attempts in a turn', () => {
    expect(frozenAttempt().attemptKey).toBe(frozenAttempt().attemptKey);
    expect(frozenAttempt({ attemptIndex: 1 }).attemptKey).not.toBe(frozenAttempt({ attemptIndex: 0 }).attemptKey);
    expect(frozenAttempt({ actor: 'piper' }).attemptKey).not.toBe(frozenAttempt().attemptKey);
});

test('a frozen attempt cannot be edited after the fact', () => {
    const frozen = frozenAttempt();
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(() => { 'use strict'; frozen.odds = 99; }).toThrow();
});

test('goal.attempt reaches the engine with the advertised ref and carries its attempt key', () => {
    const execute = jest.fn(() => ({ ok: true, transaction: { id: 'tx-1', status: 'applied' }, receipts: [{ status: 'applied', roll: { roll: 12, rate: 30, hit: true } }] }));
    const result = resolveMechanicsAttempt(frozenAttempt(), {
        timelineId: 'timeline-1', sceneId: 'scene-1', execute, listTransactions: () => [],
    });

    expect(execute).toHaveBeenCalledTimes(1);
    const [envelope, context] = execute.mock.calls[0];
    expect(envelope.requests[0]).toMatchObject({ capability: 'goal.reach', arguments: { goalRef: 'Marisol: covert watch on Piper' } });
    expect(context.source).toMatchObject({ attemptKey: frozenAttempt().attemptKey, actor: 'marisol', tool: 'goal.attempt' });
    expect(result).toMatchObject({ ok: true, reused: false });
    expect(result.receipt).toMatchObject({ status: 'applied', outcome: 'hit', roll: { roll: 12, hit: true } });
});

test('a committed attempt is replayed instead of applying its numbers twice', () => {
    const execute = jest.fn();
    const prior = {
        status: 'applied',
        source: { attemptKey: frozenAttempt().attemptKey },
        receipts: [{ status: 'applied', roll: { roll: 7, rate: 30, hit: true } }],
    };
    const result = resolveMechanicsAttempt(frozenAttempt(), {
        timelineId: 'timeline-1', sceneId: 'scene-1', execute, listTransactions: () => [prior],
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, reused: true });
    expect(result.receipt.status).toBe('applied');
});

test('only an applied transaction counts as already committed', () => {
    const rolledBack = { status: 'rolled-back', source: { attemptKey: frozenAttempt().attemptKey }, receipts: [] };
    expect(findCommittedAttempt(frozenAttempt().attemptKey, { listTransactions: () => [rolledBack] })).toBeNull();

    const execute = jest.fn(() => ({ ok: true, transaction: {}, receipts: [{ status: 'applied' }] }));
    resolveMechanicsAttempt(frozenAttempt(), { execute, listTransactions: () => [rolledBack] });
    expect(execute).toHaveBeenCalledTimes(1);
});

test('mechanic.check calculates without ever reaching a write path', () => {
    const execute = jest.fn();
    const frozen = freezeMechanicsAttempt({
        tool: 'mechanic.check', actor: 'marisol', target: 'Piper trust',
        directionId: 'direction-1', odds: 40,
    });
    const result = resolveMechanicsAttempt(frozen, { execute, listTransactions: () => [], random: () => 0.10 });

    expect(execute).not.toHaveBeenCalled();
    expect(result.transaction).toBeNull();
    expect(result.receipt.roll).toMatchObject({ roll: 11, rate: 40, hit: true });
});

test('the code owns the die: the same frozen inputs and generator give the same result', () => {
    const frozen = freezeMechanicsAttempt({ tool: 'mechanic.check', actor: 'a', target: 't', directionId: 'd', odds: 50 });
    const once = resolveMechanicsAttempt(frozen, { listTransactions: () => [], random: () => 0.99 });
    const twice = resolveMechanicsAttempt(frozen, { listTransactions: () => [], random: () => 0.99 });
    expect(once.receipt.roll).toEqual(twice.receipt.roll);
    expect(once.receipt.roll.hit).toBe(false);
});

test('the compact receipt carries the frozen inputs and never the raw store state', () => {
    const receipt = toCompactReceipt(frozenAttempt(), {
        status: 'applied',
        roll: { roll: 3, hit: true },
        before: { entire: 'goal object' },
        after: { entire: 'goal object' },
    });
    expect(receipt).toMatchObject({ status: 'applied', frozen: { odds: 30, stakes: 'discovery' } });
    expect(receipt.before).toBeUndefined();
    expect(receipt.after).toBeUndefined();
});

test('a rejected engine result surfaces its reason rather than inventing an outcome', () => {
    const execute = jest.fn(() => ({ ok: false, transaction: { status: 'rolled-back' }, receipts: [], errors: ['A Timeline is required.'] }));
    const result = resolveMechanicsAttempt(frozenAttempt(), { execute, listTransactions: () => [] });
    expect(result.ok).toBe(false);
    expect(result.receipt).toMatchObject({ status: 'rejected', outcome: null, rejectionReason: 'A Timeline is required.' });
});

// --- provider tool definitions: the model must be OFFERED a verb to use it ---

test('tool definitions are provider-shaped and cover the bounded vocabulary', () => {
    const tools = buildProviderToolDefinitions();
    expect(tools.map((tool) => tool.function.name)).toEqual([...NARRATOR_MECHANIC_TOOLS]);
    for (const tool of tools) {
        expect(tool.type).toBe('function');
        expect(tool.function.description).toBeTruthy();
        expect(tool.function.parameters.required).toContain('actor');
        expect(tool.function.parameters.required).toContain('target');
    }
});

test('a value-changing verb requires a value; an attempt does not', () => {
    const byName = Object.fromEntries(buildProviderToolDefinitions().map((tool) => [tool.function.name, tool.function]));
    expect(byName['variable.adjust'].parameters.required).toContain('value');
    expect(byName['goal.adjust'].parameters.required).toContain('value');
    expect(byName['goal.attempt'].parameters.required).not.toContain('value');
    expect(byName['mechanic.check'].parameters.required).not.toContain('value');
});

test('only advertised verbs are offered, and nothing outside the vocabulary', () => {
    expect(buildProviderToolDefinitions(['goal.attempt']).map((tool) => tool.function.name)).toEqual(['goal.attempt']);
    expect(buildProviderToolDefinitions(['goal.delete', 'sudo'])).toEqual([]);
    expect(buildProviderToolDefinitions([])).toEqual([]);
});
