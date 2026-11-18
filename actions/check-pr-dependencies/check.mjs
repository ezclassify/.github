import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const reference = /^(?:https:\/\/github\.com\/(?<urlRepo>[\w.-]+\/[\w.-]+)\/pull\/(?<urlNumber>[1-9]\d*)|(?<shortRepo>[\w.-]+\/[\w.-]+)#(?<shortNumber>[1-9]\d*))$/i
const registry = 'https://npm.pkg.github.com'
const slug = /^[\w.-]+\/[\w.-]+$/
const shaFormat = /^[0-9a-f]{40}$/
const snapshotFormat = /^\d+\.\d+\.\d+-dev\.snapshot\.g([0-9a-f]{40})\.r[1-9]\d*\.[1-9]\d*$/
const snapshotSource = version => typeof version === 'string' ? snapshotFormat.exec(version)?.[1] : undefined

async function mergedDependency({ event, consumer, producer, readPull }) {
  if (!event.pull_request) return ''
  const current = await readPull(consumer, event.number)
  if (current.state !== 'open' || current.head?.sha !== event.pull_request.head.sha) {
    throw new Error('This run belongs to an older PR revision. Check the current PR run.')
  }
  const declarations = (current.body ?? '').split(/\r?\n/).filter(line => /^Depends-on\s*:/i.test(line.trim()))
  if (declarations.length === 0) return ''
  if (!slug.test(producer)) throw new Error('Invalid producer identity.')
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
  if (!shaFormat.test(sha ?? '')) throw new Error(`GitHub did not return a merge commit for ${label}.`)
  return { label, sha }
}

export async function resolveSnapshot({ packages, packageVersion, contains, manifest, published, ...identity }) {
  const merged = await mergedDependency(identity)
  if (!merged) return ''
  const { label, sha } = merged
  const { producer } = identity
  if (packages.length === 0 || packages.some(name => !/^@ezclassify\/[a-z0-9-]+$/.test(name))) {
    throw new Error('Invalid snapshot dependency configuration.')
  }
  const check = 'development / packages'
  const expectedPackages = JSON.stringify([...packages].sort())
  const complete = (version, proof) => proof?.version === version &&
    JSON.stringify(proof.packages) === expectedPackages &&
    packages.every(name => packageVersion(name, version) === version)
  const qualifies = async version => {
    const source = snapshotSource(version)
    if (!source || (source !== sha && !await contains(producer, sha, source))) return false
    return complete(version, await published(producer, source, check, version))
  }
  const pins = packages.map(name => manifest?.dependencies?.[name] ?? manifest?.devDependencies?.[name])
  let version = pins.every(pin => pin === pins[0]) && await qualifies(pins[0]) ? pins[0] : ''
  if (!version) {
    const proof = await published(producer, sha, check)
    const exact = proof?.version
    if (snapshotSource(exact) === sha && complete(exact, proof)) version = exact
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

export async function resolveImage({ image, published, mainRef, contains, ...identity }) {
  const merged = await mergedDependency(identity)
  if (!merged) return ''
  if (!/^[a-z0-9][a-z0-9-]*$/.test(image)) throw new Error('Invalid development image name.')
  const { producer } = identity
  const check = `development / image / ${image}`
  const ref = new RegExp(`^ghcr\\.io/ezclassify/${image}@sha256:[0-9a-f]{64}$`)
  const find = async sha => {
    const proof = await published(producer, sha, check)
    return ref.test(proof?.image ?? '') ? proof.image : ''
  }
  const exact = await find(merged.sha)
  if (exact) return exact
  const main = await mainRef(producer)
  if (shaFormat.test(main) && main !== merged.sha && await contains(producer, merged.sha, main)) {
    const current = await find(main)
    if (current) return current
  }
  throw new Error(`Blocked: waiting for Release Train to publish ${image} containing ${merged.label} (${merged.sha}).`)
}

export function readPublicationCheck(list, { sha, name, app, version }) {
  const runs = list.check_runs ?? []
  for (const check of runs) {
    if (check.name !== name || check.head_sha !== sha || check.app?.id !== app ||
        check.status !== 'completed' || check.conclusion !== 'success') continue
    let proof
    try {
      proof = JSON.parse(check.output.summary)
    } catch {
      throw new Error('Malformed development publication check.')
    }
    if (!version || proof?.version === version) return proof
  }
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
  const app = Number(env.DEPENDENCY_PUBLICATION_APP_ID)
  const identity = {
    event,
    consumer: env.GITHUB_REPOSITORY,
    producer: env.DEPENDENCY_PRODUCER,
    async readPull(repo, number) {
      if (!slug.test(repo) || !/^[1-9]\d*$/.test(String(number))) throw new Error('Invalid pull request identity.')
      return github(`/repos/${repo}/pulls/${number}`)
    },
    async contains(repo, required, snapshot) {
      const comparison = await github(`/repos/${repo}/compare/${required}...${snapshot}`)
      return comparison.status === 'ahead' || comparison.status === 'identical'
    },
    async published(repo, sha, name, version) {
      if (!Number.isSafeInteger(app) || app <= 0) throw new Error('The Release Train publication App ID is required.')
      const query = new URLSearchParams({ check_name: name, app_id: String(app), filter: version ? 'all' : 'latest', per_page: '100' })
      const result = await github(`/repos/${repo}/commits/${sha}/check-runs?${query}`)
      return readPublicationCheck(result, { sha, name, app, version })
    },
  }
  const imageName = env.DEPENDENCY_IMAGE
  if (imageName) {
    const image = await resolveImage({
      ...identity,
      image: imageName,
      async mainRef(repo) {
        const ref = await github(`/repos/${repo}/git/ref/heads/main`)
        return ref.object?.sha ?? ''
      },
    })
    appendFileSync(env.GITHUB_OUTPUT, `image=${image}\n`)
    return
  }
  const version = await resolveSnapshot({
    ...identity,
    manifest: JSON.parse(readFileSync('package.json', 'utf8')),
    packages: env.DEPENDENCY_PACKAGES.trim().split(/\s+/).filter(Boolean),
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
