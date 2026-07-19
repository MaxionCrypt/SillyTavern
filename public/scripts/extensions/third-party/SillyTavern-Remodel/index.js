import { initTimelineSpine } from './timeline-spine.js';

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

// Native floating panels (Author's Note, CFG Scale, Token Probabilities) —
// each toggled by its own core script via plain jQuery display/opacity
// changes, not the openDrawer/closedDrawer class pattern the sidebar rail
// uses. We can't edit those toggle functions (core, read-only), so instead
// we watch each panel's own `style` attribute and mirror its open/closed
// state onto a class we control, which our CSS uses to dock it beside the
// sidebar rail instead of leaving it floating.
const DOCKED_FLOATING_PANELS = ['floatingPrompt', 'cfgConfig', 'logprobsViewer'];

let initialized = false;
let composerObserver;
let sidebarObserver;
let workspacePanelObserver;
let dockedPanelObservers = [];

export async function init() {
    if (initialized) {
        return;
    }

    await waitForElement('#sheld');
    ensureRemodelDom();
    applyComposerClasses();

    document.body.classList.add('st-remodel-active');
    initialized = true;

    initTimelineSpine();
    configureSidebarRail();
    bindRemodelEvents();
    observeSidebarRailChanges();
    observeWorkspacePanelChanges();
    observeComposerChanges();
    observeDockedFloatingPanels();
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

    document.getElementById('remodel-left-splitter')?.remove();
    document.getElementById('remodel-right-splitter')?.remove();
    document.getElementById('remodel-menu-side-context')?.remove();
}

function applyComposerClasses() {
    document.getElementById('send_form')?.classList.add('remodel-composer');
    document.getElementById('nonQRFormItems')?.classList.add('remodel-composer-items');
    document.getElementById('send_textarea')?.classList.add('remodel-story-input');
    document.getElementById('leftSendForm')?.classList.add('remodel-composer-toolbar', 'remodel-composer-toolbar-left');
    document.getElementById('rightSendForm')?.classList.add('remodel-composer-toolbar', 'remodel-composer-toolbar-right');
    relabelStoryActionButtons();
}

// Retitles the repurposed actions-bar icons while the story workspace is
// active; native titles apply everywhere else (Roleplay/native chat).
function relabelStoryActionButtons() {
    const isStoryWorkspace = document.body.classList.contains('remodel-story-workspace-active');
    const labels = {
        stscript_continue: isStoryWorkspace ? 'Auto-continue the manuscript' : 'Continue script execution',
        stscript_pause: isStoryWorkspace ? 'Pause auto-continue' : 'Pause script execution',
        stscript_stop: isStoryWorkspace ? 'Stop auto-continue' : 'Abort script execution',
    };

    for (const [id, title] of Object.entries(labels)) {
        const button = document.getElementById(id);
        if (button) {
            button.title = title;
        }
    }
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

function getDrawerContent(drawer) {
    return drawer?.querySelector(':scope > .drawer-content');
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
        // rightNavHolder is exempt: the Tavern Characters tab renders its own deck,
        // but still needs #right-nav-panel reachable (as an on-demand modal, see
        // style.css) for the native Create Character / Create Group forms.
        if (allowedDrawerIds.has(drawer.id) || drawer.id === 'rightNavHolder') {
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
    // #remodel-timeline-drawer (the Tavern) carries .remodel-workspace-panel too, for the
    // shared full-bleed layout rule — but it now drives its own dedicated Window state
    // machine (transitionToWindow/remodel-tavern-active in timeline-spine.js) and must not
    // ALSO trip this generic flag, or both fire together every time the Tavern opens.
    const activePanel = document.querySelector('#top-settings-holder > .drawer.remodel-sidebar-drawer:not(#remodel-timeline-drawer) > .drawer-content.remodel-workspace-panel.openDrawer');
    document.body.classList.toggle('remodel-workspace-active', Boolean(activePanel));
}

function renameSidebarDrawer(drawer, { label, icon }) {
    const toggle = drawer.querySelector(':scope > .drawer-toggle');
    const iconElement = drawer.querySelector(':scope > .drawer-toggle .drawer-icon');
    const drawerContent = getDrawerContent(drawer);

    toggle?.setAttribute('aria-label', label);
    toggle?.setAttribute('title', label);
    drawerContent?.classList.add('remodel-workspace-panel');
    drawerContent?.classList.remove('remodel-side-left', 'remodel-side-right');
    drawerContent?.setAttribute('data-remodel-workspace-title', label);

    if (!iconElement) {
        return;
    }

    iconElement.title = label;
    iconElement.setAttribute('aria-label', label);
    iconElement.dataset.remodelLabel = label;
    // Empty (not removed): SillyTavern's i18n MutationObserver re-translates on
    // any data-i18n attribute change, including removal, and crashes calling
    // .split() on the resulting null. An empty key just resolves to nothing.
    iconElement.setAttribute('data-i18n', '');

    const stateClass = iconElement.classList.contains('openIcon') ? 'openIcon' : 'closedIcon';
    // The Tavern drawer is pinned (see ensureTimelineDrawer, timeline-spine.js)
    // so core's own doNavbarIconClick()/click-outside handlers never force-close
    // it as a side effect of unrelated drawer activity elsewhere on the page —
    // this className rebuild is a full overwrite, so drawerPinnedOpen has to be
    // re-added every time or the pin silently falls off the next time this runs
    // (it's re-triggered by a MutationObserver on any #top-settings-holder change).
    const pinnedClass = drawer.id === 'remodel-timeline-drawer' ? ' drawerPinnedOpen' : '';
    iconElement.className = `drawer-icon ${icon.join(' ')} ${stateClass}${pinnedClass}`;
}

function closeDrawer(drawer) {
    const drawerContent = getDrawerContent(drawer);
    const drawerIcon = drawer.querySelector(':scope > .drawer-toggle .drawer-icon');

    drawerContent?.classList.remove('openDrawer');
    drawerContent?.classList.add('closedDrawer');
    drawerIcon?.classList.remove('openIcon');
    drawerIcon?.classList.add('closedIcon');
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
        getDrawerContent(drawer)?.classList.remove('remodel-side-left', 'remodel-side-right');
    }, true);

    document.getElementById('remodel-left-splitter')?.remove();
    document.getElementById('remodel-right-splitter')?.remove();
}

