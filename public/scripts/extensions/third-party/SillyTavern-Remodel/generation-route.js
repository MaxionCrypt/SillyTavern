const ROLE_LABELS = Object.freeze({ narrator: 'Narrator', loom: 'Loom', story: 'Story co-author' });

export class GenerationRouteError extends Error {
    constructor(message, detail = {}) {
        super(message);
        this.name = 'GenerationRouteError';
        this.detail = Object.freeze({ ...detail });
    }
}

/**
 * Resolve one model-facing job to the exact saved Connection Profile assigned
 * to it. There is deliberately no "current global connection" fallback: that
 * mutable state cannot prove which provider a job actually used.
 */
export function resolveGenerationRoute({ scene, role, profiles = [] } = {}) {
    const normalizedRole = String(role || '').trim().toLowerCase();
    const label = ROLE_LABELS[normalizedRole] || 'Generation job';
    const profileId = String(scene?.generationProfileIds?.[normalizedRole] || '').trim();
    if (!profileId) {
        throw new GenerationRouteError(`${label} has no Connection Profile assigned.`, {
            role: normalizedRole,
            reason: 'unassigned',
        });
    }

    const profile = (Array.isArray(profiles) ? profiles : []).find((item) => String(item?.id || '') === profileId);
    if (!profile) {
        throw new GenerationRouteError(`${label} Connection Profile "${profileId}" is unavailable. Choose another profile for this Scene.`, {
            role: normalizedRole,
            profileId,
            reason: 'missing',
        });
    }

    const model = String(profile.model || '').trim();
    const excludedFields = new Set(Object.values(profile.exclude || {}).map((field) => String(field || '').trim()));
    if (!model || excludedFields.has('model')) {
        throw new GenerationRouteError(`${label} Connection Profile "${String(profile.name || profileId)}" does not include a model. Edit that profile and save Model as part of it.`, {
            role: normalizedRole,
            profileId,
            reason: 'model-unbound',
        });
    }

    return Object.freeze({
        role: normalizedRole,
        profileId,
        profileName: String(profile.name || profileId),
        api: String(profile.api || ''),
        model,
    });
}

/** Capture all routes once so edits made while a turn is running affect only
 * the next job. The returned records contain values, never live profile refs. */
export function snapshotGenerationRoutes({ scene, roles = [], profiles = [] } = {}) {
    const routes = {};
    for (const role of roles) {
        const route = resolveGenerationRoute({ scene, role, profiles });
        routes[route.role] = route;
    }
    return Object.freeze(routes);
}
