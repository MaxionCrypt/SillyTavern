import { expect, test } from '@jest/globals';
import {
    GenerationRouteError,
    resolveGenerationRoute,
    snapshotGenerationRoutes,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/generation-route.js';

const profiles = [
    { id: 'narrator-route', name: 'Narrator GLM', api: 'openrouter', model: 'z-ai/glm-5.3' },
    { id: 'loom-route', name: 'Loom Fast', api: 'openrouter', model: 'qwen/qwen3' },
];

test('a generation role resolves only its explicitly assigned profile', () => {
    const scene = { generationProfileIds: { narrator: 'narrator-route', loom: 'loom-route' } };

    expect(resolveGenerationRoute({ scene, role: 'narrator', profiles })).toEqual({
        role: 'narrator',
        profileId: 'narrator-route',
        profileName: 'Narrator GLM',
        api: 'openrouter',
        model: 'z-ai/glm-5.3',
    });
    expect(resolveGenerationRoute({ scene, role: 'loom', profiles }).profileId).toBe('loom-route');
});

test('an unassigned role fails instead of inheriting the active SillyTavern connection', () => {
    expect(() => resolveGenerationRoute({
        scene: { generationProfileIds: { narrator: null } },
        role: 'narrator',
        profiles,
    })).toThrow(new GenerationRouteError('Narrator has no Connection Profile assigned.'));
});

test('a deleted profile fails with a repairable role-specific error', () => {
    expect(() => resolveGenerationRoute({
        scene: { generationProfileIds: { loom: 'deleted-route' } },
        role: 'loom',
        profiles,
    })).toThrow('Loom Connection Profile "deleted-route" is unavailable');
});

test('a profile that excludes its model is rejected instead of inheriting mutable global state', () => {
    expect(() => resolveGenerationRoute({
        scene: { generationProfileIds: { loom: 'unbound-route' } },
        role: 'loom',
        profiles: [{ id: 'unbound-route', name: 'Kimi profile', api: 'openrouter', exclude: ['model'] }],
    })).toThrow('Loom Connection Profile "Kimi profile" does not include a model');
});

test('a turn snapshots independent immutable Narrator and Loom routes', () => {
    const scene = { generationProfileIds: { narrator: 'narrator-route', loom: 'loom-route' } };
    const routes = snapshotGenerationRoutes({ scene, roles: ['narrator', 'loom'], profiles });

    scene.generationProfileIds.loom = 'narrator-route';
    profiles[0].model = 'changed-after-start';

    expect(routes.narrator.model).toBe('z-ai/glm-5.3');
    expect(routes.loom.profileId).toBe('loom-route');
    expect(Object.isFrozen(routes)).toBe(true);
    expect(Object.isFrozen(routes.loom)).toBe(true);
});
