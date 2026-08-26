import fs from 'node:fs';

const timelineSpine = fs.readFileSync(
    new URL('../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-spine.js', import.meta.url), 'utf8');
const styles = fs.readFileSync(
    new URL('../public/scripts/extensions/third-party/SillyTavern-Remodel/style.css', import.meta.url), 'utf8');

test('Archive continuity toggles expose an explicit On or Off state alongside aria-pressed', () => {
    expect(timelineSpine).toContain('aria-pressed="${active ? \'true\' : \'false\'}"');
    expect(timelineSpine).toContain('class="remodel-archive-continuity-state"');
    expect(timelineSpine).toContain("${active ? 'On' : 'Off'}");
    expect(styles).toMatch(/\.remodel-archive-continuity-button\.is-active \.remodel-archive-continuity-state\s*\{/);
});

test('World Sense browser and inspector cards size to their own content', () => {
    const gridRule = styles.match(/body\.st-remodel-active \.remodel-world-sense-grid\s*\{([^}]*)\}/)?.[1] || '';
    const panelsRule = styles.match(/body\.st-remodel-active \.remodel-world-sense-browser,\s*body\.st-remodel-active \.remodel-world-sense-inspector\s*\{([^}]*)\}/)?.[1] || '';

    expect(gridRule).toMatch(/align-items:\s*start/);
    expect(gridRule).toMatch(/min-height:\s*0/);
    expect(gridRule).not.toMatch(/min-height:\s*610px/);
    expect(panelsRule).toMatch(/align-self:\s*start/);
});
