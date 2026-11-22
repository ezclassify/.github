import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const registry = 'https://registry.npmjs.org'
const scope = /^@ezclassify\/[a-z0-9][a-z0-9-]*$/
const firstCutFloor = '^1.0.0-0'
const releaseVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-rc\.(?:0|[1-9][0-9]*))?$/
const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

const readJSON = (file) => JSON.parse(readFileSync(file, 'utf8'))

export function readConsumer(root) {
  const manifest = readJSON(join(root, 'package.json'))
  const workspaces = new Map((manifest.workspaces ?? []).map(path => {
    if (!/^[-\w]+(?:\/[-\w]+)*$/.test(path)) {
      throw new Error('The public registry check requires explicit local workspace paths')
    }
    return [path, readJSON(join(root, path, 'package.json'))]
  }))
  const ownNames = new Set([...workspaces.values()].map(member => member.name))
  const requirements = new Map()
  for (const member of [manifest, ...workspaces.values()]) {
    for (const field of dependencyFields) {
      for (const [name, range] of Object.entries(member[field] ?? {})) {
        if (!scope.test(name) || ownNames.has(name)) continue
        if (!requirements.has(name)) requirements.set(name, new Set())
        requirements.get(name).add(range)
      }
    }
  }
  return { requirements, workspaces }
}

/** A temporary first-cut approval can cover missing names at one existing floor. */
export async function selectLane(requirements, approval, fetchImpl = fetch) {
  if (!approval) return { lane: 'public', missing: [] }
  const approved = approval.split(/\s+/).filter(Boolean)
  if (!approved.length || approved.some(name => !scope.test(name)) || new Set(approved).size !== approved.length) {
    throw new Error('The first-publication approval must list exact EzClassify package names')
  }
  const missing = (await Promise.all([...requirements.keys()].map(async name => {
    const response = await fetchImpl(registry + '/' + encodeURIComponent(name), {
      method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(15_000), cache: 'no-store',
    })
    if (response.status === 404) return name
    if (response.status !== 200) throw new Error(name + ': public npm returned HTTP ' + response.status)
    return null
  }))).filter(Boolean)
  if (!missing.length) return { lane: 'public', missing }
  if (missing.some(name => !approved.includes(name)) ||
      [...requirements].some(([name, ranges]) => !approved.includes(name) || ranges.size !== 1 || !ranges.has(firstCutFloor))) {
    throw new Error('The declared dependencies exceed the approved first-publication closure')
  }
  return { lane: 'bootstrap', missing }
}

/** Validate the ephemeral lock before npm ci downloads the named tarballs. */
export function assertPublicLock(lock, workspaces) {
  if (lock.lockfileVersion !== 3 || !lock.packages || !lock.packages['']) throw new Error('Expected an npm v3 install lock')
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '' || workspaces.has(path)) continue
    const name = path.split('node_modules/').at(-1)
    if (entry.link === true) {
      if (workspaces.get(entry.resolved)?.name !== name) throw new Error(path + ': dependency is not a declared workspace')
      continue
    }
    const packageName = entry.name ?? name
    const firstParty = scope.test(name) || scope.test(packageName)
    if (firstParty && (name !== packageName || !releaseVersion.test(entry.version) || entry.inBundle === true)) {
      throw new Error(path + ': a public release or numbered release candidate is required')
    }
    if (entry.inBundle === true && !entry.resolved) {
      const owner = lock.packages[path.slice(0, path.lastIndexOf('/node_modules/'))]
      if (owner?.integrity || owner?.inBundle) continue
    }
    const url = typeof entry.resolved === 'string' && URL.canParse(entry.resolved) ? new URL(entry.resolved) : null
    if (url?.origin !== registry || url.username || url.password || url.search || url.hash ||
        !/^sha(?:1|256|384|512)-[A-Za-z0-9+/]+=*$/.test(entry.integrity ?? '')) {
      throw new Error(path + ': expected an integrity-pinned public npm tarball')
    }
    if (firstParty && decodeURIComponent(url.pathname) !== '/' + packageName + '/-/' + packageName.slice(packageName.indexOf('/') + 1) + '-' + entry.version + '.tgz') {
      throw new Error(path + ': tarball does not identify the locked first-party release')
    }
  }
}

const allowedNpmrc = new Set(['ignore-scripts=true', 'omit-lockfile-registry-resolved=true', 'legacy-peer-deps=false'])

function installPublic(root, workspaces) {
  const npmrc = join(root, '.npmrc')
  if (existsSync(npmrc)) {
    const settings = readFileSync(npmrc, 'utf8').split(/\r?\n/).map(line => line.trim())
      .filter(line => line && !line.startsWith('#') && !line.startsWith(';'))
    if (settings.some(setting => !allowedNpmrc.has(setting))) throw new Error('The project .npmrc has unsupported settings for public verification')
  }
  const scratch = mkdtempSync(join(tmpdir(), 'public-npm-'))
  try {
    const user = join(scratch, 'user.npmrc')
    const global = join(scratch, 'global.npmrc')
    writeFileSync(user, 'registry=' + registry + '/\n@ezclassify:registry=' + registry + '/\n')
    writeFileSync(global, '')
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(npm_config_|node_auth_token$|npm_token$)/i.test(name)))
    Object.assign(env, {
      NPM_CONFIG_USERCONFIG: user,
      NPM_CONFIG_GLOBALCONFIG: global,
      NPM_CONFIG_CACHE: join(scratch, 'cache'),
      NPM_CONFIG_REGISTRY: registry + '/',
      NPM_CONFIG_IGNORE_SCRIPTS: 'true',
      NPM_CONFIG_OMIT_LOCKFILE_REGISTRY_RESOLVED: 'false',
      NPM_CONFIG_ALLOW_FILE: 'none',
      NPM_CONFIG_ALLOW_GIT: 'none',
      NPM_CONFIG_ALLOW_REMOTE: 'none',
    })
    const run = (file, args) => {
      const result = spawnSync(file, args, { cwd: root, env, stdio: 'inherit' })
      if (result.status !== 0) throw new Error(file + ' ' + args.join(' ') + ' failed', { cause: result.error })
    }
    const relock = phase => run(process.execPath, ['scripts/relock.mjs', phase])
    if (existsSync(join(root, 'package-lock.json'))) {
      throw new Error('The public registry check requires a clean checkout without a generated lockfile')
    }
    rmSync(join(root, 'node_modules'), { recursive: true, force: true })
    relock('--strip')
    const lock = ['install', '--package-lock-only', '--include=optional', '--ignore-scripts', '--no-fund', '--no-audit']
    try {
      const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString()
      run('npm', [...lock, '--before=' + cutoff])
    } finally {
      relock('--restore')
    }
    run('npm', [...lock, '--tag=latest'])
    assertPublicLock(readJSON(join(root, 'package-lock.json')), workspaces)
    run('npm', ['run', 'check:dependency-age'])
    run('npm', ['ci', '--no-fund', '--no-audit'])
    relock('--normalize')
    run('npm', ['run', 'check:lockfile-portable'])
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { requirements, workspaces } = readConsumer(process.cwd())
    const { lane, missing } = await selectLane(requirements, process.env.EZ_FIRST_PUBLICATION_PACKAGES)
    if (lane === 'public') installPublic(process.cwd(), workspaces)
    else console.log('First-publication bootstrap uses the development mirror for: ' + missing.join(', '))
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'lane=' + lane + '\n')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
