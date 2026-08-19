# Single-Agent Narrator — Step 1: Ground the Narrator (Recent History)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the directed Narrator a real bounded window of recent chat history so its prose is grounded and coherent, instead of the 2–3 line window that left it hallucinating unmoored text.

**Architecture:** A single focused change to how the Narrator's prompt is gathered — replace the fixed 3-message "voice window" with a bounded recent-history window (sized by a character budget). Everything else stays: the Director still runs, the archivist state block and reasoning stay in the prompt. This isolates the coherence hypothesis (starved context → rambling) so it can be validated live before the larger single-agent restructure.

**Tech Stack:** Vanilla ES modules, Jest (`--experimental-vm-modules`), `tests/util/st-context-stub.js`.

**Spec:** `docs/superpowers/specs/2026-08-19-single-agent-narrator-design.md` — this is rollout Step 1 (Pass 1 grounding), done as the minimal coherence-validation slice. The Director-removal / Pass 2 extraction / Stop fix / notebook removal are separate follow-on plans.

## Global Constraints

- The window is bounded by a **character budget** (`NARRATOR_HISTORY_BUDGET`, default `8000` chars ≈ ~2000 tokens), newest messages first, capped at a hard message count (`NARRATOR_HISTORY_MAX_MESSAGES`, default `40`). Tuned in code, not a UI setting.
- The just-created empty performer message (blank `mes`) must never appear in the window.
- Append-only framing is preserved: the history is labelled "the story so far — continue from where it ends; do not rewrite or restate it."
- Field rename: `voiceWindow` → `recentHistory` in `compileNarratorPrompt`'s input and `buildNarratorSnapshot`'s output. Update the existing tests to match.
- Test run command, from `tests/`:
  `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json <pattern>`

---

## File Structure

- **Modify `.../SillyTavern-Remodel/narrator-prompt.js`** — `compileNarratorPrompt` input field `voiceWindow` → `recentHistory`; add the two budget constants; the message-building loop is unchanged except the field name.
- **Modify `.../SillyTavern-Remodel/live-direction.js`** — `buildNarratorSnapshot` builds `recentHistory` as a budgeted window instead of `chat.slice(-3)`; the snapshot's field and the prompt-log labels follow the rename.
- **Modify `tests/remodel-narrator-prompt.test.js`** — rename `voiceWindow` → `recentHistory` in fixtures/assertions; add a budget test.
- **Modify `tests/remodel-narrator-stream-path.test.js`** — the end-to-end test still passes; add an assertion that multiple history lines reach the prompt log.

---

## Task 1: Bounded recent-history window

**Files:**
- Modify: `.../SillyTavern-Remodel/narrator-prompt.js`
- Modify: `.../SillyTavern-Remodel/live-direction.js` (`buildNarratorSnapshot`, and the narrator prompt-log label list)
- Test: `tests/remodel-narrator-prompt.test.js`, `tests/remodel-narrator-stream-path.test.js`

**Interfaces:**
- Produces: `compileNarratorPrompt({ card, persona, worldInfo, archivistSections, reasoning, recentHistory }) → {role,content}[]` (renamed field). `buildNarratorSnapshot` returns `recentHistory` as `{role,content}[]`, newest-last, budget-bounded.
- Consumes: `getContext().chat`.

- [ ] **Step 1: Write the failing test (rename + budget)**

In `tests/remodel-narrator-prompt.test.js`, rename `voiceWindow` to `recentHistory` in `baseInput` and the "voice window" test (rename its title to "recent history"), then add a budget helper is not needed here — the budgeting lives in `buildNarratorSnapshot`, not `compileNarratorPrompt`. `compileNarratorPrompt` just consumes whatever array it's handed. So update the field name only, and keep the existing ordering assertion:

```js
// in baseInput():
        recentHistory: [
            { role: 'assistant', content: 'Marcus watched the door.' },
            { role: 'user', content: 'I step closer.' },
        ],
```

```js
test('recent history is the last content, in order, and continues the story', () => {
    const messages = compileNarratorPrompt(baseInput());
    const tail = messages.slice(-2);
    expect(tail).toEqual([
        { role: 'assistant', content: 'Marcus watched the door.' },
        { role: 'user', content: 'I step closer.' },
    ]);
});
```

