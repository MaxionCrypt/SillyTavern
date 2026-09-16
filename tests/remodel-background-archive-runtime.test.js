import { expect, jest, test } from '@jest/globals';
import { createArchiveIngestion } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archive-ingestion.js';
import { createArchiveJobRepository, createMemoryArchiveJobPersistence } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archive-job-store.js';
import { archiveRetryOverride, compileArchivePrompt, createBackgroundArchiveRuntime } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/background-archive-runtime.js';
import { __setConnectionProfiles } from './util/connection-request-stub.js';
import { legacyArchiveIngestionAdapter } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/legacy-archive-ingestion-adapter.js';
import { __setExtensionSettings } from './util/st-context-stub.js';
import { __clearDebugEvents, __getDebugEvents } from './util/debug-console-stub.js';

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

// --- Living Lore beside the Archive ----------------------------------------

function loreFence(requests, loreProposals, loreKeywords = []) {
    return `\`\`\`state\n${JSON.stringify({ requests, loreProposals, loreKeywords })}\n\`\`\``;
}

test('takeReply hands back what the reply said about lore, parsed against the job\'s packet, once', async () => {
    __setExtensionSettings({ remodel: {} });
    const packet = { protocol: 'living-lore.loom-packet.v1', book: 'Living Story', entries: [] };
    const { runtime, runScheduled } = harness({
        transport: async () => loreFence(
            [{ id: 'e1', capability: 'event.record', arguments: { summary: 'Mara opened the gate.' }, reason: 'accepted prose' }],
            [
                { content: 'The north gate opens from the inside only.', name: 'North gate', keys: ['north gate'], evidence: ['Mara opened the gate.'] },
                { name: 'no content, so rejected', evidence: ['x'] },
            ],
        ),
    });
    const queued = runtime.enqueue(job({ livingLorePacket: packet }));
    // Nothing to take until the job has replied.
    expect(runtime.takeReply(queued.jobId)).toBeNull();
    await runScheduled();
    const reply = runtime.takeReply(queued.jobId);
    expect(reply).toMatchObject({
        livingLorePacket: expect.objectContaining({ book: 'Living Story' }),
        loreProposals: [expect.objectContaining({ content: 'The north gate opens from the inside only.' })],
        loreProposalRejections: [expect.objectContaining({ code: 'missing-content' })],
    });
    // Taken once: a second read cannot file the same lore twice.
    expect(runtime.takeReply(queued.jobId)).toBeNull();
});

test('takeReply preserves a Loom request to replace the World Sense working set', async () => {
    __setExtensionSettings({ remodel: {} });
    const { runtime, runScheduled } = harness({
        transport: async () => loreFence([], [], ['Queens Lake University', 'Marissa']),
    });
    const queued = runtime.enqueue(job({
        livingLorePacket: { protocol: 'living-lore.loom-packet.v1', book: 'Living Story', entries: [] },
    }));
    await runScheduled();

    expect(runtime.takeReply(queued.jobId)).toMatchObject({
        loreKeywords: ['Queens Lake University', 'Marissa'],
    });
});

test('state subscribers receive the exact settled job even when the worker is idle again', async () => {
    __setExtensionSettings({ remodel: {} });
    const tasks = [];
    const settled = [];
    const runtime = createBackgroundArchiveRuntime({
        repository: createArchiveJobRepository({ persistence: createMemoryArchiveJobPersistence() }),
        transport: async () => loreFence([], []),
        ingestion: createArchiveIngestion(legacyArchiveIngestionAdapter),
        commit: async () => ({ transactionId: 'tx-1' }),
        schedule: (task) => { tasks.push(task); },
        retryDelayMs: 0,
        onStateChange: (state, jobResult) => {
            if (jobResult) settled.push({ state, jobResult });
        },
    });

    const queued = runtime.enqueue(job());
    while (tasks.length) await tasks.shift()();

    expect(runtime.status('timeline-1').status).toBe('idle');
    expect(settled).toEqual([expect.objectContaining({
        state: expect.objectContaining({ status: 'idle' }),
        jobResult: expect.objectContaining({ jobId: queued.jobId, status: 'succeeded' }),
    })]);
});

