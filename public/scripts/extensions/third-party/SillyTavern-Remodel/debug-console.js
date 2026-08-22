import { getContext } from '../../../st-context.js';
import { getMechanicsProfile, updateMechanicsProfile } from './variables-store.js';

const STORAGE_KEY = 'remodel.debugJournal.v1';
const SETTINGS_KEY = 'remodel.debugJournal.settings.v1';
const CHANNEL_NAME = 'remodel.debugJournal.live.v1';
const MAX_RECORDS = 5000;
const PERSISTED_RECORDS = 1000;
// Persistence is a convenience — it survives a reload — and it was costing the
// app its responsiveness to provide it. `persist` serializes up to
// PERSISTED_RECORDS records, and a record's detail can hold a whole 15KB
// prompt body, so one flush could stringify megabytes. On a 250ms timer that
// ran four times a second, synchronously, on the main thread, for the entire
// length of a streaming response — which is exactly when the app has the least
// to spare. Slower timer, idle callback where the browser offers one, and a
// byte budget so a flush is bounded no matter what the records contain.
const PERSIST_INTERVAL_MS = 2000;
const PERSIST_BYTE_BUDGET = 512 * 1024;
// The live cross-tab mirror structured-clones every record. Batched, for the
// same reason.
const BROADCAST_INTERVAL_MS = 400;
const MAX_PENDING_MUTATIONS = 500;
const MAX_TEXT = 32000;
const SECRET_KEY = /authorization|api[-_]?key|token|secret|password|cookie|session/i;
const SENSITIVE_KEY = /prompt|messages|content|response|body|description|history|persona|character|payload|raw|objective|constraints|currentAction|draft|text/i;
const SAFE_HEADER_KEY = /^(content-type|content-encoding|x-content-type-options|x-response-time)$/i;

let records = [];
let nextSequence = 1;
let initialized = false;
let flushTimer = null;
let mutationTimer = null;
let pendingMutations = [];
let originalFetch = null;
let originalConsole = null;
let xhrInstalled = false;
let liveChannel = null;
let broadcastTimer = null;
let pendingBroadcast = [];
let refreshHandle = 0;
let droppedMutations = 0;
const TAB_ID = `tab-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;

const settings = {
    recording: true,
    captureSensitive: false,
    // The DOM recorder is the single highest-volume source in the journal and
    // the least diagnostic: a streaming response mutates the document on every
    // token, and the resulting `dom/mutation.batch` records outnumbered every
    // other category combined in each of the owner's exports. Off unless it is
    // actually being used to chase a rendering bug.
    recordDom: false,
    viewPaused: false,
    category: 'all',
    severity: 'all',
    source: 'all',
    search: '',
    selectedId: '',
};

function now() {
    return new Date().toISOString();
}

function createId() {
    return `debug-${TAB_ID}-${Date.now().toString(36)}-${nextSequence++}`;
}

function currentSource() {
    const scene = document.querySelector('[data-remodel-rp-scene-title]')?.textContent?.trim();
    const tab = document.querySelector('[data-remodel-tavern-tab].is-active span')?.textContent?.trim();
    return {
        tabId: TAB_ID,
        shortId: TAB_ID.slice(-5).toUpperCase(),
        label: scene || tab || document.title || 'SillyTavern',
        url: location.href,
    };
}

function truncate(value) {
    const text = String(value ?? '');
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}...[truncated ${text.length - MAX_TEXT}]` : text;
}

function sanitize(value, key = '', depth = 0, seen = new WeakSet()) {
    if (value == null) return value;
    if (SECRET_KEY.test(key)) return '[redacted secret]';
    if (!settings.captureSensitive && SENSITIVE_KEY.test(key) && !SAFE_HEADER_KEY.test(key)) return '[sensitive capture disabled]';
    if (depth > 8) return '[depth limit]';
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return truncate(value);
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
    if (value instanceof Error) return { name: value.name, message: value.message, stack: truncate(value.stack || '') };
    if (value instanceof Event) return describeEvent(value);
    if (value instanceof Element) return describeElement(value);
    if (typeof value !== 'object') return truncate(value);
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitize(item, key, depth + 1, seen));
    const result = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 200)) {
        result[childKey] = sanitize(childValue, childKey, depth + 1, seen);
    }
    return result;
}

