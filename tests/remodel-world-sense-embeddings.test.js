import { jest } from '@jest/globals';
import { benchmarkWorldSense, ensureWorldSenseIndex, queryWorldSense } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-embeddings.js';
import { invalidateTimelineLoreCache } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-lore.js';
import { previewWorldSense, resolveWorldSense } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-runtime.js';
import {
    DEFAULT_WORLD_SENSE_MODEL,
    getWorldSenseContinuity,
    getWorldSenseIndexState,
    getWorldSenseProfile,
    listWorldSenseReceipts,
    saveWorldSenseReceipt,
    updateWorldSenseProfile,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-store.js';
import { __setContextOverrides, __setExtensionSettings } from './util/st-context-stub.js';

const TIMELINE = 'timeline-embeddings';
const nativeFetch = global.fetch;

beforeEach(() => {
    invalidateTimelineLoreCache();
    __setExtensionSettings({ remodel: { timelineV1: {
        version: 1, timelineIds: [TIMELINE], activeTimelineId: TIMELINE,
        timelines: { [TIMELINE]: { id: TIMELINE, lorebookName: 'Living Book', arcIds: [] } }, arcs: {}, scenes: {},
    } } });
    __setContextOverrides({ loadWorldInfo: async () => ({ entries: {
        1: { uid: 1, comment: 'Harbor', key: ['harbor'], content: 'A tidal port.' },
        2: { uid: 2, comment: 'Disabled', key: ['hidden'], content: 'Ignored.', disable: true },
    } }) });
});

afterEach(() => {
    global.fetch = nativeFetch;
});

test('stores a configurable local model and bounded benchmark targets', () => {
    expect(getWorldSenseProfile().modelId).toBe(DEFAULT_WORLD_SENSE_MODEL);
    const profile = updateWorldSenseProfile({ modelId: 'Org/small-model', warmQueryTargetMs: 1, supportedBookSize: 99999 });
    expect(profile).toMatchObject({ modelId: 'Org/small-model', warmQueryTargetMs: 50, supportedBookSize: 5000 });
});

test('incrementally indexes enabled entries and reuses an unchanged collection', async () => {
    global.fetch = jest.fn(async (url) => {
        if (url === '/api/vector/list') return response([]);
        if (url === '/api/vector/insert') return response(null, 204);
        throw new Error(`Unexpected URL ${url}`);
    });
    const [first, concurrent] = await Promise.all([ensureWorldSenseIndex(TIMELINE), ensureWorldSenseIndex(TIMELINE)]);
    expect(first).toMatchObject({ ok: true, inserted: 1, removed: 0 });
    expect(concurrent).toMatchObject({ ok: true, inserted: 1, removed: 0 });
    const insertBody = JSON.parse(global.fetch.mock.calls.find(([url]) => url === '/api/vector/insert')[1].body);
    expect(insertBody).toMatchObject({ source: 'transformers', model: DEFAULT_WORLD_SENSE_MODEL });
    expect(insertBody.items).toHaveLength(1);

    const calls = global.fetch.mock.calls.length;
    expect((await ensureWorldSenseIndex(TIMELINE)).ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(calls);
    expect(getWorldSenseIndexState(TIMELINE).status).toBe('ready');
});

test('fails open with an explicit unavailable state', async () => {
    global.fetch = jest.fn(async () => { throw new Error('model offline'); });
    const result = await queryWorldSense(TIMELINE, 'ships near the harbor');
    expect(result).toEqual(expect.objectContaining({ ok: false, degraded: true, status: 'unavailable', matches: [] }));
    expect(result.error).toContain('model offline');
});

test('requests and preserves real vector similarity scores', async () => {
    let insertedHash = null;
    global.fetch = jest.fn(async (url, options) => {
        if (url === '/api/vector/list') return response([]);
        if (url === '/api/vector/insert') {
            insertedHash = JSON.parse(options.body).items[0].hash;
            return response(null, 204);
        }
        if (url === '/api/vector/query') return response({ metadata: [{ hash: insertedHash, score: 0.72 }] });
        throw new Error(`Unexpected URL ${url}`);
    });
    const result = await queryWorldSense(TIMELINE, 'tidal harbor', { threshold: 0.35 });
    expect(result.matches[0]).toMatchObject({ book: 'Living Book', uid: '1', score: 0.72, rank: 0 });
    const queryBody = JSON.parse(global.fetch.mock.calls.find(([url]) => url === '/api/vector/query')[1].body);
    expect(queryBody).toMatchObject({ includeScores: true, threshold: 0.35 });
});

test('records representative benchmark measurements and acceptance', async () => {
    global.fetch = jest.fn(async (url) => {
        expect(url).toBe('/api/vector/benchmark');
        return response({ modelId: DEFAULT_WORLD_SENSE_MODEL, coldLoadMs: 900, indexMs: 12, warmQueryP50Ms: 40, warmQueryP95Ms: 80, memoryRssDeltaBytes: 1024 });
    });
    const result = await benchmarkWorldSense(TIMELINE);
    expect(result).toMatchObject({ ok: true, accepted: true, entryCount: 1, warmQueryP95Ms: 80, targetMs: 500 });
});

test('stores inspectable receipts and scene retrieval continuity', () => {
    saveWorldSenseReceipt({
        id: 'receipt-1', sceneId: 'scene-1', queryHash: 'query-1',
        selected: [{ book: 'Living Book', uid: '1', reasons: [{ channel: 'goal.link', points: 34 }] }],
        rejected: [{ book: 'Living Book', uid: '2', decision: 'token-budget' }],
    });
    expect(listWorldSenseReceipts({ sceneId: 'scene-1' })).toHaveLength(1);
    expect(getWorldSenseContinuity('scene-1')).toEqual([{ book: 'Living Book', uid: '1' }]);
});

test('Preview ranks the same deterministic lore without saving receipt or continuity', async () => {
    global.fetch = jest.fn(async () => { throw new Error('local model unavailable'); });
    const scene = { id: 'scene-preview', timelineId: TIMELINE };

    const preview = await previewWorldSense(scene, { action: 'Approach the harbor.' });

    expect(preview.selected).toEqual([expect.objectContaining({ book: 'Living Book', uid: '1' })]);
    expect(preview.receipt).toBeNull();
    expect(listWorldSenseReceipts({ sceneId: scene.id })).toHaveLength(0);
    expect(getWorldSenseContinuity(scene.id)).toEqual([]);

    const turn = await resolveWorldSense(scene, { action: 'Approach the harbor.' });
    expect(turn.receipt).toEqual(expect.objectContaining({ sceneId: scene.id }));
    expect(listWorldSenseReceipts({ sceneId: scene.id })).toHaveLength(1);
});

function response(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}
