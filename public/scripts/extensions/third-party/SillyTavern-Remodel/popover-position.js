/** Keep a fixed popover inside the visible viewport, preferring above. */
export function positionPopover(anchor, menu, viewport, { gap = 8, padding = 8 } = {}) {
    const width = Math.max(0, Number(menu?.width) || 0);
    const height = Math.max(0, Number(menu?.height) || 0);
    const viewportWidth = Math.max(0, Number(viewport?.width) || 0);
    const viewportHeight = Math.max(0, Number(viewport?.height) || 0);
    const leftMax = Math.max(padding, viewportWidth - width - padding);
    const left = Math.min(Math.max(padding, Number(anchor?.left) || 0), leftMax);
    const above = (Number(anchor?.top) || 0) - height - gap;
    const below = (Number(anchor?.bottom) || 0) + gap;
    const topMax = Math.max(padding, viewportHeight - height - padding);
    const preferredTop = above >= padding ? above : below;
    const top = Math.min(Math.max(padding, preferredTop), topMax);
    return { left, top, placement: above >= padding ? 'above' : 'below' };
}