function describeElement(element) {
    if (!(element instanceof Element)) return null;
    const classes = [...element.classList].slice(0, 8);
    return {
        tag: element.tagName.toLowerCase(),
        id: element.id || undefined,
        classes,
        role: element.getAttribute('role') || undefined,
        name: element.getAttribute('name') || undefined,
        action: [...element.attributes]
            .find((attribute) => attribute.name.startsWith('data-remodel-') && attribute.value)?.value,
        label: truncate(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent?.trim().slice(0, 160) || ''),
    };
}

function describeEvent(event) {
    return {
        type: event.type,
        target: describeElement(event.target),
        key: event instanceof KeyboardEvent ? event.key : undefined,
        button: event instanceof MouseEvent ? event.button : undefined,
        defaultPrevented: event.defaultPrevented,
    };
}

function load() {
    try {
        const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]');
        if (Array.isArray(saved)) records = saved.slice(-PERSISTED_RECORDS);
        const savedSettings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        Object.assign(settings, savedSettings, { viewPaused: false, selectedId: '' });
    } catch {
        records = [];
    }
}

/**
 * Newest records that fit inside PERSIST_BYTE_BUDGET.
 *
 * Bounded by BYTES, not by count, because the count says nothing about the
 * cost: one `fetch.request` record carrying a 15KB prompt body is worth
 * hundreds of `click` records, and it was the byte size that made a flush
 * block the main thread. Walks newest-first and stops at the budget, so what
 * survives a reload is always the most recent thing that happened.
 */
function persistableRecords() {
    const kept = [];
    let bytes = 0;
    for (let index = records.length - 1; index >= 0 && kept.length < PERSISTED_RECORDS; index--) {
        const encoded = JSON.stringify(records[index]);
        if (bytes + encoded.length > PERSIST_BYTE_BUDGET) break;
        bytes += encoded.length;
        kept.push(records[index]);
    }
    return kept.reverse();
}

function persist() {
    flushTimer = null;
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persistableRecords()));
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({
            recording: settings.recording,
            captureSensitive: settings.captureSensitive,
            recordDom: settings.recordDom,
        }));
    } catch (error) {
        originalConsole?.warn?.('Remodel debug journal could not persist.', error);
    }
}

function schedulePersist() {
    if (flushTimer) return;
    // requestIdleCallback where it exists, so a flush waits for a gap rather
    // than taking one. The timeout keeps it bounded on browsers that never go
    // idle, and setTimeout is the fallback for Safari.
    flushTimer = typeof requestIdleCallback === 'function'
        ? requestIdleCallback(persist, { timeout: PERSIST_INTERVAL_MS * 2 })
        : setTimeout(persist, PERSIST_INTERVAL_MS);
}

/**
 * Mirror to other tabs in batches.
 *
 * `postMessage` structured-clones whatever it is given, so doing it per record
 * paid a full deep copy of every prompt body on every event, on the main
 * thread, whether or not a second tab existed to receive it.
 */
function scheduleBroadcast(record) {
    if (!liveChannel) return;
    pendingBroadcast.push(record);
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
        broadcastTimer = null;
        const batch = pendingBroadcast.splice(0);
        if (batch.length) liveChannel?.postMessage({ type: 'records', sender: TAB_ID, records: batch });
    }, BROADCAST_INTERVAL_MS);
}

/**
 * Repaint the console at most once a frame, and only when it is on screen.
 *
 * This used to run on EVERY recorded event, unconditionally, re-rendering up
 * to MAX_RECORDS rows into innerHTML — including while the workspace was
 * closed and nothing could see the result.
 */
function scheduleWorkspaceRefresh() {
    if (refreshHandle) return;
    if (!document.querySelector('[data-remodel-debug-stream]')) return;
    refreshHandle = requestAnimationFrame(() => {
        refreshHandle = 0;
        refreshDebugConsoleWorkspace();
    });
}

export function recordDebugEvent(category, type, detail = {}, options = {}) {
    if (!settings.recording && !options.force) return null;
    const record = {
        id: createId(),
        sequence: records.length ? records[records.length - 1].sequence + 1 : 1,
        at: now(),
        elapsedMs: Math.round(performance.now()),
        category: String(category || 'app'),
        type: String(type || 'event'),
        severity: String(options.severity || 'info'),
        correlationId: options.correlationId || null,
        source: currentSource(),
        summary: truncate(options.summary || type || 'Event'),
        detail: sanitize(detail),
    };
    records.push(record);
    if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
    schedulePersist();
    scheduleBroadcast(record);
    scheduleWorkspaceRefresh();
    return record;
}

