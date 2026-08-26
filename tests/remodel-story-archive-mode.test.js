import { beforeEach, expect, test } from '@jest/globals';
import { createArc, createScene, createTimeline, getScene, updateScene } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-state.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('Story Scenes default to automatic archive capture and retain manual timing', () => {
    const timeline = createTimeline('Archive timing');
    const arc = createArc(timeline.id, 'Opening');
    const scene = createScene(arc.id, 'story', 'Manuscript');

    expect(scene).toMatchObject({ storyArchiveMode: 'auto', generationProfileIds: { story: null } });

    updateScene(scene.id, {
        storyArchiveMode: 'manual',
        generationProfileIds: { narrator: null, story: 'coauthor-profile', loom: 'loom-profile' },
    });

    expect(getScene(scene.id)).toMatchObject({
        storyArchiveMode: 'manual',
        generationProfileIds: { story: 'coauthor-profile', loom: 'loom-profile' },
    });
});
