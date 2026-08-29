export const ARCHIVE_SETTLEMENT_PROTOCOL = 'remodel/archive-settlement/1';
export const ARCHIVE_SETTLEMENT_TYPE = 'archive.settlement.committed';
export const ARCHIVE_CONSEQUENCE_CHANNELS = Object.freeze([
    'goals',
    'variables',
    'lore',
    'links',
    'continuity',
]);

/**
 * Build the immutable hand-off emitted only after the base Archive has
 * committed. Accepted prose and the Archive transaction are authoritative;
 * every downstream consumer is a fallible projection with its own rollback.
 */
export function createArchiveSettlementEvent(input = {}, now = () => Date.now()) {
    const jobId = requiredText(input.jobId, 'Archive job identity');
    const timelineId = requiredText(input.timelineId, 'Timeline identity');
    const sceneId = requiredText(input.sceneId, 'Scene identity');
    const mode = input.mode === 'story' ? 'story' : input.mode === 'roleplay' ? 'roleplay' : '';
    if (!mode) throw new TypeError('Archive settlement requires Story or Roleplay mode.');
    const transactionId = String(input.transactionId || '');
    return immutable({
        protocol: ARCHIVE_SETTLEMENT_PROTOCOL,
        type: ARCHIVE_SETTLEMENT_TYPE,
        eventId: `archive-settlement:${jobId}`,
        jobId,
        timelineId,
        sceneId,
        mode,
        committedAt: Number(now()) || Date.now(),
        provenance: clone(input.provenance || {}),
        evidence: {
            acceptedProse: String(input.acceptedProse || ''),
            operations: clone(Array.isArray(input.operations) ? input.operations : []),
            lifecycleProposals: clone(Array.isArray(input.lifecycleProposals) ? input.lifecycleProposals : []),
            archiveFacts: clone(Array.isArray(input.archiveFacts) ? input.archiveFacts : []),
            ingestionReceipt: clone(input.ingestionReceipt || {}),
        },
        baseArchive: {
            status: transactionId ? 'applied' : 'no-op',
            transactionId: transactionId || null,
        },
        authority: {
            acceptedProse: 'canonical',
            baseArchive: 'committed',
            consequences: 'projection-only',
        },
        rollback: {
            baseArchiveOwnedBy: transactionId ? 'mechanics-transaction' : 'none',
            subscriberMayRollbackBaseArchive: false,
        },
    });
}

/**
 * Independent consequence fan-out. Every channel is disabled by default and
 * failures become receipts rather than escaping into the Archive worker.
 */
export function createArchiveConsequenceDispatcher({ onError = () => {} } = {}) {
    const subscribers = new Map();
    const enabled = new Set();
    const deliveries = new Map();

    function subscribe(channel, subscriber, options = {}) {
        const key = requireChannel(channel);
        if (typeof subscriber !== 'function') throw new TypeError(`Archive ${key} subscriber must be a function.`);
        subscribers.set(key, subscriber);
        if (options.enabled === true) enabled.add(key);
        else enabled.delete(key);
        return () => {
            if (subscribers.get(key) === subscriber) subscribers.delete(key);
            enabled.delete(key);
        };
    }

    function setEnabled(channel, value) {
        const key = requireChannel(channel);
        if (value === true) enabled.add(key);
        else enabled.delete(key);
    }

    async function publish(event) {
        validateEvent(event);
        const results = await Promise.all(ARCHIVE_CONSEQUENCE_CHANNELS.map((channel) => deliver(channel, event)));
        return immutable({
            protocol: ARCHIVE_SETTLEMENT_PROTOCOL,
            eventId: event.eventId,
            baseArchiveStatus: event.baseArchive.status,
            deliveries: Object.fromEntries(results.map((receipt) => [receipt.channel, receipt])),
        });
    }

    function deliver(channel, event) {
        if (!enabled.has(channel)) return Promise.resolve(immutable({ channel, status: 'disabled' }));
        const subscriber = subscribers.get(channel);
        if (typeof subscriber !== 'function') return Promise.resolve(immutable({ channel, status: 'unavailable' }));
        const deliveryId = `${event.eventId}:${channel}`;
        if (deliveries.has(deliveryId)) return deliveries.get(deliveryId);
        const delivery = Promise.resolve()
            .then(() => subscriber(event))
            .then((receipt) => immutable({ channel, status: 'applied', receipt: clone(receipt || {}) }))
            .catch((error) => {
                try { onError(error, { channel, event }); } catch { /* diagnostics cannot break isolation */ }
                return immutable({ channel, status: 'failed', error: serializeError(error) });
            });
        deliveries.set(deliveryId, delivery);
        return delivery;
    }

    return Object.freeze({ publish, subscribe, setEnabled });
}

const productionDispatcher = createArchiveConsequenceDispatcher();

export function publishArchiveSettlement(event) {
    return productionDispatcher.publish(event);
}

export function registerArchiveConsequenceSubscriber(channel, subscriber, options = {}) {
    return productionDispatcher.subscribe(channel, subscriber, options);
}

export function setArchiveConsequenceSubscriberEnabled(channel, value) {
    productionDispatcher.setEnabled(channel, value);
}

function validateEvent(event) {
    if (!event || event.protocol !== ARCHIVE_SETTLEMENT_PROTOCOL || event.type !== ARCHIVE_SETTLEMENT_TYPE) {
        throw new TypeError('Archive consequence dispatch requires a versioned settlement event.');
    }
    requiredText(event.eventId, 'Archive settlement event identity');
}

function requireChannel(channel) {
    const key = String(channel || '');
    if (!ARCHIVE_CONSEQUENCE_CHANNELS.includes(key)) throw new TypeError(`Unknown Archive consequence channel: ${key || '(empty)'}.`);
    return key;
}

function requiredText(value, label) {
    const text = String(value || '').trim();
    if (!text) throw new TypeError(`${label} is required.`);
    return text;
}

function serializeError(error) {
    return {
        name: String(error?.name || 'Error'),
        message: String(error?.message || error || 'Unknown subscriber failure'),
        code: String(error?.code || ''),
    };
}

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function immutable(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) immutable(child);
    return Object.freeze(value);
}
