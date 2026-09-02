#!/usr/bin/env node
/**
 * Собирает pack.json из pack/pack.config.json.
 *
 *   node tools/build-pack.mjs                    — тег по сегодняшней дате
 *   node tools/build-pack.mjs --tag pack-alpha   — свой тег
 *
 * Моды с Modrinth подтягиваются по слагу вместе с обязательными
 * зависимостями. Моды не с Modrinth кладутся в pack/mods/ и уезжают
 * ассетами в релиз — команду скрипт напечатает в конце.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packDir = path.join(root, 'pack')
const args = process.argv.slice(2)

function valueOf(flag) {
  const index = args.indexOf(flag)
  return index === -1 ? null : args[index + 1]
}

const tag = valueOf('--tag') ?? `pack-${new Date().toISOString().slice(0, 10)}`

/**
 * Блокнот и PowerShell охотно сохраняют JSON с меткой порядка байтов,
 * на которой JSON.parse спотыкается с совершенно невнятной ошибкой.
 */
async function readJsonFile(file) {
  const text = await fs.readFile(file, 'utf8')
  return JSON.parse(text.replace(/^﻿/, ''))
}

const config = await readJsonFile(path.join(packDir, 'pack.config.json'))
const { owner, repo } = config.github ?? {}

// --- Вспомогательное ---------------------------------------------------------

/** GitHub переименовывает ассеты с необычными символами — делаем это сами. */
const assetName = (name) => name.replace(/[^A-Za-z0-9._-]/g, '.')

/**
 * Репозиторий нужен только для модов и конфигов, которые мы заливаем сами.
 * Сборке целиком с Modrinth он не требуется вовсе — там постоянный CDN.
 */
function releaseUrl(asset) {
  if (!owner || !repo || owner === 'CHANGE-ME') {
    throw new Error(
      'Чтобы залить свои файлы в релиз, заполни блок github: { owner, repo } ' +
        'в pack/pack.config.json'
    )
  }
  return `https://github.com/${owner}/${repo}/releases/download/${tag}/${asset}`
}

async function sha1(file) {
  return createHash('sha1')
    .update(await fs.readFile(file))
    .digest('hex')
}

async function walk(dir) {
  const out = []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

const uploads = new Map()

function claim(asset, source) {
  if (uploads.has(asset) && uploads.get(asset) !== source) {
    throw new Error(
      `Два файла превращаются в один ассет "${asset}":\n  ${uploads.get(asset)}\n  ${source}`
    )
  }
  uploads.set(asset, source)
}

// --- Моды с Modrinth ---------------------------------------------------------

async function modrinthVersions(idOrSlug) {
  const query = new URLSearchParams({
    loaders: JSON.stringify(['fabric']),
    game_versions: JSON.stringify([config.minecraft])
  })
  const res = await fetch(`https://api.modrinth.com/v2/project/${idOrSlug}/version?${query}`, {
    headers: { 'user-agent': 'mine-launcher/build-pack' }
  })
  if (res.status === 404) throw new Error(`На Modrinth нет проекта "${idOrSlug}"`)
  if (!res.ok) throw new Error(`Modrinth ответил ${res.status} на запрос "${idOrSlug}"`)
  return res.json()
}

/**
 * Обходим список модов вширь, попутно затягивая обязательные зависимости.
 * Без этого забытый fabric-api превращается в «у меня игра не запускается»
 * в личке — а узнаёшь об этом уже после того, как все обновились.
 */
const byProject = new Map()
const autoAdded = []
const queue = (config.modrinth ?? []).map((ref) => ({ ref, requiredBy: null }))

while (queue.length > 0) {
  const { ref, requiredBy } = queue.shift()
  const idOrSlug = typeof ref === 'string' ? ref : ref.slug
  const pinned = typeof ref === 'string' ? null : ref.version

  const versions = await modrinthVersions(idOrSlug)
  if (versions.length === 0) {
    throw new Error(
      `"${idOrSlug}" не поддерживает Fabric ${config.minecraft}` +
        (requiredBy ? ` (запрошен как зависимость ${requiredBy})` : '')
    )
  }

  const picked = pinned
    ? versions.find((v) => v.version_number === pinned || v.id === pinned)
    : (versions.find((v) => v.version_type === 'release') ?? versions[0])
  if (!picked) throw new Error(`У "${idOrSlug}" нет версии "${pinned}"`)

  if (byProject.has(picked.project_id)) continue

  const file = picked.files.find((f) => f.primary) ?? picked.files[0]
  byProject.set(picked.project_id, {
    name: file.filename,
    project: picked.project_id,
    url: file.url,
    sha1: file.hashes.sha1,
    size: file.size,
    title: `${picked.name} (${picked.version_number})`
  })

  if (requiredBy) autoAdded.push(`${file.filename} — нужен для ${requiredBy}`)
  else console.log(`  ${idOrSlug} ${picked.version_number}`)

  for (const dep of picked.dependencies ?? []) {
    if (dep.dependency_type !== 'required' || !dep.project_id) continue
    if (byProject.has(dep.project_id)) continue
    queue.push({ ref: dep.project_id, requiredBy: file.filename })
  }
}

const mods = [...byProject.values()]

// --- Моды, залитые вручную ---------------------------------------------------

const modFiles = (await walk(path.join(packDir, 'mods'))).filter((f) => f.endsWith('.jar'))
modFiles.sort()

for (const file of modFiles) {
  const asset = assetName(path.basename(file))
  claim(asset, file)
  mods.push({
    name: path.basename(file),
    url: releaseUrl(asset),
    sha1: await sha1(file),
    size: (await fs.stat(file)).size
  })
  console.log(`  ${path.basename(file)} (локальный)`)
}

// --- Дополнительные файлы ----------------------------------------------------

const extraFiles = []
for (const [dir, mode] of [
  [path.join(packDir, 'files'), 'overwrite'],
  [path.join(packDir, 'files-once'), 'once']
]) {
  for (const file of await walk(dir)) {
    const relative = path.relative(dir, file).split(path.sep).join('/')
    const asset = assetName(`cfg__${relative.split('/').join('__')}`)
    claim(asset, file)
    extraFiles.push({
      path: relative,
      url: releaseUrl(asset),
      sha1: await sha1(file),
      size: (await fs.stat(file)).size,
      mode
    })
  }
}

// --- Что изменилось со прошлого раза -----------------------------------------

const target = path.join(root, 'pack.json')
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
  mods,
  extraFiles
}

await fs.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

const totalBytes = [...mods, ...extraFiles].reduce((sum, item) => sum + item.size, 0)
console.log(`\nЗаписан pack.json (${tag})`)
console.log(`  модов: ${mods.length}, доп. файлов: ${extraFiles.length}`)
console.log(`  общий вес: ${(totalBytes / 1024 / 1024).toFixed(1)} МБ`)

if (autoAdded.length > 0) {
  console.log('\nДобавлены зависимости:')
  for (const line of autoAdded) console.log(`  ${line}`)
}

// --- Что делать дальше -------------------------------------------------------

if (uploads.size > 0) {
  const uploadArgs = [...uploads.entries()]
    .map(([asset, source]) => `"${path.relative(root, source)}#${asset}"`)
    .join(' \\\n    ')
  console.log(`
Залей файлы в релиз:

  gh release create ${tag} --title "${tag}" --notes "Обновление сборки" \\
    ${uploadArgs}
`)
}

console.log(`Опубликуй манифест:

  git add pack.json && git commit -m "pack ${tag}" && git push

Лаунчер подхватит новый состав при следующем запуске — обновлять его не нужно.
`)
