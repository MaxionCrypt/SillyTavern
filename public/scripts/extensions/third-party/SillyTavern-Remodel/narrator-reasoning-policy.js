import { getContext } from '../../../st-context.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { normalizeReasoningEffortForModel } from '../../../reasoning-compat.js';

/**
 * Per-Connection-Profile control over how a Narrator request obtains private
 * deliberation. The actual reasoning prompt remains ordinary user-authored
 * recipe content; this module only manages provider-native reasoning fields.
 */
export const NARRATOR_REASONING_MODES = Object.freeze(['native', 'tagged', 'none']);
export const DEFAULT_NARRATOR_REASONING_MODE = 'native';

export function normalizeNarratorReasoningMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    return NARRATOR_REASONING_MODES.includes(mode) ? mode : DEFAULT_NARRATOR_REASONING_MODE;
}

export function getNarratorReasoningMode(profileId, context = getContext()) {
    const id = String(profileId || '').trim();
    if (!id) return DEFAULT_NARRATOR_REASONING_MODE;
    const stored = context?.extensionSettings?.remodel?.narratorReasoningV1?.profiles?.[id];
    return normalizeNarratorReasoningMode(stored);
}

export function setNarratorReasoningMode(profileId, mode, context = getContext()) {
    const id = String(profileId || '').trim();
    if (!id) throw new TypeError('Narrator reasoning mode requires a Connection Profile.');
    const normalized = normalizeNarratorReasoningMode(mode);
    const remodel = context.extensionSettings.remodel ??= {};
    const settings = remodel.narratorReasoningV1 ??= { profiles: {} };
    settings.profiles ??= {};
    if (normalized === DEFAULT_NARRATOR_REASONING_MODE) delete settings.profiles[id];
    else settings.profiles[id] = normalized;
    context.saveSettingsDebounced?.();
    return normalized;
}

/**
 * Apply a user-selected policy only at the provider request seam. Providers
 * with no standardized reasoning controls are deliberately left untouched:
 * their tagged strategy is still governed by the recipe, rather than Remodel
 * guessing at vendor-specific request fields.
 */
export function applyNarratorReasoningPolicy(request, { profileId, context = getContext() } = {}) {
    const resolved = resolveNarratorReasoningPolicy(profileId, context);
    if (request && typeof request === 'object' && Object.keys(resolved.override).length) Object.assign(request, resolved.override);
    return { mode: resolved.mode, applied: Boolean(Object.keys(resolved.override).length) };
}

/** A transport can use this directly when it sends a raw request itself. */
export function resolveNarratorReasoningPolicy(profileId, context = getContext()) {
    const mode = getNarratorReasoningMode(profileId, context);
    return Object.freeze({
        mode,
        override: mode === 'native' ? {} : reasoningDisabledPayload(profileId),
    });
}

/** Reused by recovery: normalized against the actual selected profile. */
export function reasoningDisabledPayload(profileId) {
    try {
        const profile = ConnectionManagerRequestService.getProfile(profileId);
        const selected = ConnectionManagerRequestService.validateProfile(profile);
        if (selected?.selected !== 'openai') return {};
        return {
            reasoning_effort: normalizeReasoningEffortForModel(selected.source, profile?.model, 'none'),
            include_reasoning: false,
        };
    } catch {
        return {};
    }
}
