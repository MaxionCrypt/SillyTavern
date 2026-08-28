import { beforeEach, expect, test } from '@jest/globals';
import {
    clearUiLocation,
    loadUiLocation,
    saveUiLocation,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/ui-location-store.js';

function memoryStorage() {
    const values = new Map();
    return {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key),
    };
}

let storage;
beforeEach(() => { storage = memoryStorage(); });

test('stable workspace location survives a reload-shaped round trip', () => {
    saveUiLocation({
        currentWindow: { kind: 'tavern', tab: 'debug' },
        activeTavernTab: 'debug',
        focusedTimelineId: 'timeline-1',
        codexOpen: false,
        archive: { open: true, sceneId: 'scene-4', view: 'narrator' },
        scroll: { key: 'archive:scene-4', top: 913 },
    }, storage);

    expect(loadUiLocation(storage)).toEqual(expect.objectContaining({
        currentWindow: { kind: 'tavern', tab: 'debug' },
        focusedTimelineId: 'timeline-1',
        archive: { open: true, sceneId: 'scene-4', view: 'narrator' },
        scroll: { key: 'archive:scene-4', top: 913 },
    }));
});

test('transient request and modal state is never persisted', () => {
    const saved = saveUiLocation({
        currentWindow: { kind: 'tavern', tab: 'timeline' },
        createModalOpen: true,
        isGenerating: true,
        controller: { abort: true },
        editingId: 'archive-record',
    }, storage);

    expect(saved).not.toHaveProperty('createModalOpen');
    expect(saved).not.toHaveProperty('isGenerating');
    expect(saved).not.toHaveProperty('controller');
    expect(saved).not.toHaveProperty('editingId');
});

test('corrupt or unsupported stored state fails closed to the default location', () => {
    storage.setItem('sillytavern-remodel-ui-location-v1', '{broken');
    expect(loadUiLocation(storage)).toEqual(expect.objectContaining({
        currentWindow: { kind: 'native' },
        activeTavernTab: 'timeline',
    }));

    storage.setItem('sillytavern-remodel-ui-location-v1', JSON.stringify({ version: 99, currentWindow: { kind: 'tavern', tab: 'debug' } }));
    expect(loadUiLocation(storage).currentWindow).toEqual({ kind: 'native' });
});

test('clear removes only the Remodel location record', () => {
    saveUiLocation({ currentWindow: { kind: 'tavern', tab: 'prompts' } }, storage);
    clearUiLocation(storage);
    expect(loadUiLocation(storage).currentWindow).toEqual({ kind: 'native' });
});

