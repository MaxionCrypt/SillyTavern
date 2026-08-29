import { describe, expect, jest, test } from '@jest/globals';
import { createArchiveIngestion } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archive-ingestion.js';
import { legacyArchiveIngestionAdapter } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/legacy-archive-ingestion-adapter.js';
import {
    ARCHIVE_JOB_MAX_PER_TIMELINE,
    ARCHIVE_JOB_STATUS,
    createArchiveJobRepository,
    createMemoryArchiveJobPersistence,
    describeArchiveWorkerStatus,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archive-job-store.js';
import { ArchiveWorkerPermanentError, createArchiveWorker } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archive-worker.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

function stateReply(summary = 'The gate opened.') {
    return `\`\`\`state\n${JSON.stringify({
        swaps: [],
        requests: [{ id: 'event-1', capability: 'event.record', arguments: { summary }, reason: 'accepted prose' }],
        flow: { continue: false },
    })}\n\`\`\``;
}

function job(overrides = {}) {
    return {
        mode: 'roleplay',
        timelineId: 'timeline-1',
        sceneId: 'scene-1',
        acceptedProse: 'The gate opened.',
        provenance: {
            kind: 'current-turn', sourceId: 'direction-1', checkpointId: 'accepted', messageId: 4, interrupted: false,
        },
        archiveContext: 'Location: the north gate.',
        currentPlayerAction: 'I open the gate.',
        routeSnapshot: { role: 'loom', profileId: 'loom-profile', profileName: 'Loom', api: 'chat', model: 'model-a' },
        promptSnapshot: {
            recipeId: 'loom-recipe', recipeName: 'Loom Archive', revision: 3,
            messages: [
                { role: 'system', content: 'Record accepted fiction as Archive operations.' },
                { role: 'user', content: 'The gate opened.' },
            ],
        },
        ...overrides,
    };
}

function harness(options = {}) {
    let clock = options.now ?? 1000;
    const persistence = options.persistence || createMemoryArchiveJobPersistence();
    const repository = createArchiveJobRepository({ persistence, now: () => clock });
    const commit = options.commit || jest.fn(async ({ jobId, operations }) => ({ transactionId: `tx:${jobId}`, count: operations.length }));
    const worker = createArchiveWorker({
        repository,
        transport: options.transport || (async () => ({ text: stateReply(), reasoning: '', streamed: false })),
        ingestion: options.ingestion || createArchiveIngestion(legacyArchiveIngestionAdapter),
        commit,
        now: () => clock,
        retryDelayMs: options.retryDelayMs ?? 0,
        timeoutMs: options.timeoutMs ?? 1000,
        maxAttempts: options.maxAttempts ?? 3,
    });
    return { worker, repository, persistence, commit, setNow: (value) => { clock = value; } };
}

test('jobs snapshot only bounded Archive input, the Loom route, and the compiled recipe', () => {
    const { worker } = harness();
    const input = job({ wholeChat: ['must not persist'], worldSense: { mustNotPersist: true } });
    const queued = worker.enqueue(input);

    input.acceptedProse = 'mutated';
    input.routeSnapshot.profileId = 'different-profile';
    input.promptSnapshot.messages[0].content = 'mutated recipe';

    expect(queued.status).toBe(ARCHIVE_JOB_STATUS.PENDING);
    expect(queued.acceptedProse).toBe('The gate opened.');
    expect(queued.routeSnapshot.profileId).toBe('loom-profile');
    expect(queued.promptSnapshot.messages[0].content).toContain('Record accepted fiction');
    expect(queued).not.toHaveProperty('wholeChat');
    expect(queued).not.toHaveProperty('worldSense');
    expect(Object.isFrozen(queued)).toBe(true);
    expect(Object.isFrozen(queued.promptSnapshot.messages)).toBe(true);
});

test('exact-once identity survives reload and commits one validated Archive transaction', async () => {
    const first = harness();
    const queued = first.worker.enqueue(job());
    expect(first.worker.enqueue(job()).jobId).toBe(queued.jobId);

    const reloaded = harness({ persistence: first.persistence, commit: first.commit });
    const result = await reloaded.worker.runNext('timeline-1');
    expect(result.status).toBe(ARCHIVE_JOB_STATUS.SUCCEEDED);
    expect(result.result.operations).toEqual([expect.objectContaining({ capability: 'event.record' })]);
    expect(first.commit).toHaveBeenCalledTimes(1);
    expect(await reloaded.worker.runNext('timeline-1')).toBeNull();
    expect(reloaded.worker.get(queued.jobId)).toMatchObject({
        acceptedProse: '', archiveContext: '', currentPlayerAction: '',
        promptSnapshot: { messages: [], messageCount: 2 },
    });
    expect(reloaded.worker.get(queued.jobId).acceptedProseHash).toMatch(/^[a-f0-9]{8}$/);
    expect(reloaded.worker.get(queued.jobId).promptSnapshot.contentHash).toMatch(/^[a-f0-9]{8}$/);
});

test('a bounded extra request closer is repaired locally instead of spending another Archive attempt', async () => {
    const malformed = '```state\n{"requests":[{"id":"event-1","capability":"event.record","arguments":{"summary":"The gate opened."},"reason":"accepted"}},{"id":"beat-1","capability":"beat.set","arguments":{"directive":"Someone tests the gate."},"reason":"open"}}]}\n```';
    const transport = jest.fn(async () => malformed);
    const { worker, commit } = harness({ transport });
    const queued = worker.enqueue(job());

    const result = await worker.runNext('timeline-1');

    expect(result).toMatchObject({ jobId: queued.jobId, status: ARCHIVE_JOB_STATUS.SUCCEEDED, attempts: 1 });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
        operations: [
            expect.objectContaining({ id: 'event-1', capability: 'event.record' }),
            expect.objectContaining({ id: 'beat-1', capability: 'beat.set' }),
        ],
    }));
});

