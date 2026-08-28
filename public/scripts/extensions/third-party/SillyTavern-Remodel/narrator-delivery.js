/**
 * Closed, provider-neutral Narrator prose delivery.
 *
 * This module deliberately knows nothing about Loom, Archive, Goals,
 * Variables, Living Lore, World Sense, SillyTavern chat arrays, or DOM. Its
 * two adapters are a streaming transport and a one-message store. Commit 2
 * leaves it disconnected from production while its lifecycle is proven.
 */

export const NARRATOR_DELIVERY_PROTOCOL = 'remodel-narrator-delivery/1';

/**
 * Transport contract:
 * - `stream(request)` returns an AsyncIterable;
 * - snapshot frames contain cumulative `text` and `reasoning` strings;
 * - one complete frame names the provider finish reason;
 * - `route.profileId` is already resolved and must never be substituted.
 *
 * Message-store contract:
 * - `reserve(meta)` returns one stable identity;
 * - `append(id, delta, meta)` appends only the supplied new suffix;
 * - `finalize(id, result)` persists a non-empty terminal record;
 * - `releaseEmpty(id, result)` may remove only an empty reservation.
 */

const TERMINAL_STATES = new Set(['complete', 'stopped', 'interrupted', 'truncated', 'empty', 'failed']);
const TRUNCATED_REASONS = new Set(['length', 'max_tokens', 'max_output_tokens']);

function requireFunction(owner, name) {
    const value = owner?.[name];
    if (typeof value !== 'function') throw new TypeError(`Narrator delivery requires ${name}().`);
    return value.bind(owner);
}

function freezeDeep(value, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) freezeDeep(child, seen);
    return Object.freeze(value);
}

function immutable(value) {
    return freezeDeep(structuredClone(value));
}

function normalizeStart(input = {}) {
    const deliveryId = String(input.deliveryId || '').trim();
    const sceneId = String(input.sceneId || '').trim();
    const profileId = String(input.route?.profileId || '').trim();
    if (!deliveryId) throw new TypeError('Narrator delivery requires a deliveryId.');
    if (!sceneId) throw new TypeError('Narrator delivery requires a sceneId.');
    if (!profileId) throw new TypeError('Narrator delivery requires an explicit route.profileId.');
    if (!input.prompt || typeof input.prompt !== 'object') throw new TypeError('Narrator delivery requires an explicit prompt snapshot.');
    return immutable({
        protocol: NARRATOR_DELIVERY_PROTOCOL,
        deliveryId,
        sceneId,
        performer: input.performer || null,
        prompt: input.prompt,
        route: input.route,
        maxAttempts: Math.max(1, Math.min(3, Math.floor(Number(input.maxAttempts) || 2))),
    });
}

function normalizeFrame(frame) {
    if (!frame || typeof frame !== 'object') throw new TypeError('Narrator transport emitted an invalid frame.');
    const type = String(frame.type || 'snapshot');
    if (type === 'snapshot') {
        return {
            type,
            text: String(frame.text || ''),
            reasoning: String(frame.reasoning || ''),
        };
    }
    if (type === 'complete') {
        return {
            type,
            finishReason: String(frame.finishReason || '').toLowerCase(),
            truncated: frame.truncated === true,
        };
    }
    throw new TypeError(`Narrator transport emitted unknown frame type "${type}".`);
}

function publicError(error) {
    if (!error) return null;
    return {
        name: String(error.name || 'Error'),
        message: String(error.message || error),
    };
}

/**
 * @param {{
 *   transport: {stream: Function},
 *   messageStore: {reserve: Function, append: Function, finalize: Function, releaseEmpty: Function},
 *   onEvent?: Function,
 * }} dependencies
 */
export function createNarratorDelivery(dependencies = {}) {
    const stream = requireFunction(dependencies.transport, 'stream');
    const reserve = requireFunction(dependencies.messageStore, 'reserve');
    const append = requireFunction(dependencies.messageStore, 'append');
    const finalizeMessage = requireFunction(dependencies.messageStore, 'finalize');
    const releaseEmpty = requireFunction(dependencies.messageStore, 'releaseEmpty');
    const onEvent = typeof dependencies.onEvent === 'function' ? dependencies.onEvent : () => {};

    return Object.freeze({
        start(input) {
            return new NarratorDeliverySession({
                input: normalizeStart(input),
                adapters: { stream, reserve, append, finalizeMessage, releaseEmpty, onEvent },
            });
        },
    });
}

class NarratorDeliverySession {
    #input;
    #adapters;
    #messageId = null;
    #state = 'reserving';
    #attempt = 0;
    #acceptedText = '';
    #receivedText = '';
    #reasoning = '';
    #finishReason = '';
    #recoveryKind = null;
    #heldForDraft = false;
    #releaseHold = null;
    #termination = null;
    #controller = null;
    #result = null;
    #finalizePromise = null;

    constructor({ input, adapters }) {
        this.#input = input;
        this.#adapters = adapters;
        this.completion = this.#run();
    }

