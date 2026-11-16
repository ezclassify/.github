import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Runs after the setup-node-npm composite action. The environment names the
// leg being checked; the expected npm version is read from the action itself.
const action = readFileSync(
  new URL('../actions/setup-node-npm/action.yml', import.meta.url),
  'utf8',
);
const pinned = /run: npm install -g npm@(\d+\.\d+\.\d+)\s*$/m.exec(action)?.[1];
const npm = (...args) => execFileSync('npm', args, { encoding: 'utf8' }).trim();

test('the action installs the exact pinned npm and the requested Node', () => {
  assert.ok(pinned, 'action pins npm to one exact version');
  assert.equal(npm('--version'), pinned);
  assert.equal(process.versions.node.split('.')[0], process.env.EXPECTED_NODE_MAJOR);
});

test('registry setup matches the requested mode', () => {
  assert.equal(new URL(npm('config', 'get', 'registry')).href, 'https://registry.npmjs.org/');
  const scoped = npm('config', 'get', '@ezclassify:registry');
  if (process.env.REGISTRY_MODE === 'scoped') {
    assert.equal(new URL(scoped).href, 'https://npm.pkg.github.com/');
  } else {
    assert.equal(scoped, 'undefined', 'unscoped setup must not add a first-party registry');
  }
});
