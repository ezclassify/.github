import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Execute the workflow's actual shell block, including download verification,
// rather than keeping a second implementation of the scan in the test.
const workflow = readFileSync(
  new URL('../.github/workflows/secret-scan.yml', import.meta.url),
  'utf8',
);
const scanStep = workflow.split('      - name: Run gitleaks over full Git history\n');
assert.equal(scanStep.length, 2, 'exactly one shared scan step');
const run = scanStep[1].split('        run: |\n')[1];
assert.ok(run, 'shared scan command exists');
const command = [];
for (const line of run.split('\n')) {
  if (line && !line.startsWith('          ')) break;
  command.push(line.slice(10));
}
assert.ok(command.some((line) => line.trim()), 'shared scan command is not empty');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'secret-scan-control-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '--quiet');
  git(cwd, 'config', 'user.name', 'Secret scan control');
  git(cwd, 'config', 'user.email', 'secret-scan-control@example.invalid');
  return cwd;
}

function commit(cwd) {
  git(cwd, 'add', 'example.txt');
  git(cwd, 'commit', '--quiet', '-m', 'test fixture');
}

function scan(cwd) {
  return spawnSync('bash', ['-c', command.join('\n')], {
    cwd,
    env: { ...process.env, RUNNER_TEMP: tmpdir() },
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 1024 * 1024,
  });
}

test('a clean committed repository passes the shared scan', (t) => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, 'example.txt'), 'An ordinary committed document.\n');
  commit(cwd);
  const result = scan(cwd);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout + result.stderr, /no leaks found/i);
});

test('a synthetic secret removed from the tip still fails and is redacted', (t) => {
  const cwd = fixture(t);
  // Generated only inside the disposable CI fixture, never a credential.
  const synthetic = ['gh', 'p_'].join('') + randomBytes(18).toString('hex');
  writeFileSync(join(cwd, 'example.txt'), `token=${synthetic}\n`);
  commit(cwd);
  writeFileSync(join(cwd, 'example.txt'), 'The tip contains no token.\n');
  commit(cwd);
  const result = scan(cwd);
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  const output = result.stdout + result.stderr;
  assert.match(output, /leaks found:\s*1/i);
  assert.ok(!output.includes(synthetic), 'secret bytes must be redacted');
});