    get snapshot() {
        return immutable({
            protocol: this.#input.protocol,
            deliveryId: this.#input.deliveryId,
            sceneId: this.#input.sceneId,
            messageId: this.#messageId,
            state: this.#state,
            attempt: this.#attempt,
            acceptedText: this.#acceptedText,
            acceptedLength: this.#acceptedText.length,
            receivedLength: this.#receivedText.length,
            heldForDraft: this.#heldForDraft,
            finishReason: this.#finishReason,
            terminal: TERMINAL_STATES.has(this.#state),
        });
    }

    updateDraft(value) {
        if (this.#result) return false;
        const held = Boolean(String(value || '').trim());
        if (held === this.#heldForDraft) return false;
        this.#heldForDraft = held;
        this.#state = held ? 'held' : 'streaming';
        this.#emit(held ? 'held' : 'resumed');
        if (!held) {
            this.#acceptReceivedPrefix();
            this.#releaseHold?.();
            this.#releaseHold = null;
        }
        return true;
    }

    stop() {
        return this.#terminate('stopped');
    }

    interrupt() {
        return this.#terminate('interrupted');
    }

    async #terminate(state) {
        if (this.#result) return this.#result;
        if (!this.#termination) {
            this.#termination = state;
            this.#state = state;
            this.#emit(state);
            this.#controller?.abort();
            this.#releaseHold?.();
            this.#releaseHold = null;
        }
        return this.completion;
    }

    async #run() {
        try {
            this.#messageId = await this.#adapters.reserve({
                protocol: this.#input.protocol,
                deliveryId: this.#input.deliveryId,
                sceneId: this.#input.sceneId,
                performer: this.#input.performer,
            });
            if (this.#messageId == null) throw new Error('Narrator message reservation returned no identity.');
            this.#emit('reserved');

            while (!this.#termination && this.#attempt < this.#input.maxAttempts) {
                this.#attempt += 1;
                this.#receivedText = '';
                this.#reasoning = '';
                this.#finishReason = '';
                this.#state = this.#heldForDraft ? 'held' : 'streaming';
                this.#controller = new AbortController();
                this.#emit('attempt');

                let sawCompletion = false;
                let completionState = null;
                const recovery = this.#attempt === 1 ? null : {
                    kind: this.#recoveryKind || 'empty',
                    requestReasoning: false,
                };
                for await (const rawFrame of this.#adapters.stream({
                    protocol: this.#input.protocol,
                    deliveryId: this.#input.deliveryId,
                    prompt: this.#input.prompt,
                    route: this.#input.route,
                    attempt: this.#attempt,
                    recovery,
                    signal: this.#controller.signal,
                })) {
                    if (this.#termination) break;
                    const frame = normalizeFrame(rawFrame);
                    if (frame.type === 'snapshot') {
                        this.#receive(frame);
                        // Backpressure at the delivery boundary while the user
                        // types. The provider transport may keep filling its
                        // private queue, but the accepted message consumes no
                        // further snapshots until the hold clears. On resume,
                        // queued snapshots therefore pass through transport
                        // pacing instead of becoming one catch-up jump.
                        if (this.#heldForDraft && this.#receivedText.length > this.#acceptedText.length && !this.#termination) {
                            // eslint-disable-next-line no-await-in-loop
                            await new Promise((resolve) => { this.#releaseHold = resolve; });
                        }
                    } else {
                        sawCompletion = true;
                        this.#finishReason = frame.finishReason;
                        if (frame.truncated || TRUNCATED_REASONS.has(frame.finishReason)) {
                            completionState = 'truncated';
                        }
                    }
                }
                this.#controller = null;
                if (this.#heldForDraft && this.#receivedText.length > this.#acceptedText.length && !this.#termination) {
                    await new Promise((resolve) => { this.#releaseHold = resolve; });
                }
                if (this.#termination) break;
                if (completionState) return this.#finish(completionState);
                if (this.#acceptedText) {
                    return this.#finish(sawCompletion ? 'complete' : 'truncated');
                }
                if (this.#attempt < this.#input.maxAttempts) {
                    this.#recoveryKind = this.#reasoning ? 'reasoning-only' : 'empty';
                    this.#emit(this.#reasoning ? 'reasoning-only' : 'empty-retry');
                    continue;
                }
                return this.#finish('empty');
            }
            return this.#finish(this.#termination || 'stopped');
        } catch (error) {
            this.#controller = null;
            if (this.#termination) return this.#finish(this.#termination);
            return this.#finish('failed', error);
        }
    }

    #receive(frame) {
        if (!frame.text.startsWith(this.#receivedText)) {
            throw new Error('Narrator stream rewrote an already received prefix.');
        }
        this.#receivedText = frame.text;
        this.#reasoning = frame.reasoning;
        this.#emit('snapshot');
        if (!this.#heldForDraft) this.#acceptReceivedPrefix();
    }

    #acceptReceivedPrefix() {
        if (!this.#receivedText.startsWith(this.#acceptedText)) {
            throw new Error('Narrator stream diverged from the accepted prefix.');
        }
        const delta = this.#receivedText.slice(this.#acceptedText.length);
        if (!delta) return;
        this.#acceptedText += delta;
        this.#adapters.append(this.#messageId, delta, {
            deliveryId: this.#input.deliveryId,
            acceptedLength: this.#acceptedText.length,
        });
        this.#emit('accepted');
    }

    async #finish(state, error = null) {
        if (this.#finalizePromise) return this.#finalizePromise;
        this.#state = state;
        const result = immutable({
            protocol: this.#input.protocol,
            deliveryId: this.#input.deliveryId,
            sceneId: this.#input.sceneId,
            messageId: this.#messageId,
            status: state,
            acceptedText: this.#acceptedText,
            acceptedLength: this.#acceptedText.length,
            attemptCount: this.#attempt,
            finishReason: this.#finishReason,
            error: publicError(error),
        });
        this.#result = result;
        this.#finalizePromise = (async () => {
            if (this.#acceptedText) {
                await this.#adapters.finalizeMessage(this.#messageId, result);
            } else if (this.#messageId != null) {
                await this.#adapters.releaseEmpty(this.#messageId, result);
            }
            this.#emit('finalized');
            return result;
        })();
        return this.#finalizePromise;
    }

    #emit(type) {
        try {
            this.#adapters.onEvent(immutable({ type, snapshot: this.snapshot }));
        } catch {
            // Diagnostics and render subscribers never own delivery.
        }
    }
}
