import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const legacyBrandingTerms = [
  ['codex', '-web-local'].join(''),
  ['codex', '-web'].join(''),
  ['Codex', ' Web'].join(''),
  ['codex', '_web_local'].join(''),
  ['codex', '_web'].join(''),
  ['CODEX', '_WEB'].join(''),
  ['codex', 'local'].join(''),
  ['Codex', 'Local'].join(''),
]
const LEGACY_BRANDING_PATTERN = new RegExp(legacyBrandingTerms.join('|'), 'u')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function runGit(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function runNpmPackDryRun() {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const entries = JSON.parse(output)
  assert(Array.isArray(entries) && entries.length === 1, 'expected exactly one npm pack dry-run entry')
  return entries[0]
}

function assertPackageMetadata(packageJson) {
  assert(packageJson.name === 'cody-web-ui', `unexpected package name: ${packageJson.name}`)
  assert(packageJson.bin?.['cody-web-ui'] === 'dist-cli/index.js', 'missing cody-web-ui CLI bin')
  const legacyBinName = legacyBrandingTerms[0]
  assert(!packageJson.bin?.[legacyBinName], `legacy ${legacyBinName} CLI bin is still present`)
  assert(packageJson.files?.includes('dist/'), 'package files must include dist/')
  assert(packageJson.files?.includes('dist-cli/'), 'package files must include dist-cli/')
  assert(packageJson.files?.includes('scripts/'), 'package files must include scripts/')
}

function assertPackedFiles(packResult) {
  const files = new Set(packResult.files.map((file) => file.path))
  const requiredFiles = [
    'package.json',
    'README.md',
    'LICENSE',
    'dist/index.html',
    'dist-cli/index.js',
    'scripts/smoke-cli.mjs',
    'scripts/smoke-agent-tasks.mjs',
    'scripts/smoke-catalog.mjs',
    'scripts/smoke-history.mjs',
    'scripts/smoke-package.mjs',
  ]

  for (const file of requiredFiles) {
    assert(files.has(file), `packed npm tarball is missing ${file}`)
  }

  const legacyPathFragment = legacyBrandingTerms[1]
  for (const file of files) {
    assert(!file.includes(legacyPathFragment), `packed npm tarball includes legacy path ${file}`)
  }
}

function assertNoLegacyBrandingInReleaseSources() {
  const tracked = runGit(['ls-files']).split('\n').filter(Boolean)
  const releaseSourceFiles = tracked.filter((file) => {
    if (file.startsWith('documentation/app-server-schemas/')) return false
    return (
      file === 'README.md' ||
      file === 'package.json' ||
      file === '.cody-web-ui.yml' ||
      file.startsWith('src/') ||
      file.startsWith('scripts/') ||
      file.startsWith('docs/') ||
      file.startsWith('documentation/')
    )
  })

  const offenders = []
  for (const file of releaseSourceFiles) {
    const absolutePath = join(process.cwd(), file)
    // A pre-commit verification run can legitimately contain tracked files
    // staged for deletion. Only the release tree that still exists can ship.
    if (!existsSync(absolutePath)) continue
    const text = readFileSync(absolutePath, 'utf8')
    if (LEGACY_BRANDING_PATTERN.test(text)) {
      offenders.push(file)
    }
  }

  assert(
    offenders.length === 0,
    `legacy package branding found in release sources:\n${offenders.join('\n')}`,
  )
}

const packageJson = readJson(join(process.cwd(), 'package.json'))
assertPackageMetadata(packageJson)
assertNoLegacyBrandingInReleaseSources()

const packResult = runNpmPackDryRun()
assert(packResult.name === 'cody-web-ui', `npm pack produced unexpected name ${packResult.name}`)
assert(packResult.filename === `cody-web-ui-${packageJson.version}.tgz`, 'unexpected npm tarball filename')
assertPackedFiles(packResult)

console.log(
  `Package smoke passed: ${packResult.filename}, ${String(packResult.files.length)} files, ` +
    `${String(packResult.unpackedSize)} unpacked bytes`,
)
