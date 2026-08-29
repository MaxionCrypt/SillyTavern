// The optional Scene Council.
//
// A local advisory pass that prepares bounded packets about the scene while the
// user reads or types. It is deliberately powerless: packets are RECORDED
// first and sent to the Narrator only when a packet type is explicitly
// activated, one at a time, inside a token budget.
//
// The hard rule this module exists to enforce: the Narrator's time to first
// token must never depend on Council completion. Nothing here is awaited on
// the visible path — a caller asks what is *already* ready and moves on.
//
// The local model is injected. Choosing one is deliberately deferred until
// there are benchmarks (plan §12); this is the harness that will measure it.

/** The five packet types, recorded in this order. */
export const SCENE_COUNCIL_PACKETS = Object.freeze([
    'actor-intent',
    'knowledge-gate',
    'mechanics-watcher',
    'continuity-scout',
    'scene-pressure',
]);

export const DEFAULT_COUNCIL_TIMEOUT_MS = 4000;
export const DEFAULT_COUNCIL_TOKEN_BUDGET = 600;

/** Roughly four characters to a token — enough to hold a budget, not a claim
 * about any particular tokenizer. */
const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);

/**
 * @param {object} options
 * @param {(input: {packet: string, scene: object, signal: AbortSignal}) => Promise<string>} options.infer
 *        the local model call; injected so no model choice is baked in here
 */
export function createSceneCouncil({
    infer,
    timeoutMs = DEFAULT_COUNCIL_TIMEOUT_MS,
    tokenBudget = DEFAULT_COUNCIL_TOKEN_BUDGET,
    now = () => 0,
} = {}) {
    /** @type {Map<string, {revision: string, packets: Map<string, object>}>} */
    const cache = new Map();
    let inFlight = null;

    /** A scene's cache identity. A changed revision is a different scene state,
     * so its packets are stale by definition rather than by heuristic. */
    const cacheKey = (scene) => `${scene?.timelineId || ''}:${scene?.id || ''}`;
    const revisionOf = (scene) => String(scene?.revision ?? '');

    function readCache(scene) {
        const entry = cache.get(cacheKey(scene));
        if (!entry || entry.revision !== revisionOf(scene)) return null;
        return entry;
    }

    /**
     * Start (or reuse) a prefetch. Returns a handle, never the packets: a caller
     * that awaited this would be putting the local model on the visible path,
     * which is the one thing the Council may not do.
     */
    function prefetch(scene, { signal } = {}) {
        const existing = readCache(scene);
        if (existing && existing.packets.size === SCENE_COUNCIL_PACKETS.length) {
            return { started: false, reason: 'cache-warm' };
        }
        if (inFlight && inFlight.key === cacheKey(scene) && inFlight.revision === revisionOf(scene)) {
            return { started: false, reason: 'already-running' };
        }
        cancel();

        const controller = new AbortController();
        if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
        const entry = { revision: revisionOf(scene), packets: new Map() };
        cache.set(cacheKey(scene), entry);

        const run = (async () => {
            for (const packet of SCENE_COUNCIL_PACKETS) {
                if (controller.signal.aborted) break;
                // Every packet fails soft and independently. One slow or broken
                // advisory must not deny the others, and must never surface as
                // a turn failure — the Council is advice, not a dependency.
                const text = await withTimeout(
                    () => infer({ packet, scene, signal: controller.signal }),
                    timeoutMs,
                    controller.signal,
                ).catch(() => null);
                if (controller.signal.aborted) break;
                entry.packets.set(packet, Object.freeze({
                    packet,
                    text: typeof text === 'string' ? text : '',
                    ok: typeof text === 'string',
                    at: now(),
                }));
            }
        })();

        inFlight = { key: cacheKey(scene), revision: revisionOf(scene), controller, run };
        // Failures are already absorbed per packet; this guards the loop itself.
        run.catch(() => {});
        return { started: true, reason: 'started' };
    }

    function cancel() {
        if (!inFlight) return false;
        inFlight.controller.abort();
        inFlight = null;
        return true;
    }

    /** Whatever is ready right now. Never waits. */
    function ready(scene) {
        const entry = readCache(scene);
        if (!entry) return Object.freeze([]);
        return Object.freeze([...entry.packets.values()].filter((item) => item.ok && item.text));
    }

    /** Test seam: await the current prefetch without exposing it to callers. */
    async function settle() {
        if (inFlight) await inFlight.run;
    }

    function invalidate(scene) {
        return cache.delete(cacheKey(scene));
    }

    /**
     * What may actually reach the Narrator. Recording is the default and
     * activation is opt-in per packet type, so a packet that was merely
     * observed can never drift into the prompt.
     */
    function forPrompt(scene, { active = [], budget = tokenBudget } = {}) {
        // No validation of `active` names is needed: only canonical packets are
        // ever recorded, so a name that is not one of them simply matches
        // nothing. Filtering first looked safer but was unreachable.
        const allowed = new Set(active);
        const chosen = [];
        let spent = 0;
        for (const item of ready(scene)) {
            if (!allowed.has(item.packet)) continue;
            const cost = estimateTokens(item.text);
            if (spent + cost > budget) continue;
            spent += cost;
            chosen.push(item);
        }
        return Object.freeze({ packets: Object.freeze(chosen), tokens: spent });
    }

    return Object.freeze({ prefetch, cancel, ready, settle, invalidate, forPrompt });
}

function withTimeout(start, ms, signal) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error('Scene Council packet timed out.'));
        }, ms);
        const finish = (fn) => (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(value);
        };
        signal?.addEventListener('abort', finish(reject), { once: true });
        Promise.resolve().then(start).then(finish(resolve), finish(reject));
    });
}