function acceptRemoteRecords(incoming) {
    const known = new Set(records.map((record) => record.id));
    let changed = false;
    for (const record of Array.isArray(incoming) ? incoming : [incoming]) {
        if (!record?.id || known.has(record.id)) continue;
        known.add(record.id);
        records.push(record);
        changed = true;
    }
    if (!changed) return;
    records.sort((left, right) => String(left.at || '').localeCompare(String(right.at || '')) || Number(left.sequence || 0) - Number(right.sequence || 0));
    if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
    schedulePersist();
    window.dispatchEvent(new CustomEvent('remodel-debug-record', { detail: { remote: true } }));
}

function broadcastSharedSettings() {
    liveChannel?.postMessage({
        type: 'settings',
        sender: TAB_ID,
        settings: { recording: settings.recording, captureSensitive: settings.captureSensitive },
    });
}

function initCrossTabChannel() {
    if (liveChannel || typeof BroadcastChannel === 'undefined') return;
    liveChannel = new BroadcastChannel(CHANNEL_NAME);
    liveChannel.addEventListener('message', (event) => {
        const message = event.data;
        if (!message || message.sender === TAB_ID) return;
        if (message.type === 'record') acceptRemoteRecords(message.record);
        if (message.type === 'records') acceptRemoteRecords(message.records);
        if (message.type === 'sync-request') {
            liveChannel.postMessage({ type: 'snapshot', sender: TAB_ID, target: message.sender, records: records.slice(-PERSISTED_RECORDS) });
        }
        if (message.type === 'snapshot' && message.target === TAB_ID) acceptRemoteRecords(message.records);
        if (message.type === 'settings') {
            settings.recording = Boolean(message.settings?.recording);
            settings.captureSensitive = Boolean(message.settings?.captureSensitive);
            persist();
            refreshDebugConsoleWorkspace();
        }
        if (message.type === 'clear') clearLocalDebugRecords();
    });
    liveChannel.postMessage({ type: 'sync-request', sender: TAB_ID });
}

function installSillyTavernEvents() {
    const context = getContext();
    const uniqueEvents = [...new Set(Object.values(context.eventTypes || {}).filter((value) => typeof value === 'string'))];
    for (const eventName of uniqueEvents) {
        context.eventSource?.on?.(eventName, (...args) => recordDebugEvent('sillytavern', eventName, { payload: args }, {
            summary: `${eventName} (${args.length} argument${args.length === 1 ? '' : 's'})`,
        }));
    }
    recordDebugEvent('debug', 'instrumentation.events-installed', { eventCount: uniqueEvents.length });
}

async function readRequestBody(input, init) {
    try {
        const hasBody = init?.body != null || (input instanceof Request && !['GET', 'HEAD'].includes(input.method.toUpperCase()));
        if (!hasBody) return null;
        if (!settings.captureSensitive) return '[sensitive capture disabled]';
        if (init?.body == null && input instanceof Request) return truncate(await input.clone().text());
        if (typeof init?.body === 'string') return truncate(init.body);
        if (init?.body instanceof URLSearchParams) return truncate(init.body.toString());
        if (init?.body instanceof FormData) {
            return Object.fromEntries([...init.body.entries()].map(([key, value]) => [key, value instanceof File ? `[file ${value.name}, ${value.size} bytes]` : value]));
        }
        return init?.body == null ? null : `[${init.body.constructor?.name || typeof init.body}]`;
    } catch (error) {
        return `[unreadable request body: ${error.message}]`;
    }
}

function sanitizeHeaders(headers) {
    try {
        return Object.fromEntries([...new Headers(headers || {}).entries()].map(([key, value]) => [key, SECRET_KEY.test(key) ? '[redacted secret]' : value]));
    } catch {
        return {};
    }
}

