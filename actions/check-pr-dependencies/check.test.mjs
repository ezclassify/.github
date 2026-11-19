import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readPublicationCheck, requireMergedDependencies, resolveImage, resolveSnapshot } from './check.mjs'

const producer = 'ezclassify/web'
const consumer = 'ezclassify/website'
const sha = 'a'.repeat(40)
const later = 'b'.repeat(40)
const packages = ['@ezclassify/ui', '@ezclassify/react']
const snapshot = (source, base = '1.0.0') => `${base}-dev.snapshot.g${source}.r123.1`
const proof = version => ({ version, packages: [...packages].sort() })

function fixture({ body = `Depends-on: https://github.com/${producer}/pull/26`, merged = true, found = () => undefined, contains = () => false, head = 'pr-head' } = {}) {
  const calls = []
  return {
    calls,
    options: {
      event: { number: 32, pull_request: { head: { sha: 'pr-head' } } },
      consumer,
      producer,
      packages,
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
      published: (_producer, source) => proof(snapshot(source)),
    },
  }
}

test('ordinary CI does not query upstream or the registry', async () => {
  const { options, calls } = fixture({ body: 'No dependency' })
  assert.equal(await resolveSnapshot(options), '')
  assert.deepEqual(calls, [[consumer, 32]])
})

test('opt-in ordinary CI resolves an exact published snapshot on producer main', async () => {
  const version = snapshot(later)
  const { options } = fixture({
    body: 'No dependency',
    found: () => version,
    contains: (repo, source, target) => repo === producer && source === later && target === 'main',
  })
  assert.equal(await resolveSnapshot({ ...options, usePublishedDefault: true }), version)
  await assert.rejects(resolveSnapshot({ ...options, usePublishedDefault: true, contains: () => false }), /verified default/)
  await assert.rejects(resolveSnapshot({ ...options, usePublishedDefault: true, published: () => undefined }), /verified default/)
  await assert.rejects(resolveSnapshot({
    ...options, usePublishedDefault: true, published: () => ({ version, packages: [packages[0]] }),
  }), /verified default/)
})

