import { getContext } from '../../../st-context.js';
import { ARCHIVE_ACTION_MAX_CHARS, ARCHIVE_STATE_MAX_CHARS } from './archive-ingestion.js';

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'archiveJobsV1';
const STORE_VERSION = 1;
export const ARCHIVE_JOB_PROSE_MAX_CHARS = 12_000;
export const ARCHIVE_JOB_PROMPT_MAX_CHARS = 48_000;
export const ARCHIVE_JOB_MAX_MESSAGES = 24;
export const ARCHIVE_JOB_MAX_PER_TIMELINE = 200;

export const ARCHIVE_JOB_STATUS = Object.freeze({
    PENDING: 'pending',
    RUNNING: 'running',
    RETRYING: 'retrying',
    SUCCEEDED: 'succeeded',
    FAILED_REPAIRABLE: 'failed-repairable',
    REJECTED: 'rejected',
    SUPERSEDED: 'superseded',
    CANCELLED: 'cancelled',
});

const JOB_STATUSES = new Set(Object.values(ARCHIVE_JOB_STATUS));
const PROVENANCE_KINDS = new Set(['current-turn', 'interrupted-prefix', 'catch-up', 'story-passage']);
const OBSOLETE_STATUSES = new Set([
    ARCHIVE_JOB_STATUS.SUCCEEDED,
    ARCHIVE_JOB_STATUS.REJECTED,
    ARCHIVE_JOB_STATUS.SUPERSEDED,
    ARCHIVE_JOB_STATUS.CANCELLED,
]);

export function createMemoryArchiveJobPersistence(initial = null) {
    let value = clone(initial);
    return Object.freeze({
        load: () => clone(value),
        save: (next) => { value = clone(next); },
        snapshot: () => clone(value),
    });
}

export function createArchiveJobRepository({ persistence = defaultPersistence(), now = () => Date.now() } = {}) {
    if (!persistence || typeof persistence.load !== 'function' || typeof persistence.save !== 'function') {
        throw new TypeError('Archive job persistence requires load and save functions.');
    }
    let store = normalizeStore(persistence.load());

    function persist() {
        persistence.save(store);
    }

    function locate(jobId) {
        const id = String(jobId || '');
        for (const timeline of Object.values(store.timelines)) {
            const index = timeline.jobs.findIndex((job) => job.jobId === id);
            if (index >= 0) return { timeline, index, job: timeline.jobs[index] };
        }
        return null;
    }

    return Object.freeze({
        enqueue(input) {
            const normalized = normalizeArchiveJob(input, now());
            const prior = locate(normalized.jobId)?.job;
            if (prior) {
                if (prior.fingerprint !== normalized.fingerprint) {
                    throw new Error(`Archive job identity collision for ${normalized.jobId}.`);
                }
                return immutable(prior);
            }
            const timeline = timelineBucket(store, normalized.timelineId);
            const queued = { ...normalized, queueSeq: timeline.nextSeq++ };
            timeline.jobs.push(queued);
            compactTimeline(timeline);
            persist();
            return immutable(queued);
        },
        get(jobId) {
            return immutable(locate(jobId)?.job || null);
        },
        list(timelineId) {
            const jobs = store.timelines[String(timelineId || '')]?.jobs || [];
            return immutable(jobs.slice().sort(jobOrder));
        },
        timelineIds() {
            return Object.keys(store.timelines);
        },
        update(jobId, patch) {
            const found = locate(jobId);
            if (!found) return null;
            const value = typeof patch === 'function' ? patch(immutable(found.job)) : patch;
            const next = { ...found.job, ...(value && typeof value === 'object' ? clone(value) : {}), updatedAt: now() };
            if (!JOB_STATUSES.has(next.status)) throw new Error(`Unknown Archive job status: ${next.status}`);
            found.timeline.jobs[found.index] = OBSOLETE_STATUSES.has(next.status) ? compactTerminalJob(next) : next;
            persist();
            return immutable(found.timeline.jobs[found.index]);
        },
        next(timelineId) {
            const at = now();
            const jobs = store.timelines[String(timelineId || '')]?.jobs || [];
            const candidate = jobs.slice().sort(jobOrder).find((job) =>
                job.status === ARCHIVE_JOB_STATUS.PENDING
                || job.status === ARCHIVE_JOB_STATUS.RETRYING && Number(job.nextAttemptAt || 0) <= at);
            return immutable(candidate || null);
        },
        recover() {
            const recovered = [];
            for (const timeline of Object.values(store.timelines)) {
                for (let index = 0; index < timeline.jobs.length; index += 1) {
                    const job = timeline.jobs[index];
                    if (job.status !== ARCHIVE_JOB_STATUS.RUNNING) continue;
                    timeline.jobs[index] = {
                        ...job,
                        status: ARCHIVE_JOB_STATUS.PENDING,
                        nextAttemptAt: 0,
                        updatedAt: now(),
                        recoveryCount: Number(job.recoveryCount || 0) + 1,
                    };
                    recovered.push(job.jobId);
                }
            }
            if (recovered.length) persist();
            return recovered;
        },
        snapshot() {
            return immutable(store);
        },
    });
}

