#!/usr/bin/env node
/**
 * Live session recorder for manual Roleplay testing.
 *
 * Attaches to the ALREADY-RUNNING debug Chrome and records everything that
 * happens while you drive the app by hand. It modifies no application code,
 * navigates nothing, and clicks nothing — you test, it watches.
 *
 * DO NOT REWRITE THIS ON TOP OF PLAYWRIGHT. The first version used
 * chromium.connectOverCDP, and Playwright's Page abstraction AUTO-DISMISSES
 * every JavaScript dialog unless a 'dialog' listener is registered. Remodel
 * gates Delete Timeline / Arc / Scene / Beat / Message / Variable / recipe and
 * Remove-from-Loom-memory behind window.confirm, so simply having the recorder
 * attached made all of them silently no-op — the click registered, confirm()
 * returned false in under 200ms, and nothing errored. A recorder that changes
 * the behaviour of the session it is recording is worse than no recorder.
 *
 * This speaks raw CDP over a WebSocket and enables only Runtime, Log and
 * Network. It never enables the Page domain and never sends
 * Page.handleJavaScriptDialog, so it has no way to answer a dialog on your
 * behalf. Dialogs behave exactly as they do with nothing attached.
 *
 * Two streams are merged into one wall-clock timeline:
 *
 *   browser/*  console at EVERY level (the app itself only patches
 *              console.warn/error, so log/info/debug are invisible to its own
 *              journal), uncaught exceptions with stacks, browser log entries,
 *              failed requests and >=400 responses.
 *
 *   app/*      Remodel's structured debug journal — the `direction` domain
 *              events, generation boundaries, reveal holds, checkpoints, Loom
 *              passes and Archive catch-ups, with their correlation ids.
 *
 * WHY DRAIN THE JOURNAL TO DISK: debug-console.js keeps at most MAX_RECORDS
 * (5000) in memory and splices the oldest away, and persists only the last
 * PERSISTED_RECORDS (1000) to sessionStorage. An extensive session therefore
 * discards its own earliest evidence, and the whole journal dies with the tab.
 *
 * Usage:
 *   node dev-tools/session-recorder.cjs              # record until Ctrl-C
 *   node dev-tools/session-recorder.cjs --analyze <file.jsonl>
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const CDP_HOST = process.env.REMODEL_CDP_HOST || '127.0.0.1';
const CDP_PORT = Number(process.env.REMODEL_CDP_PORT || 9222);
const APP_URL_MATCH = process.env.REMODEL_APP_URL || '127.0.0.1:8000';
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'test_logs');
const CHANNEL_NAME = 'remodel.debugJournal.live.v1';
const TICK_MS = 1000;
const DRAIN_BATCH = 400;
/** In-page queue ceiling. If the recorder stalls or dies the page must not grow
 *  an unbounded array — but a drop is COUNTED and reported, never silent. */
const QUEUE_CEILING = 20000;

// ---------------------------------------------------------------- analyze ---

/** Collapse the volatile parts of a message so "the same error 400 times"
 *  reads as one finding with a count. */
function fingerprint(text) {
    return String(text || '')
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
        .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '<time>')
        .replace(/\b\d{3,}\b/g, '<n>')
        .slice(0, 300);
}

