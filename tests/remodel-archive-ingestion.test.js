import { jest } from '@jest/globals';
import {
    ARCHIVE_ACTION_MAX_CHARS,
    ARCHIVE_INGESTION_PROTOCOL,
    ARCHIVE_STATE_MAX_CHARS,
    archiveEvidenceFromOperations,
    createArchiveIngestion,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archive-ingestion.js';
import {
    legacyArchiveIngestionAdapter,
    roleplayArchiveIngestionInput,
    storyArchiveIngestionInput,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/legacy-archive-ingestion-adapter.js';

const STATE_REPLY = `Rewritten prose must stay outside Archive ingestion.
\`\`\`state
${JSON.stringify({
    swaps: [{ find: 'old', replace: 'new' }],
    requests: [
        { id: 'a1', capability: 'event.record', arguments: { summary: 'The gate opened.' }, reason: 'accepted prose' },
        { id: 'a2', capability: 'scene.set', arguments: { key: 'location', value: 'North gate' }, reason: 'accepted prose' },
        { id: 'w1', capability: 'goal.edit', arguments: { goalRef: 'Escape', successRate: 60 }, reason: 'outside Archive' },
    ],
    loreProposals: [{ id: 'l1', operation: 'fact.append' }],
    flow: { continue: true },
})}
\`\`\``;

test('legacy ingestion returns Archive operations only and cannot own prose or Timeline Web output', async () => {
    const ingestion = createArchiveIngestion(legacyArchiveIngestionAdapter);
    const result = await ingestion.ingest({
        mode: 'roleplay',
        jobId: 'direction-1',
        timelineId: 'timeline-1',
        sceneId: 'scene-1',
        acceptedProse: 'The gate opened.',
        candidateReply: STATE_REPLY,
        statePacket: { sourceId: 'direction-1', messageId: 7, checkpointId: 'accepted' },
    });

    expect(result).toEqual(expect.objectContaining({
        protocol: ARCHIVE_INGESTION_PROTOCOL,
        operations: [
            expect.objectContaining({ id: 'a1', capability: 'event.record' }),
            expect.objectContaining({ id: 'a2', capability: 'scene.set' }),
        ],
        archiveFacts: ['The gate opened.', 'North gate'],
        rejected: [expect.objectContaining({ requestId: 'w1', capability: 'goal.edit', code: 'outside-archive-boundary' })],
    }));
    expect(result).not.toHaveProperty('prose');
    expect(result).not.toHaveProperty('swaps');
    expect(result).not.toHaveProperty('loreProposals');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.operations[0])).toBe(true);
});

test('Story and Roleplay input adapters share the contract without sharing transient run state', async () => {
    const run = {
        directionId: 'direction-2', timelineId: 'timeline-1', sceneId: 'roleplay-1', messageId: 9,
        interrupted: true, canonicalSession: Promise.resolve(), loomController: new AbortController(), rawBufferedText: 'private',
    };
    const roleplay = roleplayArchiveIngestionInput({ run, acceptedProse: 'Visible prefix.', candidateReply: STATE_REPLY, reason: 'interrupted' });
    const story = storyArchiveIngestionInput({
        scene: { id: 'story-1', timelineId: 'timeline-1' },
        docId: 'doc-1',
        capture: { id: 'capture-1', generationId: 'generation-1', status: 'processing', attempts: 2 },
        acceptedProse: 'Accepted manuscript passage.',
        candidateReply: STATE_REPLY,
    });
    const spy = jest.fn(async () => ({ operations: [] }));
    const ingestion = createArchiveIngestion({ ingest: spy });

    await ingestion.ingest(roleplay);
    await ingestion.ingest(story);
    const [roleplayRequest, storyRequest] = spy.mock.calls.map(([request]) => request);

    expect(roleplayRequest).toEqual(expect.objectContaining({ mode: 'roleplay', sceneId: 'roleplay-1', acceptedProse: 'Visible prefix.' }));
    expect(roleplayRequest.statePacket).toEqual({
        sourceId: 'direction-2', documentId: '', messageId: '9', checkpointId: 'accepted', reason: 'interrupted', interrupted: true,
        archiveState: '', currentPlayerAction: '',
    });
    expect(storyRequest).toEqual(expect.objectContaining({ mode: 'story', sceneId: 'story-1', acceptedProse: 'Accepted manuscript passage.' }));
    expect(storyRequest.statePacket).toEqual({
        sourceId: 'generation-1', documentId: 'doc-1', messageId: null, checkpointId: 'capture-1', reason: '', interrupted: false,
        archiveState: '', currentPlayerAction: '',
    });
    for (const request of [roleplayRequest, storyRequest]) {
        expect(request).not.toHaveProperty('canonicalSession');
        expect(request).not.toHaveProperty('loomController');
        expect(request).not.toHaveProperty('rawBufferedText');
        expect(Object.isFrozen(request)).toBe(true);
    }
});

