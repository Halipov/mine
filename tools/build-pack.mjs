#!/usr/bin/env node
/**
 * Собирает pack.json из локальной папки pack/.
 *
 * Как это работает: моды и файлы конфигов заливаются ассетами в релиз GitHub,
 * а манифест ссылается на них по прямым ссылкам и хранит SHA-1 каждого файла.
 * Лаунчер сравнивает хеши и качает только то, что действительно изменилось.
 *
 *   node tools/build-pack.mjs --tag pack-2026.09.01
 *
 * После этого — команда, которую скрипт напечатает в конце, зальёт файлы
 * и опубликует релиз.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packDir = path.join(root, 'pack')

const args = process.argv.slice(2)
const tag = valueOf('--tag')
if (!tag) {
  console.error('Укажи тег релиза: node tools/build-pack.mjs --tag pack-2026-09-01')
  process.exit(1)
}

function valueOf(flag) {
  const index = args.indexOf(flag)
  return index === -1 ? null : args[index + 1]
}

const config = JSON.parse(await fs.readFile(path.join(packDir, 'pack.config.json'), 'utf8'))
const { owner, repo } = config.github ?? {}
if (!owner || !repo) {
  console.error('В pack/pack.config.json не заполнен блок github: { owner, repo }')
  process.exit(1)
}

/** GitHub переименовывает ассеты с необычными символами — делаем это сами. */
function assetName(name) {
  return name.replace(/[^A-Za-z0-9._-]/g, '.')
}

function releaseUrl(asset) {
  return `https://github.com/${owner}/${repo}/releases/download/${tag}/${asset}`
}

async function sha1(file) {
  const hash = createHash('sha1')
  hash.update(await fs.readFile(file))
  return hash.digest('hex')
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

/**
 * Моды с Modrinth никуда заливать не надо: у них есть постоянный CDN и
 * официальный SHA-1 в API. Достаточно перечислить слаги в pack.config.json —
 * скрипт сам подберёт свежую версию под нужный Minecraft и Fabric.
 * Можно закрепить конкретную версию: { "slug": "sodium", "version": "mc1.21.1-0.6.0" }.
 */
async function resolveModrinth(entry) {
  const slug = typeof entry === 'string' ? entry : entry.slug
  const pinned = typeof entry === 'string' ? null : entry.version

  const query = new URLSearchParams({
    loaders: JSON.stringify(['fabric']),
    game_versions: JSON.stringify([config.minecraft])
  })
  const res = await fetch(`https://api.modrinth.com/v2/project/${slug}/version?${query}`, {
    headers: { 'user-agent': 'mine-launcher/build-pack' }
  })
  if (!res.ok) throw new Error(`Modrinth ответил ${res.status} на запрос "${slug}"`)

  const versions = await res.json()
  if (versions.length === 0) {
    throw new Error(`На Modrinth нет "${slug}" под Fabric ${config.minecraft}`)
  }

  const picked = pinned
    ? versions.find((v) => v.version_number === pinned || v.id === pinned)
    : (versions.find((v) => v.version_type === 'release') ?? versions[0])
  if (!picked) throw new Error(`У "${slug}" нет версии "${pinned}"`)

  const file = picked.files.find((f) => f.primary) ?? picked.files[0]
  return {
    entry: {
      name: file.filename,
      url: file.url,
      sha1: file.hashes.sha1,
      size: file.size,
      title: `${picked.name ?? slug} (${picked.version_number})`
    },
    label: `${slug} ${picked.version_number}`
  }
}

const mods = []
for (const entry of config.modrinth ?? []) {
  const { entry: mod, label } = await resolveModrinth(entry)
  mods.push(mod)
  console.log(`  modrinth: ${label}`)
}

// --- Моды, залитые вручную ---------------------------------------------------

const modFiles = (await walk(path.join(packDir, 'mods'))).filter((f) => f.endsWith('.jar'))
modFiles.sort()

for (const file of modFiles) {
  const asset = assetName(path.basename(file))
  claim(asset, file)
  const stat = await fs.stat(file)
  mods.push({
    name: path.basename(file),
    url: releaseUrl(asset),
    sha1: await sha1(file),
    size: stat.size
  })
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
    const stat = await fs.stat(file)
    extraFiles.push({
      path: relative,
      url: releaseUrl(asset),
      sha1: await sha1(file),
      size: stat.size,
      mode
    })
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

const target = path.join(root, 'pack.json')
await fs.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

const totalBytes = [...mods, ...extraFiles].reduce((sum, item) => sum + item.size, 0)
console.log(`Записан ${path.relative(root, target)}`)
console.log(`  модов: ${mods.length}, доп. файлов: ${extraFiles.length}`)
console.log(`  общий вес: ${(totalBytes / 1024 / 1024).toFixed(1)} МБ`)

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
} else {
  console.log('\nВсе моды с Modrinth — заливать в релиз нечего.')
}

console.log(`Опубликуй манифест:

  git add pack.json && git commit -m "pack ${tag}" && git push

Лаунчер подхватит новый состав при следующем запуске — обновлять его не нужно.
`)
