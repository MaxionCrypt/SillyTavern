import {
    advanceDirectionProgress,
    createDirectionProgress,
    describeDirectionProgress,
    settleDirectionProgress,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-progress.js';

describe('directed turn progress', () => {
    test('records stage and total durations without mutating prior snapshots', () => {
        const context = createDirectionProgress('turn-1', 1000);
        const lore = advanceDirectionProgress(context, 'lore', 1250);
        const narrator = advanceDirectionProgress(lore, 'narrator', 1500);

        expect(context.stage).toBe('context');
        expect(describeDirectionProgress(narrator, 2000)).toMatchObject({
            id: 'narrator',
            label: 'Narrator drafting',
            elapsedMs: 500,
            totalMs: 1000,
            completed: [
                { id: 'context', durationMs: 250 },
                { id: 'lore', durationMs: 250 },
            ],
        });
    });

    test('cannot move backwards and settles only once', () => {
        const loom = advanceDirectionProgress(createDirectionProgress('turn-2', 0), 'loom', 400);
        expect(advanceDirectionProgress(loom, 'lore', 500)).toBe(loom);

        const stopped = settleDirectionProgress(loom, 'stopped', 700);
        expect(describeDirectionProgress(stopped, 900)).toMatchObject({
            id: 'loom',
            status: 'stopped',
            elapsedMs: 300,
            totalMs: 700,
        });
        expect(settleDirectionProgress(stopped, 'complete', 800)).toBe(stopped);
    });
});