test('an open upstream PR blocks before any registry work', async () => {
  const { options, calls } = fixture({ merged: false })
  await assert.rejects(resolveSnapshot({ ...options, usePublishedDefault: true }), /waiting for ezclassify\/web#26 to merge/)
  assert.deepEqual(calls, [[consumer, 32], [producer, '26']])
})

test('merge-only checks all declarations and deduplicates URL and shorthand references', async () => {
  const calls = []
  const options = {
    consumer: 'ezclassify/release-train',
    event: { number: 57, pull_request: { head: { sha } } },
    async readPull(repo, number) {
      calls.push([repo, number])
      if (repo === options.consumer) {
        return { state: 'open', head: { sha }, body: [
          'Depends-on: ezclassify/orchestration#16',
          'depends-on: https://github.com/ezclassify/.github/pull/42',
          'Depends-on: https://github.com/EzClassify/Orchestration/pull/16',
        ].join('\n') }
      }
      return { merged: true, merge_commit_sha: sha, base: { ref: 'main', repo: { full_name: repo } } }
    },
  }
  assert.deepEqual((await requireMergedDependencies(options)).map(({ label }) => label), [
    'ezclassify/orchestration#16', 'ezclassify/.github#42',
  ])
  assert.deepEqual(calls, [
    ['ezclassify/release-train', 57], ['ezclassify/orchestration', '16'], ['ezclassify/.github', '42'],
  ])
})

test('merge-only refuses a self-reference and a merge to a non-main branch', async () => {
  const { options } = fixture({ body: 'Depends-on: ezclassify/website#32' })
  await assert.rejects(requireMergedDependencies({ ...options, producer: undefined }), /cannot depend on itself/)
  const upstream = fixture().options
  const read = upstream.readPull
  upstream.readPull = async (repo, number) => {
    const pull = await read(repo, number)
    if (repo === producer) pull.base.ref = 'preview'
    return pull
  }
  await assert.rejects(requireMergedDependencies(upstream), /waiting for ezclassify\/web#26/)
})

test('snapshot mode still refuses a different official producer', async () => {
  const { options, calls } = fixture({ body: 'Depends-on: ezclassify/orchestration#16' })
  await assert.rejects(resolveSnapshot(options), /Use Depends-on: ezclassify\/web/)
  assert.deepEqual(calls, [[consumer, 32]])
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

test('a private workspace root can pin a published snapshot in devDependencies', async () => {
  const version = snapshot(sha)
  const { options } = fixture({ found: (_, selector) => selector === version ? version : undefined })
  const manifest = { devDependencies: Object.fromEntries(packages.map(name => [name, version])) }
  assert.equal(await resolveSnapshot({ ...options, manifest }), version)
  manifest.devDependencies[packages[0]] = '^1.0.0-0'
  await assert.rejects(resolveSnapshot({ ...options, manifest }), /Pin @ezclassify\/ui and @ezclassify\/react/)
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

test('registry bytes alone cannot unlock a dependency when Release Train proof is required', async () => {
  const { options } = fixture({ found: (_, version) => version })
  await assert.rejects(resolveSnapshot({ ...options, published: () => undefined }), /complete package snapshot/)
  const version = snapshot(sha)
  assert.equal(await resolveSnapshot({
    ...options, published: () => ({ version, packages: [...packages].sort() }),
  }), version)
})

test('the trusted producer version can change without a consumer workflow setting', async () => {
  const publishedVersion = snapshot(sha, '2.3.4')
  const { options, calls } = fixture({ found: (_, version) => version === publishedVersion ? version : undefined })
  const manifest = { dependencies: Object.fromEntries(packages.map(name => [name, '^1.0.0-0'])) }
  const published = () => proof(publishedVersion)
  await assert.rejects(resolveSnapshot({ ...options, manifest, published }), new RegExp(`to ${publishedVersion}`))
  for (const name of packages) manifest.dependencies[name] = publishedVersion
  assert.equal(await resolveSnapshot({ ...options, manifest, published }), publishedVersion)
  assert.ok(calls.some(([, version]) => version === publishedVersion))
})

test('a trusted check on the squash commit cannot point at a different source version', async () => {
  const { options } = fixture({ found: (_, version) => version === 'dev-snapshot' ? undefined : version })
  await assert.rejects(resolveSnapshot({ ...options, published: () => proof(snapshot(later, '2.3.4')) }), /complete package snapshot/)
})

test('a publication check must come from the designated App on the expected commit', () => {
  const name = 'development / image / rest-api'
  const evidence = { image: `ghcr.io/ezclassify/rest-api@sha256:${'1'.repeat(64)}` }
  const check = { name, head_sha: sha, app: { id: 5141343 }, status: 'completed',
    conclusion: 'success', output: { summary: JSON.stringify(evidence) } }
  const expected = { name, sha, app: 5141343 }
  assert.equal(readPublicationCheck({ check_runs: [{ ...check, app: { id: 12 } }] }, expected), undefined)
  assert.equal(readPublicationCheck({ check_runs: [{ ...check, head_sha: later }] }, expected), undefined)
  assert.equal(readPublicationCheck({ check_runs: [{ ...check, conclusion: 'failure' }] }, expected), undefined)
  assert.deepEqual(readPublicationCheck({ check_runs: [check] }, expected), evidence)
})

test('image mode requires a published digest for the exact merge or a verified descendant', async () => {
  const { options } = fixture()
  const digest = `ghcr.io/ezclassify/rest-api@sha256:${'2'.repeat(64)}`
  const args = { ...options, image: 'rest-api', mainRef: () => later, contains: () => true,
    published(_producer, source, name) {
      assert.equal(name, 'development / image / rest-api')
      return { image: source === later ? digest : 'ghcr.io/ezclassify/rest-api:dev' }
    } }
  assert.equal(await resolveImage(args), digest)
  await assert.rejects(resolveImage({ ...args, contains: () => false }), /waiting for Release Train/)
})

test('a native mirror proof on the squash commit can cover a consumer subset', async () => {
  const version = '1.0.0-mirror.42.1'
  const { options } = fixture({ found: (_, candidate) => candidate === version ? version : undefined })
  const manifest = { dependencies: { [packages[0]]: version } }
  const published = (_, source) => {
    assert.equal(source, sha)
    return proof(version)
  }
  const candidate = { ...options, packages: [packages[0]], manifest, published }
  assert.equal(await resolveSnapshot(candidate), version)
  await assert.rejects(resolveSnapshot({ ...candidate, published: () => ({
    version, packages: [packages[1]],
  }) }), /complete package snapshot/)
})

test('a native prebuilt receipt must identify the required source commit', async () => {
  const version = `1.0.0-prebuilt.42.1.g${sha.slice(0, 12)}`
  const wrong = `1.0.0-prebuilt.42.1.g${later.slice(0, 12)}`
  const { options } = fixture({ found: (_, candidate) => candidate === 'dev-snapshot' ? undefined : candidate })
  assert.equal(await resolveSnapshot({ ...options, published: () => proof(version) }), version)
  await assert.rejects(resolveSnapshot({ ...options, published: () => proof(wrong) }), /complete package snapshot/)
})

test('a cohort package pin is accepted only with proof on the exact producer squash', async () => {
  const version = '1.0.0-dev.194.2.gdefabcdefabc'
  const { options } = fixture({ found: (_, selector) => selector === version ? version : undefined })
  const manifest = { dependencies: Object.fromEntries(packages.map(name => [name, version])) }
  const pinned = { ...options, manifest, published: (_, source) => source === sha ? proof(version) : undefined }
  assert.equal(await resolveSnapshot(pinned), version)
  await assert.rejects(resolveSnapshot({ ...pinned, published: () => undefined }), /complete package snapshot/)
})