export function describeArchiveWorkerStatus(jobs) {
    const ordered = (Array.isArray(jobs) ? jobs : []).slice().sort((a, b) => jobOrder(b, a));
    const active = ordered.find((job) => [ARCHIVE_JOB_STATUS.RUNNING, ARCHIVE_JOB_STATUS.RETRYING, ARCHIVE_JOB_STATUS.PENDING].includes(job.status));
    if (active?.status === ARCHIVE_JOB_STATUS.RUNNING) return immutable({ status: 'running', label: 'Updating Archive', jobId: active.jobId });
    if (active?.status === ARCHIVE_JOB_STATUS.RETRYING) return immutable({ status: 'retrying', label: 'Archive retrying', jobId: active.jobId, error: clone(active.error) });
    if (active?.status === ARCHIVE_JOB_STATUS.PENDING) return immutable({ status: 'pending', label: 'Archive queued', jobId: active.jobId });
    const latest = ordered.find((job) => ![ARCHIVE_JOB_STATUS.SUPERSEDED, ARCHIVE_JOB_STATUS.CANCELLED].includes(job.status));
    if (latest?.status === ARCHIVE_JOB_STATUS.FAILED_REPAIRABLE) {
        return immutable({
            status: 'failed', label: 'Archive needs attention', jobId: latest.jobId,
            error: clone(latest.error), repairAction: 'retry',
        });
    }
    return immutable({ status: 'idle', label: '', jobId: null });
}

export function normalizeArchiveJob(input = {}, createdAt = Date.now()) {
    const mode = input.mode === 'story' ? 'story' : input.mode === 'roleplay' ? 'roleplay' : '';
    const timelineId = requiredText(input.timelineId, 'Timeline identity');
    const sceneId = requiredText(input.sceneId, 'Scene identity');
    const acceptedProse = requiredText(input.acceptedProse, 'Archive job accepted prose');
    if (acceptedProse.length > ARCHIVE_JOB_PROSE_MAX_CHARS) {
        throw new Error(`Archive job accepted prose exceeds ${ARCHIVE_JOB_PROSE_MAX_CHARS} characters.`);
    }
    if (!mode) throw new Error('Archive job requires Story or Roleplay provenance.');
    const provenance = normalizeProvenance(input.provenance);
    const routeSnapshot = normalizeRoute(input.routeSnapshot);
    const promptSnapshot = normalizePrompt(input.promptSnapshot);
    const stable = {
        mode, timelineId, sceneId, acceptedProse, provenance,
        archiveContext: tail(input.archiveContext, ARCHIVE_STATE_MAX_CHARS),
        currentPlayerAction: tail(input.currentPlayerAction, ARCHIVE_ACTION_MAX_CHARS),
        routeSnapshot,
        promptSnapshot,
    };
    const fingerprint = hashText(stableStringify(stable));
    const jobId = String(input.jobId || '').trim() || `archive:${hashText(stableStringify({
        mode, timelineId, sceneId, sourceId: provenance.sourceId,
        checkpointId: provenance.checkpointId, acceptedProse,
    }))}`;
    return {
        jobId,
        fingerprint,
        ...stable,
        status: ARCHIVE_JOB_STATUS.PENDING,
        attempts: 0,
        nextAttemptAt: 0,
        error: null,
        result: null,
        createdAt: Number(createdAt) || 0,
        updatedAt: Number(createdAt) || 0,
        recoveryCount: 0,
    };
}

export function isArchiveJobTerminal(status) {
    return OBSOLETE_STATUSES.has(status) || status === ARCHIVE_JOB_STATUS.FAILED_REPAIRABLE;
}

function normalizeProvenance(value) {
    const source = value && typeof value === 'object' ? value : {};
    const kind = PROVENANCE_KINDS.has(source.kind) ? source.kind : '';
    if (!kind) throw new Error('Archive job provenance requires a recognized kind.');
    const sourceId = requiredText(source.sourceId, 'Archive job source identity');
    return {
        kind,
        sourceId,
        documentId: String(source.documentId || '').trim(),
        messageId: source.messageId == null ? null : String(source.messageId),
        checkpointId: String(source.checkpointId || '').trim(),
        interrupted: Boolean(source.interrupted),
        supersedesJobIds: uniqueStrings(source.supersedesJobIds),
    };
}

