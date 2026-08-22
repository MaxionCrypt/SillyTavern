import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/scripts/extensions/connection-manager/index.js', import.meta.url), 'utf8');

test('native profile activation does not reconnect an already-online selected profile', () => {
    expect(source).toMatch(/selectedProfile === profile\.id && online_status !== 'no_connection'/);
});

test('native profile activation waits for asynchronous reconnect before returning', () => {
    expect(source).toMatch(/waitUntilCondition\(\(\) => online_status !== 'no_connection'/);
});
