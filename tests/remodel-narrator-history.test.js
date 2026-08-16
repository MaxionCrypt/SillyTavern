// Task 8: narrow the Narrator's own generation prompt to its own prose.
//
// Design: the Narrator is a passive voice. It renders what the hidden
// Director decided, informed by its own PRIOR PROSE — not by the user's
// words, and not by anything another cast member wrote. Everything the user
// did this turn reaches the Narrator only through the Director's notes (a
// separate, already-filtered injection — director-notes-store.js's
// readNarratorEntries never returns `secret` or `abandoned` entries), so the
// one property this suite exists to pin down is: the filter removes exactly
// the user's and other cast members' chat-history lines, and never the notes
// injection sitting beside them.
//
// Part 1 exercises the pure filter directly (narrator-history.js has zero
// imports, so its exact behaviour can be asserted offline). Part 2 drives it
// through the real event wiring in live-direction.js — the only way to prove
// the notes injection genuinely survives what reaches the seam, rather than
// merely what a hand-built fixture claims about it.
import { test, expect, beforeEach, afterEach } from '@jest/globals';
import { filterNarratorHistory } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-history.js';
import {
    initLiveDirection,
    setLiveDirectionTestAdapters,
    requestNextDirection,
    stopLiveDirection,
    getLiveDirectionRun,
    clearLiveDirectionFailure,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { __setExtensionSettings, __getChat, __emit } from './util/st-context-stub.js';
import { __setOnlineStatus, __getExtensionPrompt, __clearExtensionPromptCalls } from './util/script-stub.js';

// generateDirectedPerformer clears SillyTavern's native composer before it
// hands generation to core, so it touches the DOM once. Jest's environment is
// `node`; these are the two bindings that reach for, nothing more (mirrors
// remodel-direction-lifecycle.test.js's own setup for the same reason).
globalThis.document ??= { getElementById: () => null };
globalThis.HTMLTextAreaElement ??= class HTMLTextAreaElement {};

// ---------------------------------------------------------------- Part 1
// The pure filter, exercised directly.

const chatFixture = [
    { role: 'user', name: 'User', content: 'I open the door.' },
    { role: 'assistant', name: 'The Narrator', content: 'The door creaks open.' },
    { role: 'assistant', name: 'Other Character', content: 'Someone else speaks from the shadows.' },
    { role: 'assistant', name: 'The Narrator', content: 'The room is empty.' },
];

test("only the Narrator's own messages survive filtering", () => {
    const filtered = filterNarratorHistory(chatFixture, { narratorName: 'The Narrator' });
    expect(filtered.every((m) => m.name === 'The Narrator')).toBe(true);
});

// The companion to the test above. "Every remaining entry is named the
// Narrator" is true of an empty array too — this is the shape of test-honesty
// gap this branch has already been bitten by (a test that could not
// distinguish correct history from no history at all). Asserting the actual
// surviving content is what a filter-returns-[] mutation cannot slip past.
test("the Narrator's own history actually survives, not just vacuously (an empty result would also pass a name-only check)", () => {
    const filtered = filterNarratorHistory(chatFixture, { narratorName: 'The Narrator' });
    expect(filtered).toEqual([
        { role: 'assistant', name: 'The Narrator', content: 'The door creaks open.' },
        { role: 'assistant', name: 'The Narrator', content: 'The room is empty.' },
    ]);
});

test("the user's messages do not survive", () => {
    const filtered = filterNarratorHistory(chatFixture, { narratorName: 'The Narrator' });
    expect(filtered.some((m) => m.role === 'user')).toBe(false);
    expect(filtered.some((m) => m.name === 'User')).toBe(false);
});

test("another cast member's messages do not survive", () => {
    const filtered = filterNarratorHistory(chatFixture, { narratorName: 'The Narrator' });
    expect(filtered.some((m) => m.name === 'Other Character')).toBe(false);
});

test("the Director's notes injection — a role: 'system' entry, not chat history — is untouched", () => {
    const notesEntry = { role: 'system', content: "[DIRECTOR'S NOTES — established by the hidden director; treat as settled fact]\nTurn 1\n- The lantern flickers." };
    const withNotes = [notesEntry, ...chatFixture];
    const filtered = filterNarratorHistory(withNotes, { narratorName: 'The Narrator' });
    // Same reference, same position, unmutated — never mistaken for chat
    // history because it carries no `name` and role !== 'user'/'assistant'.
    expect(filtered[0]).toBe(notesEntry);
    expect(filtered.filter((m) => m.role === 'system')).toEqual([notesEntry]);
});

test('a non-array message list degrades to an empty result rather than throwing', () => {
    expect(() => filterNarratorHistory(null, { narratorName: 'The Narrator' })).not.toThrow();
    expect(filterNarratorHistory(null, { narratorName: 'The Narrator' })).toEqual([]);
    expect(filterNarratorHistory(undefined, { narratorName: 'The Narrator' })).toEqual([]);
    expect(filterNarratorHistory('not an array', { narratorName: 'The Narrator' })).toEqual([]);
    expect(filterNarratorHistory(42, { narratorName: 'The Narrator' })).toEqual([]);
});

test('an empty message list degrades to an empty result', () => {
    expect(filterNarratorHistory([], { narratorName: 'The Narrator' })).toEqual([]);
});

test('malformed entries inside an otherwise-valid list are dropped rather than throwing', () => {
    const messy = [null, undefined, 42, 'oops', { role: 'assistant', name: 'The Narrator', content: 'ok' }];
    expect(() => filterNarratorHistory(messy, { narratorName: 'The Narrator' })).not.toThrow();
    expect(filterNarratorHistory(messy, { narratorName: 'The Narrator' })).toEqual([
        { role: 'assistant', name: 'The Narrator', content: 'ok' },
    ]);
});

test('a missing or blank narrator name degrades to a no-op rather than guessing who to drop', () => {
    expect(filterNarratorHistory(chatFixture, {})).toEqual(chatFixture);
    expect(filterNarratorHistory(chatFixture)).toEqual(chatFixture);
    expect(filterNarratorHistory(chatFixture, { narratorName: '   ' })).toEqual(chatFixture);
});

test('an assistant-authored entry with no name at all cannot be identified as not-the-Narrator, so it is kept', () => {
    const unnamed = [{ role: 'assistant', content: 'Nameless prose.' }];
    expect(filterNarratorHistory(unnamed, { narratorName: 'The Narrator' })).toEqual(unnamed);
});

test('the input array and its entries are never mutated', () => {
    const before = JSON.parse(JSON.stringify(chatFixture));
    filterNarratorHistory(chatFixture, { narratorName: 'The Narrator' });
    expect(chatFixture).toEqual(before);
});

// ---------------------------------------------------------------- Part 2
// The real event wiring — proves what reaches the seam, not a hand-built
// fixture's claim about it.

const scene = {
    id: 'scene-narrator-history',
    timelineId: 'timeline-narrator-history',
    title: 'Narrator History Scene',
    mode: 'roleplay',
    staging: 'directed',
    liveDirection: { enabled: true, directorRef: null, narratorRef: null, pacing: 'instant', autoplay: false },
};

// One active card, no Narrator bound: resolvePerformer takes the sole
// available performer (same fallback path remodel-direction-lifecycle.test.js
// exercises), so activeRun.performer.label resolves to exactly this label.
const cast = [{ ref: { kind: 'character', id: 'char-narrator', label: 'The Narrator' }, label: 'The Narrator', characterId: 0 }];

const RESPONSE = 'The Narrator answers the room.';

function directorReply() {
    return ['[note] The room holds its breath.', '```state', JSON.stringify({ requests: [], flow: { continue: false } }), '```'].join('\n');
}

/** Poll rather than sleep: the reveal loop chains through its own timers. */
async function until(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) return false;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return true;
}