function installFetchRecorder() {
    if (originalFetch || typeof window.fetch !== 'function') return;
    originalFetch = window.fetch.bind(window);
    window.fetch = async function remodelDebugFetch(input, init = {}) {
        const requestId = `request-${crypto.randomUUID?.() || Date.now().toString(36)}`;
        const url = input instanceof Request ? input.url : String(input);
        const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
        const started = performance.now();
        recordDebugEvent('network', 'fetch.request', {
            requestId, url, method,
            headers: sanitizeHeaders(init.headers || (input instanceof Request ? input.headers : undefined)),
            body: await readRequestBody(input, init),
        }, { correlationId: requestId, summary: `${method} ${url}` });
        try {
            const response = await originalFetch(input, init);
            let responseBody = '[sensitive capture disabled]';
            if (settings.captureSensitive) {
                const contentType = response.headers.get('content-type') || '';
                responseBody = /event-stream/.test(contentType)
                    ? '[stream body is recorded through generation events]'
                    : /json|text/.test(contentType) ? truncate(await response.clone().text()) : `[${contentType || 'binary'}]`;
            }
            recordDebugEvent('network', 'fetch.response', {
                requestId, url: response.url || url, method, status: response.status, ok: response.ok,
                durationMs: Math.round(performance.now() - started),
                headers: sanitizeHeaders(response.headers), responseBody,
            }, { correlationId: requestId, severity: response.ok ? 'info' : 'warn', summary: `${response.status} ${method} ${url}` });
            return response;
        } catch (error) {
            recordDebugEvent('network', 'fetch.failure', { requestId, url, method, durationMs: Math.round(performance.now() - started), error }, {
                correlationId: requestId, severity: 'error', summary: `FAILED ${method} ${url}`,
            });
            throw error;
        }
    };
}

function installXhrRecorder() {
    if (xhrInstalled || typeof XMLHttpRequest === 'undefined') return;
    xhrInstalled = true;
    const states = new WeakMap();
    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;
    const nativeSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function remodelDebugXhrOpen(method, url, ...rest) {
        states.set(this, { requestId: `xhr-${crypto.randomUUID?.() || Date.now().toString(36)}`, method: String(method).toUpperCase(), url: String(url), headers: {} });
        return nativeOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.setRequestHeader = function remodelDebugXhrHeader(name, value) {
        const state = states.get(this);
        if (state) state.headers[name] = SECRET_KEY.test(name) ? '[redacted secret]' : String(value);
        return nativeSetRequestHeader.call(this, name, value);
    };
    XMLHttpRequest.prototype.send = function remodelDebugXhrSend(body) {
        const state = states.get(this) || { requestId: `xhr-${Date.now().toString(36)}`, method: 'GET', url: '', headers: {} };
        state.started = performance.now();
        recordDebugEvent('network', 'xhr.request', {
            ...state,
            body: body == null ? null : settings.captureSensitive ? sanitize(body, 'body') : '[sensitive capture disabled]',
        }, { correlationId: state.requestId, summary: `${state.method} ${state.url}` });
        this.addEventListener('loadend', () => {
            let responseBody = '[sensitive capture disabled]';
            if (settings.captureSensitive) {
                try {
                    responseBody = this.responseType === '' || this.responseType === 'text' ? truncate(this.responseText) : `[${this.responseType || 'unknown response'}]`;
                } catch (error) {
                    responseBody = `[unreadable response: ${error.message}]`;
                }
            }
            recordDebugEvent('network', 'xhr.response', {
                requestId: state.requestId,
                method: state.method,
                url: this.responseURL || state.url,
                status: this.status,
                durationMs: Math.round(performance.now() - state.started),
                responseBody,
            }, { correlationId: state.requestId, severity: this.status >= 400 || this.status === 0 ? 'warn' : 'info', summary: `${this.status} ${state.method} ${state.url}` });
        }, { once: true });
        return nativeSend.call(this, body);
    };
}

function installUiRecorder() {
    const capture = (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target || target.closest('.remodel-debug-workspace')) return;
        const detail = describeEvent(event);
        if (event.type === 'change' && target instanceof HTMLInputElement) {
            detail.checked = target.type === 'checkbox' || target.type === 'radio' ? target.checked : undefined;
            detail.value = settings.captureSensitive && !/password/i.test(target.type) ? truncate(target.value) : '[redacted input]';
        }
        recordDebugEvent('ui', event.type, detail, { summary: `${event.type}: ${detail.target?.label || detail.target?.id || detail.target?.tag || 'unknown'}` });
    };
    document.addEventListener('click', capture, true);
    document.addEventListener('change', capture, true);
    document.addEventListener('submit', capture, true);
    document.addEventListener('keydown', (event) => {
        if (!['Enter', 'Escape', 'Tab'].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) return;
        capture(event);
    }, true);
}

