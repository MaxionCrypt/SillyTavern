import {
    DISCLOSURE_MODES,
    KNOWLEDGE_STANCES,
    actorStance,
    findKnowledgeLeaks,
    normalizeKnowledgeScope,
    projectActorKnowledge,
    projectAuthorKnowledge,
    renderKnowledgeSection,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/knowledge-scopes.js';

const SECRETS = [
    { key: 'piper-is-the-informant', value: 'Piper has been reporting to the Warden since spring.' },
    { key: 'gate-code', value: 'The gate code is 4-1-7.' },
    { key: 'marisol-illness', value: 'Marisol is dying and has told no one.' },
];

const SCOPES = [
    { key: 'piper-is-the-informant', authorKnows: true, disclosure: 'foreshadowable', actors: { marisol: 'suspects', piper: 'knows' } },
    { key: 'gate-code', authorKnows: true, disclosure: 'revealable', actors: { piper: 'knows' } },
    { key: 'marisol-illness', authorKnows: true, disclosure: 'causal-only', actors: { marisol: 'knows' } },
];

test('the typed vocabularies are closed', () => {
    expect(KNOWLEDGE_STANCES).toEqual(['knows', 'suspects', 'unknown']);
    expect(DISCLOSURE_MODES).toEqual(['revealable', 'foreshadowable', 'causal-only']);
});

test('unrecorded knowledge is unknown, never inferred', () => {
    expect(actorStance(undefined, 'wren')).toBe('unknown');
    expect(actorStance({ key: 'k', actors: {} }, 'wren')).toBe('unknown');
    expect(actorStance(SCOPES[1], 'marisol')).toBe('unknown');
});

test('a malformed record narrows what may be said rather than widening it', () => {
    const scope = normalizeKnowledgeScope({ key: 'k', disclosure: 'shout-it', actors: { wren: 'definitely-knows' } });
    expect(scope.disclosure).toBe('causal-only');
    expect(scope.actors.wren).toBe('unknown');
});

test('an actor who knows receives the value', () => {
    const projection = projectActorKnowledge({ secrets: SECRETS, scopes: SCOPES, actor: 'piper' });
    const gate = projection.items.find((item) => item.key === 'gate-code');
    expect(gate).toMatchObject({ stance: 'knows', value: 'The gate code is 4-1-7.' });
});

test('an actor who merely suspects gets the key and never the value', () => {
    const projection = projectActorKnowledge({ secrets: SECRETS, scopes: SCOPES, actor: 'marisol' });
    const informant = projection.items.find((item) => item.key === 'piper-is-the-informant');
    expect(informant).toMatchObject({ stance: 'suspects', value: null });
});

test('an actor who does not know is not told the secret exists', () => {
    const projection = projectActorKnowledge({ secrets: SECRETS, scopes: SCOPES, actor: 'marisol' });
    expect(projection.items.map((item) => item.key)).not.toContain('gate-code');

    const stranger = projectActorKnowledge({ secrets: SECRETS, scopes: SCOPES, actor: 'wren' });
    expect(stranger.items).toEqual([]);
});

test('an actor projection never carries a value the actor lacks', () => {
    for (const actor of ['marisol', 'piper', 'wren']) {
        const projection = projectActorKnowledge({ secrets: SECRETS, scopes: SCOPES, actor });
        for (const item of projection.items) {
            if (item.stance !== 'knows') expect(item.value).toBeNull();
        }
    }
});

test('the author view carries everything, labelled with what may be done with it', () => {
    const author = projectAuthorKnowledge({ secrets: SECRETS, scopes: SCOPES });
    expect(author.items).toHaveLength(3);
    expect(author.items.find((item) => item.key === 'marisol-illness')).toMatchObject({
        disclosure: 'causal-only', knownBy: ['marisol'], suspectedBy: [],
    });
    expect(author.items.find((item) => item.key === 'piper-is-the-informant')).toMatchObject({
        disclosure: 'foreshadowable', knownBy: ['piper'], suspectedBy: ['marisol'],
    });
});

test('a secret the author does not know is withheld from the author view too', () => {
    const author = projectAuthorKnowledge({
        secrets: SECRETS,
        scopes: [{ key: 'gate-code', authorKnows: false, actors: { piper: 'knows' } }, ...SCOPES.slice(2)],
    });
    expect(author.items.map((item) => item.key)).not.toContain('gate-code');
});

test('rendering is one adapter and reflects the projection exactly', () => {
    const actorText = renderKnowledgeSection(projectActorKnowledge({ secrets: SECRETS, scopes: SCOPES, actor: 'marisol' }), 'actor');
    expect(actorText).toContain('suspected, not established');
    expect(actorText).not.toContain('4-1-7');
    expect(actorText).not.toContain('reporting to the Warden');

    const authorText = renderKnowledgeSection(projectAuthorKnowledge({ secrets: SECRETS, scopes: SCOPES }), 'author');
    expect(authorText).toContain('[causal-only]');
    expect(authorText).toContain('4-1-7');

    expect(renderKnowledgeSection({ actor: 'wren', items: [] }, 'actor')).toBe('');
});

test('the leak guard names exactly the values an actor must not have seen', () => {
    const leaked = 'She said it plainly: The gate code is 4-1-7. Nobody moved.';
    expect(findKnowledgeLeaks(leaked, { secrets: SECRETS, scopes: SCOPES, actor: 'marisol' }))
        .toEqual(['The gate code is 4-1-7.']);
    // Piper knows the code, so the same text is not a leak for Piper.
    expect(findKnowledgeLeaks(leaked, { secrets: SECRETS, scopes: SCOPES, actor: 'piper' })).toEqual([]);
});

test('a suspicion does not license stating the fact', () => {
    const text = 'Piper has been reporting to the Warden since spring.';
    expect(findKnowledgeLeaks(text, { secrets: SECRETS, scopes: SCOPES, actor: 'marisol' })).toEqual([text]);
});

test('clean text produces no leaks', () => {
    expect(findKnowledgeLeaks('She crossed the room and said nothing.', { secrets: SECRETS, scopes: SCOPES, actor: 'wren' }))
        .toEqual([]);
});
