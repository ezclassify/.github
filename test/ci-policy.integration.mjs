import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

function command(workflow) {
  const source = readFileSync(new URL(`../.github/workflows/${workflow}.yml`, import.meta.url), 'utf8');
  const matches = [...source.matchAll(/          node --input-type=module <<'NODE'\n([\s\S]*?)          NODE/g)];
  assert.equal(matches.length, 1);
  return matches[0][1].split('\n').map(line => line.slice(10)).join('\n');
}
const plan = command('ci-policy'), accept = command('ci-result');
function execute(t, source, env) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-lane-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, 'outputs');
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: source, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, EVENT_NAME: 'pull_request', GITHUB_OUTPUT: output, ...env },
  });
  return { ...result, outputs: result.status === 0 && source === plan ? Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])) : {} };
}
for (const event of ['pull_request', 'push', 'workflow_dispatch', 'schedule']) {
  test(`${event} selects only its intended compatibility lane`, t => {
    const result = execute(t, plan, { EVENT_NAME: event, PRIMARY_VERSION: '24', FULL_VERSIONS: '["22","24"]' });
    assert.equal(result.status, 0, result.stderr);
    const full = event === 'workflow_dispatch' || event === 'schedule';
    assert.deepEqual(result.outputs, { full: String(full), versions: full ? '["22","24"]' : '["24"]' });
  });
}
test('invalid matrices fail before installation', t => {
  for (const versions of ['[]', '["24"]', '["22","22"]', '[22,24]', '["22","$(touch unsafe)"]']) {
    assert.notEqual(execute(t, plan, { PRIMARY_VERSION: '22', FULL_VERSIONS: versions }).status, 0);
  }
});
function results(full, change = {}) {
  return JSON.stringify({ policy: { result: 'success', outputs: { full: String(full) } },
    test: { result: 'success' }, browser: { result: full ? 'success' : 'skipped' }, ...change });
}
for (const full of [false, true]) {
  test(`acceptance requires the selected native results (full=${full})`, t => {
    const env = { FULL: String(full), FULL_ONLY: '["browser"]', OPTIONAL: '[]', EVENT_NAME: full ? 'workflow_dispatch' : 'pull_request' };
    assert.equal(execute(t, accept, { ...env, NEEDS_JSON: results(full) }).status, 0);
    for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
      assert.notEqual(execute(t, accept, { ...env, NEEDS_JSON: results(full, { test: { result } }) }).status, 0);
    }
    assert.notEqual(execute(t, accept, { ...env, NEEDS_JSON: results(full, { policy: { result: 'failure' } }) }).status, 0);
    assert.notEqual(execute(t, accept, { ...env, FULL: String(!full), NEEDS_JSON: results(full) }).status, 0);
  });
}
test('only an explicit optional lane may be inapplicable in full qualification', t => {
  const env = { FULL: 'true', FULL_ONLY: '[]', EVENT_NAME: 'schedule', NEEDS_JSON: results(true, { browser: { result: 'skipped' } }) };
  assert.notEqual(execute(t, accept, { ...env, OPTIONAL: '[]' }).status, 0);
  assert.equal(execute(t, accept, { ...env, OPTIONAL: '["browser"]' }).status, 0);
  assert.notEqual(execute(t, accept, { ...env, OPTIONAL: '["missing"]' }).status, 0);
});
