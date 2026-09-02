import fs from 'node:fs/promises'
import path from 'node:path'
import { downloadFile, fetchJson, type DownloadTask } from './http'
import { paths, readJson, writeJson } from './paths'
import type { VersionJson } from './version'

const VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const RESOURCES = 'https://resources.download.minecraft.net'

interface VersionManifest {
  latest: { release: string; snapshot: string }
  versions: Array<{
    id: string
    type: string
    url: string
    sha1: string
    releaseTime: string
  }>
}

/** Список релизов — чтобы в настройках можно было посмотреть, что вообще бывает. */
export async function listReleases(): Promise<string[]> {
  const manifest = await fetchJson<VersionManifest>(VERSION_MANIFEST)
  return manifest.versions.filter((v) => v.type === 'release').map((v) => v.id)
}

/**
 * Скачивает и парсит ванильный version.json.
 * Файл кладётся в shared/versions и дальше берётся с диска.
 */
export async function loadVanillaVersion(mcVersion: string): Promise<VersionJson> {
  const manifest = await fetchJson<VersionManifest>(VERSION_MANIFEST)
  const wanted = mcVersion === 'latest' ? manifest.latest.release : mcVersion
  const entry = manifest.versions.find((v) => v.id === wanted)
  if (!entry) {
    throw new Error(
      `Версия Minecraft "${wanted}" не найдена. Проверь поле minecraft в манифесте сборки.`
    )
  }

  const dest = paths.versionJson(entry.id)
  await downloadFile({ url: entry.url, dest, sha1: entry.sha1 })
  const json = await readJson<VersionJson>(dest)
  if (!json) throw new Error(`Не удалось прочитать version.json для ${entry.id}`)
  return json
}

/** Задача на скачивание client.jar. */
export function clientJarTask(version: VersionJson): DownloadTask {
  const client = version.downloads?.client
  if (!client) throw new Error(`В version.json ${version.id} нет ссылки на client.jar`)
  return {
    url: client.url,
    dest: paths.versionJar(version.id),
    sha1: client.sha1,
    size: client.size
  }
}

interface AssetIndex {
  objects: Record<string, { hash: string; size: number }>
}

/**
 * Ассеты — самая многочисленная часть: несколько тысяч мелких файлов.
 * Индекс качаем отдельно, потому что из него берётся список остальных.
 */
export async function assetTasks(version: VersionJson): Promise<DownloadTask[]> {
  const index = version.assetIndex
  if (!index) return []

  const indexFile = paths.assetIndex(index.id)
  await downloadFile({ url: index.url, dest: indexFile, sha1: index.sha1, size: index.size })

  const parsed = await readJson<AssetIndex>(indexFile)
  if (!parsed) throw new Error('Не удалось прочитать индекс ассетов')

  const seen = new Set<string>()
  const tasks: DownloadTask[] = []
  for (const { hash, size } of Object.values(parsed.objects)) {
    if (seen.has(hash)) continue
    seen.add(hash)
    tasks.push({
      url: `${RESOURCES}/${hash.slice(0, 2)}/${hash}`,
      dest: paths.assetObject(hash),
      sha1: hash,
      size
    })
  }
  return tasks
}

/** Кладёт итоговый (уже слитый с Fabric) version.json рядом с остальными. */
export async function saveMergedVersion(version: VersionJson): Promise<void> {
  await writeJson(paths.versionJson(version.id), version)
}

/** Копия client.jar под именем итоговой версии не нужна — храним ссылку на исходную. */
export function vanillaJarPath(mcVersion: string): string {
  return path.join(paths.versionDir(mcVersion), `${mcVersion}.jar`)
}

export async function readCachedVersion(id: string): Promise<VersionJson | null> {
  try {
    await fs.access(paths.versionJson(id))
  } catch {
    return null
  }
  return readJson<VersionJson>(paths.versionJson(id))
}
