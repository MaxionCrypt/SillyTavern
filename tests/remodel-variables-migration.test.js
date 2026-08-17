import {
    clearMigrationBackup,
    getMigrationBackup,
    getVariableStore,
    listVariableEvents,
    listVariableValues,
    setVariableField,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

// Fixtures mirror shapes taken from a real settings file, not invented ones.
// The V1 records are the [DEMO] set that shipped as runtime fixtures — an enum
// definition whose states are OBJECTS, a resource with a maximum, and an
// instance carrying a modifier under the old `delta` key. Those three shapes
// are exactly what the migration used to destroy.

const TIMELINE = 'timeline-fixture-1';

function v1Store() {
    return {
        version: 2,
        definitionIds: ['def-vitality', 'def-alertness'],
        definitions: {
            'def-vitality': {
                id: 'def-vitality', key: 'demo-vitality', name: 'Vitality', kind: 'resource',
                summary: 'Physical durability.', constraints: { minimum: 0, maximum: null },
                loreRef: { book: 'Fixture Book', uid: '3' },
                enumStates: [],
            },
            'def-alertness': {
                id: 'def-alertness', key: 'demo-alertness', name: 'Alertness', kind: 'enum',
                summary: 'Current awareness state.',
                loreRef: { book: 'Fixture Book', uid: '5' },
                // The shape that broke: objects, not strings.
                enumStates: [
                    { id: 'unaware', label: 'Unaware', reachModifier: -10 },
                    { id: 'suspicious', label: 'Suspicious', reachModifier: 0 },
                    { id: 'hunting', label: 'Hunting', reachModifier: 10 },
                ],
            },
        },
        timelineDefinitions: {},
        timelineInstances: {
            [TIMELINE]: {
                timelineId: TIMELINE,
                instanceIds: ['inst-vitality', 'inst-alertness'],
                instances: {
                    'inst-vitality': {
                        id: 'inst-vitality', timelineId: TIMELINE, definitionId: 'def-vitality',
                        ownerRef: { kind: 'character', id: 'lord-veyr', label: 'Lord Veyr' },
                        value: 68, maximum: 100,
                        // The old key. Reading only `amount` dropped every one.
                        modifiers: [{ id: 'mod-1', label: 'Wounded', delta: -12, target: 'value' }],
                    },
                    'inst-alertness': {
                        id: 'inst-alertness', timelineId: TIMELINE, definitionId: 'def-alertness',
                        ownerRef: { kind: 'character', id: 'lord-veyr', label: 'Lord Veyr' },
                        value: 'suspicious', maximum: null, modifiers: [],
                    },
                },
            },
        },
        eventIds: ['ev-1'],
        events: { 'ev-1': { id: 'ev-1', variableId: 'inst-vitality', type: 'variable.adjusted', at: '2026-08-13T06:00:00.000Z' } },
        transactionIds: [], transactions: {},
        mechanicsProfile: { enabled: true, contextBudget: 8000 },
    };
}

function goalsStore() {
    return {
        version: 2,
        goals: {
            'goal-1': {
                id: 'goal-1', timelineId: TIMELINE, title: 'Survive the night', status: 'active', successRate: 30,
                // Points at a V1 instance id; must be remapped or the Goal is unreachable.
                resolution: { kind: 'tracked', variableInstanceId: 'inst-vitality', field: 'value', direction: 'decrease', completionThreshold: 0 },
            },
        },
        timelines: {}, scenes: {}, relations: {}, events: {},
    };
}

function migrate(namespace) {
    __setExtensionSettings({ remodel: namespace });
    return getVariableStore();
}

describe('V1 to V3 migration', () => {
    test('carries enum states across instead of stringifying the objects', () => {
        migrate({ storyVariablesV1: v1Store() });
        const alertness = listVariableValues({ timelineId: TIMELINE }).find((v) => v.name.includes('Alertness'));
        expect(alertness.valueType).toBe('enum');
        expect(alertness.enumValues).toEqual(['unaware', 'suspicious', 'hunting']);
        expect(alertness.value).toBe('suspicious');
        expect(alertness.enumValues).not.toContain('[object Object]');
    });

    test('keeps modifiers that used the old delta key', () => {
        migrate({ storyVariablesV1: v1Store() });
        const vitality = listVariableValues({ timelineId: TIMELINE }).find((v) => v.name.includes('Vitality'));
        expect(vitality.modifiers).toHaveLength(1);
        expect(vitality.modifiers[0].amount).toBe(-12);
        expect(vitality.modifiers[0].label).toBe('Wounded');
    });

    test('names a migrated Variable from its owner and definition, and keeps its bounds', () => {
        migrate({ storyVariablesV1: v1Store() });
        const vitality = listVariableValues({ timelineId: TIMELINE }).find((v) => v.name.includes('Vitality'));
        expect(vitality.name).toBe('Lord Veyr Vitality');
        expect(vitality.value).toBe(68);
        expect(vitality.subvalues.find((s) => s.role === 'maximum').value).toBe(100);
        expect(vitality.subvalues.find((s) => s.role === 'minimum').value).toBe(0);
    });

    test('migrates the legacy event ledger', () => {
        migrate({ storyVariablesV1: v1Store() });
        const events = listVariableEvents({ timelineId: TIMELINE });
        expect(events.some((e) => e.type === 'variable.adjusted')).toBe(true);
    });

    test('retains the legacy stores and carries the mechanics profile forward', () => {
        const namespace = { storyVariablesV1: v1Store() };
        const store = migrate(namespace);
        expect(namespace.storyVariablesV1).toBeDefined();
        expect(getMigrationBackup().sources.storyVariablesV1).toBeDefined();
        expect(store.mechanicsProfile.enabled).toBe(true);
        expect(store.mechanicsProfile.contextBudget).toBe(8000);
    });
});

describe('V2 and recovery shapes', () => {
    test('renames V2 fields and converts min/max into subvalues', () => {
        migrate({
            storyVariablesV2: {
                version: 2,
                timelines: { [TIMELINE]: { values: { 'v2-a': { id: 'a', label: 'Faction Heat', note: 'Attention level', kind: 'number', value: 4, min: 0, max: 10, entryRefs: [{ book: 'Fixture Book', uid: '7' }] } } } },
            },
        });
        const heat = listVariableValues({ timelineId: TIMELINE })[0];
        expect(heat.name).toBe('Faction Heat');
        expect(heat.description).toBe('Attention level');
        expect(heat.valueType).toBe('number');
        expect(heat.loreLinks[0]).toMatchObject({ book: 'Fixture Book', uid: '7' });
        expect(heat.subvalues.find((s) => s.role === 'maximum').value).toBe(10);
    });

    test('recovers V1 and Goals from a retired V2 payload', () => {
        const namespace = { storyVariablesV2: { version: 2, timelines: {}, retired: { data: { storyVariablesV1: v1Store(), storyGoalsV3: goalsStore() } } } };
        migrate(namespace);
        expect(listVariableValues({ timelineId: TIMELINE })).toHaveLength(2);
        // The active Goals store must be restored, never treated as Variable data.
        expect(namespace.storyGoalsV3.goals['goal-1']).toBeDefined();
    });

    test('parks malformed records in the unresolved tray rather than dropping them', () => {
        const broken = v1Store();
        broken.timelineInstances[TIMELINE].instances['inst-orphan'] = { id: 'inst-orphan', timelineId: TIMELINE, definitionId: 'missing-def', value: 1 };
        migrate({ storyVariablesV1: broken });
        const unresolved = getMigrationBackup().unresolved;
        expect(unresolved.some((item) => item.reason === 'Missing definition')).toBe(true);
    });
});

describe('idempotency', () => {
    test('a second load neither duplicates Variables nor re-runs migration', () => {
        const namespace = { storyVariablesV1: v1Store() };
        migrate(namespace);
        const firstIds = listVariableValues({ timelineId: TIMELINE }).map((v) => v.id).sort();
        const firstMigratedAt = getMigrationBackup().migratedAt;
        getVariableStore();
        getVariableStore();
        expect(listVariableValues({ timelineId: TIMELINE }).map((v) => v.id).sort()).toEqual(firstIds);
        expect(getMigrationBackup().migratedAt).toBe(firstMigratedAt);
    });

    test('repeated reads do not grow the unresolved tray', () => {
        const broken = v1Store();
        broken.timelineInstances[TIMELINE].instances['inst-orphan'] = { id: 'inst-orphan', timelineId: TIMELINE, definitionId: 'missing-def', value: 1 };
        migrate({ storyVariablesV1: broken });
        const first = getMigrationBackup().unresolved.length;
        for (let i = 0; i < 5; i++) getVariableStore();
        expect(getMigrationBackup().unresolved.length).toBe(first);
    });

    test('a store with content is repaired, not replaced', () => {
        const namespace = { storyVariablesV1: v1Store() };
        migrate(namespace);
        const before = listVariableValues({ timelineId: TIMELINE }).length;
        // A shape failure that used to trigger a wholesale reset.
        namespace.storyVariablesV3.version = 99;
        delete namespace.storyVariablesV3.eventIds;
        getVariableStore();
        expect(listVariableValues({ timelineId: TIMELINE })).toHaveLength(before);
    });
});

describe('write validation', () => {
    test('an enum rejects a state it does not have', () => {
        migrate({ storyVariablesV1: v1Store() });
        const alertness = listVariableValues({ timelineId: TIMELINE }).find((v) => v.name.includes('Alertness'));
        expect(setVariableField(alertness.id, 'value', 'not-a-state')).toBeNull();
        expect(listVariableValues({ timelineId: TIMELINE }).find((v) => v.id === alertness.id).value).toBe('suspicious');
        expect(setVariableField(alertness.id, 'value', 'hunting')).not.toBeNull();
    });
});

describe('backup purge', () => {
    test('clearing discards the retained sources without touching live Variables', () => {
        migrate({ storyVariablesV1: v1Store() });
        const before = listVariableValues({ timelineId: TIMELINE }).length;
        clearMigrationBackup();
        expect(Object.keys(getMigrationBackup().sources)).toHaveLength(0);
        expect(listVariableValues({ timelineId: TIMELINE })).toHaveLength(before);
    });
});
