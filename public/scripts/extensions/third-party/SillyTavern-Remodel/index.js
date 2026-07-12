import { initTimelineSpine } from './timeline-spine.js';

const STORAGE_KEY = 'sillytavern-remodel-layout-v1';
const MENU_SIDE_STORAGE_KEY = 'sillytavern-remodel-menu-sides-v1';
const LEFT_MIN = 220;
const RIGHT_MIN = 260;
const CHAT_MIN = 420;
const LEFT_COLLAPSE_AT = 140;
const RIGHT_COLLAPSE_AT = 160;
const KEYBOARD_STEP = 16;
const KEYBOARD_LARGE_STEP = 48;
const INIT_TIMEOUT_MS = 10000;
const SIDEBAR_DRAWERS = [
    {
        id: 'remodel-timeline-drawer',
        label: 'Tavern',
        icon: ['fa-solid', 'fa-beer-mug-empty', 'fa-fw'],
    },
    {
        id: 'ai-config-button',
        label: 'Response Settings',
        icon: ['fa-solid', 'fa-sliders', 'fa-fw'],
    },
    {
        id: 'sys-settings-button',
        label: 'API Connections',
        icon: ['fa-solid', 'fa-plug-circle-exclamation', 'fa-fw'],
    },
    {
        id: 'advanced-formatting-button',
        label: 'Response Formatting',
        icon: ['fa-solid', 'fa-font', 'fa-fw'],
    },
    {
        id: 'user-settings-button',
        label: 'User Settings',
        icon: ['fa-solid', 'fa-user-cog', 'fa-fw'],
    },
    {
        id: 'backgrounds-button',
        label: 'Change Background Image',
        icon: ['fa-solid', 'fa-panorama', 'fa-fw'],
    },
    {
        id: 'extensions-settings-button',
        label: 'Extensions',
        icon: ['fa-solid', 'fa-cubes', 'fa-fw'],
    },
];

const variableHost = document.body;
let leftSplitter;
let rightSplitter;
let defaultLayout;
let currentLayout;
let menuSideAssignments;
let menuSideContext;
let initialized = false;
let composerObserver;
let sidebarObserver;
let workspacePanelObserver;

export async function init() {
    if (initialized) {
        return;
    }

    await waitForElement('#sheld');
    ensureRemodelDom();
    applyComposerClasses();

    document.body.classList.add('st-remodel-active');
    initialized = true;

    defaultLayout = getDefaultLayout();
    menuSideAssignments = loadMenuSideAssignments();
    menuSideContext = ensureMenuSideContext();
    currentLayout = applyLayout(loadLayout());

    initTimelineSpine({
        onDrawerReady(drawer) {
            applyMenuSide(drawer);
        },
    });
    configureSidebarRail();
    applyAllMenuSides();
    bindRemodelEvents();
    observeSidebarRailChanges();
    observeWorkspacePanelChanges();
    observeComposerChanges();
}

