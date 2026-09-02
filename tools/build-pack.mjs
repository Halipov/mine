#!/usr/bin/env node
/**
 * Собирает pack.json из pack/pack.config.json.
 *
 *   node tools/build-pack.mjs                    — тег по сегодняшней дате
 *   node tools/build-pack.mjs --tag pack-alpha   — свой тег
 *
 * Манифест — общий контракт лаунчера и сервера: у каждого мода проставлена
 * сторона, и каждый берёт из списка своё. Так версии модов на клиенте и
 * сервере не разъезжаются, а разъехавшись, они выкидывают игрока при заходе.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveMods, sideLabel } from './modrinth.mjs'
import {
  formatMb,
  hashFile,
  readJsonFile,
  repoRoot,
  safeName,
  walk,
  writeJsonFile
} from './util.mjs'

const packDir = path.join(repoRoot, 'pack')
const args = process.argv.slice(2)
const valueOf = (flag) => {
  const index = args.indexOf(flag)
  return index === -1 ? null : args[index + 1]
}

const tag = valueOf('--tag') ?? `pack-${new Date().toISOString().slice(0, 10)}`
const config = await readJsonFile(path.join(packDir, 'pack.config.json'))

/**
 * Куда лаунчер пойдёт за модами, которых нет на Modrinth. Раздаёт их тот же
 * сервер, что и манифест, — поэтому нужен только базовый адрес.
 */
function hostedUrl(fileName) {
  const base = config.filesBaseUrl
  if (!base) {
    throw new Error(
      'В pack/pack.config.json не задан filesBaseUrl — без него некуда положить ' +
        'моды, которых нет на Modrinth. Либо задай адрес раздачи, либо убери ' +
        'файлы из pack/mods*.'
    )
  }
  return `${base.replace(/\/+$/, '')}/files/${tag}/${fileName}`
}

// --- Моды с Modrinth ---------------------------------------------------------

const { mods, autoAdded } = await resolveMods({
  minecraft: config.minecraft,
  entries: config.modrinth ?? []
})

for (const mod of mods) {
  console.log(`  ${(mod.slug ?? mod.name).padEnd(28)} ${mod.versionNumber ?? ''}  [${sideLabel(mod)}]`)
}

// --- Моды, залитые вручную ---------------------------------------------------

const uploads = new Map()

for (const [dir, side] of [
  [path.join(packDir, 'mods'), 'both'],
  [path.join(packDir, 'mods-client'), 'client'],
  [path.join(packDir, 'mods-server'), 'server']
]) {
  const files = (await walk(dir)).filter((f) => f.endsWith('.jar')).sort()
  for (const file of files) {
    const fileName = safeName(path.basename(file))
    uploads.set(fileName, file)
    mods.push({
      name: path.basename(file),
      url: hostedUrl(fileName),
      sha1: await hashFile(file),
      size: (await fs.stat(file)).size,
      client: side !== 'server',
      server: side !== 'client'
    })
    console.log(`  ${path.basename(file).padEnd(28)} локальный  [${sideLabel(mods.at(-1))}]`)
  }
}

// --- Дополнительные файлы ----------------------------------------------------

const extraFiles = []
for (const [dir, mode] of [
  [path.join(packDir, 'files'), 'overwrite'],
  [path.join(packDir, 'files-once'), 'once']
]) {
  for (const file of await walk(dir)) {
    const relative = path.relative(dir, file).split(path.sep).join('/')
    const fileName = safeName(`cfg__${relative.split('/').join('__')}`)
    uploads.set(fileName, file)
    extraFiles.push({
      path: relative,
      url: hostedUrl(fileName),
      sha1: await hashFile(file),
      size: (await fs.stat(file)).size,
      mode
    })
  }
}

// --- Что изменилось со прошлого раза -----------------------------------------

const target = path.join(repoRoot, 'web', 'pack.json')
const previous = await readJsonFile(target).catch(() => null)

/** Ключ мода: проект Modrinth, а для локальных jar — имя файла. */
const keyOf = (mod) => mod.project ?? mod.name ?? mod.url

if (previous) {
  const before = new Map(previous.mods.map((m) => [keyOf(m), m]))
  const after = new Map(mods.map((m) => [keyOf(m), m]))

  const added = [...after.values()].filter((m) => !before.has(keyOf(m)))
  const removed = [...before.values()].filter((m) => !after.has(keyOf(m)))
  const updated = [...after.values()].filter((m) => {
    const old = before.get(keyOf(m))
    return old && old.sha1 !== m.sha1
  })

  console.log('\nИзменения:')
  for (const m of added) console.log(`  + ${m.name}`)
  for (const m of removed) console.log(`  − ${m.name}`)
  for (const m of updated) console.log(`  ~ ${before.get(keyOf(m)).name} → ${m.name}`)
  if (added.length + removed.length + updated.length === 0) {
    console.log('  состав модов не изменился')
  }
}

// --- Манифест ----------------------------------------------------------------

const manifest = {
  schema: 1,
  id: config.id,
  name: config.name,
  packVersion: tag,
  minecraft: config.minecraft,
  fabricLoader: config.fabricLoader ?? 'latest',
  ...(config.java ? { java: config.java } : {}),
  ...(config.server ? { server: config.server } : {}),
  ...(config.minLauncherVersion ? { minLauncherVersion: config.minLauncherVersion } : {}),
  recommendedRamMb: config.recommendedRamMb ?? 4096,
  mods: mods.map((mod) => ({
    name: mod.name,
    ...(mod.project ? { project: mod.project } : {}),
    url: mod.url,
    sha1: mod.sha1,
    size: mod.size,
    ...(mod.title ? { title: mod.title } : {}),
    side: mod.client && mod.server ? 'both' : mod.client ? 'client' : 'server'
  })),
  extraFiles
}

await writeJsonFile(target, manifest)

// Копии файлов, которые раздаём сами, — рядом с манифестом, готовые к заливке.
for (const [fileName, source] of uploads) {
  const dest = path.join(repoRoot, 'web', 'files', tag, fileName)
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.copyFile(source, dest)
}

const clientCount = mods.filter((m) => m.client).length
const serverCount = mods.filter((m) => m.server).length
const totalBytes = [...mods, ...extraFiles].reduce((sum, item) => sum + item.size, 0)

console.log(`\nЗаписан web/pack.json (${tag})`)
console.log(`  модов: ${mods.length} — на клиент ${clientCount}, на сервер ${serverCount}`)
console.log(`  доп. файлов: ${extraFiles.length}, общий вес: ${formatMb(totalBytes)}`)
if (uploads.size > 0) console.log(`  своих файлов скопировано в web/files/${tag}: ${uploads.size}`)

if (autoAdded.length > 0) {
  console.log('\nДобавлены зависимости:')
  for (const line of autoAdded) console.log(`  ${line}`)
}

console.log(`
Дальше:
  раздать web/ с сервера — лаунчер и сервер читают оттуда один и тот же
  манифест и берут из него каждый свою половину модов.
`)
