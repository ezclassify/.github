import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { requireMergedDependencies } from './check.mjs'

export const checkName = 'PR dependencies'

export function identifyPull({ event, eventName, consumer }) {
  const { number, pull_request: pull } = event
  if (eventName !== 'pull_request_target' || !/^ezclassify\/[\w.-]+$/i.test(consumer) ||
      !Number.isSafeInteger(number) || number < 1 || !/^[0-9a-f]{40}$/.test(pull?.head?.sha ?? '') ||
      pull.base?.ref !== 'main' || pull.base?.repo?.full_name?.toLowerCase() !== consumer.toLowerCase()) {
    throw new Error('Dependency checks require a trusted pull request event for official main.')
  }
  return { number, sha: pull.head.sha, privateRepo: pull.base.repo.private === true }
}

export async function verifyCurrentDependencies({ event, consumer, readPull }) {
  let checkedPull
  const dependencies = await requireMergedDependencies({
    event, consumer,
    async readPull(repo, number) {
      const pull = await readPull(repo, number)
      if (repo === consumer && Number(number) === event.number) checkedPull = pull
      return pull
    },
  })
  const latest = await readPull(consumer, event.number)
  if (latest.state !== 'open' || latest.head?.sha !== checkedPull.head.sha || latest.body !== checkedPull.body ||
      latest.base?.ref !== 'main' || latest.base?.repo?.full_name?.toLowerCase() !== consumer.toLowerCase()) {
    throw new Error('This PR changed while its dependencies were checked. Run the latest dependency check.')
  }
  return dependencies
}

function github(token) {
  if (!token) throw new Error('A GitHub token is required for dependency checks.')
  return async function request(path, { method = 'GET', body } = {}) {
    const response = await fetch(`https://api.github.com${path}`, {
      method, body: body && JSON.stringify(body),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`GitHub request for ${path} failed (HTTP ${response.status}).`)
    return response.json()
  }
}

export async function main(env = process.env, command = process.argv[2]) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
  const consumer = env.GITHUB_REPOSITORY.toLowerCase()
  const { number, sha, privateRepo } = identifyPull({ event, consumer, eventName: env.GITHUB_EVENT_NAME })
  const request = github(env.DEPENDENCY_CHECK_TOKEN)
  const checks = `/repos/${consumer}/check-runs`
  const externalId = `${consumer}#${number}/${env.GITHUB_RUN_ID}.${env.GITHUB_RUN_ATTEMPT}`
  if (command === 'start') {
    const check = await request(checks, {
      method: 'POST',
      body: {
        name: checkName,
        head_sha: sha,
        status: 'in_progress',
        external_id: externalId,
        output: { title: checkName, summary: 'Checking declared upstream pull requests.' },
      },
    })
    if (!Number.isSafeInteger(check.id) || check.id < 1) throw new Error('GitHub returned an invalid check ID.')
    appendFileSync(env.GITHUB_OUTPUT, `check-id=${check.id}\n`)
    return
  }
  if (!/^[1-9]\d*$/.test(env.DEPENDENCY_CHECK_ID) || !['verify', 'fail'].includes(command)) {
    throw new Error('A check ID and a valid dependency check command are required.')
  }

  const checkPath = `${checks}/${env.DEPENDENCY_CHECK_ID}`
  const check = await request(checkPath)
  if (check.name !== checkName || check.head_sha !== sha || check.external_id !== externalId) {
    throw new Error('GitHub returned a check for a different PR or run.')
  }
  const complete = (conclusion, summary) => request(checkPath, {
    method: 'PATCH',
    body: { status: 'completed', conclusion, output: { title: checkName, summary } },
  })

  if (command === 'fail') {
    if (check.status !== 'completed') {
      await complete('failure', 'The trusted dependency check could not complete. See the workflow run for details.')
    }
    return
  }

  const upstream = privateRepo && env.DEPENDENCY_UPSTREAM_TOKEN
    ? github(env.DEPENDENCY_UPSTREAM_TOKEN) : request
  let dependencies
  try {
    dependencies = await verifyCurrentDependencies({
      event, consumer,
      readPull: (repo, pr) => (repo === consumer ? request : upstream)(`/repos/${repo}/pulls/${pr}`),
    })
  } catch (error) {
    await complete('failure', error.message)
    throw error
  }
  await complete('success', dependencies.length ? 'All declared upstream PRs merged into official main.' : 'No upstream PR dependencies declared.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
