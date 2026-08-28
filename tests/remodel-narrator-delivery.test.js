import fs from 'node:fs';
import { jest } from '@jest/globals';
import {
    createNarratorDelivery,
    NARRATOR_DELIVERY_PROTOCOL,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-delivery.js';

const fixture = JSON.parse(fs.readFileSync('./fixtures/remodel-narrator-delivery.json', 'utf8'));

function createStore() {
    const records = new Map();
    return {
        records,
        reserve: jest.fn(({ deliveryId }) => {
            const id = `message:${deliveryId}`;
            records.set(id, '');
            return id;
        }),
        append: jest.fn((id, delta) => records.set(id, records.get(id) + delta)),
        finalize: jest.fn(),
        releaseEmpty: jest.fn((id) => records.delete(id)),
    };
}

function createTransport(attemptFrames) {
    const calls = [];
    return {
        calls,
        async *stream(request) {
            calls.push(request);
            const frames = attemptFrames[Math.min(request.attempt - 1, attemptFrames.length - 1)] || [];
            for (const frame of frames) yield structuredClone(frame);
        },
    };
}

function startWith({ frames = [fixture.ordinary], transport = null, store = createStore(), input = {} } = {}) {
    const selectedTransport = transport || createTransport(frames);
    const delivery = createNarratorDelivery({ transport: selectedTransport, messageStore: store });
    const session = delivery.start({ ...fixture.request, ...input });
    return { delivery, session, store, transport: selectedTransport };
}

async function until(predicate, attempts = 30) {
    for (let index = 0; index < attempts; index += 1) {
        if (predicate()) return;
        // Let an async iterator and its adapter promises advance without a
        // wall-clock sleep that makes this suite flaky or slow.
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
    }
    throw new Error('Condition was not reached.');
}

test('requires closed transport, message store, prompt, and explicit route contracts', () => {
    expect(() => createNarratorDelivery()).toThrow(/stream/);
    const store = createStore();
    const delivery = createNarratorDelivery({ transport: createTransport([[]]), messageStore: store });
    expect(() => delivery.start({ ...fixture.request, route: null })).toThrow(/profileId/);
    expect(() => delivery.start({ ...fixture.request, prompt: null })).toThrow(/prompt/);
});

test('reserves one message and appends cumulative stream snapshots monotonically', async () => {
    const { session, store, transport } = startWith();
    const result = await session.completion;
    const id = `message:${fixture.request.deliveryId}`;

    expect(result).toEqual(expect.objectContaining({
        protocol: NARRATOR_DELIVERY_PROTOCOL,
        messageId: id,
        status: 'complete',
        acceptedText: 'The room went quiet.',
        attemptCount: 1,
    }));
    expect(store.reserve).toHaveBeenCalledTimes(1);
    expect(store.append.mock.calls.map(([, delta]) => delta)).toEqual(['The room', ' went quiet.']);
    expect(store.records.get(id)).toBe('The room went quiet.');
    expect(store.finalize).toHaveBeenCalledTimes(1);
    expect(store.releaseEmpty).not.toHaveBeenCalled();
    expect(transport.calls[0].route).toEqual(fixture.request.route);
});

test('snapshots the prompt and strict connection route before asynchronous delivery begins', async () => {
    const input = structuredClone(fixture.request);
    const { session, transport } = startWith({ input });
    input.prompt.messages[1].content = 'Mutated after Start';
    input.route.profileId = 'different-profile';
    await session.completion;

    expect(transport.calls[0].prompt.messages[1].content).toBe('Aiden asks what changed.');
    expect(transport.calls[0].route.profileId).toBe('profile-glm');
    expect(Object.isFrozen(transport.calls[0].route)).toBe(true);
});

test('retries reasoning-only output on the same message identity with request-scoped recovery', async () => {
    const { session, store, transport } = startWith({ frames: [fixture.reasoningOnly, fixture.recovered] });
    const result = await session.completion;

    expect(result.status).toBe('complete');
    expect(result.acceptedText).toBe('Marisol answered.');
    expect(result.attemptCount).toBe(2);
    expect(store.reserve).toHaveBeenCalledTimes(1);
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0].recovery).toBeNull();
    expect(transport.calls[1].recovery).toEqual({ kind: 'reasoning-only', requestReasoning: false });
    expect(transport.calls[1].route).toEqual(fixture.request.route);
});

test('an exhausted empty response releases only its empty reservation', async () => {
    const empty = [{ type: 'complete', finishReason: 'stop' }];
    const { session, store } = startWith({ frames: [empty, empty] });
    const result = await session.completion;

    expect(result.status).toBe('empty');
    expect(result.acceptedText).toBe('');
    expect(store.reserve).toHaveBeenCalledTimes(1);
    expect(store.append).not.toHaveBeenCalled();
    expect(store.finalize).not.toHaveBeenCalled();
    expect(store.releaseEmpty).toHaveBeenCalledTimes(1);
});

test('a truncated response keeps and finalizes the accepted prefix', async () => {
    const { session, store } = startWith({ frames: [fixture.truncated] });
    const result = await session.completion;

    expect(result.status).toBe('truncated');
    expect(result.finishReason).toBe('length');
    expect(result.acceptedText).toBe('The sentence stopped');
    expect(store.finalize).toHaveBeenCalledTimes(1);
    expect(store.releaseEmpty).not.toHaveBeenCalled();
});

