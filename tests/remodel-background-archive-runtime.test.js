import { expect, jest, test } from '@jest/globals';
import { createArchiveIngestion } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archive-ingestion.js';
import { createArchiveJobRepository, createMemoryArchiveJobPersistence } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archive-job-store.js';
import { createBackgroundArchiveRuntime } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/background-archive-runtime.js';
import { legacyArchiveIngestionAdapter } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/legacy-archive-ingestion-adapter.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

function job(overrides = {}) {
    return {
        mode: 'roleplay', timelineId: 'timeline-1', sceneId: 'scene-1', acceptedProse: 'Mara opened the gate.',
        provenance: { kind: 'current-turn', sourceId: 'turn-1', checkpointId: 'accepted', messageId: 4 },
        archiveContext: 'gate: closed', currentPlayerAction: 'I ask Mara to open it.',
        routeSnapshot: { role: 'loom', profileId: 'loom-a', profileName: 'Loom A' },
        promptSnapshot: { recipeId: 'recipe-1', recipeName: 'Archive', revision: 1, messages: [{ role: 'user', content: 'Mara opened the gate.' }] },
        ...overrides,
    };
}

function fence(requests) {
    return `\`\`\`state\n${JSON.stringify({ requests, swaps: [{ find: 'x', replace: 'y' }], loreProposals: [{ value: 'forbidden' }] })}\n\`\`\``;
}

function harness({ transport, commit, persistence } = {}) {
    const tasks = [];
    const repository = createArchiveJobRepository({ persistence: persistence || createMemoryArchiveJobPersistence() });
    const runtime = createBackgroundArchiveRuntime({
        repository,
        transport: transport || (async () => fence([{ id: 'e1', capability: 'event.record', arguments: { summary: 'Mara opened the gate.' } }])),
        ingestion: createArchiveIngestion(legacyArchiveIngestionAdapter),
        commit: commit || jest.fn(async () => ({ transactionId: 'tx-1' })),
        schedule: (task) => { tasks.push(task); }, retryDelayMs: 0,
    });
    return { runtime, repository, tasks, runScheduled: async () => { while (tasks.length) await tasks.shift()(); } };
}

test('enqueue is immediate and Archive transport begins only in the background', async () => {
    __setExtensionSettings({ remodel: {} });
    let release;
    const transport = jest.fn(() => new Promise((resolve) => { release = resolve; }));
    const { runtime, tasks } = harness({ transport });

    const queued = runtime.enqueue(job());
    expect(queued.status).toBe('pending');
    expect(transport).not.toHaveBeenCalled();
    expect(runtime.status('timeline-1').label).toBe('Archive queued');

    const work = tasks.shift()();
    await Promise.resolve();
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ routeSnapshot: expect.objectContaining({ profileId: 'loom-a' }) }));
    release(fence([{ id: 'e1', capability: 'event.record', arguments: { summary: 'Mara opened the gate.' } }]));
    await work;
    expect(runtime.status('timeline-1').status).toBe('idle');
});

test('each accepted turn freezes its assigned Loom profile before profiles change', async () => {
    __setExtensionSettings({ remodel: {} });
    const seen = [];
    const { runtime, runScheduled } = harness({ transport: async ({ routeSnapshot }) => {
        seen.push(routeSnapshot.profileId);
        return fence([]);
    } });
    runtime.enqueue(job());
    runtime.enqueue(job({
        acceptedProse: 'Mara crossed the gate.',
        provenance: { kind: 'current-turn', sourceId: 'turn-2', checkpointId: 'accepted', messageId: 5 },
        routeSnapshot: { role: 'loom', profileId: 'loom-b', profileName: 'Loom B' },
    }));
    await runScheduled();
    expect(seen).toEqual(['loom-a', 'loom-b']);
});

test('the background boundary separates Archive operations from bounded lifecycle proposals', async () => {
    __setExtensionSettings({ remodel: {} });
    const commit = jest.fn(async () => ({ transactionId: 'tx-1' }));
    const { runtime, runScheduled } = harness({
        commit,
        transport: async () => fence([
            { id: 'e1', capability: 'event.record', arguments: { summary: 'Mara opened the gate.' } },
            { id: 'g1', capability: 'goal.create', arguments: { title: 'Open the gate', description: 'Get the gate open.' }, reason: 'Mara is trying to open it.' },
            { id: 'v1', capability: 'variable.set', arguments: { variableRef: 'x', value: 2 } },
        ]),
    });
    runtime.enqueue(job());
    await runScheduled();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0].operations).toEqual([
        expect.objectContaining({ capability: 'event.record' }),
    ]);
    expect(commit.mock.calls[0][0].lifecycleProposals).toEqual([
        expect.objectContaining({ id: 'g1', capability: 'goal.create' }),
    ]);
    expect(commit.mock.calls[0][0]).toMatchObject({
        routeSnapshot: { profileId: 'loom-a' },
        recipeId: 'recipe-1',
    });
});

test('reload recovery resumes an interrupted job exactly once', async () => {
    __setExtensionSettings({ remodel: {} });
    const persistence = createMemoryArchiveJobPersistence();
    const first = harness({ persistence });
    const queued = first.runtime.enqueue(job());
    first.repository.update(queued.jobId, { status: 'running' });

    const commit = jest.fn(async () => ({ transactionId: 'tx-recovered' }));
    const second = harness({ persistence, commit });
    expect(second.runtime.recover()).toEqual([queued.jobId]);
    await second.runScheduled();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(second.runtime.get(queued.jobId).status).toBe('succeeded');
});

test('a failed job exposes attention and manual retry without losing its snapshot', async () => {
    __setExtensionSettings({ remodel: {} });
    let fail = true;
    const { runtime, runScheduled } = harness({ transport: async () => {
        if (fail) throw new Error('temporary provider failure');
        return fence([]);
    } });
    runtime.enqueue(job());
    await runScheduled();
    expect(runtime.status('timeline-1')).toMatchObject({ status: 'failed', repairAction: 'retry' });
    fail = false;
    runtime.retry(runtime.status('timeline-1').jobId);
    await runScheduled();
    expect(runtime.status('timeline-1').status).toBe('idle');
});
