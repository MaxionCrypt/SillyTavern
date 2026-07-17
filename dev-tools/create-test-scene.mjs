// Creates a fresh, disposable Story Scene for live testing, so verification
// never has to touch real chat data again. Drives the REAL UI (no shortcuts
// into module internals — createArc/createScene aren't exposed on window),
// using the exact click sequence proven to work during the 2026-07-17/18
// manuscript-redesign session, consolidated here instead of re-derived by
// hand every time.
//
// Usage: node create-test-scene.mjs [cdpPort] [tabId]
//   cdpPort defaults to 9222 (see launch-debug-chrome.bat)
//   tabId: if omitted, uses the first "SillyTavern" tab found automatically.
//
// What it does:
//   1. Opens the Tavern drawer, switches to the Timelines tab.
//   2. Creates a new Timeline named "Test Timeline <timestamp>" (via the
//      real modal, not a native prompt()).
//   3. Creates an Arc inside it (native prompt(), auto-accepted).
//   4. Creates a Story Scene inside that Arc.
//   5. Opens the scene, clicks through the character-cast wizard picking
//      the FIRST available character, closes the persona editor if it
//      intercepts the click (a known quirk — clicking a character's
//      list-row can open its editor instead of selecting it).
//   6. Reports whether the story workspace is active and how many
//      messages are in the resulting chat, so you know it's ready to test against.
//
// This scene/timeline is real data in your SillyTavern install (same as
// any manually-created one) — delete it via the Timelines UI when done if
// you don't want it cluttering your timeline list.

const CDP_PORT = Number(process.argv[2]) || 9222;
const EXPLICIT_TAB_ID = process.argv[3] || null;

async function main() {
    const tabId = EXPLICIT_TAB_ID || await findSillyTavernTab();
    if (!tabId) {
        console.error(`No SillyTavern tab found on port ${CDP_PORT}. Is launch-debug-chrome.bat running?`);
        process.exit(1);
    }
    console.log(`Using tab: ${tabId}`);

    const ws = new WebSocket(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${tabId}`);
    let msgId = 1;
    const pending = new Map();
    function send(method, params = {}) {
        const id = msgId++;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
        });
    }
    let dialogQueueText = '';
    ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.method === 'Page.javascriptDialogOpening') {
            send('Page.handleJavaScriptDialog', { accept: true, promptText: dialogQueueText });
            return;
        }
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(JSON.stringify(msg.error)));
            else resolve(msg.result);
        }
    });
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
    });
    await send('Runtime.enable');
    await send('Page.enable');

    async function evalJs(expression, timeoutMs = 8000, awaitPromise = false) {
        const evalPromise = send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs));
        const result = await Promise.race([evalPromise, timeoutPromise]);
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    }
    async function click(selector, opts = {}) {
        return evalJs(`document.querySelector(${JSON.stringify(selector)})?.click()`, opts.timeout ?? 5000, false);
    }
    async function wait(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    const timelineName = `Test Timeline ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;

    // 1. Open the drawer + Timelines tab.
    for (let i = 0; i < 10; i++) {
        const exists = await evalJs(`!!document.getElementById('remodel-timeline-panel')`, 3000, false);
        if (exists) break;
        await wait(500);
    }
    await evalJs(`(function() {
        const panel = document.getElementById('remodel-timeline-panel');
        if (panel) { panel.classList.remove('closedDrawer'); panel.classList.add('openDrawer'); }
    })()`, 5000, false);
    await wait(400);
    await evalJs(`(function() {
        const tabs = Array.from(document.querySelectorAll('.remodel-tavern-tab'));
        const timelinesTab = tabs.find(t => t.textContent.includes('Timelines'));
        if (timelinesTab) timelinesTab.click();
    })()`, 5000, false);
    await wait(400);

    // 2. Create the Timeline (real modal, not prompt()).
    await click('[aria-label="Create new Timeline"]');
    await wait(500);
    await evalJs(`(function() {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])')).filter(i => i.offsetParent !== null);
        const nameInput = inputs.find(i => (i.placeholder || '').length < 30);
        if (nameInput) { nameInput.value = ${JSON.stringify(timelineName)}; nameInput.dispatchEvent(new Event('input', { bubbles: true })); }
    })()`, 5000, false);
    await evalJs(`(function() {
        const buttons = Array.from(document.querySelectorAll('button'));
        const createBtn = buttons.find(b => b.textContent.trim() === 'Create');
        if (createBtn) createBtn.click();
    })()`, 5000, false);
    await wait(600);

    // 3. Create an Arc (native prompt(), auto-accepted with "Test Arc").
    dialogQueueText = 'Test Arc';
    await click('[data-remodel-timeline-action="create-arc"]');
    await wait(600);

    // 4. Create a Story Scene.
    await click('[data-remodel-timeline-action="create-scene"][data-mode="story"]');
    await wait(600);

    // 5. Open it.
    await click('[data-remodel-timeline-action="open-scene"]');
    await wait(1000);

    // 6. If the character-cast wizard shows, pick the first character.
    const wizardShowing = await evalJs(`document.body.innerHTML.includes('CHOOSE WHO THE AI PLAYS')`, 4000, false);
    if (wizardShowing) {
        await click('#CharID0');
        await wait(800);
        // Clicking a character's list row can open its editor instead of
        // selecting it (a known quirk) — close it if that happened, which
        // also finalizes the wizard's character choice underneath.
        await evalJs(`document.getElementById('remodel-character-editor-cancel')?.click()`, 4000, false);
        await wait(500);
    }

    const result = await evalJs(`(function() {
        const ctx = SillyTavern.getContext();
        return {
            workspaceActive: document.body.classList.contains('remodel-story-workspace-active'),
            chatLength: ctx.chat.length,
            chatId: ctx.chatId,
        };
    })()`, 5000, false);

    console.log('\n=== Result ===');
    console.log(`Timeline: ${timelineName}`);
    console.log(JSON.stringify(result, null, 2));
    if (result.workspaceActive) {
        console.log('\nReady — this is a disposable scene, safe to test against.');
    } else {
        console.log('\nDid not land in the story workspace — check screenshots, the wizard flow may have changed.');
    }

    ws.close();
    process.exit(0);
}

async function findSillyTavernTab() {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const tabs = await res.json();
    const match = tabs.find((t) => t.title === 'SillyTavern' && t.type === 'page');
    return match?.id ?? null;
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
