import {
    buildTimelineContinuityDocuments,
    scoreTimelineContinuityCandidates,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-continuity.js';
import {
    getSceneContinuitySettings,
    pinContinuityRecord,
    recordEvent,
    setSceneContinuitySettings,
    setSceneFact,
    setSecret,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';
import { buildWorldSenseQueryPacket, selectWorldSenseCandidates } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-retrieval.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

const TIMELINE = 'timeline-continuity';

beforeEach(() => {
    __setExtensionSettings({ remodel: {
        timelineV1: {
            version: 1,
            timelineIds: [TIMELINE],
            activeTimelineId: TIMELINE,
            timelines: { [TIMELINE]: { id: TIMELINE, title: 'Route', arcIds: ['arc-1', 'arc-2'], activeSceneId: 'scene-3' } },
            arcs: {
                'arc-1': { id: 'arc-1', timelineId: TIMELINE, title: 'Arrival', sceneIds: ['scene-1', 'scene-2'] },
                'arc-2': { id: 'arc-2', timelineId: TIMELINE, title: 'Aftermath', sceneIds: ['scene-3'] },
            },
            scenes: {
                'scene-1': { id: 'scene-1', timelineId: TIMELINE, arcId: 'arc-1', title: 'The Cellar', mode: 'roleplay' },
                'scene-2': { id: 'scene-2', timelineId: TIMELINE, arcId: 'arc-1', title: 'The Search', mode: 'roleplay' },
                'scene-3': { id: 'scene-3', timelineId: TIMELINE, arcId: 'arc-2', title: 'The Return', mode: 'roleplay' },
            },
        },
    } });
});

test('indexes accepted facts and events with arc and scene provenance', () => {
    const event = recordEvent(TIMELINE, 'scene-1', 'Mara hid the obsidian key beneath the cellar floor.');
    setSceneFact(TIMELINE, 'scene-1', 'location', 'Vesper House cellar');

    const result = buildTimelineContinuityDocuments(TIMELINE);

    expect(result.documents).toEqual(expect.arrayContaining([
        expect.objectContaining({ metadata: expect.objectContaining({ kind: 'archive', sceneId: 'scene-1', arcId: 'arc-1', recordType: 'event', recordId: event.id }) }),
        expect.objectContaining({ metadata: expect.objectContaining({ sceneTitle: 'The Cellar', arcTitle: 'Arrival', recordType: 'fact' }) }),
    ]));
    expect(result.hash).toMatch(/^[0-9a-f]{16}$/);
});

test('never places Archive secrets in continuity records or embedding documents', () => {
    recordEvent(TIMELINE, 'scene-1', 'Mara locked the cellar door.');
    setSecret(TIMELINE, 'scene-1', 'parasite-origin', 'The dean planted the alien egg.');

    const result = buildTimelineContinuityDocuments(TIMELINE);

    expect(JSON.stringify(result)).not.toContain('alien egg');
    expect(result.records.map((item) => item.recordType)).not.toContain('secret');
});

test('only earlier eligible scenes are automatic sources and settings remain timeline-isolated', () => {
    recordEvent(TIMELINE, 'scene-1', 'Mara hid the obsidian key beneath the cellar floor.');
    recordEvent(TIMELINE, 'scene-2', 'The search ended with the cellar still sealed.');
    setSceneContinuitySettings(TIMELINE, 'scene-2', { shareForward: false });

    const candidates = scoreTimelineContinuityCandidates({
        timelineId: TIMELINE,
        sceneId: 'scene-3',
        packet: buildWorldSenseQueryPacket({ action: 'Mara searches for the obsidian key in the cellar.' }),
        records: buildTimelineContinuityDocuments(TIMELINE).records,
        semanticMatches: [],
    });

    expect(candidates.map((candidate) => candidate.record.sceneId)).toEqual(['scene-1']);
    expect(getSceneContinuitySettings(TIMELINE, 'scene-2')).toMatchObject({ readPrevious: true, shareForward: false });
    expect(getSceneContinuitySettings('another-timeline', 'scene-2')).toMatchObject({ readPrevious: true, shareForward: true });
});

test('explicit recalls survive automatic look-back being disabled and enter the shared budget as forced provenance', () => {
    const event = recordEvent(TIMELINE, 'scene-1', 'Mara hid the obsidian key beneath the cellar floor.');
    setSceneContinuitySettings(TIMELINE, 'scene-3', { readPrevious: false });
    pinContinuityRecord(TIMELINE, 'scene-3', { sourceSceneId: 'scene-1', recordType: 'event', recordId: event.id });

    const candidates = scoreTimelineContinuityCandidates({
        timelineId: TIMELINE,
        sceneId: 'scene-3',
        packet: buildWorldSenseQueryPacket({ action: 'Return to the cellar.' }),
        records: buildTimelineContinuityDocuments(TIMELINE).records,
        semanticMatches: [],
    });
    const ranked = selectWorldSenseCandidates(candidates, { budget: { maxEntries: 1, maxTokens: 120 }, continuityLimit: 4 });

    expect(ranked.selected).toEqual([expect.objectContaining({
        kind: 'continuity', sceneId: 'scene-1', arcTitle: 'Arrival', sceneTitle: 'The Cellar', forced: true,
    })]);
    expect(ranked.selected[0].reasons).toEqual(expect.arrayContaining([expect.objectContaining({ channel: 'continuity.pin' })]));
});

test('a consumer may exclude one prior scene without disabling timeline recall', () => {
    recordEvent(TIMELINE, 'scene-1', 'Mara hid the obsidian key beneath the cellar floor.');
    recordEvent(TIMELINE, 'scene-2', 'Mara carried the brass key into the sealed cellar.');
    setSceneContinuitySettings(TIMELINE, 'scene-3', { excludedSceneIds: ['scene-1'] });

    const candidates = scoreTimelineContinuityCandidates({
        timelineId: TIMELINE,
        sceneId: 'scene-3',
        packet: buildWorldSenseQueryPacket({ action: 'Mara searches the cellar for a key.' }),
        records: buildTimelineContinuityDocuments(TIMELINE).records,
        semanticMatches: [],
    });

    expect(candidates.map((candidate) => candidate.record.sceneId)).toEqual(['scene-2']);
});

test('Story and Roleplay Archive evidence share one ordered Timeline index', () => {
    const settings = __setExtensionSettings({ remodel: {
        timelineV1: {
            version: 1,
            timelineIds: [TIMELINE],
            activeTimelineId: TIMELINE,
            timelines: { [TIMELINE]: { id: TIMELINE, title: 'Route', arcIds: ['arc-1'], activeSceneId: 'scene-rp-2' } },
            arcs: { 'arc-1': { id: 'arc-1', timelineId: TIMELINE, title: 'Mixed', sceneIds: ['scene-rp-1', 'scene-story', 'scene-rp-2'] } },
            scenes: {
                'scene-rp-1': { id: 'scene-rp-1', timelineId: TIMELINE, arcId: 'arc-1', title: 'Roleplay Discovery', mode: 'roleplay' },
                'scene-story': { id: 'scene-story', timelineId: TIMELINE, arcId: 'arc-1', title: 'Story Decision', mode: 'story' },
                'scene-rp-2': { id: 'scene-rp-2', timelineId: TIMELINE, arcId: 'arc-1', title: 'Roleplay Consequence', mode: 'roleplay' },
            },
        },
    } });
    expect(settings).toBeTruthy();
    recordEvent(TIMELINE, 'scene-rp-1', 'Mara found the western gate mechanism.');
    recordEvent(TIMELINE, 'scene-story', 'Mara sealed the western gate in the manuscript.');

    const source = buildTimelineContinuityDocuments(TIMELINE);
    expect(source.records.map((record) => [record.sceneId, record.sceneMode])).toEqual([
        ['scene-rp-1', 'roleplay'],
        ['scene-story', 'story'],
    ]);
    const candidates = scoreTimelineContinuityCandidates({
        timelineId: TIMELINE,
        sceneId: 'scene-rp-2',
        packet: buildWorldSenseQueryPacket({ action: 'What happened at the western gate?' }),
        records: source.records,
    });
    expect(candidates.map((candidate) => candidate.record.sceneId)).toEqual(['scene-rp-1', 'scene-story']);
});
