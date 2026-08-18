import { buildDirectionSources } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-sources.js';

// The performer's card is not a person in the scene. It is the instrument the
// prose comes out of, and its description is an authoring style guide — on the
// owner's Timeline, 3,341 of the snapshot's 9,180 characters of "Author Rules"
// and "Literary Rules" delivered under a heading saying these are the people
// in your scene. That is why the Director wrote prose instead of direction.

const NARRATOR = { kind: 'narrator', id: 'The Narrator II.png', label: 'The Narrator II' };

function snapshotWith(cast) {
    return {
        scene: { id: 's1', timelineId: 't1', title: 'roleplay one' },
        currentAction: '"Really Teo?" I sigh.',
        narratorRef: NARRATOR,
        cast,
        persona: { label: 'Eli Mercer' },
        acceptedHistory: [],
    };
}

const STYLE_GUIDE = '## Author Rules\n1. Never name an emotion or interior state.';

test('the performer is not listed as a member of its own cast', () => {
    const { directorSnapshot } = buildDirectionSources(snapshotWith([
        { ref: NARRATOR, label: 'The Narrator II', description: STYLE_GUIDE },
    ]));

    expect(directorSnapshot).not.toContain('Author Rules');
    expect(directorSnapshot).not.toContain('Never name an emotion');
    // PERFORMER still says who writes, which is the only thing about them the
    // Director needs.
    expect(directorSnapshot).toContain('The Narrator II writes the next response.');
});

test('real cast members keep their descriptions in full', () => {
    const { directorSnapshot } = buildDirectionSources(snapshotWith([
        { ref: NARRATOR, label: 'The Narrator II', description: STYLE_GUIDE },
        { ref: { kind: 'character', id: 'teo.png' }, label: 'Teo Alvarez', description: 'Collects things nobody asked him to collect.' },
    ]));

    expect(directorSnapshot).toContain('Teo Alvarez');
    expect(directorSnapshot).toContain('Collects things nobody asked him to collect.');
    expect(directorSnapshot).not.toContain('Author Rules');
});

test('the performer is matched by id, not by label', () => {
    // Two cards can share a display name. resolvePerformer matched on id, so
    // this must too, or a same-named NPC would be silently dropped from the
    // cast the Director is directing.
    const { directorSnapshot } = buildDirectionSources(snapshotWith([
        { ref: NARRATOR, label: 'The Narrator II', description: STYLE_GUIDE },
        { ref: { kind: 'character', id: 'other.png' }, label: 'The Narrator II', description: 'A different card that happens to share a name.' },
    ]));

    expect(directorSnapshot).toContain('A different card that happens to share a name.');
    expect(directorSnapshot).not.toContain('Author Rules');
});

test('with no narratorRef nothing is excluded, rather than everything', () => {
    // A Scene with no Narrator bound must not lose its whole cast to a blank
    // id matching a blank id.
    const snapshot = { ...snapshotWith([{ ref: { kind: 'character', id: '' }, label: 'Teo Alvarez', description: 'Present.' }]), narratorRef: null };
    const { directorSnapshot } = buildDirectionSources(snapshot);

    expect(directorSnapshot).toContain('Teo Alvarez');
    expect(directorSnapshot).toContain('Present.');
});

test('a cast of only the performer renders no CAST section at all', () => {
    const { directorSnapshot } = buildDirectionSources(snapshotWith([
        { ref: NARRATOR, label: 'The Narrator II', description: STYLE_GUIDE },
    ]));

    expect(directorSnapshot).not.toMatch(/^CAST$/m);
});