function normalizeRoute(value) {
    const source = value && typeof value === 'object' ? value : {};
    const profileId = requiredText(source.profileId, 'Archive job Loom profile');
    return {
        role: 'loom',
        profileId,
        profileName: String(source.profileName || profileId),
        api: String(source.api || ''),
        model: String(source.model || ''),
    };
}

function normalizePrompt(value) {
    const source = value && typeof value === 'object' ? value : {};
    const sourceMessages = Array.isArray(source.messages) ? source.messages : [];
    if (sourceMessages.length > ARCHIVE_JOB_MAX_MESSAGES) {
        throw new Error(`Archive job prompt exceeds ${ARCHIVE_JOB_MAX_MESSAGES} messages.`);
    }
    const messages = sourceMessages.map((message) => ({
        role: ['system', 'user', 'assistant'].includes(message?.role) ? message.role : 'system',
        content: String(message?.content || ''),
    }));
    if (!messages.length || !messages.some((message) => message.content.trim())) {
        throw new Error('Archive job requires a compiled Loom recipe prompt.');
    }
    const total = messages.reduce((sum, message) => sum + message.content.length, 0);
    if (total > ARCHIVE_JOB_PROMPT_MAX_CHARS) throw new Error(`Archive job prompt exceeds ${ARCHIVE_JOB_PROMPT_MAX_CHARS} characters.`);
    return {
        recipeId: String(source.recipeId || '').trim(),
        recipeName: String(source.recipeName || '').trim(),
        revision: Math.max(0, Math.floor(Number(source.revision) || 0)),
        messages,
    };
}

function defaultPersistence() {
    return {
        load() {
            const context = getContext();
            context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
            return clone(context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY]);
        },
        save(value) {
            const context = getContext();
            context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
            context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY] = clone(value);
            context.saveSettingsDebounced();
        },
    };
}

function normalizeStore(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) && Number(value.version) === STORE_VERSION ? value : {};
    const timelines = {};
    for (const [timelineId, timeline] of Object.entries(source.timelines || {})) {
        const id = String(timelineId || '').trim();
        if (!id) continue;
        const jobs = (Array.isArray(timeline?.jobs) ? timeline.jobs : []).filter((job) => job && JOB_STATUSES.has(job.status)).map(clone);
        timelines[id] = {
            timelineId: id,
            jobs,
            nextSeq: Math.max(Number(timeline?.nextSeq) || 0, ...jobs.map((job) => Number(job.queueSeq) + 1 || 0)),
        };
    }
    return { version: STORE_VERSION, timelines };
}

function timelineBucket(store, timelineId) {
    const id = String(timelineId || '');
    return (store.timelines[id] ??= { timelineId: id, jobs: [], nextSeq: 0 });
}

function compactTimeline(timeline) {
    while (timeline.jobs.length > ARCHIVE_JOB_MAX_PER_TIMELINE) {
        const index = timeline.jobs.findIndex((job) => isArchiveJobTerminal(job.status));
        if (index < 0) break;
        timeline.jobs.splice(index, 1);
    }
}

function compactTerminalJob(job) {
    const promptMessages = Array.isArray(job.promptSnapshot?.messages) ? job.promptSnapshot.messages : [];
    return {
        ...job,
        acceptedProseHash: job.acceptedProseHash || hashText(job.acceptedProse),
        acceptedProse: '',
        archiveContext: '',
        currentPlayerAction: '',
        promptSnapshot: {
            recipeId: String(job.promptSnapshot?.recipeId || ''),
            recipeName: String(job.promptSnapshot?.recipeName || ''),
            revision: Number(job.promptSnapshot?.revision) || 0,
            messageCount: Number(job.promptSnapshot?.messageCount) || promptMessages.length,
            contentHash: job.promptSnapshot?.contentHash || hashText(stableStringify(promptMessages)),
            messages: [],
        },
    };
}

function jobOrder(left, right) {
    return Number(left?.queueSeq || 0) - Number(right?.queueSeq || 0)
        || Number(left?.createdAt || 0) - Number(right?.createdAt || 0)
        || String(left?.jobId || '').localeCompare(String(right?.jobId || ''));
}

function requiredText(value, label) {
    const text = String(value || '').trim();
    if (!text) throw new Error(`${label} is required.`);
    return text;
}

function uniqueStrings(value) {
    return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function tail(value, limit) {
    const text = String(value || '');
    return text.length > limit ? text.slice(-limit) : text;
}

function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function hashText(value) {
    let hash = 0x811c9dc5;
    for (const character of String(value || '')) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function immutable(value) {
    return deepFreeze(clone(value));
}

function clone(value) {
    return value == null ? value : structuredClone(value);
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    return value;
}
