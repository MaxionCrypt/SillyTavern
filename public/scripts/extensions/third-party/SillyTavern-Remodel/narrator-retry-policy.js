/**
 * Make a retry materially different when an OpenRouter model used its whole
 * answer for reasoning and returned no visible prose.
 *
 * This edits the request-scoped payload emitted by SillyTavern immediately
 * before fetch. It does not mutate the selected connection profile or the
 * user's reasoning controls. OpenRouter accepts `reasoning.effort: "none"` as
 * the explicit off switch; merely excluding reasoning would still let it
 * consume the output budget invisibly.
 *
 * @param {Record<string, unknown>} request
 * @param {{ emptyRetries?: number, previousReasoningLength?: number }} retry
 * @returns {boolean} whether a reasoning-only recovery was applied
 */
export function applyNarratorRetryPolicy(request, retry = {}) {
    if (!request || typeof request !== 'object') return false;
    if (String(request.chat_completion_source || '').toLowerCase() !== 'openrouter') return false;
    if (Number(retry.emptyRetries) < 1 || Number(retry.previousReasoningLength) < 1) return false;

    request.reasoning_effort = 'none';
    request.include_reasoning = false;
    return true;
}