test('the default repository persists jobs through Remodel extension settings', () => {
    __setExtensionSettings({ remodel: {} });
    const first = createArchiveJobRepository({ now: () => 1000 });
    const queued = first.enqueue(job());
    const reloaded = createArchiveJobRepository({ now: () => 2000 });

    expect(reloaded.get(queued.jobId)).toMatchObject({
        jobId: queued.jobId, timelineId: 'timeline-1', routeSnapshot: { profileId: 'loom-profile' },
    });
});

test('completed job history is bounded without discarding queued work', () => {
    const { repository } = harness();
    for (let index = 0; index < ARCHIVE_JOB_MAX_PER_TIMELINE + 5; index += 1) {
        const queued = repository.enqueue(job({
            acceptedProse: `Accepted passage ${index}.`,
            provenance: { ...job().provenance, sourceId: `source-${index}` },
        }));
        repository.update(queued.jobId, { status: ARCHIVE_JOB_STATUS.SUCCEEDED });
    }
    const pending = repository.enqueue(job({
        acceptedProse: 'Still waiting.', provenance: { ...job().provenance, sourceId: 'pending-source' },
    }));

    expect(repository.list('timeline-1')).toHaveLength(ARCHIVE_JOB_MAX_PER_TIMELINE);
    expect(repository.get(pending.jobId)?.status).toBe(ARCHIVE_JOB_STATUS.PENDING);
});

test('each Timeline runs in order while unrelated Timelines have independent queues', async () => {
    const seen = [];
    const { worker } = harness({
        transport: async ({ job }) => {
            seen.push(`${job.timelineId}:${job.provenance.sourceId}`);
            return stateReply(job.acceptedProse);
        },
    });
    worker.enqueue(job({ acceptedProse: 'First.', provenance: { ...job().provenance, sourceId: 'first' } }));
    worker.enqueue(job({ acceptedProse: 'Second.', provenance: { ...job().provenance, sourceId: 'second' } }));
    worker.enqueue(job({ timelineId: 'timeline-2', sceneId: 'scene-2', acceptedProse: 'Other.', provenance: { ...job().provenance, sourceId: 'other' } }));

    await worker.drain('timeline-1');
    await worker.drain('timeline-2');
    expect(seen).toEqual(['timeline-1:first', 'timeline-1:second', 'timeline-2:other']);
});

describe.each([
    ['empty', async () => ({ text: '', reasoning: '' })],
    ['reasoning-only', async () => ({ text: '', reasoning: 'private analysis' })],
    ['malformed', async () => ({ text: 'not a state fence', reasoning: '' })],
    ['provider error', async () => { throw new Error('service unavailable'); }],
])('%s responses', (_label, transport) => {
    test('retry within bounds, then become repairable without claiming success', async () => {
        const { worker, commit } = harness({ transport, maxAttempts: 2 });
        const queued = worker.enqueue(job());

        const retrying = await worker.runNext('timeline-1');
        expect(retrying).toMatchObject({ jobId: queued.jobId, status: ARCHIVE_JOB_STATUS.RETRYING, attempts: 1 });
        expect(describeArchiveWorkerStatus(worker.list('timeline-1')).label).toBe('Archive retrying');

        const failed = await worker.runNext('timeline-1');
        expect(failed).toMatchObject({ status: ARCHIVE_JOB_STATUS.FAILED_REPAIRABLE, attempts: 2 });
        expect(describeArchiveWorkerStatus(worker.list('timeline-1'))).toMatchObject({
            status: 'failed', label: 'Archive needs attention', repairAction: 'retry',
        });
        expect(commit).not.toHaveBeenCalled();
    });
});

test('provider cause details survive in the repairable Archive error', async () => {
    const caused = new Error('Got response status 400');
    const wrapped = new Error('API request failed', { cause: caused });
    const { worker } = harness({ maxAttempts: 1, transport: async () => { throw wrapped; } });
    worker.enqueue(job());

    const failed = await worker.runNext('timeline-1');

    expect(failed).toMatchObject({
        status: ARCHIVE_JOB_STATUS.FAILED_REPAIRABLE,
        error: { message: 'API request failed <- Got response status 400' },
    });
});

