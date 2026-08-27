import { jest } from '@jest/globals';
import { benchmarkWorldSense, ensureWorldSenseIndex, queryWorldSense } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-embeddings.js';
import { invalidateTimelineLoreCache } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-lore.js';
import { recordEvent } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';
import { getWorldSenseTurnOverrides, prefetchWorldSense, previewWorldSense, resolveWorldSense, setWorldSenseTurnOverride } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-runtime.js';
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
import { __clearDebugEvents, __getDebugEvents } from './util/debug-console-stub.js';

const TIMELINE = 'timeline-embeddings';
const nativeFetch = global.fetch;

beforeEach(() => {
    __clearDebugEvents();
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
    const profile = updateWorldSenseProfile({ mode: 'observe', modelId: 'Org/small-model', warmQueryTargetMs: 1, supportedBookSize: 99999 });
    expect(profile).toMatchObject({ mode: 'observe', modelId: 'Org/small-model', warmQueryTargetMs: 50, supportedBookSize: 5000 });
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

test('accepts SillyTavern plain-text vector mutation acknowledgements', async () => {
    global.fetch = jest.fn(async (url) => {
        if (url === '/api/vector/list') return response([]);
        if (url === '/api/vector/insert') return response('OK');
        throw new Error(`Unexpected URL ${url}`);
    });

    await expect(ensureWorldSenseIndex(TIMELINE)).resolves.toMatchObject({ ok: true, inserted: 1 });
    expect(getWorldSenseIndexState(TIMELINE).status).toBe('ready');
});

test('fails open with an explicit unavailable state', async () => {
    global.fetch = jest.fn(async () => { throw new Error('model offline'); });
    const result = await queryWorldSense(TIMELINE, 'ships near the harbor');
    expect(result).toEqual(expect.objectContaining({ ok: false, degraded: true, status: 'unavailable', matches: [] }));
    expect(result.error).toContain('model offline');
});

test('retries cleanly after a model download or temporary offline failure', async () => {
    let offline = true;
    global.fetch = jest.fn(async (url) => {
        if (offline) throw new Error('model download in progress');
        if (url === '/api/vector/list') return response([]);
        if (url === '/api/vector/insert') return response(null, 204);
        throw new Error(`Unexpected URL ${url}`);
    });
    expect(await ensureWorldSenseIndex(TIMELINE)).toMatchObject({ ok: false, state: { status: 'unavailable' } });
    offline = false;
    expect(await ensureWorldSenseIndex(TIMELINE)).toMatchObject({ ok: true, state: { status: 'ready' } });
});

test('rebuilds a corrupt collection once when query hashes have no local identity', async () => {
    let knownHash = null;
    let queries = 0;
    global.fetch = jest.fn(async (url, options) => {
        if (url === '/api/vector/list') return response(knownHash == null ? [] : [knownHash]);
        if (url === '/api/vector/insert') { knownHash = JSON.parse(options.body).items[0].hash; return response(null, 204); }
        if (url === '/api/vector/delete') return response(null, 204);
        if (url === '/api/vector/query') { queries += 1; return response({ metadata: [{ hash: queries === 1 ? 4294967295 : knownHash, score: 0.8 }] }); }
        throw new Error(`Unexpected URL ${url}`);
    });

    const result = await queryWorldSense(TIMELINE, 'harbor');

    expect(result).toMatchObject({ ok: true, matches: [expect.objectContaining({ uid: '1', score: 0.8 })] });
    expect(queries).toBe(2);
    expect(global.fetch.mock.calls.some(([url]) => url === '/api/vector/delete')).toBe(true);
});

test('migrates Auto-safe settings to the guarded allowlist and threshold', () => {
    __setExtensionSettings({ remodel: { worldSenseV1: { version: 1, profile: { mode: 'auto-safe', autoSafeConfidence: 0.1, autoSafeOperations: ['entry.retire', 'fact.append'] } } } });
    expect(getWorldSenseProfile()).toMatchObject({ mode: 'auto-safe', autoSafeConfidence: 0.5, autoSafeOperations: ['fact.append'] });
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

test('indexes Archive records in the same collection and returns them as continuity matches', async () => {
    __setExtensionSettings({ remodel: { timelineV1: {
        version: 1, timelineIds: [TIMELINE], activeTimelineId: TIMELINE,
        timelines: { [TIMELINE]: { id: TIMELINE, lorebookName: 'Living Book', arcIds: ['arc-1'] } },
        arcs: { 'arc-1': { id: 'arc-1', timelineId: TIMELINE, title: 'Arrival', sceneIds: ['scene-1'] } },
        scenes: { 'scene-1': { id: 'scene-1', timelineId: TIMELINE, arcId: 'arc-1', title: 'The Cellar', mode: 'roleplay' } },
    } } });
    const event = recordEvent(TIMELINE, 'scene-1', 'Mara hid the obsidian key beneath the cellar floor.');
    let archiveHash = null;
    global.fetch = jest.fn(async (url, options) => {
        if (url === '/api/vector/list') return response([]);
        if (url === '/api/vector/insert') {
            const items = JSON.parse(options.body).items;
            archiveHash = items.find((item) => item.text.includes('obsidian key')).hash;
            return response(null, 204);
        }
        if (url === '/api/vector/query') return response({ metadata: [{ hash: archiveHash, score: 0.79 }] });
        throw new Error(`Unexpected URL ${url}`);
    });

    const result = await queryWorldSense(TIMELINE, 'the key hidden in the cellar');

    expect(result.matches).toEqual([]);
    expect(result.continuityMatches).toEqual([expect.objectContaining({
        kind: 'archive', sceneId: 'scene-1', recordType: 'event', recordId: event.id, score: 0.79,
    })]);
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

test('compacts heavyweight retrieval candidates and bounds receipt history', () => {
    const oversized = {
        kind: 'lore', book: 'Living Book', uid: '2', decision: 'no-evidence',
        entry: { book: 'Living Book', uid: '2', name: 'Large entry', content: 'x'.repeat(20000), native: { content: 'x'.repeat(20000) } },
        reasons: Array.from({ length: 20 }, (_, index) => ({ channel: `reason-${index}`, points: index, payload: 'y'.repeat(500) })),
    };
    for (let i = 0; i < 45; i += 1) saveWorldSenseReceipt({ id: `receipt-${i}`, sceneId: 'scene-compact', selected: [], rejected: [oversized] });

    const receipts = listWorldSenseReceipts({ sceneId: 'scene-compact' });
    expect(receipts).toHaveLength(40);
    expect(receipts[0].id).toBe('receipt-5');
    expect(receipts.at(-1).rejected[0]).not.toHaveProperty('entry');
    expect(receipts.at(-1).rejected[0].reasons).toHaveLength(8);
    expect(JSON.stringify(receipts).length).toBeLessThan(100 * 1024);
});

test('Preview ranks the same deterministic lore without saving receipt or continuity', async () => {
    global.fetch = jest.fn(async () => { throw new Error('local model unavailable'); });
    const scene = { id: 'scene-preview', timelineId: TIMELINE, mode: 'story' };

    const preview = await previewWorldSense(scene, { action: 'Approach the harbor.' });

    expect(preview.selected).toEqual([expect.objectContaining({ book: 'Living Book', uid: '1' })]);
    expect(preview.loomPacket.entries).toEqual([expect.objectContaining({
        target: { book: 'Living Book', uid: '1', revision: 1 },
    })]);
    expect(preview.receipt).toBeNull();
    expect(listWorldSenseReceipts({ sceneId: scene.id })).toHaveLength(0);
    expect(getWorldSenseContinuity(scene.id)).toEqual([]);

    const turn = await resolveWorldSense(scene, { action: 'Approach the harbor.' });
    expect(turn.receipt).toEqual(expect.objectContaining({
        sceneId: scene.id,
        sceneMode: 'story',
        querySources: expect.arrayContaining([expect.objectContaining({ kind: 'action', label: 'Current action', characters: 20 })]),
        promptInclusion: [expect.objectContaining({ kind: 'lore', book: 'Living Book', uid: '1', included: true, rankingReasons: expect.arrayContaining(['action.primary']) })],
    }));
    expect(turn.receipt).not.toHaveProperty('loomPacket');
    expect(turn.loomPacket.entries[0].content).toBe('A tidal port.');
    expect(listWorldSenseReceipts({ sceneId: scene.id })).toHaveLength(1);
    const diagnostic = __getDebugEvents().find((event) => event.category === 'world-sense' && event.type === 'retrieval.receipt');
    expect(diagnostic?.detail?.sceneMode).toBe('story');
    expect(Array.isArray(diagnostic?.detail?.promptInclusion)).toBe(true);
});

test('Send reuses an exact completed composer prefetch', async () => {
    global.fetch = jest.fn(async () => { throw new Error('local model unavailable'); });
    const scene = { id: 'scene-prefetch', timelineId: TIMELINE, mode: 'roleplay' };
    const options = { action: 'Approach the harbor.', cast: [], history: [] };

    await prefetchWorldSense(scene, options);
    const turn = await resolveWorldSense(scene, options);

    expect(turn.reusedPrefetch).toBe(true);
    expect(turn.receipt.reusedPrefetch).toBe(true);
});

test('one-turn pins and exclusions affect Preview but are consumed only by Send', async () => {
    global.fetch = jest.fn(async () => { throw new Error('local model unavailable'); });
    __setContextOverrides({ loadWorldInfo: async () => ({ entries: {
        1: { uid: 1, comment: 'Harbor', key: ['harbor'], content: 'A tidal port.' },
        3: { uid: 3, comment: 'Bell Tower', key: ['bell'], content: 'A silent tower.' },
    } }) });
    invalidateTimelineLoreCache();
    const scene = { id: 'scene-overrides', timelineId: TIMELINE };
    setWorldSenseTurnOverride(scene.id, { book: 'Living Book', uid: '1' }, 'exclude');
    setWorldSenseTurnOverride(scene.id, { book: 'Living Book', uid: '3' }, 'pin');

    const preview = await previewWorldSense(scene, { action: 'Approach the harbor.' });
    expect(preview.selected).toEqual([expect.objectContaining({ uid: '3' })]);
    expect(getWorldSenseTurnOverrides(scene.id)).toMatchObject({ pins: [{ uid: '3' }], excludes: [{ uid: '1' }] });

    const turn = await resolveWorldSense(scene, { action: 'Approach the harbor.' });
    expect(turn.selected).toEqual([expect.objectContaining({ uid: '3' })]);
    expect(getWorldSenseTurnOverrides(scene.id)).toEqual({ pins: [], excludes: [] });
});

function response(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() { return body; },
        async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
    };
}