function waitForElement(selector) {
    const existingElement = document.querySelector(selector);

    if (existingElement) {
        return Promise.resolve(existingElement);
    }

    return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Remodel UI could not find required element: ${selector}`));
        }, INIT_TIMEOUT_MS);

        const observer = new MutationObserver(() => {
            const element = document.querySelector(selector);

            if (!element) {
                return;
            }

            window.clearTimeout(timeout);
            observer.disconnect();
            resolve(element);
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
        });
    });
}

function ensureRemodelDom() {
    const sheld = document.getElementById('sheld');

    if (!sheld || !sheld.parentElement) {
        throw new Error('Remodel UI requires #sheld to initialize.');
    }

    leftSplitter = document.getElementById('remodel-left-splitter') || createSplitter({
        id: 'remodel-left-splitter',
        label: 'Resize left menu and chat columns',
    });

    rightSplitter = document.getElementById('remodel-right-splitter') || createSplitter({
        id: 'remodel-right-splitter',
        label: 'Resize chat and right menu columns',
    });

    if (!leftSplitter.parentElement) {
        sheld.before(leftSplitter);
    }

    if (!rightSplitter.parentElement) {
        sheld.before(rightSplitter);
    }
}

function createSplitter({ id, label }) {
    const splitter = document.createElement('div');
    splitter.id = id;
    splitter.className = 'remodel-column-splitter';
    splitter.setAttribute('role', 'separator');
    splitter.setAttribute('aria-orientation', 'vertical');
    splitter.setAttribute('aria-label', label);
    splitter.tabIndex = 0;
    return splitter;
}

function applyComposerClasses() {
    document.getElementById('send_form')?.classList.add('remodel-composer');
    document.getElementById('nonQRFormItems')?.classList.add('remodel-composer-items');
    document.getElementById('send_textarea')?.classList.add('remodel-story-input');
    document.getElementById('leftSendForm')?.classList.add('remodel-composer-toolbar', 'remodel-composer-toolbar-left');
    document.getElementById('rightSendForm')?.classList.add('remodel-composer-toolbar', 'remodel-composer-toolbar-right');
}

function observeComposerChanges() {
    if (composerObserver) {
        return;
    }

    let pending = false;
    composerObserver = new MutationObserver(() => {
        if (pending) {
            return;
        }

        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            applyComposerClasses();
        });
    });

    composerObserver.observe(document.body, {
        childList: true,
        subtree: true,
    });
}

function ensureMenuSideContext() {
    const existingContext = document.getElementById('remodel-menu-side-context');

    if (existingContext) {
        return existingContext;
    }

    const context = document.createElement('div');
    context.id = 'remodel-menu-side-context';
    context.innerHTML = `
        <button type="button" data-remodel-side="left">Open Left</button>
        <button type="button" data-remodel-side="right">Open Right</button>
    `;
    document.body.append(context);
    return context;
}

function readPxVariable(name, fallback) {
    const hostValue = getComputedStyle(variableHost).getPropertyValue(name).trim();
    const rootValue = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const parsedValue = Number.parseFloat(hostValue || rootValue);
    return Number.isFinite(parsedValue) ? parsedValue : fallback;
}

function getRailWidth() {
    return readPxVariable('--rail-width', 60);
}

function getViewportWidth() {
    return window.innerWidth || document.documentElement.clientWidth || 1280;
}

function getDefaultLayout() {
    return {
        leftWidth: readPxVariable('--remodel-left-width', 260),
        rightWidth: readPxVariable('--remodel-right-width', 300),
        leftCollapsed: false,
        rightCollapsed: false,
    };
}

function loadLayout() {
    try {
        const savedLayout = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        return {
            leftWidth: Number.isFinite(savedLayout.leftWidth) ? savedLayout.leftWidth : defaultLayout.leftWidth,
            rightWidth: Number.isFinite(savedLayout.rightWidth) ? savedLayout.rightWidth : defaultLayout.rightWidth,
            leftCollapsed: Boolean(savedLayout.leftCollapsed),
            rightCollapsed: Boolean(savedLayout.rightCollapsed),
        };
    } catch {
        return defaultLayout;
    }
}

function saveLayout(layout) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
        leftWidth: Math.round(layout.leftWidth),
        rightWidth: Math.round(layout.rightWidth),
        leftCollapsed: Boolean(layout.leftCollapsed),
        rightCollapsed: Boolean(layout.rightCollapsed),
    }));
}

function loadMenuSideAssignments() {
    try {
        const savedAssignments = JSON.parse(localStorage.getItem(MENU_SIDE_STORAGE_KEY) || '{}');
        return savedAssignments && typeof savedAssignments === 'object' ? savedAssignments : {};
    } catch {
        return {};
    }
}

function saveMenuSideAssignments() {
    localStorage.setItem(MENU_SIDE_STORAGE_KEY, JSON.stringify(menuSideAssignments));
}

function getDrawerId(drawer) {
    return drawer?.id || '';
}

function getDefaultMenuSide(drawerId) {
    return drawerId === 'ai-config-button' ? 'right' : 'left';
}

function getAssignedMenuSide(drawer) {
    const drawerId = getDrawerId(drawer);
    const assignedSide = menuSideAssignments[drawerId];
    return assignedSide === 'right' || assignedSide === 'left' ? assignedSide : getDefaultMenuSide(drawerId);
}

function getDrawerContent(drawer) {
    return drawer?.querySelector(':scope > .drawer-content');
}

function applyMenuSide(drawer) {
    const drawerContent = getDrawerContent(drawer);

    if (!drawerContent) {
        return;
    }

    const side = getAssignedMenuSide(drawer);
    drawerContent.classList.toggle('remodel-side-right', side === 'right');
    drawerContent.classList.toggle('remodel-side-left', side !== 'right');
}

function applyAllMenuSides() {
    document.querySelectorAll('#top-settings-holder > .drawer').forEach((drawer) => {
        applyMenuSide(drawer);
    });
}

function configureSidebarRail() {
    const holder = document.getElementById('top-settings-holder');

    if (!holder) {
        return;
    }

    const allowedDrawerIds = new Set(SIDEBAR_DRAWERS.map((drawer) => drawer.id));

    for (const drawerConfig of SIDEBAR_DRAWERS) {
        const drawer = document.getElementById(drawerConfig.id);

        if (!drawer) {
            continue;
        }

        holder.append(drawer);
        drawer.classList.add('remodel-sidebar-drawer');
        drawer.classList.remove('remodel-sidebar-hidden');
        renameSidebarDrawer(drawer, drawerConfig);
    }

    holder.querySelectorAll(':scope > .drawer').forEach((drawer) => {
        if (allowedDrawerIds.has(drawer.id)) {
            return;
        }

        closeDrawer(drawer);
        drawer.classList.add('remodel-sidebar-hidden');
    });

    syncWorkspacePanelState();
}

function observeSidebarRailChanges() {
    if (sidebarObserver) {
        return;
    }

    const holder = document.getElementById('top-settings-holder');

    if (!holder) {
        return;
    }

    let pending = false;
    sidebarObserver = new MutationObserver(() => {
        if (pending) {
            return;
        }

        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            configureSidebarRail();
            applyAllMenuSides();
        });
    });

    sidebarObserver.observe(holder, {
        childList: true,
    });
}

function observeWorkspacePanelChanges() {
    if (workspacePanelObserver) {
        return;
    }

    const holder = document.getElementById('top-settings-holder');

    if (!holder) {
        return;
    }

    workspacePanelObserver = new MutationObserver(syncWorkspacePanelState);
    workspacePanelObserver.observe(holder, {
        attributes: true,
        attributeFilter: ['class'],
        childList: true,
        subtree: true,
    });
    syncWorkspacePanelState();
}

function syncWorkspacePanelState() {
    const activePanel = document.querySelector('#top-settings-holder > .drawer.remodel-sidebar-drawer > .drawer-content.remodel-workspace-panel.openDrawer');
    document.body.classList.toggle('remodel-workspace-active', Boolean(activePanel));
}

function renameSidebarDrawer(drawer, { label, icon }) {
    const toggle = drawer.querySelector(':scope > .drawer-toggle');
    const iconElement = drawer.querySelector(':scope > .drawer-toggle .drawer-icon');
    const drawerContent = getDrawerContent(drawer);

    toggle?.setAttribute('aria-label', label);
    toggle?.setAttribute('title', label);
    drawerContent?.classList.add('remodel-workspace-panel');
    drawerContent?.setAttribute('data-remodel-workspace-title', label);

    if (!iconElement) {
        return;
    }

    iconElement.title = label;
    iconElement.setAttribute('aria-label', label);
    iconElement.dataset.remodelLabel = label;
    iconElement.removeAttribute('data-i18n');

    const stateClass = iconElement.classList.contains('openIcon') ? 'openIcon' : 'closedIcon';
    iconElement.className = `drawer-icon ${icon.join(' ')} ${stateClass}`;
}

function closeDrawer(drawer) {
    const drawerContent = getDrawerContent(drawer);
    const drawerIcon = drawer.querySelector(':scope > .drawer-toggle .drawer-icon');

    drawerContent?.classList.remove('openDrawer');
    drawerContent?.classList.add('closedDrawer');
    drawerIcon?.classList.remove('openIcon');
    drawerIcon?.classList.add('closedIcon');
}

function setMenuSide(drawer, side) {
    const drawerId = getDrawerId(drawer);

    if (!drawerId || (side !== 'left' && side !== 'right')) {
        return;
    }

    menuSideAssignments[drawerId] = side;
    saveMenuSideAssignments();
    applyMenuSide(drawer);
    restoreSide(side);
}

function closeMenuSideContext() {
    menuSideContext.removeAttribute('data-open');
    menuSideContext.removeAttribute('data-drawer-id');
}

function openMenuSideContext(drawer, event) {
    applyMenuSide(drawer);
    menuSideContext.dataset.drawerId = getDrawerId(drawer);
    menuSideContext.dataset.open = 'true';
    menuSideContext.style.left = `${Math.min(event.clientX, window.innerWidth - 150)}px`;
    menuSideContext.style.top = `${Math.min(event.clientY, window.innerHeight - 86)}px`;

    const assignedSide = getAssignedMenuSide(drawer);
    menuSideContext.querySelectorAll('[data-remodel-side]').forEach((button) => {
        button.toggleAttribute('aria-current', button.dataset.remodelSide === assignedSide);
    });
}

function clampLayout(layout) {
    const railWidth = getRailWidth();
    const availableWidth = Math.max(LEFT_MIN + RIGHT_MIN, getViewportWidth() - railWidth - CHAT_MIN);

    let leftCollapsed = Boolean(layout.leftCollapsed);
    let rightCollapsed = Boolean(layout.rightCollapsed);
    let leftWidth = Number(layout.leftWidth);
    let rightWidth = Number(layout.rightWidth);

    if (!Number.isFinite(leftWidth)) {
        leftWidth = defaultLayout.leftWidth;
    }

    if (!Number.isFinite(rightWidth)) {
        rightWidth = defaultLayout.rightWidth;
    }

    if (!leftCollapsed && leftWidth < LEFT_COLLAPSE_AT) {
        leftCollapsed = true;
    }

    if (!rightCollapsed && rightWidth < RIGHT_COLLAPSE_AT) {
        rightCollapsed = true;
    }

    leftWidth = leftCollapsed ? 0 : Math.max(LEFT_MIN, leftWidth);
    rightWidth = rightCollapsed ? 0 : Math.max(RIGHT_MIN, rightWidth);

    if (leftWidth + rightWidth > availableWidth) {
        let excessWidth = leftWidth + rightWidth - availableWidth;

        const leftShrinkRoom = leftCollapsed ? 0 : Math.max(0, leftWidth - LEFT_MIN);
        const leftShrink = Math.min(leftShrinkRoom, excessWidth / 2);
        leftWidth -= leftShrink;
        excessWidth -= leftShrink;

        const rightShrinkRoom = rightCollapsed ? 0 : Math.max(0, rightWidth - RIGHT_MIN);
        const rightShrink = Math.min(rightShrinkRoom, excessWidth);
        rightWidth -= rightShrink;
        excessWidth -= rightShrink;

        if (excessWidth > 0) {
            if (!leftCollapsed) {
                leftWidth = LEFT_MIN;
            }

            if (!rightCollapsed) {
                rightWidth = RIGHT_MIN;
            }
        }
    }

    return {
        leftWidth: Math.round(leftWidth),
        rightWidth: Math.round(rightWidth),
        leftCollapsed,
        rightCollapsed,
    };
}

function applyLayout(layout, { persist = false } = {}) {
    const clampedLayout = clampLayout(layout);
    variableHost.style.setProperty('--remodel-left-width', `${clampedLayout.leftWidth}px`);
    variableHost.style.setProperty('--remodel-right-width', `${clampedLayout.rightWidth}px`);
    document.body.classList.toggle('remodel-left-collapsed', clampedLayout.leftCollapsed);
    document.body.classList.toggle('remodel-right-collapsed', clampedLayout.rightCollapsed);

    if (leftSplitter) {
        const leftMax = Math.max(LEFT_MIN, getViewportWidth() - getRailWidth() - clampedLayout.rightWidth - CHAT_MIN);
        leftSplitter.setAttribute('aria-valuemin', '0');
        leftSplitter.setAttribute('aria-valuemax', String(Math.round(leftMax)));
        leftSplitter.setAttribute('aria-valuenow', String(clampedLayout.leftWidth));
        leftSplitter.setAttribute('aria-valuetext', clampedLayout.leftCollapsed ? 'Left panel collapsed' : `Left panel ${clampedLayout.leftWidth}px`);
    }

    if (rightSplitter) {
        const rightMax = Math.max(RIGHT_MIN, getViewportWidth() - getRailWidth() - clampedLayout.leftWidth - CHAT_MIN);
        rightSplitter.setAttribute('aria-valuemin', '0');
        rightSplitter.setAttribute('aria-valuemax', String(Math.round(rightMax)));
        rightSplitter.setAttribute('aria-valuenow', String(clampedLayout.rightWidth));
        rightSplitter.setAttribute('aria-valuetext', clampedLayout.rightCollapsed ? 'Right panel collapsed' : `Right panel ${clampedLayout.rightWidth}px`);
    }

    if (persist) {
        saveLayout(clampedLayout);
    }

    return clampedLayout;
}

function setActiveSplitter(splitter, isActive) {
    splitter?.setAttribute('data-active', String(isActive));
    document.body.classList.toggle('remodel-resizing', isActive);
}

function startDrag(splitter, side, event) {
    if (!(event instanceof PointerEvent)) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    splitter.setPointerCapture(event.pointerId);
    setActiveSplitter(splitter, true);

    function handlePointerMove(moveEvent) {
        moveEvent.preventDefault();
        moveEvent.stopPropagation();

        const railWidth = getRailWidth();
        const viewportWidth = getViewportWidth();

        if (side === 'left') {
            currentLayout = applyLayout({
                leftWidth: moveEvent.clientX - railWidth,
                rightWidth: currentLayout.rightWidth,
                leftCollapsed: false,
                rightCollapsed: currentLayout.rightCollapsed,
            });
        } else {
            currentLayout = applyLayout({
                leftWidth: currentLayout.leftWidth,
                rightWidth: viewportWidth - moveEvent.clientX,
                leftCollapsed: currentLayout.leftCollapsed,
                rightCollapsed: false,
            });
        }
    }

    function stopDrag(stopEvent) {
        stopEvent?.preventDefault();
        stopEvent?.stopPropagation();
        splitter.releasePointerCapture(event.pointerId);
        setActiveSplitter(splitter, false);
        currentLayout = applyLayout(currentLayout, { persist: true });
        splitter.removeEventListener('pointermove', handlePointerMove);
        splitter.removeEventListener('pointerup', stopDrag);
        splitter.removeEventListener('pointercancel', stopDrag);
    }

    splitter.addEventListener('pointermove', handlePointerMove);
    splitter.addEventListener('pointerup', stopDrag);
    splitter.addEventListener('pointercancel', stopDrag);
}

function handleKeyboardResize(side, event) {
    const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;
    let delta = 0;

    if (event.key === 'ArrowLeft') {
        delta = -step;
    } else if (event.key === 'ArrowRight') {
        delta = step;
    } else {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    const shouldRestoreLeft = side === 'left' && currentLayout.leftCollapsed && delta > 0;
    const shouldRestoreRight = side === 'right' && currentLayout.rightCollapsed && delta < 0;

    currentLayout = applyLayout({
        leftWidth: shouldRestoreLeft ? defaultLayout.leftWidth : side === 'left' ? currentLayout.leftWidth + delta : currentLayout.leftWidth,
        rightWidth: shouldRestoreRight ? defaultLayout.rightWidth : side === 'right' ? currentLayout.rightWidth - delta : currentLayout.rightWidth,
        leftCollapsed: shouldRestoreLeft ? false : side === 'left' ? false : currentLayout.leftCollapsed,
        rightCollapsed: shouldRestoreRight ? false : side === 'right' ? false : currentLayout.rightCollapsed,
    }, { persist: true });
}

function restoreSide(side) {
    if (side === 'left' && currentLayout.leftCollapsed) {
        currentLayout = applyLayout({
            leftWidth: defaultLayout.leftWidth,
            rightWidth: currentLayout.rightWidth,
            leftCollapsed: false,
            rightCollapsed: currentLayout.rightCollapsed,
        }, { persist: true });
    }

    if (side === 'right' && currentLayout.rightCollapsed) {
        currentLayout = applyLayout({
            leftWidth: currentLayout.leftWidth,
            rightWidth: defaultLayout.rightWidth,
            leftCollapsed: currentLayout.leftCollapsed,
            rightCollapsed: false,
        }, { persist: true });
    }
}

function bindRemodelEvents() {
    document.addEventListener('pointerdown', (event) => {
        const toggle = event.target instanceof Element
            ? event.target.closest('#top-settings-holder > .drawer > .drawer-toggle')
            : null;

        if (!toggle) {
            return;
        }

        const drawer = toggle.closest('#top-settings-holder > .drawer');
        applyMenuSide(drawer);
        restoreSide(getAssignedMenuSide(drawer));
        closeMenuSideContext();
    }, true);

    document.addEventListener('contextmenu', (event) => {
        const toggle = event.target instanceof Element
            ? event.target.closest('#top-settings-holder > .drawer > .drawer-toggle')
            : null;

        if (!toggle) {
            closeMenuSideContext();
            return;
        }

        const drawer = toggle.closest('#top-settings-holder > .drawer');

        if (!drawer) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        openMenuSideContext(drawer, event);
    });

    menuSideContext.addEventListener('click', (event) => {
        const button = event.target instanceof Element
            ? event.target.closest('[data-remodel-side]')
            : null;

        if (!button) {
            return;
        }

        const drawer = document.getElementById(menuSideContext.dataset.drawerId || '');
        setMenuSide(drawer, button.dataset.remodelSide);
        closeMenuSideContext();
    });

    document.addEventListener('pointerdown', (event) => {
        if (event.target instanceof Element && event.target.closest('#remodel-menu-side-context')) {
            return;
        }

        closeMenuSideContext();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeMenuSideContext();
        }
    });

    leftSplitter?.addEventListener('pointerdown', (event) => startDrag(leftSplitter, 'left', event));
    rightSplitter?.addEventListener('pointerdown', (event) => startDrag(rightSplitter, 'right', event));
    leftSplitter?.addEventListener('keydown', (event) => handleKeyboardResize('left', event));
    rightSplitter?.addEventListener('keydown', (event) => handleKeyboardResize('right', event));

    window.addEventListener('resize', () => {
        currentLayout = applyLayout(currentLayout, { persist: true });
    });
}