beforeEach(() => {
    __setExtensionSettings({});
    __setOnlineStatus('connected');
    __clearExtensionPromptCalls();
    scene.liveDirection.pacing = 'instant';
    initLiveDirection({
        getActiveScene: () => scene,
        getCast: () => cast,
        getPersona: () => null,
        ensureSceneReady: async () => true,
        getComposerDraft: () => '',
        clearComposer: () => {},
        sendNormally: () => {},
        onStateChange: () => {},
        onSettled: () => {},
        onFailure: () => {},
    });
});

afterEach(async () => {
    await stopLiveDirection();
    clearLiveDirectionFailure();
    setLiveDirectionTestAdapters(null);
});

test("the Narrator's own native request keeps its own prior line and the Director's notes, and drops the user's and another cast member's lines", async () => {
    // Seeded so the fixture proves discrimination rather than passing on an
    // empty history either way (the same trap a reviewer already found once
    // in this file's neighbour, remodel-direction-lifecycle.test.js).
    __getChat().push({ name: 'The Narrator', is_user: false, mes: 'The lantern is lit.', extra: {} });
    __getChat().push({ name: 'Someone Else', is_user: false, mes: 'A voice from the dark.', extra: {} });

    let capturedNotes = null;
    let capturedChat = null;
    setLiveDirectionTestAdapters({
        requestDirection: async () => directorReply(),
        // Stands in for core's native generate(): by this point
        // generateDirectedPerformer has already called setExtensionPrompt
        // for this turn's notes (mirrors production ordering — see the
        // comment on that call in live-direction.js), so reading it here is
        // reading the SAME content core would have merged into its own
        // compiled prompt as a system-role entry.
        generatePerformer: async () => {
            capturedNotes = __getExtensionPrompt('remodel_director_notes');
            const eventData = {
                chat: [
                    { role: 'system', content: 'World info before...' },
                    { role: 'user', name: 'User', content: 'I step into the room.' },
                    { role: 'assistant', name: 'The Narrator', content: 'The lantern is lit.' },
                    { role: 'assistant', name: 'Someone Else', content: 'A voice from the dark.' },
                    { role: 'system', content: capturedNotes },
                ],
            };
            await __emit('CHAT_COMPLETION_PROMPT_READY', eventData);
            capturedChat = eventData.chat;

            const chat = __getChat();
            chat.push({ name: 'The Narrator', is_user: false, mes: RESPONSE, extra: {} });
            await __emit('MESSAGE_RECEIVED', chat.length - 1);
        },
    });

    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    expect(capturedNotes).toBeTruthy();
    // Sanity: this is a real, turn-specific notes block, not an empty string
    // or a stand-in — so the assertions below are about the actual notes
    // this turn produced.
    expect(capturedNotes).toContain('The room holds its breath.');
    expect(capturedChat).toBeTruthy();

    // The user's line is gone...
    expect(capturedChat.some((m) => m.role === 'user')).toBe(false);
    // ...another cast member's line is gone...
    expect(capturedChat.some((m) => m.name === 'Someone Else')).toBe(false);
    // ...the Narrator's OWN prior line survives...
    expect(capturedChat).toContainEqual({ role: 'assistant', name: 'The Narrator', content: 'The lantern is lit.' });
    // ...and the Director's notes — the only channel left for what the user
    // did this turn, now that the Narrator is blind to the chat history
    // carrying it — are present verbatim, not merely "some system entry".
    expect(capturedChat).toContainEqual({ role: 'system', content: capturedNotes });
    expect(capturedChat).toHaveLength(3); // world info, the Narrator's own line, the notes
});

test('the filter does nothing to a Chat Completion request live-direction does not own', async () => {
    // Regression guard for the ownership guard itself: emitting the event
    // outside generateDirectedPerformer's window (no activeRun, no owned
    // generation) must leave eventData.chat exactly as some other caller —
    // native chat, another extension — built it.
    const eventData = {
        chat: [
            { role: 'user', name: 'User', content: 'Unrelated native chat message.' },
            { role: 'assistant', name: 'Someone Else', content: 'Unrelated reply.' },
        ],
    };
    const before = JSON.parse(JSON.stringify(eventData.chat));
    await __emit('CHAT_COMPLETION_PROMPT_READY', eventData);
    expect(eventData.chat).toEqual(before);
});
