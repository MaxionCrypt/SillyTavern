import { jest } from '@jest/globals';
import {
    activateWorldSenseSelection,
    materializeWorldSenseActivations,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-activation.js';

const selection = {
    book: 'Living Book',
    selected: [
        { book: 'Living Book', uid: '2' },
        { book: 'Living Book', uid: '2' },
        { book: 'Other Book', uid: '1' },
        { book: 'Living Book', uid: '404' },
    ],
};

test('materializes selected identities as exact native World Info entries without duplicates', () => {
    const data = { entries: {
        1: { uid: 1, comment: 'Ignored', content: 'Wrong book identity.' },
        2: {
            uid: 2,
            comment: 'Vox Mentis',
            content: 'The amulet has rules.',
            position: 4,
            role: 1,
            probability: 73,
            useProbability: true,
            group: 'artifacts',
            preventRecursion: true,
        },
    } };

    const result = materializeWorldSenseActivations(selection, data);

    expect(result.requested).toEqual(['2', '404']);
    expect(result.missing).toEqual(['404']);
    expect(result.entries).toEqual([expect.objectContaining({
        world: 'Living Book',
        uid: 2,
        content: 'The amulet has rules.',
        position: 4,
        role: 1,
        probability: 73,
        useProbability: true,
        group: 'artifacts',
        preventRecursion: true,
    })]);
    expect(data.entries[2]).not.toHaveProperty('world');
});

test('emits one native force-activation batch and reports missing identities', async () => {
    const emit = jest.fn(async () => {});
    const context = {
        getWorldInfoEntriesForBook: jest.fn(async () => [{ world: 'Living Book', uid: 2, content: 'Native lore.', decorators: [] }]),
        eventSource: { emit },
        eventTypes: { WORLDINFO_FORCE_ACTIVATE: 'worldinfo_force_activate' },
    };

    const result = await activateWorldSenseSelection(context, selection, { phase: 'dry-run' });

    expect(context.getWorldInfoEntriesForBook).toHaveBeenCalledWith('Living Book');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('worldinfo_force_activate', [expect.objectContaining({ world: 'Living Book', uid: 2 })]);
    expect(result).toMatchObject({ ok: true, phase: 'dry-run', requested: 2, activated: 1, missing: ['404'] });
});

test('fails open when native lore cannot be loaded', async () => {
    const emit = jest.fn();
    const context = {
        getWorldInfoEntriesForBook: jest.fn(async () => { throw new Error('book unavailable'); }),
        eventSource: { emit },
        eventTypes: { WORLDINFO_FORCE_ACTIVATE: 'worldinfo_force_activate' },
    };

    await expect(activateWorldSenseSelection(context, selection, { phase: 'generation' })).resolves.toMatchObject({
        ok: false,
        phase: 'generation',
        activated: 0,
        error: 'book unavailable',
    });
    expect(emit).not.toHaveBeenCalled();
});

test('an empty or degraded selection leaves native World Info untouched', async () => {
    const context = { getWorldInfoEntriesForBook: jest.fn(), eventSource: { emit: jest.fn() }, eventTypes: {} };
    const result = await activateWorldSenseSelection(context, { book: 'Living Book', selected: [] }, { phase: 'preview' });
    expect(result).toMatchObject({ ok: true, phase: 'preview', requested: 0, activated: 0 });
    expect(context.getWorldInfoEntriesForBook).not.toHaveBeenCalled();
    expect(context.eventSource.emit).not.toHaveBeenCalled();
});