test('a job enqueued without a packet still parses its reply, against no packet', async () => {
    __setExtensionSettings({ remodel: {} });
    const { runtime, runScheduled } = harness({
        transport: async () => loreFence([], [{ content: 'Filed nowhere, but reported.', evidence: ['x'] }]),
    });
    const queued = runtime.enqueue(job());
    await runScheduled();
    expect(runtime.takeReply(queued.jobId)).toMatchObject({ livingLorePacket: null, loreProposals: [expect.objectContaining({ content: 'Filed nowhere, but reported.' })] });
});

test('superseding a job forgets its packet and reply', async () => {
    __setExtensionSettings({ remodel: {} });
    let release;
    const { runtime, tasks } = harness({ transport: () => new Promise((resolve) => { release = resolve; }) });
    const queued = runtime.enqueue(job({ livingLorePacket: { book: 'Living Story', entries: [] } }));
    const work = tasks.shift()();
    await Promise.resolve();
    runtime.supersede(queued.jobId, 'replacement');
    release(loreFence([], []));
    await work;
    expect(runtime.takeReply(queued.jobId)).toBeNull();
});

// --- Recall inside {{loom.archive}} ------------------------------------------

const archiveOnlyRecipe = {
    mode: 'loom', apiType: 'chat',
    blocks: [{ id: 'archive', kind: 'message', role: 'system', content: '{{loom.archive}}', enabled: true }],
};

test("recall is placed after the Scene's own Archive, inside the same source", () => {
    const { messages } = compileArchivePrompt({
        acceptedProse: 'Mara locked the door.',
        archiveContext: 'location: observatory',
        recipe: archiveOnlyRecipe,
        recall: '=== WORLD SENSE RECALL ===\nAccepted evidence recalled from earlier Timeline Scenes:\n- [Arrival / The Cellar / event] Mara hid the key.',
    });
    const text = messages.map((message) => message.content).join('\n');
    const archiveAt = text.indexOf('Current Loom Archive:');
    const recallAt = text.indexOf('=== WORLD SENSE RECALL ===');
    expect(archiveAt).toBeGreaterThanOrEqual(0);
    expect(recallAt).toBeGreaterThan(archiveAt);
    expect(text).toContain('location: observatory');
    expect(text).toContain('[Arrival / The Cellar / event] Mara hid the key.');
});

test('no recall means the Archive source is exactly what it was before', () => {
    const without = compileArchivePrompt({ acceptedProse: 'x', archiveContext: 'gate: closed', recipe: archiveOnlyRecipe });
    const blank = compileArchivePrompt({ acceptedProse: 'x', archiveContext: 'gate: closed', recipe: archiveOnlyRecipe, recall: '   ' });
    const render = (snapshot) => snapshot.messages.map((message) => message.content).join('\n');
    expect(render(blank)).toBe(render(without));
    expect(render(without)).toBe('Current Loom Archive:\ngate: closed');
});


// --- The Archive retry override ---------------------------------------------

const OPENROUTER = [{ id: 'loom-a', selected: 'openai', source: 'openrouter', model: 'deepseek/deepseek-v4-flash-vision-exp' }];

test('a reasoning-only failure turns reasoning off for the retry', () => {
    __setConnectionProfiles(OPENROUTER);
    expect(archiveRetryOverride({ previousError: { code: 'reasoning-only' }, profileId: 'loom-a' }))
        .toEqual({ reasoning_effort: 'none', include_reasoning: false });
});

test('every other failure is retried unchanged', () => {
    __setConnectionProfiles(OPENROUTER);
    for (const code of ['empty-response', 'malformed-response', 'worker-error', 'aborted', '']) {
        expect(archiveRetryOverride({ previousError: { code }, profileId: 'loom-a' })).toEqual({});
    }
    // A first attempt has no prior failure at all.
    expect(archiveRetryOverride({ previousError: null, profileId: 'loom-a' })).toEqual({});
    expect(archiveRetryOverride()).toEqual({});
});

test('a profile that cannot be resolved changes nothing rather than guessing', () => {
    __setConnectionProfiles([]);
    expect(archiveRetryOverride({ previousError: { code: 'reasoning-only' }, profileId: 'gone' })).toEqual({});
});

