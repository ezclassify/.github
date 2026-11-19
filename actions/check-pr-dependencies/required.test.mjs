import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkName, identifyPull, main, verifyCurrentDependencies } from './required.mjs'

const consumer = 'ezclassify/release-train'
const producer = 'ezclassify/orchestration'
const sha = 'a'.repeat(40)
const event = {
  number: 57,
  pull_request: { head: { sha }, base: { ref: 'main', repo: { full_name: consumer, private: true } } },
}
const current = { ...event.pull_request, state: 'open', body: `Depends-on: ${producer}#16` }
const merged = { merged: true, merge_commit_sha: 'b'.repeat(40), base: { ref: 'main', repo: { full_name: producer } } }
const identity = { event, consumer, eventName: 'pull_request_target' }

test('only a trusted event for official main can report a required dependency result', () => {
  assert.deepEqual(identifyPull(identity), { number: 57, sha, privateRepo: true })
  assert.throws(() => identifyPull({ ...identity, eventName: 'pull_request' }), /trusted pull request/)
  assert.throws(() => identifyPull({ ...identity, consumer: 'someone/release-train' }), /official main/)
})

test('a dependency edit while the check is evaluating prevents a stale success', async () => {
  let reads = 0
  await assert.rejects(verifyCurrentDependencies({
    event, consumer,
    async readPull(repo) {
      if (repo === producer) return merged
      return ++reads === 1 ? current : { ...current, body: current.body + '\nDepends-on: ezclassify/web#30' }
    },
  }), /PR changed/)
})

for (const privateRepo of [true, false]) {
  test(`reports a check on the PR head and ${privateRepo ? 'uses' : 'withholds'} the private reader`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'dependency-check-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const eventPath = join(dir, 'event.json')
    const output = join(dir, 'output')
    const { pull_request } = event
    writeFileSync(eventPath, JSON.stringify({ ...event, pull_request: {
      ...pull_request, base: { ...pull_request.base, repo: { ...pull_request.base.repo, private: privateRepo } },
    } }))
    const env = {
      GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: consumer, GITHUB_EVENT_NAME: 'pull_request_target',
      GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: output,
      DEPENDENCY_CHECK_TOKEN: 'check-token', DEPENDENCY_UPSTREAM_TOKEN: 'reader-token',
    }
    const calls = []
    const check = { id: 99, name: checkName, head_sha: sha, external_id: `${consumer}#57/123.1` }
    t.mock.method(globalThis, 'fetch', async (url, args) => {
      const path = new URL(url).pathname
      const token = args.headers.authorization
      const body = args.body ? JSON.parse(args.body) : undefined
      calls.push({ path, token, method: args.method, body })
      if (path === `/repos/${producer}/pulls/16`) return Response.json(privateRepo ? merged : { ...merged, merged: false })
      if (path === `/repos/${consumer}/pulls/57`) return Response.json(current)
      return Response.json(check)
    })
    await main(env, 'start')
    assert.equal(readFileSync(output, 'utf8'), 'check-id=99\n')
    assert.equal(calls[0].body.head_sha, sha)
    if (privateRepo) await main({ ...env, DEPENDENCY_CHECK_ID: '99' }, 'verify')
    else await assert.rejects(main({ ...env, DEPENDENCY_CHECK_ID: '99' }, 'verify'), /waiting for/)
    const lookup = calls.find(call => call.path === `/repos/${producer}/pulls/16`)
    assert.equal(lookup.token, privateRepo ? 'Bearer reader-token' : 'Bearer check-token')
    assert.equal(calls.at(-1).body.conclusion, privateRepo ? 'success' : 'failure')
  })
}
