import { STORY_LOOM_CARD, isStoryLoomInstalled } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-loom-card.js';
import { __setContextOverrides } from './util/st-context-stub.js';

test('the card is named Story Loom and carries the create-endpoint fields', () => {
    expect(STORY_LOOM_CARD.ch_name).toBe('Story Loom');
    for (const field of ['description', 'personality', 'system_prompt', 'post_history_instructions', 'first_mes']) {
        expect(typeof STORY_LOOM_CARD[field]).toBe('string');
        expect(STORY_LOOM_CARD[field].length).toBeGreaterThan(0);
    }
});

test('the system prompt embodies the omniscient camera, append-only, and authored reasoning', () => {
    const brain = `${STORY_LOOM_CARD.system_prompt}\n${STORY_LOOM_CARD.post_history_instructions}`.toLowerCase();
    // Omniscient / camera
    expect(brain).toMatch(/omniscient|narrator|everything|the world/);
    // Append-only (continue forward, do not restate)
    expect(brain).toMatch(/forward|never restate|do not repeat|what happens next/);
    // Authored reasoning that feeds extraction
    expect(brain).toMatch(/reason|thinking|before you write/);
    expect(brain).toMatch(/changes|witnessed|track/);
});

test('isStoryLoomInstalled detects an existing Story Loom in the character list', () => {
    __setContextOverrides({ characters: [{ name: 'Aria' }, { name: 'Story Loom' }] });
    expect(isStoryLoomInstalled()).toBe(true);
    __setContextOverrides({ characters: [{ name: 'Aria' }] });
    expect(isStoryLoomInstalled()).toBe(false);
    __setContextOverrides({ characters: undefined });
    expect(isStoryLoomInstalled()).toBe(false);
});