test('a non-chat-completion profile is left alone', () => {
    __setConnectionProfiles([{ id: 'text-a', selected: 'textgenerationwebui', source: 'ooba', model: 'local' }]);
    expect(archiveRetryOverride({ previousError: { code: 'reasoning-only' }, profileId: 'text-a' })).toEqual({});
});


// --- Saying why the Archive stopped -------------------------------------------
//
// job.queued was the only Archive event that existed. A job that retried three
// times and gave up left no trace, so "Archive needs attention" was a dead end
// in the very console meant to explain it.

const archiveEvents = () => __getDebugEvents().filter((e) => e.category === 'archive-worker');

test('a reasoning-only failure names the cause and the reply shape it came from', async () => {
    __setExtensionSettings({ remodel: {} });
    __clearDebugEvents();
    const { runtime, runScheduled } = harness({
        transport: async () => ({ text: '', reasoning: 'x'.repeat(957) }),
    });
    runtime.enqueue(job());
    await runScheduled();

    const outcomes = archiveEvents().filter((e) => e.type.startsWith('job.') && e.type !== 'job.queued');
    expect(outcomes.length).toBeGreaterThan(0);
    const last = outcomes.at(-1);
    expect(last.type).toBe('job.failed-repairable');
    expect(last.severity).toBe('error');
    expect(last.summary).toContain('needs attention');
    expect(last.summary).toContain('reasoning-only');
    // The half that tells a reader which of three identical-looking failures
    // this was: the model reasoned and returned nothing.
    expect(last.summary).toContain('text 0 chars');
    expect(last.summary).toContain('reasoning 957 chars');
    expect(last.detail.error).toMatchObject({ code: 'reasoning-only', detail: { textChars: 0, reasoningChars: 957 } });
});

test('an empty reply with no reasoning reads differently from a reasoning-only one', async () => {
    __setExtensionSettings({ remodel: {} });
    __clearDebugEvents();
    const { runtime, runScheduled } = harness({ transport: async () => ({ text: '', reasoning: '' }) });
    runtime.enqueue(job());
    await runScheduled();
    const last = archiveEvents().filter((e) => e.type.startsWith('job.') && e.type !== 'job.queued').at(-1);
    expect(last.summary).toContain('empty-response');
    expect(last.summary).toContain('text 0 chars');
    expect(last.summary).not.toContain('reasoning');
});

test('prose without a readable fence is reported as a fence problem, not an empty reply', async () => {
    __setExtensionSettings({ remodel: {} });
    __clearDebugEvents();
    const { runtime, runScheduled } = harness({ transport: async () => 'I would rather keep narrating the scene.' });
    runtime.enqueue(job());
    await runScheduled();
    const last = archiveEvents().filter((e) => e.type.startsWith('job.') && e.type !== 'job.queued').at(-1);
    expect(last.summary).toContain('malformed-response');
    expect(last.summary).toContain('no fence');
    expect(last.detail.error.detail.textChars).toBe(40);
});

test('a saved Archive says how much it saved', async () => {
    __setExtensionSettings({ remodel: {} });
    __clearDebugEvents();
    const { runtime, runScheduled } = harness();
    runtime.enqueue(job());
    await runScheduled();
    const last = archiveEvents().filter((e) => e.type.startsWith('job.') && e.type !== 'job.queued').at(-1);
    expect(last.type).toBe('job.succeeded');
    expect(last.severity).toBe('info');
    expect(last.summary).toBe('Archive saved 1 operation');
});

test('a retry that has not run out of attempts is a warning, not a failure', async () => {
    __setExtensionSettings({ remodel: {} });
    __clearDebugEvents();
    let attempt = 0;
    const { runtime, runScheduled } = harness({
        transport: async () => { attempt += 1; return attempt === 1 ? { text: '', reasoning: '' } : fence([]); },
    });
    runtime.enqueue(job());
    await runScheduled();
    const outcomes = archiveEvents().filter((e) => e.type.startsWith('job.') && e.type !== 'job.queued');
    expect(outcomes.map((e) => [e.type, e.severity])).toEqual([
        ['job.retrying', 'warn'],
        ['job.succeeded', 'info'],
    ]);
    expect(outcomes[0].summary).toContain('retrying');
});
