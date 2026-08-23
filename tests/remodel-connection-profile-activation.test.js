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

test('native profile activation does not reconnect an already-online selected profile', () => {
    expect(connectionManager).toMatch(/selectedProfile === profile\.id && online_status !== 'no_connection'/);
});

test('native profile activation waits for asynchronous reconnect before returning', () => {
    expect(connectionManager).toMatch(/waitUntilCondition\(\(\) => online_status !== 'no_connection'/);
});

// THE DEFECT: applying a profile runs `secret-id` and a second `api` pass near
// the end of CC_COMMANDS. Those re-enter core's `#main_api` change handler,
// which calls cancelStatusCheck() — aborting the in-flight status probe and
// forcing online_status to 'no_connection' with no replacement scheduled. The
// wait above then spun its full 10s and threw, and the Scene being opened was
// abandoned. Applying a profile must leave a live probe behind for that wait.
test('applying a profile re-establishes the connection when its own commands cancelled the probe', () => {
    const body = connectionManager.slice(
        connectionManager.indexOf('async function applyConnectionProfile'),
        connectionManager.indexOf('export async function activateConnectionProfile'));
    expect(body).toMatch(/if \(online_status === 'no_connection' && profile\.api\)/);
    expect(body).toMatch(/SlashCommandParser\.commands\['api'\]\.callback\(getNamedArguments\(\), profile\.api\)/);
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
