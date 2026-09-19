import { __setExtensionSettings } from './util/st-context-stub.js';
import { renderLoomAction } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('{{loom.action}} wraps the player action as authoritative, and is empty when blank', () => {
    const rendered = renderLoomAction('Aiden shoulders the iron door.');
    expect(rendered).toContain('AUTHORITATIVE TURN INPUT');
    expect(rendered).toContain('Aiden shoulders the iron door.');
    expect(renderLoomAction('   ')).toBe('');
});
