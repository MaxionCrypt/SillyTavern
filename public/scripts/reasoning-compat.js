/**
 * Provider/model reasoning compatibility kept separate from UI settings.
 *
 * OpenRouter normally accepts `none` as its explicit reasoning-off effort,
 * but models whose reasoning is intrinsic reject that value with HTTP 400.
 * Hiding reasoning is still allowed through `reasoning.exclude`; only the
 * model's internal effort must remain at its smallest supported value.
 */

const OPENROUTER_REQUIRED_REASONING_MODELS = [
    /^z-ai\/glm-5\.3(?:$|-)/i,
];

export function openRouterModelRequiresReasoning(model) {
    const id = String(model || '').trim();
    return OPENROUTER_REQUIRED_REASONING_MODELS.some((pattern) => pattern.test(id));
}

export function normalizeReasoningEffortForModel(source, model, effort) {
    if (String(source || '').toLowerCase() !== 'openrouter') return effort;
    if (!openRouterModelRequiresReasoning(model)) return effort;

    const value = String(effort || '').toLowerCase();
    return ['none', 'min', 'minimal'].includes(value) ? 'low' : effort;
}
