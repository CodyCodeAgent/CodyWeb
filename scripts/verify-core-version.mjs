import { readFile } from 'node:fs/promises'
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const dependencyName = '@codycodeagent/cody-web-core'
const dependencySpec = packageJson.dependencies?.[dependencyName]
const expectedVersion = dependencySpec?.match(/#v(\d+\.\d+\.\d+)$/)?.[1]

if (!expectedVersion) {
  throw new Error(`${dependencyName} must use an immutable vX.Y.Z tag; received ${String(dependencySpec)}`)
}

const installedPackageJson = JSON.parse(
  await readFile(new URL('../node_modules/@codycodeagent/cody-web-core/package.json', import.meta.url), 'utf8'),
)
if (installedPackageJson.version !== expectedVersion) {
  throw new Error(
    `${dependencyName} runtime mismatch: package.json requires ${expectedVersion}, `
      + `but node_modules contains ${installedPackageJson.version}. Regenerate the lockfile and reinstall.`,
  )
}

console.log(`${dependencyName} runtime verified: ${installedPackageJson.version}`)
