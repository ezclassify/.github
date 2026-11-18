import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveSnapshot } from './check.mjs'

const producer = 'ezclassify/web'
const consumer = 'ezclassify/website'
const sha = 'a'.repeat(40)
const later = 'b'.repeat(40)
const packages = ['@ezclassify/ui', '@ezclassify/react']
const snapshot = source => `1.0.0-dev.snapshot.g${source}`

function fixture({ body = `Depends-on: https://github.com/${producer}/pull/26`, merged = true, found = () => undefined, contains = () => false, head = 'pr-head' } = {}) {
  const calls = []
  return {
    calls,
    options: {
      event: { number: 32, pull_request: { head: { sha: 'pr-head' } } },
      consumer,
      producer,
      packages,
      base: '1.0.0',
      async readPull(repo, number) {
        calls.push([repo, number])
        return repo === consumer
          ? { body, state: 'open', head: { sha: head } }
          : { merged, merge_commit_sha: sha, base: { ref: 'main', repo: { full_name: producer } } }
      },
      packageVersion(name, version) {
        calls.push([name, version])
        return found(name, version)
      },
      contains,
    },
  }
}

test('ordinary CI does not query upstream or the registry', async () => {
  const { options, calls } = fixture({ body: 'No dependency' })
  assert.equal(await resolveSnapshot(options), '')
  assert.deepEqual(calls, [[consumer, 32]])
})

test('an open upstream PR blocks before any registry work', async () => {
  const { options, calls } = fixture({ merged: false })
  await assert.rejects(resolveSnapshot(options), /waiting for ezclassify\/web#26 to merge/)
  assert.deepEqual(calls, [[consumer, 32], [producer, '26']])
})

test('a squash commit selects two exact package versions', async () => {
  const { options, calls } = fixture({ found: (_, version) => version })
  assert.equal(await resolveSnapshot(options), snapshot(sha))
  assert.deepEqual(calls.slice(2), packages.map(name => [name, snapshot(sha)]))
})

test('a subsequent snapshot can cover a merge that predates publication', async () => {
  const { options } = fixture({
    found: (_, version) => ['dev-snapshot', snapshot(later)].includes(version) ? snapshot(later) : undefined,
    contains(repo, from, to) {
      assert.deepEqual([repo, from, to], [producer, sha, later])
      return true
    },
  })
  assert.equal(await resolveSnapshot(options), snapshot(later))
  await assert.rejects(resolveSnapshot({ ...options, contains: () => false }), /complete package snapshot/)
})

test('publication is incomplete while either package is missing', async () => {
  const { options } = fixture({ found: (name, version) => name === packages[0] ? version : undefined })
  await assert.rejects(resolveSnapshot(options), /complete package snapshot/)
})

test('an old consumer check cannot consume a new PR declaration', async () => {
  const { options } = fixture({ head: 'new-head' })
  await assert.rejects(resolveSnapshot(options), /older PR revision/)
})

test('foreign repositories cannot cause arbitrary GitHub or registry reads', async () => {
  const { options, calls } = fixture({ body: 'Depends-on: outside/unknown#3' })
  await assert.rejects(resolveSnapshot(options), /Use Depends-on/)
  assert.deepEqual(calls, [[consumer, 32]])
})

test('an available snapshot must be pinned so later builds use the tested versions', async () => {
  const { options } = fixture({ found: (_, version) => version })
  const manifest = { dependencies: Object.fromEntries(packages.map(name => [name, '^1.0.0-0'])) }
  await assert.rejects(resolveSnapshot({ ...options, manifest }), /Pin @ezclassify\/ui and @ezclassify\/react/)
  for (const name of packages) manifest.dependencies[name] = snapshot(sha)
  assert.equal(await resolveSnapshot({ ...options, manifest }), snapshot(sha))
})

test('a verified committed pin stays usable after the moving tag changes', async () => {
  const pinned = snapshot(later)
  const { options, calls } = fixture({
    found: (_, version) => version === pinned ? pinned : undefined,
    contains: () => true,
  })
  const manifest = { dependencies: Object.fromEntries(packages.map(name => [name, pinned])) }
  assert.equal(await resolveSnapshot({ ...options, manifest }), pinned)
  assert.ok(calls.every(([, version]) => version !== 'dev-snapshot'))
})