test('typed interruption preserves the visible prefix and discards the held suffix', async () => {
    let releaseSuffix;
    let suffixYielded;
    const suffixGate = new Promise((resolve) => { releaseSuffix = resolve; });
    const suffixSeen = new Promise((resolve) => { suffixYielded = resolve; });
    const transport = {
        async *stream() {
            yield { type: 'snapshot', text: 'Visible.', reasoning: '' };
            await suffixGate;
            yield { type: 'snapshot', text: 'Visible. Hidden tail.', reasoning: '' };
            suffixYielded();
            yield { type: 'complete', finishReason: 'stop' };
        },
    };
    const { session, store } = startWith({ transport });
    await until(() => session.snapshot.acceptedText === 'Visible.');
    session.updateDraft('The user is typing');
    releaseSuffix();
    await suffixSeen;
    await until(() => session.snapshot.receivedLength > session.snapshot.acceptedLength);
    const result = await session.interrupt();

    expect(result.status).toBe('interrupted');
    expect(result.acceptedText).toBe('Visible.');
    expect(store.records.get(result.messageId)).toBe('Visible.');
    expect(store.finalize).toHaveBeenCalledTimes(1);
});

test('clearing a typed hold appends its buffered suffix once before completion', async () => {
    let releaseSuffix;
    let suffixYielded;
    const suffixGate = new Promise((resolve) => { releaseSuffix = resolve; });
    const suffixSeen = new Promise((resolve) => { suffixYielded = resolve; });
    const transport = {
        async *stream() {
            yield { type: 'snapshot', text: 'Visible.', reasoning: '' };
            await suffixGate;
            yield { type: 'snapshot', text: 'Visible. Then more.', reasoning: '' };
            suffixYielded();
            yield { type: 'complete', finishReason: 'stop' };
        },
    };
    const { session, store } = startWith({ transport });
    await until(() => session.snapshot.acceptedText === 'Visible.');
    session.updateDraft('typing');
    releaseSuffix();
    await suffixSeen;
    await until(() => session.snapshot.receivedLength > session.snapshot.acceptedLength);
    session.updateDraft('');
    const result = await session.completion;

    expect(result.status).toBe('complete');
    expect(result.acceptedText).toBe('Visible. Then more.');
    expect(store.records.get(result.messageId)).toBe('Visible. Then more.');
    expect(store.append.mock.calls.map(([, delta]) => delta)).toEqual(['Visible.', ' Then more.']);
});

test('Stop aborts delivery and finalizes the prefix without erasing it', async () => {
    let started;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const transport = {
        async *stream({ signal }) {
            yield { type: 'snapshot', text: 'Keep this.', reasoning: '' };
            started();
            await new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            });
        },
    };
    const { session, store } = startWith({ transport });
    await startedPromise;
    await until(() => session.snapshot.acceptedText === 'Keep this.');
    const [first, second] = await Promise.all([session.stop(), session.stop()]);

    expect(first).toBe(second);
    expect(first.status).toBe('stopped');
    expect(first.acceptedText).toBe('Keep this.');
    expect(store.finalize).toHaveBeenCalledTimes(1);
    expect(store.releaseEmpty).not.toHaveBeenCalled();
});

test('provider errors preserve accepted prose and release only an actually empty message', async () => {
    const afterText = startWith({ transport: {
        async *stream() {
            yield { type: 'snapshot', text: 'Canon remains.', reasoning: '' };
            throw new Error('provider disconnected');
        },
    } });
    const withText = await afterText.session.completion;
    expect(withText.status).toBe('failed');
    expect(withText.error.message).toBe('provider disconnected');
    expect(afterText.store.records.get(withText.messageId)).toBe('Canon remains.');
    expect(afterText.store.finalize).toHaveBeenCalledTimes(1);

    const beforeText = startWith({ transport: {
        async *stream() {
            throw new Error('provider unavailable');
        },
    } });
    const empty = await beforeText.session.completion;
    expect(empty.status).toBe('failed');
    expect(empty.acceptedText).toBe('');
    expect(beforeText.store.releaseEmpty).toHaveBeenCalledTimes(1);
    expect(beforeText.store.finalize).not.toHaveBeenCalled();
});

test('rejects a provider snapshot that rewrites an already delivered prefix', async () => {
    const rewritten = [
        { type: 'snapshot', text: 'First wording', reasoning: '' },
        { type: 'snapshot', text: 'Different wording', reasoning: '' },
    ];
    const { session, store } = startWith({ frames: [rewritten] });
    const result = await session.completion;

    expect(result.status).toBe('failed');
    expect(result.error.message).toMatch(/rewrote/);
    expect(result.acceptedText).toBe('First wording');
    expect(store.records.get(result.messageId)).toBe('First wording');
    expect(store.finalize).toHaveBeenCalledTimes(1);
});

test('remains disconnected from the production turn and legacy adapter', () => {
    const timelineSpine = fs.readFileSync('../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-spine.js', 'utf8');
    const adapter = fs.readFileSync('../public/scripts/extensions/third-party/SillyTavern-Remodel/legacy-directed-turn-adapter.js', 'utf8');

    expect(timelineSpine).not.toContain('narrator-delivery.js');
    expect(adapter).not.toContain('narrator-delivery.js');
});