Update the other tests in the file that reference `voiceWindow` (the empty-input test's `voiceWindow: []` → `recentHistory: []`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-narrator-prompt`
Expected: FAIL — `compileNarratorPrompt` still destructures `voiceWindow`, so `recentHistory` is ignored and the tail assertion fails.

- [ ] **Step 3: Rename the field in `compileNarratorPrompt`**

In `narrator-prompt.js`, change the destructure and the loop:

```js
export function compileNarratorPrompt(input = {}) {
    const { card = '', persona = '', worldInfo = '', archivistSections = '', reasoning = '', recentHistory = [] } = input;
    const systemParts = [card, persona, CAMERA_CONSTRAINT].filter((p) => String(p || '').trim());
    const messages = [{ role: 'system', content: systemParts.join('\n\n') }];
    if (String(worldInfo || '').trim()) messages.push({ role: 'system', content: worldInfo });
    if (String(archivistSections || '').trim()) messages.push({ role: 'system', content: archivistSections });
    if (String(reasoning || '').trim()) messages.push({ role: 'system', content: reasoning });
    for (const line of Array.isArray(recentHistory) ? recentHistory : []) {
        if (line && String(line.content || '').trim()) messages.push({ role: line.role === 'user' ? 'user' : 'assistant', content: line.content });
    }
    return messages;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-narrator-prompt`
Expected: PASS.

- [ ] **Step 5: Add the budget constants**

At the top of `narrator-prompt.js`, after the imports, add:

```js
// The Narrator's grounding window: the most recent chat lines, newest last,
// bounded so the prompt stays affordable. Long-range memory is the archivist's
// job, not raw history — so this is a window, not the whole log.
export const NARRATOR_HISTORY_BUDGET = 8000;        // characters (~2000 tokens)
export const NARRATOR_HISTORY_MAX_MESSAGES = 40;
```

- [ ] **Step 6: Write the failing test for the budgeted window (in the store/e2e file)**

In `tests/remodel-narrator-stream-path.test.js`, seed several chat messages before a run and assert more than 3 reach the prompt log. First add a helper to push history, then extend the completion test. Add near the top imports:

```js
import { compileNarratorPrompt } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js';
```

Then a new test:

```js
test('the narrator prompt includes a real window of recent history, not just 3 lines', async () => {
    const chat = __getChat();
    for (let i = 0; i < 8; i++) chat.push({ name: i % 2 ? 'Wren' : 'You', is_user: i % 2 === 0, mes: `history line ${i}`, extra: {} });
    narratorStreams(['Wren ', 'moves.']);
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    const compiled = __getDebugEvents().find((e) => e.type === 'narrator.compiled');
    // Voice-window count in the journal detail reflects the recent-history size.
    expect(compiled.detail.voiceWindow).toBeGreaterThan(3);
});
```

(The `narrator.compiled` journal detail field is currently named `voiceWindow`; Step 8 renames it to `recentHistory` — update this assertion in that step.)

- [ ] **Step 7: Run it to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-narrator-stream-path`
Expected: FAIL — `buildNarratorSnapshot` still uses `chat.slice(-3)`, so at most 3 lines reach the prompt; `voiceWindow` count is ≤ 3.

- [ ] **Step 8: Build the budgeted window in `buildNarratorSnapshot`**

In `live-direction.js`, update the import to add the constants:

```js
import { compileNarratorPrompt, buildNarratorArchivistSections, narratorStreamBlock, NARRATOR_HISTORY_BUDGET, NARRATOR_HISTORY_MAX_MESSAGES } from './narrator-prompt.js';
```

Replace the `voiceWindow` block in `buildNarratorSnapshot` with a budgeted `recentHistory`:

```js
    const chat = Array.isArray(context.chat) ? context.chat : [];
    // The most recent lines, newest last, bounded by a character budget and a
    // hard message cap. The just-created empty performer row (blank mes) is
    // skipped by the non-empty filter. Long-range facts live in the archivist
    // block, so this window can stay small.
    const recentHistory = [];
    let budget = NARRATOR_HISTORY_BUDGET;
    for (let i = chat.length - 1; i >= 0 && recentHistory.length < NARRATOR_HISTORY_MAX_MESSAGES; i--) {
        const content = String(chat[i]?.mes || '').trim();
        if (!content) continue;
        if (budget - content.length < 0 && recentHistory.length) break;
        budget -= content.length;
        recentHistory.unshift({ role: chat[i].is_user ? 'user' : 'assistant', content });
    }
    return {
        card,
        persona,
        worldInfo,
        archivistSections: buildNarratorArchivistSections(scene.timelineId, scene.id),
        reasoning: frameDirectorReasoning(run.envelope?.reasoning) || '',
        recentHistory,
    };
```

- [ ] **Step 9: Update the prompt-log labels and journal for the rename**

In `live-direction.js`, in the custom branch where the narrator prompt log is built, rename the `voiceWindow` references to `recentHistory`:

```js
            for (const line of snapshot.recentHistory) narratorLabels.push(line.role === 'user' ? 'Recent history — you' : 'Recent history — character');
            captureNarratorPromptLog(prompt.map((message, index) => ({ label: narratorLabels[index] || 'Context', role: message.role, content: message.content })));
            journal('narrator.compiled', {
                directionId: envelope.directionId,
                blocks: prompt.length,
                hasArchivist: Boolean(String(snapshot.archivistSections || '').trim()),
                archivistChars: String(snapshot.archivistSections || '').length,
                hasReasoning: Boolean(String(snapshot.reasoning || '').trim()),
                worldInfoChars: String(snapshot.worldInfo || '').length,
                recentHistory: snapshot.recentHistory.length,
            }, { correlationId: envelope.directionId, summary: 'Narrator prompt compiled (custom stream)' });
```

Then update the Step 6 test assertion from `compiled.detail.voiceWindow` to `compiled.detail.recentHistory`.

- [ ] **Step 10: Run the narrator tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json remodel-narrator`
Expected: PASS — prompt tests, stream-path tests (incl. the new history-window test), and the section formatter.

- [ ] **Step 11: Run the full direction sweep for no regression**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json "remodel-(direction|director|narrator)"`
Expected: PASS — the rename and window change do not disturb the lifecycle (the test adapter path never builds a narrator snapshot).

- [ ] **Step 12: Commit**

```bash
git add public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js tests/remodel-narrator-prompt.test.js tests/remodel-narrator-stream-path.test.js
git commit -m "feat(remodel): ground the Narrator with a bounded recent-history window"
```

- [ ] **Step 13: Live smoke test (REQUIRED — the whole point)**

Reload SillyTavern (Chat Completion + streaming). Run a multi-turn directed scene. Verify in **Prompt Studio → Prompt Log → Narrator** that the prompt now contains several "Recent history" blocks, and that the prose **reads as a coherent continuation** rather than the unmoored rambling from before. Check the debug timeline's `narrator.compiled` shows `recentHistory` > 3.

**Decision gate:** if grounding restores coherence, proceed to the follow-on plans (Director removal → Pass 2 extraction → Stop fix → notebook removal). If it does not, stop and reassess before the larger restructure — the hypothesis was wrong and the big refactor needs rethinking.

---

## Self-Review

**Spec coverage:** Implements rollout Step 1's grounding half (bounded recent history + archivist block) as an isolated, testable slice. The Director-removal half of Step 1, and Steps 2–4, are explicitly deferred to follow-on plans. ✅

**Placeholder scan:** All steps carry full code and exact run commands. The live smoke test (Step 13) is a defined verification with pass/fail criteria and a decision gate, not a placeholder. ✅

**Type consistency:** `recentHistory` is the field name in `compileNarratorPrompt`'s destructure (Step 3), `buildNarratorSnapshot`'s return (Step 8), the prompt-log labels and journal (Step 9), and the tests (Steps 1, 6). The old `voiceWindow` name is fully removed. ✅

## Follow-on Plans (out of scope here)

- **Director removal** — fold the Director's judgment into Pass 1's own reasoning; restructure `beginDirection` so the single agent both reasons and writes; drop the separate `requestDirection` call.
- **Pass 2 extraction** — `extractStateFromProse(prose, reasoning, context)` after finalize → mechanics request → `executeMechanicsRequest`; move state execution off the finalize-time envelope path.
- **Stop = cut off** — flush the buffer into accepted prose on manual stop; never delete a non-empty run.
- **Notebook removal + direction cards** — delete `director-notes-store.js`; re-source the roleplay-stream direction cards from the archivist.
