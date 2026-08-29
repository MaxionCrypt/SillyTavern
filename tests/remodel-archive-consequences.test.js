import { jest } from '@jest/globals';
import {
    ARCHIVE_CONSEQUENCE_CHANNELS,
    ARCHIVE_SETTLEMENT_PROTOCOL,
    ARCHIVE_SETTLEMENT_TYPE,
    createArchiveConsequenceDispatcher,
    createArchiveSettlementEvent,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archive-consequences.js';

function settlement(overrides = {}) {
    return createArchiveSettlementEvent({
        jobId: 'archive:turn-1',
        timelineId: 'timeline-1',
        sceneId: 'scene-1',
        mode: 'roleplay',
        acceptedProse: 'Mara opened the gate.',
        provenance: { sourceId: 'turn-1', checkpointId: 'accepted' },
        operations: [{ capability: 'event.record', arguments: { summary: 'Mara opened the gate.' } }],
        archiveFacts: ['Mara opened the gate.'],
        ingestionReceipt: { fenceParsed: true },
        transactionId: 'transaction-1',
        ...overrides,
    }, () => 42);
}

test('settlement events freeze canonical evidence and explicit authority boundaries', () => {
    const event = settlement();
    expect(event).toMatchObject({
        protocol: ARCHIVE_SETTLEMENT_PROTOCOL,
        type: ARCHIVE_SETTLEMENT_TYPE,
        eventId: 'archive-settlement:archive:turn-1',
        committedAt: 42,
        projection: { routeSnapshot: {}, recipeId: '' },
        baseArchive: { status: 'applied', transactionId: 'transaction-1' },
        authority: { acceptedProse: 'canonical', baseArchive: 'committed', consequences: 'projection-only' },
        rollback: { subscriberMayRollbackBaseArchive: false },
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.evidence.operations)).toBe(true);
});

test('all Timeline consequence channels remain disabled by default', async () => {
    const subscribers = Object.fromEntries(ARCHIVE_CONSEQUENCE_CHANNELS.map((channel) => [channel, jest.fn()]));
    const dispatcher = createArchiveConsequenceDispatcher();
    for (const [channel, subscriber] of Object.entries(subscribers)) dispatcher.subscribe(channel, subscriber);
    const receipt = await dispatcher.publish(settlement());
    expect(Object.values(receipt.deliveries).map((item) => item.status)).toEqual(ARCHIVE_CONSEQUENCE_CHANNELS.map(() => 'disabled'));
    for (const subscriber of Object.values(subscribers)) expect(subscriber).not.toHaveBeenCalled();
});

test('enabled subscribers run independently and receive the same immutable event', async () => {
    const goals = jest.fn(async (event) => ({ eventId: event.eventId, projectionId: 'goals-1' }));
    const continuity = jest.fn(async () => ({ projectionId: 'continuity-1' }));
    const dispatcher = createArchiveConsequenceDispatcher();
    dispatcher.subscribe('goals', goals, { enabled: true });
    dispatcher.subscribe('continuity', continuity, { enabled: true });
    const event = settlement();
    const receipt = await dispatcher.publish(event);
    expect(goals).toHaveBeenCalledWith(event);
    expect(continuity).toHaveBeenCalledWith(event);
    expect(receipt.deliveries.goals).toMatchObject({ status: 'applied', receipt: { projectionId: 'goals-1' } });
    expect(receipt.deliveries.variables.status).toBe('disabled');
});

test('one failed subscriber cannot fail another subscriber or the committed Archive receipt', async () => {
    const errors = [];
    const dispatcher = createArchiveConsequenceDispatcher({ onError: (error, context) => errors.push([error.message, context.channel]) });
    dispatcher.subscribe('goals', async () => { throw new Error('goal projection failed'); }, { enabled: true });
    dispatcher.subscribe('variables', async () => ({ transactionId: 'variables-1' }), { enabled: true });
    const receipt = await dispatcher.publish(settlement());
    expect(receipt.baseArchiveStatus).toBe('applied');
    expect(receipt.deliveries.goals).toMatchObject({ status: 'failed', error: { message: 'goal projection failed' } });
    expect(receipt.deliveries.variables).toMatchObject({ status: 'applied', receipt: { transactionId: 'variables-1' } });
    expect(errors).toEqual([['goal projection failed', 'goals']]);
});

test('delivery ids make duplicate publication exact-once within one runtime', async () => {
    const goals = jest.fn(async () => ({ projectionId: 'goals-1' }));
    const dispatcher = createArchiveConsequenceDispatcher();
    dispatcher.subscribe('goals', goals, { enabled: true });
    const event = settlement();
    const [first, duplicate] = await Promise.all([dispatcher.publish(event), dispatcher.publish(event)]);
    expect(goals).toHaveBeenCalledTimes(1);
    expect(duplicate.deliveries.goals).toEqual(first.deliveries.goals);
});

test('a successful no-op Archive still settles but grants no rollback authority', () => {
    const event = settlement({ operations: [], transactionId: null });
    expect(event.baseArchive).toEqual({ status: 'no-op', transactionId: null });
    expect(event.rollback).toEqual({ baseArchiveOwnedBy: 'none', subscriberMayRollbackBaseArchive: false });
});
