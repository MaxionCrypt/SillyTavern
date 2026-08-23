#!/usr/bin/env node
/**
 * Capture the ACTUAL outgoing Narrator/Loom request bodies and diff consecutive
 * ones.
 *
 * WHY THIS EXISTS: three separate attempts to explain a byte-identical
 * duplicated turn from journal evidence alone were wrong. capturePromptLog()
 * stores recipe BLOCKS with markers emptied, so it cannot show the assembled
 * history; the journal records that grounding was produced but not whether it
 * reached the wire. The request body is the only artefact that settles it.
 *
 * Raw CDP, Runtime/Network only — never the Page domain. See
 * session-recorder.cjs for why that matters (dialog auto-dismissal).
 *
 * Usage:
 *   node dev-tools/capture-prompts.cjs           # listen until Ctrl-C
 *   node dev-tools/capture-prompts.cjs --diff    # diff the last two captures
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const CDP_HOST = process.env.REMODEL_CDP_HOST || '127.0.0.1';
const CDP_PORT = Number(process.env.REMODEL_CDP_PORT || 9222);
const APP_URL_MATCH = process.env.REMODEL_APP_URL || '127.0.0.1:8000';
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'test_logs', 'prompts');
const TARGET = '/api/backends/chat-completions/generate';

function httpJson(pathname) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: CDP_HOST, port: CDP_PORT, path: pathname, timeout: 5000 }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        });
        req.on('timeout', () => req.destroy(new Error('timed out')));
        req.on('error', reject);
    });
}

/** Render one captured body as a readable transcript. */
function summarize(body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { return { error: 'unparseable body', raw: body.slice(0, 400) }; }
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    return {
        model: parsed.model,
        max_tokens: parsed.max_tokens,
        stream: parsed.stream,
        messageCount: messages.length,
        roles: messages.map((m) => m.role),
        userMessageCount: messages.filter((m) => m.role === 'user').length,
        assistantMessageCount: messages.filter((m) => m.role === 'assistant').length,
        messages: messages.map((m, i) => ({
            i, role: m.role, name: m.name || null,
            length: String(m.content ?? '').length,
            content: String(m.content ?? ''),
        })),
    };
}

function listCaptures() {
    if (!fs.existsSync(OUT_DIR)) return [];
    return fs.readdirSync(OUT_DIR).filter((n) => n.endsWith('.json')).sort();
}

function diffLastTwo() {
    const files = listCaptures();
    if (files.length < 2) { console.log(`Need 2 captures, have ${files.length}. Run two turns while the capture is listening.`); return; }
    const [aName, bName] = files.slice(-2);
    const a = JSON.parse(fs.readFileSync(path.join(OUT_DIR, aName), 'utf8'));
    const b = JSON.parse(fs.readFileSync(path.join(OUT_DIR, bName), 'utf8'));
    console.log(`\nA: ${aName}   ${a.messageCount} messages, ${a.userMessageCount} user / ${a.assistantMessageCount} assistant`);
    console.log(`B: ${bName}   ${b.messageCount} messages, ${b.userMessageCount} user / ${b.assistantMessageCount} assistant`);
    console.log(`\nmax_tokens: ${a.max_tokens} -> ${b.max_tokens}    model: ${a.model} -> ${b.model}`);

    const aJoined = a.messages.map((m) => `${m.role}:${m.content}`).join('\n---\n');
    const bJoined = b.messages.map((m) => `${m.role}:${m.content}`).join('\n---\n');
    console.log(`\nprompts identical: ${aJoined === bJoined}`);

    const max = Math.max(a.messages.length, b.messages.length);
    console.log('\nper-message comparison:');
    for (let i = 0; i < max; i += 1) {
        const ma = a.messages[i];
        const mb = b.messages[i];
        if (!ma) { console.log(`  [${i}] ONLY IN B  ${mb.role} (${mb.length}) ${mb.content.slice(0, 70).replace(/\s+/g, ' ')}`); continue; }
        if (!mb) { console.log(`  [${i}] ONLY IN A  ${ma.role} (${ma.length}) ${ma.content.slice(0, 70).replace(/\s+/g, ' ')}`); continue; }
        const same = ma.role === mb.role && ma.content === mb.content;
        const flag = same ? 'same' : 'DIFF';
        console.log(`  [${i}] ${flag}  ${ma.role.padEnd(9)} ${String(ma.length).padStart(6)} -> ${String(mb.length).padStart(6)}  ${ma.content.slice(0, 55).replace(/\s+/g, ' ')}`);
        if (!same && ma.role === mb.role) {
            // Show where they start to differ — that is the payload that changed.
            let d = 0;
            while (d < Math.min(ma.content.length, mb.content.length) && ma.content[d] === mb.content[d]) d += 1;
            console.log(`         first difference at char ${d}`);
            console.log(`         A: ...${ma.content.slice(d, d + 130).replace(/\s+/g, ' ')}`);
            console.log(`         B: ...${mb.content.slice(d, d + 130).replace(/\s+/g, ' ')}`);
        }
    }
    console.log('');
}

async function capture() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const targets = await httpJson('/json/list');
    const target = targets.find((t) => t.type === 'page' && String(t.url).includes(APP_URL_MATCH));
    if (!target) { console.error(`No page matching "${APP_URL_MATCH}".`); process.exitCode = 1; return; }

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    let id = 1;
    const send = (method, params = {}) => ws.send(JSON.stringify({ id: id++, method, params }));
    send('Network.enable');

    let count = 0;
    ws.addEventListener('message', (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.method !== 'Network.requestWillBeSent') return;
        const req = m.params?.request;
        if (!req || !String(req.url).includes(TARGET) || !req.postData) return;
        count += 1;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const summary = summarize(req.postData);
        // requestId and the CDP timestamp distinguish a genuine second request
        // from this tool being run twice — a confounder that already produced
        // convincing-looking "duplicate" pairs 10ms apart.
        summary.requestId = m.params.requestId;
        summary.wallTime = m.params.wallTime;
        summary.capturePid = process.pid;
        const file = path.join(OUT_DIR, `prompt-${stamp}.json`);
        fs.writeFileSync(file, JSON.stringify(summary, null, 2));
        console.log(`[${count}] req=${summary.requestId} captured ${path.basename(file)} — ${summary.messageCount} messages `
            + `(${summary.userMessageCount} user / ${summary.assistantMessageCount} assistant), max_tokens=${summary.max_tokens}`);
    });

    console.log(`Listening for POST ${TARGET}`);
    console.log(`Writing to ${path.relative(REPO_ROOT, OUT_DIR)}`);
    console.log('Run two turns, then Ctrl-C and re-run with --diff.\n');
    process.on('SIGINT', () => {
        console.log(`\nCaptured ${count} request(s).`);
        if (count >= 2) diffLastTwo();
        process.exit(0);
    });
}

if (process.argv.includes('--diff')) diffLastTwo();
else capture().catch((e) => { console.error(e); process.exit(1); });
