# Archivist Narrator — Layer 2 Implementation Plan (Custom Narrator Path)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the directed Narrator off native generation onto a custom, archivist-driven `streamChatPrompt` path so it never receives the full chat history and cannot rewrite past prose.

**Architecture:** A new `narrator-prompt.js` compiles the Narrator's message array from archivist state (Layer 1), character card, world info, a 2–3 message voice window, the beat, and the framed Director reasoning. `generateDirectedPerformer` stops calling `context.generate()`/`generateGroupWrapper`, pushes its own attributed chat message, and streams via `streamChatPrompt`, feeding the existing reveal pipeline unchanged. The feature is refused when the backend cannot stream (`canStreamStory()` false). Interruption switches from `stopGeneration()` to a per-run `AbortController`.

**Tech Stack:** Vanilla ES modules, Jest (`--experimental-vm-modules`), `tests/util/st-context-stub.js`. Live-integration parts are browser-verified in the running SillyTavern app (not unit-testable).

**Spec:** `docs/superpowers/specs/2026-08-19-archivist-narrator-layer2-design.md` (Layer 2 of `2026-08-19-archivist-narrator-design.md`). Pipeline map: `scratchpad/layer2-pipeline-findings.md`.

## Global Constraints

- The directed Narrator requires Chat Completion + streaming (`canStreamStory()` — `context.mainApi === 'openai'` && `context.chatCompletionSettings.stream_openai`). When false, refuse the turn with a clear message; **no native fallback**.
- `compileNarratorPrompt` output is an OpenAI-style `{ role, content }[]` array (the shape `streamChatPrompt`'s `prompt` expects, same as `compileDirectorPrompt`).
- The Narrator prompt MUST NOT contain the full chat history, notebook entries, secrets, or mechanics internals. The only raw prior prose is the voice window (last 2–3 messages).
- `streamChatPrompt`'s `onChunk({ text })` is **cumulative**; `acceptNativeBuffer(text)` replaces `rawBufferedText` cumulatively — feed one to the other directly.
- The reveal/pacing loop (`scheduleReveal`, `revealStep`) and `finalizeRunMessage` stay **unchanged** — only their inputs change.
- Test run command, from `tests/`:
  `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json <pattern>`
- Do not use `Date.now()`/`Math.random()` in test assertions.

## Testability Split

- **Unit-testable (Tasks 1–3):** archivist→Narrator formatter (incl. fail-closed secret exclusion), `compileNarratorPrompt`, the stream-availability gate decision. Full TDD.
- **Live-verified (Tasks 4–6):** the async snapshot gatherer, self-created message attribution, the `streamChatPrompt` rewire, AbortController interruption, and the event-emission audit. These touch the live generation core and the DOM; each task ends with explicit **browser verification** steps, not Jest assertions. This is the integration risk the layered rollout exists to contain.

---

## File Structure

- **Create `.../SillyTavern-Remodel/narrator-prompt.js`** — pure prompt compilation: `buildNarratorArchivistSections`, `compileNarratorPrompt`, `narratorStreamBlock`, and the `CAMERA_CONSTRAINT` constant. No side effects, no generation.
- **Modify `.../SillyTavern-Remodel/live-direction.js`** — `generateDirectedPerformer` (self-created message + `streamChatPrompt` rewire + gate), `interruptLiveDirection` (AbortController), and post-finalize event emission. Add `buildNarratorSnapshot`.
- **Create `tests/remodel-narrator-archivist-sections.test.js`** — formatter + secret exclusion.
- **Create `tests/remodel-narrator-prompt.test.js`** — `compileNarratorPrompt` + gate decision.

---

## Task 1: Archivist → Narrator sections (fail-closed on secrets)

**Files:**
- Create: `.../SillyTavern-Remodel/narrator-prompt.js` (this task adds `buildNarratorArchivistSections`)
- Test: `tests/remodel-narrator-archivist-sections.test.js`

**Interfaces:**
- Consumes (Layer 1): `listSceneFacts`, `listCharStates`, `listEvents`, `getBeat` from `archivist-store.js`. **Deliberately does not import `listSecrets`** — secrets cannot leak through a function that never reads them.
- Produces: `buildNarratorArchivistSections(timelineId, sceneId) → string` (labelled sections; empty string when the scene has no archivist state).

- [ ] **Step 1: Write the failing test**

Create `tests/remodel-narrator-archivist-sections.test.js`:

```js
import { __setExtensionSettings } from './util/st-context-stub.js';
import {
    setSceneFact, recordEvent, setCharStateFacet, setBeat, setSecret,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';
import { buildNarratorArchivistSections } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js';

const T = 'tl-n';
const S = 'sc-n';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('renders scene, characters, events, and beat as labelled sections', () => {
    setSceneFact(T, S, 'location', 'rain-soaked rooftop');
    setCharStateFacet(T, S, 'marcus', 'mood', 'desperate');
    recordEvent(T, S, 'Marcus drew his knife');
    setBeat(T, S, 'Marcus lunges', 'tense');
    const text = buildNarratorArchivistSections(T, S);
    expect(text).toContain('location: rain-soaked rooftop');
    expect(text).toContain('marcus');
    expect(text).toContain('mood: desperate');
    expect(text).toContain('Marcus drew his knife');
    expect(text).toContain('Marcus lunges');
    // the event log must be framed as already-written
    expect(text.toLowerCase()).toContain('already');
    // the beat must be framed as what happens next
    expect(text.toLowerCase()).toContain('next');
});

test('secrets never appear in the Narrator sections (fail-closed)', () => {
    setSceneFact(T, S, 'location', 'rooftop');
    setSecret(T, S, 'betrayer', 'Marcus works for the guild');
    const text = buildNarratorArchivistSections(T, S);
    expect(text).not.toContain('betrayer');
    expect(text).not.toContain('guild');
});

test('an empty scene renders as an empty string', () => {
    expect(buildNarratorArchivistSections(T, S)).toBe('');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-narrator-archivist-sections`
Expected: FAIL — `Cannot find module '.../narrator-prompt.js'`.

- [ ] **Step 3: Create `narrator-prompt.js` with the formatter**

Create `.../SillyTavern-Remodel/narrator-prompt.js`:

```js
import { listSceneFacts, listCharStates, listEvents, getBeat } from './archivist-store.js';

// The Narrator is framed as a camera to make append-only intuitive: it can
// only move forward, so it never restates what is already on the page.
export const CAMERA_CONSTRAINT = 'You are a camera. You can only move forward. You see the current scene, you hear the director\'s instruction, and you write what happens next. You never cut away, never rewind, and never restate what is already on the page.';

/**
 * Render the archivist's Narrator-visible state as labelled sections.
 *
 * Secrets are excluded by construction: this function never reads the secret
 * store, so a secret cannot leak through a formatting mistake. Returns '' when
 * the scene has no state yet.
 */
export function buildNarratorArchivistSections(timelineId, sceneId) {
    const facts = listSceneFacts(timelineId, sceneId);
    const charStates = listCharStates(timelineId, sceneId);
    const events = listEvents(timelineId, sceneId);
    const beat = getBeat(timelineId, sceneId);
    const sections = [];
    if (facts.length) {
        sections.push(['Scene', facts.map((f) => `- ${f.key}: ${f.value}`).join('\n')]);
    }
    if (charStates.length) {
        const lines = charStates.map((c) => {
            const facets = Object.entries(c.facets || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
            return `- ${c.charId} — ${facets}`;
        });
        sections.push(['Characters', lines.join('\n')]);
    }
    if (events.length) {
        sections.push(['What has happened (already written — do NOT narrate this again)', events.map((e) => `- ${e.summary}`).join('\n')]);
    }
    if (beat) {
        const tone = beat.tone ? ` (tone: ${beat.tone})` : '';
        sections.push(['What happens next', `${beat.directive}${tone}`]);
    }
    return sections.map(([label, body]) => `## ${label}\n${body}`).join('\n\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-narrator-archivist-sections`
Expected: PASS — 3 tests.

- [ ] **Step 5: Mutation check**

Temporarily add `import { listSecrets } from './archivist-store.js';` and append a secrets section. Re-run — the fail-closed test goes RED. Revert. This proves the secret-exclusion test has teeth.

- [ ] **Step 6: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js tests/remodel-narrator-archivist-sections.test.js
git commit -m "feat(remodel): archivist-to-narrator section formatter (secrets fail-closed)"
```

---

## Task 2: `compileNarratorPrompt` — the message array

**Files:**
- Modify: `.../SillyTavern-Remodel/narrator-prompt.js` (add `compileNarratorPrompt`)
- Test: `tests/remodel-narrator-prompt.test.js`

**Interfaces:**
- Consumes: `CAMERA_CONSTRAINT` (Task 1). `frameDirectorReasoning` from `live-direction.js` is NOT imported here (avoid a cycle) — the caller passes already-framed reasoning text in.
- Produces: `compileNarratorPrompt(input) → { role, content }[]`, where
  `input = { card: string, persona: string, worldInfo: string, archivistSections: string, reasoning: string, voiceWindow: { role, content }[] }`.
  All string fields may be empty; `voiceWindow` may be `[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/remodel-narrator-prompt.test.js`:

```js
import { compileNarratorPrompt, CAMERA_CONSTRAINT } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js';

function baseInput(overrides = {}) {
    return {
        card: 'You are Marcus, a terse mercenary.',
        persona: 'The user plays Wren.',
        worldInfo: 'The city of Vell is under curfew.',
        archivistSections: '## Scene\n- location: rooftop',
        reasoning: 'Marcus should feel cornered and lash out.',
        voiceWindow: [
            { role: 'assistant', content: 'Marcus watched the door.' },
            { role: 'user', content: 'I step closer.' },
        ],
        ...overrides,
    };
}

test('the system message carries the card, persona, and camera constraint', () => {
    const messages = compileNarratorPrompt(baseInput());
    const system = messages.find((m) => m.role === 'system');
    expect(system.content).toContain('Marcus, a terse mercenary');
    expect(system.content).toContain('The user plays Wren');
    expect(system.content).toContain(CAMERA_CONSTRAINT);
});

test('world info, archivist state, and reasoning each appear as content', () => {
    const joined = compileNarratorPrompt(baseInput()).map((m) => m.content).join('\n');
    expect(joined).toContain('under curfew');
    expect(joined).toContain('location: rooftop');
    expect(joined).toContain('cornered and lash out');
});

test('the voice window is the last content, in order, and is the only prior prose', () => {
    const messages = compileNarratorPrompt(baseInput());
    const tail = messages.slice(-2);
    expect(tail).toEqual([
        { role: 'assistant', content: 'Marcus watched the door.' },
        { role: 'user', content: 'I step closer.' },
    ]);
});

test('an absent reasoning bridge is simply omitted (no empty block)', () => {
    const messages = compileNarratorPrompt(baseInput({ reasoning: '' }));
    expect(messages.every((m) => m.content.trim().length > 0)).toBe(true);
});

test('empty optional inputs still yield a valid system message', () => {
    const messages = compileNarratorPrompt({ card: '', persona: '', worldInfo: '', archivistSections: '', reasoning: '', voiceWindow: [] });
    const system = messages.find((m) => m.role === 'system');
    expect(system).toBeTruthy();
    expect(system.content).toContain(CAMERA_CONSTRAINT);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-narrator-prompt`
Expected: FAIL — `compileNarratorPrompt is not a function`.

- [ ] **Step 3: Implement `compileNarratorPrompt`**

Append to `.../SillyTavern-Remodel/narrator-prompt.js`:

```js
/**
 * Build the Narrator's message array. Order: a single system message (card +
 * persona + camera constraint), then world info, archivist state, and the
 * framed Director reasoning as system context, then the voice window as the
 * only prior prose. The full chat history is deliberately absent.
 */
export function compileNarratorPrompt(input = {}) {
    const { card = '', persona = '', worldInfo = '', archivistSections = '', reasoning = '', voiceWindow = [] } = input;
    const systemParts = [card, persona, CAMERA_CONSTRAINT].filter((p) => String(p || '').trim());
    const messages = [{ role: 'system', content: systemParts.join('\n\n') }];
    if (String(worldInfo || '').trim()) messages.push({ role: 'system', content: worldInfo });
    if (String(archivistSections || '').trim()) messages.push({ role: 'system', content: archivistSections });
    if (String(reasoning || '').trim()) messages.push({ role: 'system', content: reasoning });
    for (const line of Array.isArray(voiceWindow) ? voiceWindow : []) {
        if (line && String(line.content || '').trim()) messages.push({ role: line.role === 'user' ? 'user' : 'assistant', content: line.content });
    }
    return messages;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-narrator-prompt`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js tests/remodel-narrator-prompt.test.js
git commit -m "feat(remodel): compileNarratorPrompt builds the archivist-driven message array"
```

---

## Task 3: Stream-availability gate

**Files:**
- Modify: `.../SillyTavern-Remodel/narrator-prompt.js` (add `narratorStreamBlock`)
- Test: `tests/remodel-narrator-prompt.test.js` (extend)

**Interfaces:**
- Consumes: `canStreamStory` from `story-stream.js`.
- Produces: `narratorStreamBlock() → string` — a user-facing reason when the directed Narrator cannot run (backend can't stream), or `''` when it can. Task 4 calls this at the top of `generateDirectedPerformer`.

- [ ] **Step 1: Write the failing test**

Append to `tests/remodel-narrator-prompt.test.js`:

```js
import { narratorStreamBlock } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js';
import { __setContextOverrides } from './util/st-context-stub.js';
```

(If `__setContextOverrides` does not exist in the stub, use whatever setter the stub provides for `mainApi`/`chatCompletionSettings` — inspect `tests/util/st-context-stub.js` first and match its API. The two assertions below are the contract regardless of setter name.)

```js
describe('narratorStreamBlock', () => {
    test('returns empty when Chat Completion streaming is available', () => {
        __setContextOverrides({ mainApi: 'openai', chatCompletionSettings: { stream_openai: true } });
        expect(narratorStreamBlock()).toBe('');
    });
    test('returns a clear reason when the backend cannot stream', () => {
        __setContextOverrides({ mainApi: 'textgenerationwebui', chatCompletionSettings: { stream_openai: false } });
        const reason = narratorStreamBlock();
        expect(reason).not.toBe('');
        expect(reason.toLowerCase()).toContain('stream');
    });
});
```

- [ ] **Step 2: Confirm the stub setter**

Read `tests/util/st-context-stub.js`. Confirm the exact function that sets `mainApi` and `chatCompletionSettings` on the context (it may be `__setContextOverrides`, `__setContext`, or fields on `__setExtensionSettings`'s object). Adjust the test import/calls to the real setter. Do not invent one.

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-narrator-prompt`
Expected: FAIL — `narratorStreamBlock is not a function`.

- [ ] **Step 4: Implement `narratorStreamBlock`**

Append to `.../SillyTavern-Remodel/narrator-prompt.js`:

```js
import { canStreamStory } from './story-stream.js';

/**
 * Why the directed Narrator cannot run right now, or '' if it can. The custom
 * path streams via streamChatPrompt, which only works on Chat Completion with
 * streaming enabled; there is no native fallback.
 */
export function narratorStreamBlock() {
    if (canStreamStory()) return '';
    return 'The directed Narrator needs a Chat Completion backend with streaming enabled. Switch to a Chat Completion API and turn on streaming to use it.';
}
```

(Place the `import` at the top of the file with the other imports.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-narrator-prompt`
Expected: PASS — all 7 tests.

- [ ] **Step 6: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js tests/remodel-narrator-prompt.test.js
git commit -m "feat(remodel): stream-availability gate for the directed Narrator"
```

---

## Task 4: Rewire `generateDirectedPerformer` to the custom path

**Files:**
- Modify: `.../SillyTavern-Remodel/live-direction.js` — `generateDirectedPerformer` (~1671–1810); add `buildNarratorSnapshot`.

**Interfaces:**
- Consumes: `compileNarratorPrompt`, `buildNarratorArchivistSections`, `narratorStreamBlock` (Tasks 1–3); `streamChatPrompt` (already imported); `frameDirectorReasoning` (already in file); `acceptNativeBuffer`, `scheduleReveal`, `finalizeRunMessage` (unchanged).
- Produces: a Narrator turn that pushes its own attributed message and streams via `streamChatPrompt`, with `run.messageId` set to the pushed index and `run.abortController` set (consumed by Task 5).

> **This task is browser-verified, not unit-tested** — it rewrites the live generation call. Follow the edits, then run the verification workflow in the running app.

- [ ] **Step 1: Add the imports**

At the top of `live-direction.js`, add to the existing import section:

```js
import { compileNarratorPrompt, buildNarratorArchivistSections, narratorStreamBlock } from './narrator-prompt.js';
```

- [ ] **Step 2: Add `buildNarratorSnapshot` (async gatherer)**

Add near `buildDirectionSnapshot`. It gathers the Narrator's inputs from context, mirroring how the Director gathers its own:

```js
async function buildNarratorSnapshot(scene, run) {
    const context = getContext();
    const chid = Number(run.performer.characterId);
    const character = context.characters?.[chid] || null;
    // Card fields for the performer, resolved eagerly (see timeline-spine.js's
    // getCharacterCardFields usage). Fall back to the raw description.
    let card = '';
    try {
        const fields = context.getCharacterCardFields?.({ chid });
        card = [fields?.description, fields?.personality, fields?.scenario].filter(Boolean).join('\n\n') || String(character?.description || '');
    } catch { card = String(character?.description || ''); }
    const persona = String(context.getPersonaDescription?.() || context.name1 ? `The user plays ${context.name1}.` : '');
    let worldInfo = '';
    try {
        const scan = [buildNarratorArchivistSections(scene.timelineId, scene.id), card].join('\n');
        const lore = await context.getWorldInfoPrompt?.(scan, context.maxContext, true);
        worldInfo = String(lore?.worldInfoString || lore || '');
    } catch { worldInfo = ''; }
    // Voice window: the last 2-3 non-user-hidden chat lines, most recent last.
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const voiceWindow = chat.slice(-3).map((m) => ({ role: m.is_user ? 'user' : 'assistant', content: String(m.mes || '') })).filter((m) => m.content.trim());
    return {
        card,
        persona,
        worldInfo,
        archivistSections: buildNarratorArchivistSections(scene.timelineId, scene.id),
        reasoning: frameDirectorReasoning(run.envelope?.reasoning) || '',
        voiceWindow,
    };
}
```

Note: verify `getCharacterCardFields`, `getPersonaDescription`, and `getWorldInfoPrompt`'s return shape against the running context during Step 8 (the app is the source of truth for these core helpers); adjust the field access if the live objects differ. The `try/catch` guards keep a missing helper from throwing.

- [ ] **Step 3: Gate at the top of `generateDirectedPerformer`**

As the first statements inside `generateDirectedPerformer` (before `resolveDirector`/`activeRun` setup), refuse when the backend cannot stream:

```js
    const streamBlock = narratorStreamBlock();
    if (streamBlock) {
        throw new Error(streamBlock);
    }
```

(The existing callers already surface a thrown error to the user; confirm the message appears in Step 8.)

- [ ] **Step 4: Push the attributed performer message**

After `activeRun` is assigned and `releaseDirectionLock(token)` is called, and BEFORE generation, create the message row (replacing the role core used to play). Use the shape the extension already uses for `context.chat.push` (timeline-spine.js:2376):

```js
    const narratorContext = getContext();
    const performerCard = narratorContext.characters?.[Number(performer.characterId)] || null;
    const performerMessage = {
        name: performerCard?.name || performer.label || 'Narrator',
        is_user: false,
        is_system: false,
        send_date: Date.now(),
        mes: '',
        extra: {},
    };
    if (performerCard?.avatar && performerCard.avatar !== 'none') {
        performerMessage.original_avatar = performerCard.avatar;
        performerMessage.force_avatar = narratorContext.getThumbnailUrl?.('avatar', performerCard.avatar) || performerCard.avatar;
    }
    narratorContext.chat.push(performerMessage);
    activeRun.messageId = narratorContext.chat.length - 1;
```

- [ ] **Step 5: Replace the native generation block with the custom stream**

Remove the `setNativePromptContent('directorNotes', …)` injection and the whole `if (testAdapters?.generatePerformer) … else if (context.groupId) { generateGroupWrapper … } else { context.generate … }` block. In its place:

```js
    const controller = new AbortController();
    activeRun.abortController = controller;
    capturePromptLog('narrator');
    const snapshot = await buildNarratorSnapshot(scene, activeRun);
    const prompt = compileNarratorPrompt(snapshot);
    ownedGenerationDepth++;
    const generationStartedAt = Date.now();
    try {
        if (testAdapters?.generatePerformer) {
            await testAdapters.generatePerformer({ scene, envelope, performer, prompt, run: activeRun });
        } else {
            const result = await streamChatPrompt({
                prompt,
                onChunk: (update) => acceptNativeBuffer(update.text),
                signal: controller.signal,
            });
            if (!result.streamed) acceptNativeBuffer(result.text);
            activeRun.reasoning = result.reasoning;
        }
    } catch (error) {
        if (!controller.signal.aborted) throw error; // an aborted stream is an interruption, not a failure
    } finally {
        ownedGenerationDepth = Math.max(0, ownedGenerationDepth - 1);
        if (activeRun?.directionId === envelope.directionId) {
            activeRun.generationFinished = true;
            activeRun.generationSettled = true;
            scheduleReveal(0);
        }
    }
```

Keep the existing `journal('generation.start'/'generation.end', …)` calls, adapting their fields (drop `transport`/`nativeIndex`; keep `directionId`, `durationMs`, `bufferedLength`). Preserve any post-generation logic that ran after the old `finally`.

- [ ] **Step 6: Remove now-dead native wiring for this path**

The `STREAM_TOKEN_RECEIVED` / `MESSAGE_RECEIVED` / `GENERATION_ENDED` listeners (live-direction.js:180–224) still exist for safety but no longer fire for the Narrator (no `prepareOpenAIMessages`). Leave them in place — they are harmless and still guard on `ownsLiveDirectionGeneration()`. Do NOT delete them in this task (the Director path and recovery still rely on `ownsLiveDirectionGeneration`).

- [ ] **Step 7: Sanity — run the existing direction suites**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json "remodel-direction"`
Expected: PASS. If a test drove the old native path via `testAdapters.generatePerformer`, update its adapter call to the new signature (`{ scene, envelope, performer, prompt, run }`). Fix any that assumed native generation.

- [ ] **Step 8: Browser verification (REQUIRED — this replaces unit tests for this task)**

1. `preview_start` the `sillytavern` dev server; open a chat on a Chat Completion backend with streaming ON.
2. Start a directed scene and send a turn. Verify: a Narrator message appears with the **correct name and avatar**, streams in gradually (reveal works), and reads as a continuation (not a restatement of prior prose).
3. `read_network_requests` — confirm the outgoing prompt contains the archivist sections and NOT the full chat history.
4. `read_console_messages` / `preview_logs` — no errors; `journal` shows the custom path.
5. Switch to a non-streaming backend (or streaming off) and start a turn — confirm the clear refusal message appears and no empty Narrator row is left behind.

- [ ] **Step 9: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js
git commit -m "feat(remodel): stream the Narrator via custom archivist-driven path"
```

---

## Task 5: Interruption via AbortController

**Files:**
- Modify: `.../SillyTavern-Remodel/live-direction.js` — `interruptLiveDirection` (~2210–2238).

**Interfaces:**
- Consumes: `activeRun.abortController` (Task 4).
- Produces: interruption that aborts the custom stream instead of calling `stopGeneration()`.

> Browser-verified.

- [ ] **Step 1: Swap the stop mechanism**

In `interruptLiveDirection`, replace the native stop:

```js
    if (!run.generationSettled && ownsLiveDirectionGeneration()) {
        getContext().stopGeneration?.();
        await waitFor(() => run.generationSettled, 2200);
    }
```

with an abort of the run's own controller:

```js
    if (!run.generationSettled && run.abortController) {
        run.abortController.abort();
        await waitFor(() => run.generationSettled, 2200);
    }
```

`streamChatPrompt` honors the signal (checks it per-iteration and hands it to `sendOpenAIRequest`), and Task 4's `finally` sets `generationSettled` when the awaited call returns — so the `waitFor` resolves promptly rather than racing a core event.

- [ ] **Step 2: Browser verification (REQUIRED)**

1. In the running app, start a directed turn and, while it is revealing, **send another message** (interrupt-with-intervention) — verify the Narrator stops, the partial prose is kept, and the new turn proceeds.
2. Start another turn and hit **Stop** — verify it halts and (if nothing was accepted) leaves no empty row.
3. `read_console_messages` — no unhandled abort errors (the `catch` in Task 4 swallows aborts).

- [ ] **Step 3: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js
git commit -m "feat(remodel): interrupt the Narrator via AbortController"
```

---

## Task 6: Event-emission audit

**Files:**
- Modify: `.../SillyTavern-Remodel/live-direction.js` — after `finalizeRunMessage` writes the message (or at the `completeVisibleRun` finalize site).

**Interfaces:**
- Consumes: the finalized message + `run.messageId`.
- Produces: the minimal set of core events downstream listeners need, emitted after finalize.

> Browser-verified; the audit is investigative and its result is code.

- [ ] **Step 1: Audit which events downstream code depends on**

The native path emitted `MESSAGE_RECEIVED`, `CHARACTER_MESSAGE_RENDERED`, `GENERATION_ENDED`, etc. Determine which are load-bearing for a finalized Narrator message by checking:
- Core UI message rendering: does the message bubble render and behave (swipes, edit) without `CHARACTER_MESSAGE_RENDERED`? Test in the browser.
- Other Remodel code / extensions listening for a new assistant message.

Write the findings (which events, why) as a comment above the emission call.

- [ ] **Step 2: Emit the needed events after finalize**

After `finalizeRunMessage` completes for a normal completion (in `completeVisibleRun`, after finalize), emit exactly the events the audit found load-bearing, e.g.:

```js
    // Native generation fired these; the custom path must emit them for core UI
    // and listeners that expect a rendered assistant message. Audited <date>:
    // <which listeners need which events>.
    const ctx = getContext();
    await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, run.messageId);
    await ctx.eventSource.emit(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, run.messageId);
```

Emit only what the audit justifies. Do **not** emit `CHAT_CHANGED` on this path (slow async, ~8.5s, 21 listeners) — and never `await` an emission on the reveal timer path.

- [ ] **Step 3: Browser verification (REQUIRED)**

1. After a Narrator turn completes, verify the message is fully interactive: swipe, edit, delete all work.
2. Confirm any dependent extension/UI updates as it did with native generation.
3. `read_console_messages` — no listener errors.

- [ ] **Step 4: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js
git commit -m "feat(remodel): emit audited core events for custom Narrator messages"
```

---

## Self-Review

**Spec coverage:**
- Availability gate (`canStreamStory`) → Task 3 + Task 4 Step 3. ✅
- `compileNarratorPrompt` + archivist formatter in `narrator-prompt.js` → Tasks 1–2. ✅ (Spec Components 2–3.)
- Self-created attributed message → Task 4 Step 4. ✅ (Component 4.)
- `streamChatPrompt` rewire, cumulative `onChunk`, `streamed:false` handling → Task 4 Step 5. ✅ (Component 5.)
- AbortController interruption → Task 5. ✅ (Component 6.)
- Event-emission audit → Task 6. ✅ (Component 7.)
- Reveal/finalize unchanged → Tasks 4–6 leave `revealStep`/`finalizeRunMessage` untouched. ✅
- Secrets never reach the Narrator → Task 1 (fail-closed, tested). ✅
- Reasoning bridge kept as a Narrator input → Task 4 Step 2 (`frameDirectorReasoning`). ✅

**Placeholder scan:** Tasks 1–3 contain full code and assertions. Tasks 4–6 give exact edit locations and code; their "investigate the live helper shape" steps (Task 4 Step 2 note, Task 6 Step 1) are defined browser-verification steps with a specific question and source, not vague TODOs — appropriate because these seams are only observable in the running app.

**Type consistency:** `buildNarratorArchivistSections(timelineId, sceneId) → string` (Task 1) is consumed by `buildNarratorSnapshot` (Task 4). `compileNarratorPrompt(input) → {role,content}[]` (Task 2) input fields (`card, persona, worldInfo, archivistSections, reasoning, voiceWindow`) are exactly what `buildNarratorSnapshot` returns (Task 4 Step 2). `narratorStreamBlock() → string` (Task 3) is called in Task 4 Step 3. `run.abortController` set in Task 4 Step 5 is read in Task 5 Step 1. Consistent.

**Known integration unknowns (resolved during execution, not gaps):** the exact return shapes of `getCharacterCardFields`/`getPersonaDescription`/`getWorldInfoPrompt` and the precise attribution fields core reads for name/avatar are confirmed against the running app in Task 4 Step 8 — the plan gives the expected shapes with `try/catch` guards and a verification gate rather than guessing silently.
