// STRUCTURAL tests. connection-manager/index.js and timeline-spine.js both pull
// in the browser world at module scope, so these read the source rather than
// executing it. That is a real weakness — a source assertion cannot prove the
// behaviour, only that the shape which produced the bug is gone. Live
// verification in the app is the actual gate; these exist to stop a silent
// revert.
import fs from 'node:fs';

const connectionManager = fs.readFileSync(
    new URL('../public/scripts/extensions/connection-manager/index.js', import.meta.url), 'utf8');
const timelineSpine = fs.readFileSync(
    new URL('../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-spine.js', import.meta.url), 'utf8');
const liveDirection = fs.readFileSync(
    new URL('../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js', import.meta.url), 'utf8');

test('native profile activation does not reconnect an already-online selected profile', () => {
    expect(connectionManager).toMatch(/selectedProfile === profile\.id && online_status !== 'no_connection'/);
});

test('native profile activation waits for asynchronous reconnect before returning', () => {
    expect(connectionManager).toMatch(/waitUntilCondition\(\(\) => online_status !== 'no_connection'/);
    expect(connectionManager).toContain('30000, 100, { rejectOnTimeout: true }');
    expect(connectionManager).toContain('did not become ready within 30 seconds');
});

test('concurrent activation of the same profile shares one connection flight', () => {
    expect(connectionManager).toContain('let profileActivationFlight = null');
    expect(connectionManager).toContain('if (profileActivationId === profile.id) return profileActivationFlight');
    expect(connectionManager).toContain('await profileActivationFlight');
});

test('the roleplay connection picker waits for the Narrator route before closing', () => {
    expect(timelineSpine).toContain('roleplayConnectionApplication = state.narratorProfileId');
    expect(timelineSpine).toContain('await roleplayConnectionApplication');
    expect(timelineSpine).toContain('Connecting Narrator');
});

test('profile command events are not claimed as the Narrator generation', () => {
    const start = liveDirection.indexOf('async function generateDirectedPerformer');
    const body = liveDirection.slice(start, liveDirection.indexOf('async function beginLoomVisibleStream', start));
    expect(body.indexOf('await hooks.activateConnectionProfile(narratorProfileId)')).toBeLessThan(body.indexOf('ownedGenerationDepth++'));
    expect(body).toContain('if (generationOwned) ownedGenerationDepth');
});


// THE DEFECT: a failed connection check used to `return` out of
// beginRoleplaySceneWithNarrator BEFORE selectCharacterById and
// createNewChatForScene, so the Scene existed but could never be opened — with
// only a toast to say why. Creating and entering a Scene does not need a live
// API; a turn does, and generateDirectedPerformer re-activates the profile and
// fails loudly there instead.
test('a failed Narrator profile activation does not abandon Scene creation', () => {
    const start = timelineSpine.indexOf('async function beginRoleplaySceneWithNarrator');
    expect(start).toBeGreaterThan(-1);
    const body = timelineSpine.slice(start, start + 2500);
    const catchStart = body.indexOf("console.error('Remodel: could not activate the selected Narrator connection profile'");
    expect(catchStart).toBeGreaterThan(-1);
    // From the failure report to the end of the catch block: no early return.
    const catchBlock = body.slice(catchStart, body.indexOf('await context.selectCharacterById', catchStart));
    expect(catchBlock).not.toMatch(/\breturn\b/);
    // ...and the Scene really is still created afterwards.
    expect(body).toMatch(/await context\.selectCharacterById\(narratorIndex/);
    expect(body).toMatch(/await createNewChatForScene\(sceneId\)/);
});


// THE DEFECT: applying a profile runs `secret-id` and a second `api` pass near
// the end of CC_COMMANDS. Those re-enter core's `#main_api` change handler,
// which calls cancelStatusCheck() — aborting the in-flight status probe AND
// forcing online_status to 'no_connection', with nothing scheduled to replace
// it. The wait then burns its timeout and throws, and the Scene being opened
// is abandoned.
//
// The FIRST fix guarded on online_status at the end of applyConnectionProfile
// and never fired. Captured live: the probe aborts at .646 and main_api_changed
// lands at .666, both after the guard runs, with the log still reading
// "Connection successful". It tested a flag that had not been set yet.
//
// The final probe must be real and must start after the queued change handlers,
// rather than trusting that transient flag or waiting on a probe already known
// to have been cancelled.
test('activation starts a final real connection probe after profile commands settle', () => {
    const body = connectionManager.slice(
        connectionManager.indexOf('export async function activateConnectionProfile'),
        connectionManager.indexOf('async function updateConnectionProfile'));

    expect(body).toContain('setTimeout(resolve, 100)');
    expect(body).toContain('reissueConnection(profile)');
    expect(body).toContain("waitUntilCondition(() => online_status !== 'no_connection'");
});

test('the final probe clicks the mapped Connect button rather than repeating a no-op API command', () => {
    expect(connectionManager).toContain('async function reissueConnection(profile)');
    expect(connectionManager).toContain('CONNECT_API_MAP[String(profile.api).toLowerCase()]');
    expect(connectionManager).toContain("$(api.button).trigger('click')");
    const helper = connectionManager.slice(
        connectionManager.indexOf('async function reissueConnection(profile)'),
        connectionManager.indexOf('export async function activateConnectionProfile'));
    expect(helper).not.toContain("SlashCommandParser.commands['api'].callback");
});

// The re-issue must not be a bare state check any more — that shape is what
// silently did nothing.
test('the re-probe is no longer guarded on a transient online_status read', () => {
    const apply = connectionManager.slice(
        connectionManager.indexOf('async function applyConnectionProfile'),
        connectionManager.indexOf('export async function activateConnectionProfile'));
    expect(apply).not.toContain("online_status === 'no_connection' && profile.api");
});