test('manual retry clears attention, preserves the frozen route, and can recover', async () => {
    let fail = true;
    const { worker, commit } = harness({ maxAttempts: 1, transport: async ({ job }) => {
        expect(job.routeSnapshot.profileId).toBe('loom-profile');
        if (fail) throw new Error('temporary failure');
        return stateReply();
    } });
    const queued = worker.enqueue(job());
    await worker.runNext('timeline-1');
    expect(describeArchiveWorkerStatus(worker.list('timeline-1')).label).toBe('Archive needs attention');

    fail = false;
    worker.retry(queued.jobId);
    expect(describeArchiveWorkerStatus(worker.list('timeline-1')).label).toBe('Archive queued');
    await worker.runNext('timeline-1');
    expect(describeArchiveWorkerStatus(worker.list('timeline-1')).status).toBe('idle');
    expect(commit).toHaveBeenCalledTimes(1);
});

test('reload recovery returns an abandoned running job to pending without changing its snapshots', () => {
    const first = harness();
    const queued = first.worker.enqueue(job());
    first.repository.update(queued.jobId, { status: ARCHIVE_JOB_STATUS.RUNNING, attempts: 1 });

    const reloaded = harness({ persistence: first.persistence });
    const recovered = reloaded.worker.recover();
    expect(recovered).toContain(queued.jobId);
    expect(reloaded.worker.get(queued.jobId)).toMatchObject({
        status: ARCHIVE_JOB_STATUS.PENDING, attempts: 1,
        routeSnapshot: { profileId: 'loom-profile' },
    });
});

test('supersession makes obsolete jobs inert and catch-up remains ordinary accepted provenance', async () => {
    const { worker, commit } = harness();
    const old = worker.enqueue(job());
    const replacement = worker.enqueue(job({
        acceptedProse: 'The gate stayed closed.',
        provenance: { ...job().provenance, kind: 'catch-up', sourceId: 'catch-up-1', supersedesJobIds: [old.jobId] },
    }));

    expect(worker.get(old.jobId).status).toBe(ARCHIVE_JOB_STATUS.SUPERSEDED);
    expect(replacement.provenance.kind).toBe('catch-up');
    await worker.drain('timeline-1');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0].jobId).toBe(replacement.jobId);
    expect(describeArchiveWorkerStatus(worker.list('timeline-1')).status).toBe('idle');
});

test('cancellation aborts a slow job without retrying or showing attention', async () => {
    let started;
    const began = new Promise((resolve) => { started = resolve; });
    const { worker, commit } = harness({ transport: ({ signal }) => new Promise((_resolve, reject) => {
        started();
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }) });
    const queued = worker.enqueue(job());
    const running = worker.runNext('timeline-1');
    await began;
    worker.cancel(queued.jobId, 'owner-cancelled');
    const cancelled = await running;

    expect(cancelled.status).toBe(ARCHIVE_JOB_STATUS.CANCELLED);
    expect(commit).not.toHaveBeenCalled();
    expect(describeArchiveWorkerStatus(worker.list('timeline-1')).status).toBe('idle');
});

test('a transport that settles after cancellation still cannot commit', async () => {
    let release;
    let started;
    const began = new Promise((resolve) => { started = resolve; });
    const { worker, commit } = harness({ transport: () => new Promise((resolve) => {
        release = resolve;
        started();
    }) });
    const queued = worker.enqueue(job());
    const running = worker.runNext('timeline-1');
    await began;
    worker.cancel(queued.jobId, 'owner-cancelled');
    release(stateReply());
    const cancelled = await running;

    expect(cancelled.status).toBe(ARCHIVE_JOB_STATUS.CANCELLED);
    expect(commit).not.toHaveBeenCalled();
});

test('timeouts are bounded retryable failures rather than permanent hangs', async () => {
    const { worker } = harness({ timeoutMs: 10, maxAttempts: 2, transport: () => new Promise(() => {}) });
    worker.enqueue(job());
    const result = await worker.runNext('timeline-1');
    expect(result).toMatchObject({ status: ARCHIVE_JOB_STATUS.RETRYING, attempts: 1 });
    expect(result.error.code).toBe('timeout');
});

test('identity collisions and invalid jobs are permanently rejected before transport', () => {
    const { worker } = harness();
    const queued = worker.enqueue(job());
    expect(() => worker.enqueue(job({ jobId: queued.jobId, acceptedProse: 'Different evidence.' }))).toThrow(/identity collision/i);
    expect(() => worker.enqueue(job({ acceptedProse: '' }))).toThrow(/accepted prose/i);
});

test('a permanent contract rejection is terminal and never becomes Archive attention', async () => {
    const ingestion = { ingest: async () => { throw new ArchiveWorkerPermanentError('unsupported operation', { code: 'contract-rejected' }); } };
    const { worker, commit } = harness({ ingestion });
    worker.enqueue(job());
    const rejected = await worker.runNext('timeline-1');

    expect(rejected).toMatchObject({ status: ARCHIVE_JOB_STATUS.REJECTED, attempts: 1, error: { code: 'contract-rejected' } });
    expect(describeArchiveWorkerStatus(worker.list('timeline-1')).status).toBe('idle');
    expect(await worker.runNext('timeline-1')).toBeNull();
    expect(commit).not.toHaveBeenCalled();
});
