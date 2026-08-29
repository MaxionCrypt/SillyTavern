import { jest } from '@jest/globals';
import { createLoreIndexScheduler } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/lore-index-scheduler.js';

/** A controllable clock and timer queue, so no test waits on wall time. */
function fakeTimers() {
    let clock = 0;
    let nextId = 1;
    const timers = new Map();
    return {
        now: () => clock,
        schedule: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: clock + ms }); return id; },
        cancel: (id) => { timers.delete(id); },
        /** Advance time and fire everything due, in order. */
        async advance(ms) {
            clock += ms;
            const due = [...timers.entries()].filter(([, t]) => t.at <= clock).sort((a, b) => a[1].at - b[1].at);
            for (const [id, timer] of due) {
                timers.delete(id);
                timer.fn();
                await Promise.resolve();
                await Promise.resolve();
            }
        },
        count: () => timers.size,
    };
}

const scheduler = (index, overrides = {}) => {
    const timers = fakeTimers();
    return {
        timers,
        instance: createLoreIndexScheduler({
            index, now: timers.now, schedule: timers.schedule, cancel: timers.cancel, ...overrides,
        }),
    };
};

test('an index function is required', () => {
    expect(() => createLoreIndexScheduler({})).toThrow(TypeError);
});

test('a single write indexes once, after the debounce', async () => {
    const index = jest.fn(async () => 'ok');
    const { instance, timers } = scheduler(index);

    instance.request('t1');
    expect(index).not.toHaveBeenCalled();
    expect(instance.pending('t1')).toBe(true);

    await timers.advance(1200);
    expect(index).toHaveBeenCalledTimes(1);
    expect(index).toHaveBeenCalledWith('t1');
    expect(instance.pending('t1')).toBe(false);
});

test('a burst of writes coalesces into one pass', async () => {
    const index = jest.fn(async () => 'ok');
    const { instance, timers } = scheduler(index);

    for (let i = 0; i < 6; i += 1) {
        instance.request('t1');
        await timers.advance(200); // each write resets the debounce
    }
    expect(index).not.toHaveBeenCalled();

    await timers.advance(1200);
    expect(index).toHaveBeenCalledTimes(1);
});

test('a continuous write stream still indexes at the ceiling', async () => {
    const index = jest.fn(async () => 'ok');
    const { instance, timers } = scheduler(index, { maxWaitMs: 3000 });

    // Writes arriving faster than the debounce would defer forever without a cap.
    for (let i = 0; i < 20; i += 1) {
        instance.request('t1');
        await timers.advance(400);
    }
    expect(index).toHaveBeenCalled();
});

test('timelines are scheduled independently', async () => {
    const index = jest.fn(async () => 'ok');
    const { instance, timers } = scheduler(index);

    instance.request('t1');
    instance.request('t2');
    await timers.advance(1200);

    expect(index.mock.calls.map((call) => call[0]).sort()).toEqual(['t1', 't2']);
});

test('a write during a run earns exactly one more pass, not one per write', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const index = jest.fn(async () => { await gate; });
    const { instance, timers } = scheduler(index);

    instance.request('t1');
    await timers.advance(1200);
    expect(index).toHaveBeenCalledTimes(1); // in flight, awaiting the gate

    instance.request('t1');
    instance.request('t1');
    instance.request('t1');
    expect(index).toHaveBeenCalledTimes(1); // still only the one run

    release();
    await Promise.resolve();
    await Promise.resolve();
    await timers.advance(1200);
    expect(index).toHaveBeenCalledTimes(2); // one follow-up covering all three
});

test('two runs never overlap for one timeline', async () => {
    let active = 0;
    let overlapped = false;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const index = jest.fn(async () => {
        active += 1;
        if (active > 1) overlapped = true;
        await gate;
        active -= 1;
    });
    const { instance, timers } = scheduler(index);

    instance.request('t1');
    await timers.advance(1200);
    instance.request('t1');
    await timers.advance(1200);

    release();
    await timers.advance(1200);
    expect(overlapped).toBe(false);
});

test('an index failure is reported, never thrown at the caller', async () => {
    const onError = jest.fn();
    const index = jest.fn(async () => { throw new Error('vector backend down'); });
    const { instance, timers } = scheduler(index, { onError });

    instance.request('t1');
    await expect(timers.advance(1200)).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe('vector backend down');
    expect(onError.mock.calls[0][1]).toBe('t1');
});

test('a failed pass does not wedge the scheduler', async () => {
    let fail = true;
    const index = jest.fn(async () => { if (fail) throw new Error('down'); });
    const { instance, timers } = scheduler(index, { onError: () => {} });

    instance.request('t1');
    await timers.advance(1200);
    fail = false;
    instance.request('t1');
    await timers.advance(1200);

    expect(index).toHaveBeenCalledTimes(2);
    expect(instance.pending('t1')).toBe(false);
});

test('flush indexes immediately, skipping the wait', async () => {
    const index = jest.fn(async () => 'ok');
    const { instance } = scheduler(index);

    instance.request('t1');
    await expect(instance.flush('t1')).resolves.toBe(true);
    expect(index).toHaveBeenCalledTimes(1);
});

test('an empty timeline id is refused rather than scheduled', () => {
    const index = jest.fn();
    const { instance } = scheduler(index);
    expect(instance.request('')).toBe(false);
    expect(instance.request(null)).toBe(false);
    expect(index).not.toHaveBeenCalled();
});

test('stop cancels pending work', async () => {
    const index = jest.fn(async () => 'ok');
    const { instance, timers } = scheduler(index);

    instance.request('t1');
    instance.stop();
    await timers.advance(5000);
    expect(index).not.toHaveBeenCalled();
    expect(instance.pending('t1')).toBe(false);
});
