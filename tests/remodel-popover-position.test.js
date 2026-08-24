import { positionPopover } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/popover-position.js';

test('clamps a right-edge roleplay menu inside the viewport', () => {
    const result = positionPopover(
        { left: 1148, top: 520, bottom: 552 },
        { width: 280, height: 174 },
        { width: 1365, height: 720 },
    );
    expect(result.left).toBe(1077);
    expect(result.top).toBe(338);
    expect(result.placement).toBe('above');
});

test('falls below and clamps vertically when there is no room above', () => {
    const result = positionPopover(
        { left: 4, top: 20, bottom: 52 },
        { width: 240, height: 300 },
        { width: 500, height: 320 },
    );
    expect(result).toMatchObject({ left: 8, top: 12, placement: 'below' });
});
