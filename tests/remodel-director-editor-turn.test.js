// A full editor-mode turn: the narrator produces a DRAFT, the Director-editor
// reconciles it, and the COMMITTED prose (not the draft) is what lands in chat.
import { test, expect, beforeEach, afterEach } from '@jest/globals';
import {
    initLiveDirection, setLiveDirectionTestAdapters, requestNextDirection,
    getLiveDirectionRun, stopLiveDirection, clearLiveDirectionFailure,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { listEvents } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';
import { __setExtensionSettings, __getChat, __emit } from './util/st-context-stub.js';
import { __setOnlineStatus } from './util/script-stub.js';

globalThis.document ??= { getElementById: () => null };
globalThis.HTMLTextAreaElement ??= class HTMLTextAreaElement {};

const scene = {
    id: 'scene-editor', timelineId: 'timeline-editor', title: 'Editor Scene',
    mode: 'roleplay', staging: 'directed',
    liveDirection: { enabled: true, mode: 'editor', directorRef: null, narratorRef: null, pacing: 'instant', autoplay: false },
};
const cast = [{ ref: { kind: 'character', id: 'char-n', label: 'Narrator' }, label: 'Narrator', characterId: 0 }];

const DRAFT = 'Eli leans in and Marissa melts into him.';
const COMMITTED = 'Eli leans in, but Marissa turns her cheek at the last second.';
const fence = JSON.stringify({
    requests: [{ id: 'r1', capability: 'event.record', arguments: { summary: 'Eli tried to kiss Marissa; she pulled back' }, reason: 'roll failed' }],
    flow: { continue: false },
});

async function speakDraft() {
    const chat = __getChat();
    chat.push({ name: 'Narrator', is_user: false, mes: DRAFT, extra: {} });
    await __emit('MESSAGE_RECEIVED', chat.length - 1);
}

async function until(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) return false;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return true;
}

beforeEach(() => {
    __setExtensionSettings({});
    __setOnlineStatus('connected');
    const chat = __getChat();
    chat.length = 0;
    initLiveDirection({
        getActiveScene: () => scene, getCast: () => cast, getPersona: () => null,
        ensureSceneReady: async () => true, getComposerDraft: () => '', clearComposer: () => {},
        sendNormally: () => {}, onStateChange: () => {}, onSettled: () => {}, onFailure: () => {},
        setNativePromptContent: () => {},
    });
    setLiveDirectionTestAdapters({
        requestDirection: async () => { throw new Error('Director must not run in editor mode'); },
        generatePerformer: speakDraft,
        directorEdit: async () => [COMMITTED, '', '```state', fence, '```'].join('\n'),
    });
});

afterEach(async () => {
    await stopLiveDirection();
    clearLiveDirectionFailure();
    setLiveDirectionTestAdapters(null);
});

test('an editor turn posts the Director-committed prose, not the raw draft', async () => {
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    // The committed prose is what lands — the draft is never stored.
    expect(__getChat().at(-1).mes).toBe(COMMITTED);
    expect(__getChat().at(-1).mes).not.toBe(DRAFT);
    // The Director-editor's state fence was recorded.
    expect(listEvents(scene.timelineId, scene.id).map((e) => e.summary)).toEqual(['Eli tried to kiss Marissa; she pulled back']);
});