// Docks Author's Note / CFG Scale / Token Probabilities beside the sidebar
// rail instead of leaving them as free-floating draggable panels. Native
// code only ever shows/hides these via inline `display`/`opacity` (see
// authors-note.js/cfg-scale.js/logprobs.js) — there's no class we can hook,
// so a MutationObserver watching `style` is the only lever available
// without editing core files.
function observeDockedFloatingPanels() {
    dockedPanelObservers.forEach((observer) => observer.disconnect());
    dockedPanelObservers = [];

    for (const id of DOCKED_FLOATING_PANELS) {
        const panel = document.getElementById(id);

        if (!panel) {
            continue;
        }

        panel.classList.add('remodel-docked-panel');
        syncDockedPanelState(panel);

        const observer = new MutationObserver(() => syncDockedPanelState(panel));
        observer.observe(panel, { attributes: true, attributeFilter: ['style', 'class'] });
        dockedPanelObservers.push(observer);
    }
}

function syncDockedPanelState(panel) {
    // Native show/hide is driven by a transient ".resizing" class during the
    // fade animation — defer our own class sync until that settles so we
    // don't fight the native opacity transition mid-flight.
    if (panel.classList.contains('resizing')) {
        requestAnimationFrame(() => syncDockedPanelState(panel));
        return;
    }

    // Reads the native inline `display` directly rather than getComputedStyle:
    // once .remodel-docked-panel-open is applied, our own CSS forces
    // `display: flex !important`, which would make computedStyle.display
    // report "flex" forever afterward regardless of what native code's
    // inline style says — checking the inline value is the only way to see
    // what native code actually intended. No inline display at all (the
    // panel's initial state, before any toggle function has touched it)
    // means closed, matching these panels' shared base CSS (display: none).
    const inlineDisplay = panel.style.display;
    const isOpen = inlineDisplay !== '' && inlineDisplay !== 'none';
    panel.classList.toggle('remodel-docked-panel-open', isOpen);
    updateDockedPanelStack();
}

// Re-orders the open docked panels top-to-bottom by DOM order and reserves
// matching space for the chat column, so #sheld visibly narrows by however
// many panels are stacked open (see .remodel-docked-panel-open CSS).
function updateDockedPanelStack() {
    const openPanels = DOCKED_FLOATING_PANELS
        .map((id) => document.getElementById(id))
        .filter((panel) => panel?.classList.contains('remodel-docked-panel-open'));

    openPanels.forEach((panel, index) => {
        panel.style.setProperty('--remodel-docked-stack-index', String(index));
    });

    document.body.classList.toggle('remodel-docked-panels-active', openPanels.length > 0);
    document.body.style.setProperty('--remodel-docked-panel-count', String(openPanels.length));
}
