import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const reference = /^(?:https:\/\/github\.com\/(?<urlRepo>[\w.-]+\/[\w.-]+)\/pull\/(?<urlNumber>[1-9]\d*)|(?<shortRepo>[\w.-]+\/[\w.-]+)#(?<shortNumber>[1-9]\d*))$/i
const registry = 'https://npm.pkg.github.com'
const slug = /^[\w.-]+\/[\w.-]+$/

export async function resolveSnapshot({ event, consumer, producer, packages, base, readPull, packageVersion, contains, manifest }) {
  if (!event.pull_request) return ''
  const current = await readPull(consumer, event.number)
  if (current.state !== 'open' || current.head?.sha !== event.pull_request.head.sha) {
    throw new Error('This run belongs to an older PR revision. Check the current PR run.')
  }
  const declarations = (current.body ?? '').split(/\r?\n/).filter(line => /^Depends-on\s*:/i.test(line.trim()))
  if (declarations.length === 0) return ''
  if (!slug.test(producer) || !/^\d+\.\d+\.\d+$/.test(base) ||
      packages.length === 0 || packages.some(name => !/^@ezclassify\/[a-z0-9-]+$/.test(name))) {
    throw new Error('Invalid snapshot dependency configuration.')
  }
  if (declarations.length !== 1) throw new Error('This CI workflow supports one upstream snapshot dependency.')
  const value = declarations[0].trim().replace(/^Depends-on\s*:\s*/i, '').trim()
  const match = reference.exec(value)
  const upstream = match?.groups.urlRepo ?? match?.groups.shortRepo
  const number = match?.groups.urlNumber ?? match?.groups.shortNumber
  if (upstream?.toLowerCase() !== producer.toLowerCase()) {
    throw new Error(`Use Depends-on: ${producer}#<PR number> for this workflow.`)
  }
  const label = `${producer}#${number}`
  const pull = await readPull(producer, number)
  if (pull.merged !== true || pull.base?.ref !== 'main' || pull.base?.repo?.full_name?.toLowerCase() !== producer.toLowerCase()) {
    throw new Error(`Blocked: waiting for ${label} to merge into official main.`)
  }
  const sha = pull.merge_commit_sha
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error(`GitHub did not return a merge commit for ${label}.`)
  const prefix = `${base}-dev.snapshot.g`
  const sourceOf = version => {
    const source = typeof version === 'string' && version.startsWith(prefix) ? version.slice(prefix.length) : ''
    return /^[0-9a-f]{40}$/.test(source) ? source : ''
  }
  const available = version => packages.every(name => packageVersion(name, version) === version)
  const qualifies = async version => {
    const source = sourceOf(version)
    return source && (source === sha || await contains(producer, sha, source)) && available(version)
  }
  const pins = packages.map(name => manifest?.dependencies?.[name])
  let version = pins.every(pin => pin === pins[0]) && await qualifies(pins[0]) ? pins[0] : ''
  if (!version) {
    const exact = `${prefix}${sha}`
    if (available(exact)) version = exact
  }
  if (!version) {
    // A later snapshot can contain a merge from before the publisher was enabled.
    const candidate = packageVersion(packages[0], 'dev-snapshot')
    if (await qualifies(candidate)) version = candidate
  }
  if (!version) {
    throw new Error(`Blocked: waiting for a complete package snapshot containing ${label} (${sha}). Rerun after publication.`)
  }
  if (manifest && pins.some(pin => pin !== version)) {
    throw new Error(`Pin ${packages.join(' and ')} to ${version} in package.json, then push the downstream PR.`)
  }
  console.log(`Resolved ${label} to ${version} for ${packages.join(', ')}.`)
  return version
}

async function main() {
  const env = process.env
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
  async function github(path) {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${env.DEPENDENCY_GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`GitHub lookup failed for ${path} (HTTP ${response.status}).`)
    return response.json()
  }
  const version = await resolveSnapshot({
    event,
    manifest: JSON.parse(readFileSync('package.json', 'utf8')),
    consumer: env.GITHUB_REPOSITORY,
    producer: env.DEPENDENCY_PRODUCER,
    packages: env.DEPENDENCY_PACKAGES.trim().split(/\s+/).filter(Boolean),
    base: env.DEPENDENCY_VERSION_BASE,
    async readPull(repo, number) {
      if (!slug.test(repo) || !/^[1-9]\d*$/.test(String(number))) throw new Error('Invalid pull request identity.')
      return github(`/repos/${repo}/pulls/${number}`)
    },
    async contains(repo, required, snapshot) {
      const comparison = await github(`/repos/${repo}/compare/${required}...${snapshot}`)
      return comparison.status === 'ahead' || comparison.status === 'identical'
    },
    packageVersion(name, version) {
      try {
        const result = execFileSync('npm', [
          'view', `${name}@${version}`, 'version', '--json', '--prefer-online',
          '--fetch-retries=0', '--fetch-timeout=10000', '--registry', registry, `--@ezclassify:registry=${registry}`,
        ], { cwd: env.RUNNER_TEMP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 12_000 })
        return result.trim() ? JSON.parse(result) : undefined
      } catch (error) {
        if (/\bE404\b/.test(error.stderr ?? '')) return undefined
        throw new Error(`Registry lookup failed for ${name}. Check GitHub Packages read access and retry.`)
      }
    },
  })
  appendFileSync(env.GITHUB_OUTPUT, `version=${version}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