test('Archive state and current player action are bounded without provider-specific handling', async () => {
    const spy = jest.fn(async () => ({ operations: [] }));
    const ingestion = createArchiveIngestion({ ingest: spy });
    const archiveState = `discarded-${'a'.repeat(ARCHIVE_STATE_MAX_CHARS)}-archive-tail`;
    const currentPlayerAction = `discarded-${'b'.repeat(ARCHIVE_ACTION_MAX_CHARS)}-action-tail`;

    await ingestion.ingest({
        mode: 'roleplay', timelineId: 'timeline-1', sceneId: 'scene-1', acceptedProse: 'Accepted.',
        statePacket: { archiveState, currentPlayerAction },
    });

    const request = spy.mock.calls[0][0];
    expect(request.statePacket.archiveState).toHaveLength(ARCHIVE_STATE_MAX_CHARS);
    expect(request.statePacket.archiveState).toEqual(archiveState.slice(-ARCHIVE_STATE_MAX_CHARS));
    expect(request.statePacket.currentPlayerAction).toHaveLength(ARCHIVE_ACTION_MAX_CHARS);
    expect(request.statePacket.currentPlayerAction).toEqual(currentPlayerAction.slice(-ARCHIVE_ACTION_MAX_CHARS));
});

test('Story and Roleplay retain their characterized Archive evidence formats', () => {
    const operations = [
        { capability: 'event.record', arguments: { summary: 'The gate opened.' } },
        { capability: 'scene.set', arguments: { key: 'location', value: 'North gate' } },
        { capability: 'scene.clear', arguments: { key: 'weather' } },
        { capability: 'char_state.set', arguments: { charId: 'Wren', facet: 'injury', value: 'cut arm' } },
        { capability: 'char_state.clear', arguments: { charId: 'Wren', facet: 'fear' } },
        { capability: 'beat.set', arguments: { directive: 'The bell begins to ring.' } },
    ];

    expect(archiveEvidenceFromOperations(operations)).toEqual([
        'The gate opened.', 'North gate', 'cut arm', 'The bell begins to ring.',
    ]);
    expect(archiveEvidenceFromOperations(operations, { mode: 'story' })).toEqual([
        'The gate opened.', 'location: North gate', 'weather: cleared',
        'Wren injury: cut arm', 'Wren fear: cleared', 'The bell begins to ring.',
    ]);
});

test('the port rejects prose rewriting and propagates implementation failures for the caller retry policy', async () => {
    const rewritten = createArchiveIngestion({ ingest: async () => ({ operations: [], committedProse: 'replacement' }) });
    await expect(rewritten.ingest({
        mode: 'story', timelineId: 'timeline-1', sceneId: 'scene-1', acceptedProse: 'Accepted.',
    })).rejects.toThrow(/cannot return committedProse/);

    const failed = createArchiveIngestion({ ingest: async () => { throw new Error('legacy provider unavailable'); } });
    await expect(failed.ingest({
        mode: 'roleplay', timelineId: 'timeline-1', sceneId: 'scene-1', acceptedProse: 'Accepted.',
    })).rejects.toThrow('legacy provider unavailable');
});
