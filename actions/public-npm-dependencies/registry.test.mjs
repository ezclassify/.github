import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertPublicLock, readConsumer, selectLane } from './registry.mjs'

const registry = 'https://registry.npmjs.org'
const types = '@ezclassify/types'
const client = '@ezclassify/rest-client'
const initial = new Set(['^1.0.0-0'])
const requirements = new Map([[types, initial], [client, initial]])
const approval = types + ' ' + client
const fixture = t => {
  const root = mkdtempSync(join(tmpdir(), 'public-npm-consumer-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('an unapproved checkout always takes the public install path', async () => {
  await assert.doesNotReject(async () => assert.deepEqual(
    await selectLane(requirements, '', () => assert.fail('no bootstrap lookup was authorized')),
    { lane: 'public', missing: [] },
  ))
})

test('a temporary approval only covers truly unpublished first-cut packages', async () => {
  const fetch = async (url, options) => {
    assert.equal(options.method, 'HEAD')
    assert.equal(options.redirect, 'error')
    assert.equal(url.split('/').slice(0, -1).join('/'), registry)
    return { status: url.endsWith(encodeURIComponent(types)) ? 200 : 404 }
  }
  assert.deepEqual(await selectLane(requirements, approval, fetch), { lane: 'bootstrap', missing: [client] })
  await assert.rejects(selectLane(requirements, types, fetch), /exceed the approved/)
  await assert.rejects(selectLane(new Map([[types, new Set(['^1.1.0-rc.0'])], [client, initial]]), approval, fetch), /exceed the approved/)
  await assert.rejects(selectLane(requirements, approval, async () => ({ status: 503 })), /HTTP 503/)
  assert.deepEqual(await selectLane(requirements, approval, async () => ({ status: 200 })), { lane: 'public', missing: [] })
})

test('only external dependencies in the installed workspaces enter the bootstrap closure', t => {
  const root = fixture(t)
  const put = (dir, manifest) => writeFileSync(join(root, dir, 'package.json'), JSON.stringify(manifest))
  mkdirSync(join(root, 'packages/ui'), { recursive: true })
  put('.', { workspaces: ['packages/ui'], devDependencies: { '@ezclassify/ui': '1.0.0-dev.0', lodash: '^4.18.0' } })
  put('packages/ui', { name: '@ezclassify/ui', dependencies: { [types]: '^1.0.0-0' } })
  const { workspaces, requirements } = readConsumer(root)
  assert.deepEqual(workspaces.get('packages/ui'), { name: '@ezclassify/ui', dependencies: { [types]: '^1.0.0-0' } })
  assert.deepEqual([...requirements], [[types, initial]])
})

test('lock verification refuses a private tarball, a dev build and an arbitrary local link', () => {
  const ui = '@ezclassify/ui'
  const workspaces = new Map([['packages/ui', { name: ui }]])
  const dependency = {
    version: '1.0.0-rc.0', resolved: registry + '/@ezclassify/types/-/types-1.0.0-rc.0.tgz', integrity: 'sha512-YQ==',
  }
  const lockFor = entry => ({ lockfileVersion: 3, packages: {
    '': {}, 'packages/ui': {}, ['node_modules/' + ui]: { resolved: 'packages/ui', link: true }, ['node_modules/' + types]: entry,
  } })
  assert.doesNotThrow(() => assertPublicLock(lockFor(dependency), workspaces))
  assert.throws(() => assertPublicLock(lockFor({ ...dependency, resolved: 'https://npm.pkg.github.com/download' }), workspaces), /public npm tarball/)
  assert.throws(() => assertPublicLock(lockFor({ ...dependency, version: '1.0.0-dev.30' }), workspaces), /public release/)
  assert.throws(() => assertPublicLock(lockFor({ ...dependency, integrity: undefined }), workspaces), /public npm tarball/)
  assert.throws(() => assertPublicLock(lockFor({ link: true, resolved: '../../outside' }), workspaces), /declared workspace/)
  assert.throws(() => assertPublicLock(lockFor({ ...dependency, resolved: 'https://name@registry.npmjs.org/download' }), workspaces), /public npm tarball/)
})

test('the local entry point admits and installs a genuine npm workspace without inherited credentials', t => {
  const root = fixture(t)
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'packages/ui'), { recursive: true })
  const check = 'node scripts/assert-registry.mjs'
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'public-install-fixture',
    private: true,
    workspaces: ['packages/ui'],
    scripts: { 'check:dependency-age': check, 'check:lockfile-portable': check },
  }))
  writeFileSync(join(root, 'packages/ui/package.json'), '{"name":"@ezclassify/ui","version":"1.0.0-dev.0"}')
  writeFileSync(join(root, 'scripts/relock.mjs'), '')
  writeFileSync(join(root, 'scripts/assert-registry.mjs'), [
    'import assert from "node:assert/strict"',
    'assert.equal(process.env.NODE_AUTH_TOKEN, undefined)',
    'assert.equal(process.env.npm_token, undefined)',
    'assert.equal(process.env.NPM_CONFIG_REGISTRY, "https://registry.npmjs.org/")',
  ].join('\n'))
  const output = join(root, 'output')
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./registry.mjs', import.meta.url))], {
    cwd: root, encoding: 'utf8', env: {
      ...process.env, GITHUB_OUTPUT: output, EZ_FIRST_PUBLICATION_PACKAGES: '',
      NODE_AUTH_TOKEN: 'unavailable-in-public-install', npm_token: 'also-unavailable',
      npm_config_registry: 'http://private-fixture.invalid/',
    },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(readFileSync(output, 'utf8'), 'lane=public\n')
  assert.equal(JSON.parse(readFileSync(join(root, 'node_modules/@ezclassify/ui/package.json'), 'utf8')).name, '@ezclassify/ui')
})
