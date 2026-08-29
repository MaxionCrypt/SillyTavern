import { jest } from '@jest/globals';
import {
    SCENE_COUNCIL_PACKETS,
    createSceneCouncil,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/scene-council.js';

const SCENE = { id: 'scene-1', timelineId: 'timeline-1', revision: 'r1' };
const council = (infer, options = {}) => createSceneCouncil({ infer, ...options });
const echo = () => jest.fn(async ({ packet }) => `advice about ${packet}`);

test('the five packet types are recorded in order', async () => {
    const infer = echo();
    const c = council(infer);
    c.prefetch(SCENE);
    await c.settle();

    expect(infer.mock.calls.map((call) => call[0].packet)).toEqual([...SCENE_COUNCIL_PACKETS]);
    expect(c.ready(SCENE).map((item) => item.packet)).toEqual([...SCENE_COUNCIL_PACKETS]);
});

test('recorded packets do not reach the Narrator until activated one at a time', async () => {
    const c = council(echo());
    c.prefetch(SCENE);
    await c.settle();

    expect(c.forPrompt(SCENE).packets).toEqual([]);
    expect(c.forPrompt(SCENE, { active: [] }).packets).toEqual([]);

    const one = c.forPrompt(SCENE, { active: ['actor-intent'] });
    expect(one.packets.map((item) => item.packet)).toEqual(['actor-intent']);

    const two = c.forPrompt(SCENE, { active: ['actor-intent', 'scene-pressure'] });
    expect(two.packets.map((item) => item.packet)).toEqual(['actor-intent', 'scene-pressure']);
});

test('an unknown packet name selects nothing, and does not smuggle in the real ones', async () => {
    const c = council(echo());
    c.prefetch(SCENE);
    await c.settle();
    expect(c.forPrompt(SCENE, { active: ['everything', 'sudo'] }).packets).toEqual([]);
    // A bogus name alongside a real one activates only the real one.
    expect(c.forPrompt(SCENE, { active: ['sudo', 'scene-pressure'] }).packets.map((item) => item.packet))
        .toEqual(['scene-pressure']);
});

test('the token budget trims rather than overruns', async () => {
    const c = council(jest.fn(async () => 'x'.repeat(400))); // ~100 tokens each
    c.prefetch(SCENE);
    await c.settle();

    const tight = c.forPrompt(SCENE, { active: [...SCENE_COUNCIL_PACKETS], budget: 250 });
    expect(tight.packets.length).toBe(2);
    expect(tight.tokens).toBeLessThanOrEqual(250);

    const loose = c.forPrompt(SCENE, { active: [...SCENE_COUNCIL_PACKETS], budget: 10000 });
    expect(loose.packets.length).toBe(5);
});

test('the Narrator never waits: ready() answers immediately while inference is pending', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const c = council(async () => { await gate; return 'late advice'; });

    c.prefetch(SCENE);
    // Nothing has resolved, and asking does not block.
    expect(c.ready(SCENE)).toEqual([]);
    expect(c.forPrompt(SCENE, { active: [...SCENE_COUNCIL_PACKETS] }).packets).toEqual([]);

    release();
    await c.settle();
    expect(c.ready(SCENE).length).toBeGreaterThan(0);
});

test('a packet that times out fails soft and does not deny the others', async () => {
    const infer = jest.fn(async ({ packet }) => {
        if (packet === 'knowledge-gate') return new Promise(() => {}); // never settles
        return `advice about ${packet}`;
    });
    const c = council(infer, { timeoutMs: 20 });
    c.prefetch(SCENE);
    await c.settle();

    const names = c.ready(SCENE).map((item) => item.packet);
    expect(names).not.toContain('knowledge-gate');
    expect(names).toContain('actor-intent');
    expect(names).toContain('scene-pressure');
});

test('a throwing packet is absorbed, never surfaced as a turn failure', async () => {
    const c = council(jest.fn(async ({ packet }) => {
        if (packet === 'mechanics-watcher') throw new Error('local model exploded');
        return 'fine';
    }));
    c.prefetch(SCENE);
    await expect(c.settle()).resolves.toBeUndefined();
    expect(c.ready(SCENE).map((item) => item.packet)).not.toContain('mechanics-watcher');
});

test('cancellation stops the run', async () => {
    let calls = 0;
    const c = council(async ({ packet }) => { calls += 1; return packet; });
    c.prefetch(SCENE);
    expect(c.cancel()).toBe(true);
    await c.settle();
    expect(calls).toBeLessThan(SCENE_COUNCIL_PACKETS.length);
});

test('an external abort signal cancels the run', async () => {
    const controller = new AbortController();
    const c = council(async ({ packet }) => packet);
    c.prefetch(SCENE, { signal: controller.signal });
    controller.abort();
    await c.settle();
    expect(c.ready(SCENE).length).toBeLessThan(SCENE_COUNCIL_PACKETS.length);
});

test('a warm cache is reused instead of re-inferring', async () => {
    const infer = echo();
    const c = council(infer);
    c.prefetch(SCENE);
    await c.settle();
    expect(infer).toHaveBeenCalledTimes(5);

    expect(c.prefetch(SCENE)).toMatchObject({ started: false, reason: 'cache-warm' });
    await c.settle();
    expect(infer).toHaveBeenCalledTimes(5);
});

test('a changed scene revision invalidates the cache by definition', async () => {
    const infer = echo();
    const c = council(infer);
    c.prefetch(SCENE);
    await c.settle();

    expect(c.ready({ ...SCENE, revision: 'r2' })).toEqual([]);
    expect(c.prefetch({ ...SCENE, revision: 'r2' })).toMatchObject({ started: true });
    await c.settle();
    expect(infer).toHaveBeenCalledTimes(10);
});

test('invalidate drops a scene from the cache', async () => {
    const c = council(echo());
    c.prefetch(SCENE);
    await c.settle();
    expect(c.ready(SCENE).length).toBe(5);
    expect(c.invalidate(SCENE)).toBe(true);
    expect(c.ready(SCENE)).toEqual([]);
});