function analyze(file) {
    const rows = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try { rows.push(JSON.parse(line)); } catch { /* a torn final line */ }
    }
    if (!rows.length) { console.log('No records in', file); return; }

    const bySeverity = new Map();
    const byKind = new Map();
    const problems = new Map();
    for (const row of rows) {
        bySeverity.set(row.severity, (bySeverity.get(row.severity) || 0) + 1);
        byKind.set(row.kind, (byKind.get(row.kind) || 0) + 1);
        if (row.severity !== 'error' && row.severity !== 'warn') continue;
        const key = `${row.severity} ${row.kind} ${fingerprint(row.summary)}`;
        const seen = problems.get(key);
        if (seen) { seen.count += 1; seen.lastAt = row.at; continue; }
        problems.set(key, { count: 1, firstAt: row.at, lastAt: row.at, severity: row.severity, kind: row.kind, summary: row.summary, sample: row });
    }

    console.log(`\nSession: ${path.basename(file)}`);
    console.log(`  ${rows.length} records   ${rows[0].at} -> ${rows[rows.length - 1].at}`);
    console.log(`  severity: ${[...bySeverity].map(([k, v]) => `${k}=${v}`).join('  ') || 'none'}`);
    console.log(`  kinds:    ${[...byKind].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}=${v}`).join('  ')}`);

    const ranked = [...problems.values()].sort((a, b) => {
        if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
        return b.count - a.count;
    });
    if (!ranked.length) { console.log('\nNo errors or warnings recorded.\n'); return; }
    console.log(`\n${ranked.length} distinct problem(s), most severe first:\n`);
    for (const p of ranked) {
        console.log(`  [${p.severity.toUpperCase()}] ${p.kind}  x${p.count}`);
        console.log(`    ${String(p.summary).replace(/\n/g, '\n    ').slice(0, 500)}`);
        if (p.sample.detail) console.log(`    detail: ${JSON.stringify(p.sample.detail).slice(0, 400)}`);
        console.log(`    first ${p.firstAt}   last ${p.lastAt}\n`);
    }
}

// ------------------------------------------------------------ in-page code --

/** Joins the journal's existing broadcast channel and parks records on a queue
 *  the recorder drains. Idempotent — safe to call every tick, which is also how
 *  it heals itself after a reload without needing the Page domain. */
function installBridge({ channelName, ceiling }) {
    const existing = window.__remodelRecorder;
    if (existing && existing.channelName === channelName && existing.alive) return { reused: true };
    try { existing?.channel?.close(); } catch { /* already gone */ }
    const state = {
        channelName, alive: true, queue: [], dropped: 0,
        senderId: `recorder-${Math.random().toString(36).slice(2)}`, channel: null,
    };
    const push = (records) => {
        for (const record of Array.isArray(records) ? records : [records]) {
            if (!record) continue;
            if (state.queue.length >= ceiling) { state.dropped += 1; continue; }
            state.queue.push(record);
        }
    };
    try {
        state.channel = new BroadcastChannel(channelName);
        state.channel.addEventListener('message', (event) => {
            const message = event.data;
            if (!message || message.sender === state.senderId) return;
            if (message.type === 'record') push(message.record);
            if (message.type === 'records') push(message.records);
            if (message.type === 'snapshot' && message.target === state.senderId) push(message.records);
        });
        // Backfill whatever the page already had, then ride the live stream.
        state.channel.postMessage({ type: 'sync-request', sender: state.senderId });
    } catch (error) {
        state.alive = false;
        window.__remodelRecorder = state;
        return { reused: false, error: String(error && error.message || error) };
    }
    window.__remodelRecorder = state;
    return { reused: false, installed: true };
}

/** The journal obeys a persisted `recording` flag, and when it is off
 *  recordDebugEvent returns null for everything unforced — so the Debug
 *  workspace and this recorder would both show an empty session while the app
 *  looked perfectly healthy. Switch it on through the journal's own cross-tab
 *  settings message rather than by poking module state.
 *
 *  Only `recording` changes. `captureSensitive` is echoed back as-is and
 *  `recordDom` is never touched — it is off deliberately (it outweighs every
 *  other category combined during a streaming response). */
function ensureRecording({ channelName }) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('remodel.debugJournal.settings.v1') || '{}'); } catch { saved = {}; }
    if (saved.recording !== false) return { wasRecording: true, changed: false };
    try {
        const channel = new BroadcastChannel(channelName);
        channel.postMessage({
            type: 'settings',
            sender: `recorder-settings-${Math.random().toString(36).slice(2)}`,
            settings: { recording: true, captureSensitive: Boolean(saved.captureSensitive) },
        });
        setTimeout(() => { try { channel.close(); } catch { /* closed */ } }, 500);
        return { wasRecording: false, changed: true };
    } catch (error) {
        return { wasRecording: false, changed: false, error: String(error && error.message || error) };
    }
}

function drainBridge({ batch }) {
    const state = window.__remodelRecorder;
    if (!state || !state.alive) return { records: [], dropped: 0, alive: false };
    const records = state.queue.splice(0, batch);
    const dropped = state.dropped;
    state.dropped = 0;
    return { records, dropped, alive: true, remaining: state.queue.length };
}

// -------------------------------------------------------------- cdp client --

function httpJson(pathname) {
    return new Promise((resolve, reject) => {
        const request = http.get({ host: CDP_HOST, port: CDP_PORT, path: pathname, timeout: 5000 }, (response) => {
            let body = '';
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
            });
        });
        request.on('timeout', () => request.destroy(new Error('timed out')));
        request.on('error', reject);
    });
}

function createClient(wsUrl) {
    if (typeof WebSocket !== 'function') {
        throw new Error('This Node build has no global WebSocket. Node 22+ is required.');
    }
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    const handlers = new Map();
    let nextId = 1;

    socket.addEventListener('message', (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.id != null) {
            const slot = pending.get(message.id);
            if (!slot) return;
            pending.delete(message.id);
            if (message.error) slot.reject(new Error(`${message.error.message} (${slot.method})`));
            else slot.resolve(message.result);
            return;
        }
        const list = handlers.get(message.method);
        if (list) for (const handler of list) handler(message.params || {});
    });

    return {
        socket,
        ready: new Promise((resolve, reject) => {
            socket.addEventListener('open', () => resolve());
            socket.addEventListener('error', () => reject(new Error(`Could not connect to ${wsUrl}`)));
        }),
        send(method, params = {}) {
            const id = nextId++;
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject, method });
                socket.send(JSON.stringify({ id, method, params }));
            });
        },
        on(method, handler) {
            if (!handlers.has(method)) handlers.set(method, []);
            handlers.get(method).push(handler);
        },
        close() { try { socket.close(); } catch { /* already closed */ } },
    };
}

/** Render a CDP RemoteObject argument as readable text. */
function describeArg(arg) {
    if (!arg) return '';
    if (arg.type === 'string') return String(arg.value);
    if ('value' in arg) { try { return JSON.stringify(arg.value); } catch { return String(arg.value); } }
    if (arg.unserializableValue) return String(arg.unserializableValue);
    if (arg.description) return String(arg.description);
    return arg.type || '';
}

// ---------------------------------------------------------------- record ----

async function record() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outFile = path.join(OUT_DIR, `session-${stamp}.jsonl`);
    const out = fs.createWriteStream(outFile, { flags: 'a' });

    const counts = { total: 0, error: 0, warn: 0, info: 0, dropped: 0, reconnects: 0 };
    const seenIds = new Set();
    const quiet = process.argv.includes('--quiet');
    let stopping = false;
    let currentSession = null;

    const write = (row) => {
        counts.total += 1;
        counts[row.severity] = (counts[row.severity] || 0) + 1;
        out.write(`${JSON.stringify(row)}\n`);
        if (row.severity === 'error' || row.severity === 'warn') {
            const tag = row.severity === 'error' ? '\x1b[31mERROR\x1b[0m' : '\x1b[33mWARN \x1b[0m';
            console.log(`${String(row.at).slice(11, 19)} ${tag} ${row.kind}  ${String(row.summary).split('\n')[0].slice(0, 160)}`);
        }
    };
    const emit = (kind, severity, summary, detail) => write({
        at: new Date().toISOString(), source: 'browser', kind, severity, summary, detail: detail ?? null,
    });

    const tickExpression = `(() => {
        const installBridge = ${installBridge.toString()};
        const ensureRecording = ${ensureRecording.toString()};
        const drainBridge = ${drainBridge.toString()};
        const bridge = installBridge({ channelName: ${JSON.stringify(CHANNEL_NAME)}, ceiling: ${QUEUE_CEILING} });
        const recording = ensureRecording({ channelName: ${JSON.stringify(CHANNEL_NAME)} });
        const drained = drainBridge({ batch: ${DRAIN_BATCH} });
        return { bridge, recording, drained };
    })()`;

    /**
     * One connected session. Resolves when the socket closes so the caller can
     * reconnect; it deliberately does NOT exit the process.
     *
     * THE DEFECT, so it is not reintroduced: the first version exited on socket
     * close. A page reload drops the target socket, so the recorder died on the
     * first refresh and everything after it went unrecorded — while the user
     * believed the session was still being captured. That is the exact failure
     * this tool exists to prevent, so reconnection is mandatory and every gap
     * is written into the log.
     */
    async function runSession() {
        const targets = await httpJson('/json/list');
        const target = targets.find((entry) => entry.type === 'page' && String(entry.url).includes(APP_URL_MATCH));
        if (!target) throw new Error(`no page matching "${APP_URL_MATCH}"`);

        const client = createClient(target.webSocketDebuggerUrl);
        await client.ready;
        // Runtime, Log and Network ONLY. Enabling Page would put this process in
        // charge of answering window.confirm on the user's behalf — see header.
        await client.send('Runtime.enable');
        await client.send('Log.enable');
        await client.send('Network.enable');

        client.on('Runtime.consoleAPICalled', (params) => {
            const type = params.type || 'log';
            const severity = (type === 'error' || type === 'assert') ? 'error' : (type === 'warning' ? 'warn' : 'info');
            const text = (params.args || []).map(describeArg).join(' ');
            const frame = params.stackTrace?.callFrames?.[0] || null;
            emit(`console.${type}`, severity, text, frame ? { url: frame.url, line: frame.lineNumber } : null);
        });
        client.on('Runtime.exceptionThrown', (params) => {
            const d = params.exceptionDetails || {};
            const message = d.exception?.description || d.text || 'Uncaught exception';
            emit('pageerror', 'error', String(message).split('\n')[0], {
                stack: String(d.exception?.description || ''), url: d.url || null, line: d.lineNumber ?? null,
            });
        });
        client.on('Log.entryAdded', (params) => {
            const entry = params.entry || {};
            if (entry.source === 'console-api') return;
            const severity = entry.level === 'error' ? 'error' : (entry.level === 'warning' ? 'warn' : 'info');
            emit(`log.${entry.source || 'other'}`, severity, entry.text || '', { url: entry.url || null });
        });
        const requestUrls = new Map();
        client.on('Network.requestWillBeSent', (params) => {
            requestUrls.set(params.requestId, `${params.request?.method || 'GET'} ${params.request?.url || ''}`);
            if (requestUrls.size > 3000) requestUrls.delete(requestUrls.keys().next().value);
        });
        client.on('Network.loadingFailed', (params) => {
            if (params.canceled) return;
            emit('request.failed', 'error', `${requestUrls.get(params.requestId) || params.type || 'request'} failed — ${params.errorText || 'unknown'}`, {
                errorText: params.errorText, type: params.type,
            });
        });
        client.on('Network.responseReceived', (params) => {
            const status = params.response?.status ?? 0;
            if (status < 400) return;
            emit('response.error', 'error', `${status} ${requestUrls.get(params.requestId) || params.response?.url || ''}`, {
                status, url: params.response?.url || null,
            });
        });
        client.on('Runtime.executionContextsCleared', () => {
            emit('page.navigated', 'info', 'The page navigated or reloaded; the journal bridge will be reinstalled.');
        });

        let ticking = false;
        const tick = async () => {
            if (ticking) return;
            ticking = true;
            try {
                for (;;) {
                    const response = await client.send('Runtime.evaluate', {
                        expression: tickExpression, returnByValue: true, awaitPromise: true,
                    });
                    if (response.exceptionDetails) {
                        emit('bridge.failed', 'warn', `Bridge tick threw: ${response.exceptionDetails.text || 'unknown'}`);
                        break;
                    }
                    const value = response.result?.value || {};
                    if (value.bridge?.installed) emit('bridge.installed', 'info', 'Listening on the Remodel journal broadcast channel.');
                    if (value.bridge?.error) emit('bridge.failed', 'error', `Could not open the broadcast channel: ${value.bridge.error}`);
                    if (value.recording?.changed) {
                        console.log('\x1b[33m  ! The Remodel debug journal was OFF. Turned it on.\x1b[0m');
                        emit('journal.enabled', 'warn', 'The Remodel debug journal was disabled and has been switched on.');
                    }
                    const drained = value.drained || {};
                    if (drained.dropped) {
                        counts.dropped += drained.dropped;
                        emit('journal.dropped', 'warn', `The in-page queue overflowed; ${drained.dropped} journal record(s) were dropped.`);
                    }
                    for (const rec of drained.records || []) {
                        if (!rec || (rec.id && seenIds.has(rec.id))) continue;
                        if (rec.id) seenIds.add(rec.id);
                        write({
                            at: rec.at || new Date().toISOString(),
                            source: 'app',
                            kind: `${rec.category || 'app'}/${rec.type || 'event'}`,
                            severity: rec.severity === 'error' ? 'error' : (rec.severity === 'warn' ? 'warn' : 'info'),
                            summary: rec.summary || rec.type || 'Event',
                            correlationId: rec.correlationId || null,
                            detail: rec.detail ?? null,
                            recordId: rec.id || null,
                            sequence: rec.sequence ?? null,
                        });
                    }
                    if (!drained.records || drained.records.length < DRAIN_BATCH) break;
                }
            } catch (error) {
                if (!/closed|CLOSING|CLOSED/i.test(String(error.message))) {
                    emit('drain.failed', 'warn', `Journal drain failed: ${error.message}`);
                }
            } finally {
                ticking = false;
            }
        };

        await tick();
        const timer = setInterval(tick, TICK_MS);
        currentSession = { client, timer, drain: tick };
        return new Promise((resolve) => {
            client.socket.addEventListener('close', () => {
                clearInterval(timer);
                currentSession = null;
                resolve();
            });
        });
    }

    console.log(`Looking for the app on ${CDP_HOST}:${CDP_PORT} ...`);
    const statusTimer = quiet ? null : setInterval(() => {
        process.stdout.write(`\r\x1b[2m  ${counts.total} records  ·  ${counts.error} errors  ·  ${counts.warn} warnings\x1b[0m`);
    }, 5000);

    const stop = async () => {
        if (stopping) return;
        stopping = true;
        if (statusTimer) clearInterval(statusTimer);
        process.stdout.write('\r\x1b[K');
        console.log('\nStopping — draining what is left ...');
        try {
            if (currentSession) {
                clearInterval(currentSession.timer);
                await currentSession.drain();
                currentSession.client.close();
            }
        } catch { /* the page may already be gone */ }
        await new Promise((resolve) => out.end(resolve));
        if (counts.dropped) console.log(`\n!! ${counts.dropped} journal record(s) were dropped — the record is INCOMPLETE.`);
        if (counts.reconnects) console.log(`   ${counts.reconnects} reconnect(s) this session; every gap is marked in the log.`);
        analyze(outFile);
        console.log(`Full log: ${path.relative(REPO_ROOT, outFile)}`);
        console.log(`Re-analyze: node dev-tools/session-recorder.cjs --analyze "${path.relative(REPO_ROOT, outFile)}"\n`);
        process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    let announced = false;
    let downSince = null;
    while (!stopping) {
        try {
            if (!announced) {
                console.log(`Recording to ${path.relative(REPO_ROOT, outFile)}`);
                console.log('Dialogs are untouched — confirm/prompt behave normally.');
                console.log('Survives reloads: reconnects automatically and marks the gap.');
                console.log('Test freely. Errors and warnings print below as they happen. Ctrl-C to stop.\n');
                announced = true;
            }
            if (downSince) {
                counts.reconnects += 1;
                const gapMs = Date.now() - downSince;
                // Never let a gap pass unrecorded: whatever the app did while the
                // socket was down is genuinely absent from this file, and a silent
                // hole reads exactly like a quiet stretch.
                emit('cdp.reconnected', 'warn', `Reconnected after ${Math.round(gapMs / 1000)}s. Events during that gap are NOT in this log.`, { gapMs });
                downSince = null;
            }
            await runSession();
            if (stopping) break;
            emit('cdp.disconnected', 'warn', 'The debug connection closed (reload or tab close). Reconnecting ...');
            downSince = Date.now();
        } catch (error) {
            if (stopping) break;
            if (!downSince) {
                downSince = Date.now();
                emit('cdp.unavailable', 'warn', `Cannot reach the app: ${error.message}. Retrying every 2s ...`);
            }
        }
        if (!stopping) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
}

const args = process.argv.slice(2);
if (args[0] === '--analyze') {
    if (!args[1]) { console.error('Usage: node dev-tools/session-recorder.cjs --analyze <file.jsonl>'); process.exit(1); }
    analyze(path.resolve(args[1]));
} else {
    record().catch((error) => { console.error(error); process.exit(1); });
}
