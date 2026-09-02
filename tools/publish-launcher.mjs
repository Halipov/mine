#!/usr/bin/env node
/**
 * Раскладывает собранный лаунчер в web/launcher/ и пишет latest.json,
 * по которому лаунчер у друзей находит обновление.
 *
 *   npm run pack:win      (и/или pack:mac на макбуке)
 *   node tools/publish-launcher.mjs
 *
 * Сборки под разные платформы делаются на разных машинах, поэтому скрипт
 * не перетирает latest.json целиком, а дополняет его: собрал на Windows —
 * обновилась запись win-x64, остальные остались от прошлого раза.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { formatMb, hashFile, readJsonFile, repoRoot, writeJsonFile } from './util.mjs'

const distDir = path.join(repoRoot, 'dist')
const webDir = path.join(repoRoot, 'web', 'launcher')
const latestFile = path.join(webDir, 'latest.json')

const pkg = await readJsonFile(path.join(repoRoot, 'package.json'))
const version = pkg.version

// Корень раздачи берём оттуда же, откуда его берут моды: сервер один и тот же,
// а разъехавшиеся адреса — это молчаливо неработающее обновление.
const packConfig = await readJsonFile(path.join(repoRoot, 'pack', 'pack.config.json'))
const base = (packConfig.filesBaseUrl ?? '').replace(/\/+$/, '')
if (!base) {
  console.error('В pack/pack.config.json не задан filesBaseUrl — некуда публиковать')
  process.exit(1)
}

const notesIndex = process.argv.indexOf('--notes')
const notes = notesIndex === -1 ? null : process.argv[notesIndex + 1]

/** Как называется платформа в latest.json — см. platformKey в updater.ts. */
function platformOf(fileName) {
  if (fileName.endsWith('.exe')) return 'win-x64'
  if (fileName.endsWith('-mac-arm64.zip')) return 'mac-arm64'
  if (fileName.endsWith('-mac-x64.zip')) return 'mac-x64'
  return null
}

const built = (await fs.readdir(distDir).catch(() => [])).filter(
  (name) => name.includes(version) && platformOf(name)
)

if (built.length === 0) {
  console.error(
    `В dist/ нет сборок версии ${version}. Сначала: npm run pack:win (или pack:mac).`
  )
  process.exit(1)
}

// Сохраняем то, что уже опубликовано с других машин.
const previous = await readJsonFile(latestFile).catch(() => null)
const files = previous?.version === version ? { ...previous.files } : {}

await fs.mkdir(webDir, { recursive: true })

for (const name of built) {
  const platform = platformOf(name)
  const source = path.join(distDir, name)
  const dest = path.join(webDir, name)

  await fs.copyFile(source, dest)
  const size = (await fs.stat(dest)).size
  files[platform] = {
    url: `${base}/launcher/${name}`,
    size,
    sha256: await hashFile(dest, 'sha256')
  }
  console.log(`  ${platform.padEnd(10)} ${name}  ${formatMb(size)}`)
}

if (previous && previous.version !== version) {
  const stale = Object.keys(previous.files ?? {}).filter((key) => !files[key])
  if (stale.length > 0) {
    console.log(`\nНе собрано на этой машине: ${stale.join(', ')}`)
    console.log('Те платформы останутся на прошлой версии, пока их не соберёшь.')
  }
}

await writeJsonFile(latestFile, { version, notes: notes ?? '', files })

console.log(`\nЗаписан web/launcher/latest.json (${version}), раздача ${base}`)
console.log(`
Дальше: выложить web/ на сервер. Лаунчер сверит SHA-256 перед установкой,
так что битая или подменённая по дороге сборка не поставится.
`)
