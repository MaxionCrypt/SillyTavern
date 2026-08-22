import {
    captureSentPromptLog,
    compilePromptRecipe,
    getPromptLog,
    parseMacroArguments,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio.js';

function recipe(blocks) {
    return { id: 'macro-recipe', mode: 'story', apiType: 'chat', blocks };
}

test('recipe macro arguments parse named numbers, booleans, quoted strings, and depth alias', () => {
    expect(parseMacroArguments('messages=3 enabled=true label="Old forest"')).toEqual({
        messages: 3,
        depth: 3,
        enabled: true,
        label: 'Old forest',
    });
});

test('text macros expand inline inside ordinary authored messages', () => {
    const compiled = compilePromptRecipe(recipe([
        { id: 'one', kind: 'message', role: 'system', enabled: true, content: 'Character:\n{{character.card}}' },
    ]), { characterCard: 'Eli Mercer' });
    expect(compiled.messages).toEqual([{ role: 'system', content: 'Character:\nEli Mercer' }]);
});

test('standalone structural macros preserve the roles and order of their message sequence', () => {
    const compiled = compilePromptRecipe(recipe([
        { id: 'one', kind: 'message', role: 'system', enabled: true, content: '{{world.info.depth messages=3}}' },
    ]), {
        worldInfoDepth: (args) => ({
            messages: [
                { role: 'system', content: `Depth ${args.depth}` },
                { role: 'user', content: 'A remembered warning' },
            ],
        }),
    });
    expect(compiled.messages).toEqual([
        { role: 'system', content: 'Depth 3' },
        { role: 'user', content: 'A remembered warning' },
    ]);
});

test('unknown SillyTavern macros remain available to the native macro engine', () => {
    const compiled = compilePromptRecipe(recipe([
        { id: 'one', kind: 'message', role: 'system', enabled: true, content: 'Speak as {{char}}.' },
    ]));
    expect(compiled.messages[0].content).toContain('{{char}}');
});

test('Prompt Log stores every final message and the complete redacted request payload', () => {
    captureSentPromptLog('narrator', {
        recipeName: 'Native Narrator',
        messages: [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Continue' }],
        request: { prompt: [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Continue' }], temperature: 0.8, api_key: 'hidden' },
        transport: 'chat',
    });
    const entry = getPromptLog().narrator;
    expect(entry.blocks.map((block) => block.content)).toEqual(['Rules', 'Continue']);
    expect(entry.request.temperature).toBe(0.8);
    expect(entry.request.api_key).toBe('[redacted]');
    expect(getPromptLog().latest).toBe(entry);
});