/**
 * The DOM recorder, which is off unless `recordDom` is switched on.
 *
 * A streaming response mutates the document on every token. Left running it
 * produced more records than every other category combined, and each one cost
 * a `closest()` walk per mutation plus a sanitize of up to 36 described
 * elements. Recording the DOM while chasing a rendering bug is worth that;
 * recording it during ordinary play was paying for a diagnostic nobody was
 * reading.
 */
function installMutationRecorder() {
    const observer = new MutationObserver((mutations) => {
        if (!settings.recordDom || !settings.recording) return;
        // Bounded, and NOT spread. `push(...mutations)` passes every mutation
        // as an argument, which on a heavy batch can exceed the argument limit
        // outright; and an unbounded queue during a long stream grows until
        // the flush walks all of it. Overflow is counted rather than silently
        // dropped, so the record says what it did not see.
        for (const mutation of mutations) {
            if (pendingMutations.length >= MAX_PENDING_MUTATIONS) { droppedMutations++; continue; }
            pendingMutations.push(mutation);
        }
        if (mutationTimer) return;
        mutationTimer = setTimeout(() => {
            mutationTimer = null;
            // Resolved ONCE per flush. `closest()` walks to the root, and
            // calling it per mutation made the filter cost scale with both the
            // batch size and the DOM depth — on the flush that is already the
            // expensive part of this recorder.
            const workspace = document.querySelector('.remodel-debug-workspace');
            const batch = pendingMutations.splice(0).filter((mutation) => {
                if (workspace && mutation.target instanceof Node && workspace.contains(mutation.target)) return false;
                if (mutation.type === 'attributes' && mutation.attributeName) {
                    const currentValue = mutation.target.getAttribute?.(mutation.attributeName);
                    if ((mutation.oldValue ?? null) === (currentValue ?? null)) return false;
                }
                return true;
            });
            if (!batch.length) return;
            let added = 0;
            let removed = 0;
            let attributes = 0;
            const samples = [];
            const addedNodes = [];
            const removedNodes = [];
            for (const mutation of batch) {
                added += mutation.addedNodes.length;
                removed += mutation.removedNodes.length;
                if (mutation.type === 'attributes') attributes += 1;
                for (const node of mutation.addedNodes) {
                    if (addedNodes.length < 12 && node instanceof Element) addedNodes.push(describeElement(node));
                }
                for (const node of mutation.removedNodes) {
                    if (removedNodes.length < 12 && node instanceof Element) removedNodes.push(describeElement(node));
                }
                if (samples.length < 12 && mutation.target instanceof Element) {
                    samples.push({ kind: mutation.type, target: describeElement(mutation.target), attribute: mutation.attributeName || undefined });
                }
            }
            const skipped = droppedMutations;
            droppedMutations = 0;
            if (added || removed || attributes) recordDebugEvent('dom', 'mutation.batch', { mutationCount: batch.length, added, removed, attributes, addedNodes, removedNodes, samples, skipped }, {
                summary: `DOM +${added} -${removed} ~${attributes}${skipped ? ` (${skipped} not recorded)` : ''}`,
            });
        }, 120);
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'hidden', 'open', 'aria-expanded'] });
}

function installErrorRecorder() {
    window.addEventListener('error', (event) => recordDebugEvent('error', 'window.error', { message: event.message, filename: event.filename, line: event.lineno, column: event.colno, error: event.error }, { severity: 'error' }));
    window.addEventListener('unhandledrejection', (event) => recordDebugEvent('error', 'unhandledrejection', { reason: event.reason }, { severity: 'error' }));
    originalConsole = { warn: console.warn.bind(console), error: console.error.bind(console) };
    for (const level of ['warn', 'error']) {
        console[level] = (...args) => {
            recordDebugEvent('console', level, { arguments: args }, { severity: level === 'error' ? 'error' : 'warn', summary: `console.${level}` });
            originalConsole[level](...args);
        };
    }
}

export function initDebugConsole() {
    if (initialized) return;
    initialized = true;
    load();
    initCrossTabChannel();
    installErrorRecorder();
    installFetchRecorder();
    installXhrRecorder();
    installUiRecorder();
    installMutationRecorder();
    installSillyTavernEvents();
    recordDebugEvent('debug', 'journal.started', {
        url: location.href,
        userAgent: navigator.userAgent,
        captureSensitive: settings.captureSensitive,
    }, { force: true, summary: 'Debug journal started' });
    Object.defineProperty(window, 'RemodelDebugConsole', {
        configurable: true,
        value: Object.freeze({
            record: recordDebugEvent,
            list: () => structuredClone(records),
            clear: clearDebugRecords,
            export: downloadDebugRecords,
            settings: () => ({ ...settings }),
        }),
    });
}

export function clearDebugRecords() {
    clearLocalDebugRecords();
    liveChannel?.postMessage({ type: 'clear', sender: TAB_ID });
    recordDebugEvent('debug', 'journal.cleared', {}, { force: true });
}

function clearLocalDebugRecords() {
    records = [];
    settings.selectedId = '';
    settings.source = 'all';
    sessionStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new CustomEvent('remodel-debug-cleared'));
}

export function downloadDebugRecords() {
    const payload = {
        format: 'remodel-debug-journal/1',
        exportedAt: now(),
        captureSensitive: settings.captureSensitive,
        page: { url: location.href, userAgent: navigator.userAgent },
        records,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `remodel-debug-${now().replaceAll(':', '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    recordDebugEvent('debug', 'journal.exported', { recordCount: records.length }, { force: true });
}

function filteredRecords() {
    const needle = settings.search.trim().toLowerCase();
    return records.filter((record) => {
        if (settings.category !== 'all' && record.category !== settings.category) return false;
        if (settings.severity !== 'all' && record.severity !== settings.severity) return false;
        if (settings.source !== 'all' && record.source?.tabId !== settings.source) return false;
        if (!needle) return true;
        return `${record.type} ${record.summary} ${record.category} ${JSON.stringify(record.detail)}`.toLowerCase().includes(needle);
    });
}

function escapeHtml(value) {
    const node = document.createElement('div');
    node.textContent = String(value ?? '');
    return node.innerHTML;
}

function renderRows() {
    return filteredRecords().slice(-750).reverse().map((record) => `
        <button type="button" class="remodel-debug-row ${record.id === settings.selectedId ? 'is-selected' : ''} is-${escapeHtml(record.severity)}" data-remodel-debug-select="${escapeHtml(record.id)}">
            <time>${escapeHtml(record.at.slice(11, 23))}</time>
            <span class="remodel-debug-source" title="${escapeHtml(record.source?.label || 'Legacy record')}">${escapeHtml(record.source?.shortId || 'LOCAL')}</span>
            <span class="remodel-debug-category">${escapeHtml(record.category)}</span>
            <strong>${escapeHtml(record.type)}</strong>
            <span class="remodel-debug-summary">${escapeHtml(record.summary)}</span>
        </button>`).join('') || '<p class="remodel-debug-empty">No records match these filters.</p>';
}

function renderDetail() {
    const record = records.find((item) => item.id === settings.selectedId) || filteredRecords().at(-1);
    if (!record) return '<p class="remodel-debug-empty">Select an event to inspect its structured record.</p>';
    settings.selectedId = record.id;
    return `<div class="remodel-debug-detail-heading"><span>${escapeHtml(record.category)}</span><strong>${escapeHtml(record.type)}</strong><time>${escapeHtml(record.at)}</time></div><pre>${escapeHtml(JSON.stringify(record, null, 2))}</pre>`;
}

export function renderDebugConsoleWorkspace() {
    const categories = ['all', ...new Set(records.map((record) => record.category))];
    const sources = [...new Map(records.filter((record) => record.source?.tabId).map((record) => [record.source.tabId, record.source])).values()];
    return `
        <section class="remodel-debug-workspace">
            <header class="remodel-debug-header">
                <div><span>Application observatory</span><h2>Debug Console</h2></div>
                <div class="remodel-debug-actions">
                    <button type="button" data-remodel-debug-action="record">${settings.recording ? 'Pause recording' : 'Resume recording'}</button>
                    <button type="button" data-remodel-debug-action="view">${settings.viewPaused ? 'Resume view' : 'Pause view'}</button>
                    <button type="button" data-remodel-debug-action="dom" title="Record every DOM mutation. High volume — a streaming response mutates the document on every token — so this is off unless you are chasing a rendering bug.">${settings.recordDom ? 'Stop DOM capture' : 'Capture DOM'}</button>
                    <button type="button" data-remodel-debug-action="export">Export JSON</button>
                    <button type="button" data-remodel-debug-action="clear">Clear</button>
                </div>
            </header>
            <div class="remodel-debug-safety ${settings.captureSensitive ? 'is-sensitive' : ''}">
                <label><input type="checkbox" data-remodel-debug-sensitive ${settings.captureSensitive ? 'checked' : ''}> Capture prompt, message, request, and response bodies</label>
                <span>Secrets, cookies, authorization headers, and password fields are always redacted.</span>
            </div>
            ${renderMechanicsProfile()}
            <div class="remodel-debug-filters">
                <select data-remodel-debug-source><option value="all">all source tabs</option>${sources.map((source) => `<option value="${escapeHtml(source.tabId)}" ${settings.source === source.tabId ? 'selected' : ''}>${escapeHtml(source.shortId)} · ${escapeHtml(source.label)}</option>`).join('')}</select>
                <select data-remodel-debug-category>${categories.map((category) => `<option value="${escapeHtml(category)}" ${settings.category === category ? 'selected' : ''}>${escapeHtml(category)}</option>`).join('')}</select>
                <select data-remodel-debug-severity><option value="all">all severities</option>${['info', 'warn', 'error'].map((severity) => `<option value="${severity}" ${settings.severity === severity ? 'selected' : ''}>${severity}</option>`).join('')}</select>
                <input type="search" data-remodel-debug-search value="${escapeHtml(settings.search)}" placeholder="Search event types, summaries, and JSON...">
                <output><b>LIVE</b> · ${new Set(records.map((record) => record.source?.tabId).filter(Boolean)).size || 1} tab${new Set(records.map((record) => record.source?.tabId).filter(Boolean)).size === 1 ? '' : 's'} · ${filteredRecords().length} / ${records.length}</output>
            </div>
            <div class="remodel-debug-grid">
                <div class="remodel-debug-stream" data-remodel-debug-stream>${renderRows()}</div>
                <aside class="remodel-debug-detail" data-remodel-debug-detail>${renderDetail()}</aside>
            </div>
        </section>`;
}

/**
 * The Mechanics profile lives here rather than in a Variables workspace: it
 * decides whether the Loom may change stored facts at all, and while that
 * pipeline is still being hardened the people who need the switch are the
 * people reading this journal. It moves to the Timeline State drawer once that
 * surface exists.
 */
function renderMechanicsProfile() {
    const profile = getMechanicsProfile();
    const option = (value, label, selected) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`;
    return `
        <details class="remodel-debug-mechanics" ${profile.enabled ? 'open' : ''}>
            <summary>Mechanics profile — <b>${profile.enabled ? 'enabled' : 'disabled'}</b></summary>
            <div class="remodel-debug-mechanics-grid">
                <label class="is-wide"><input type="checkbox" data-remodel-debug-mechanics="enabled" ${profile.enabled ? 'checked' : ''}>
                    Let the Loom propose changes to Goals and Variables</label>
                <label>Context budget
                    <input type="number" min="1000" max="32000" step="500" data-remodel-debug-mechanics="contextBudget" value="${profile.contextBudget}"></label>
                <label title="One budget covering both kinds. Goals and Variables are scored in a single ranking and the top of it travels, so a Goal-poor turn spends the budget on Variables and the reverse.">Goals and Variables per pass
                    <input type="number" min="1" max="16" data-remodel-debug-mechanics="retrievalLimit" value="${profile.retrievalLimit}"></label>
                <label>Recent messages scanned
                    <input type="number" min="1" max="60" data-remodel-debug-mechanics="retrievalWindow" value="${profile.retrievalWindow}"></label>
                <label>Authority
                    <select data-remodel-debug-mechanics="automationPolicy">
                        ${option('hybrid', 'Hybrid — world auto, you review', profile.automationPolicy)}
                        ${option('review-all', 'Review everything', profile.automationPolicy)}
                        ${option('automatic', 'Apply everything', profile.automationPolicy)}
                    </select></label>
                <label>On failure
                    <select data-remodel-debug-mechanics="failureBehavior">
                        ${option('pause', 'Pause and show it', profile.failureBehavior)}
                        ${option('bypass', 'Carry on without mechanics', profile.failureBehavior)}
                        ${option('retry-once', 'Retry once, then pause', profile.failureBehavior)}
                    </select></label>
            </div>
            <p class="remodel-debug-mechanics-note">The budget sizes how much mechanical state enters the Loom recipe. Response
                length and reasoning effort come from the Loom connection profile selected for the scene.</p>
        </details>`;
}

export function refreshDebugConsoleWorkspace() {
    if (settings.viewPaused) return;
    const stream = document.querySelector('[data-remodel-debug-stream]');
    const detail = document.querySelector('[data-remodel-debug-detail]');
    if (stream) stream.innerHTML = renderRows();
    if (detail) detail.innerHTML = renderDetail();
    const output = document.querySelector('.remodel-debug-filters output');
    if (output) {
        const sourceCount = new Set(records.map((record) => record.source?.tabId).filter(Boolean)).size || 1;
        output.innerHTML = `<b>LIVE</b> · ${sourceCount} tab${sourceCount === 1 ? '' : 's'} · ${filteredRecords().length} / ${records.length}`;
    }
}

export function handleDebugConsoleClick(target, requestRender) {
    const selection = target.closest('[data-remodel-debug-select]');
    if (selection) {
        settings.selectedId = selection.dataset.remodelDebugSelect || '';
        refreshDebugConsoleWorkspace();
        return true;
    }
    const action = target.closest('[data-remodel-debug-action]')?.dataset.remodelDebugAction;
    if (!action) return false;
    if (action === 'record') settings.recording = !settings.recording;
    if (action === 'view') settings.viewPaused = !settings.viewPaused;
    if (action === 'dom') settings.recordDom = !settings.recordDom;
    if (action === 'export') downloadDebugRecords();
    if (action === 'clear') clearDebugRecords();
    persist();
    if (action === 'record' || action === 'dom') broadcastSharedSettings();
    requestRender();
    return true;
}

export function handleDebugConsoleInput(target) {
    if (target.matches('[data-remodel-debug-search]')) settings.search = target.value || '';
    else return false;
    refreshDebugConsoleWorkspace();
    return true;
}

export function handleDebugConsoleChange(target, requestRender) {
    const mechanicsField = target.dataset?.remodelDebugMechanics;
    if (mechanicsField) {
        const value = target.type === 'checkbox' ? target.checked : target.value;
        const applied = updateMechanicsProfile({ [mechanicsField]: value });
        // Store-clamped, so echo what was actually stored rather than what was typed.
        recordDebugEvent('variables', 'mechanics.profile.changed', { field: mechanicsField, stored: applied[mechanicsField] },
            { force: true, severity: mechanicsField === 'enabled' && applied.enabled ? 'warn' : 'info', summary: `Mechanics ${mechanicsField} = ${applied[mechanicsField]}` });
        requestRender();
        return true;
    }
    if (target.matches('[data-remodel-debug-source]')) settings.source = target.value;
    else if (target.matches('[data-remodel-debug-category]')) settings.category = target.value;
    else if (target.matches('[data-remodel-debug-severity]')) settings.severity = target.value;
    else if (target.matches('[data-remodel-debug-sensitive]')) {
        settings.captureSensitive = target.checked;
        recordDebugEvent('debug', 'sensitive-capture.changed', { enabled: settings.captureSensitive }, { force: true, severity: settings.captureSensitive ? 'warn' : 'info' });
    } else return false;
    persist();
    if (target.matches('[data-remodel-debug-sensitive]')) broadcastSharedSettings();
    requestRender();
    return true;
}

// Deliberately NOT a per-record listener any more. recordDebugEvent calls
// scheduleWorkspaceRefresh itself, which coalesces to one repaint per frame
// and does nothing at all when the workspace is not mounted.

window.addEventListener('remodel-debug-cleared', refreshDebugConsoleWorkspace);
