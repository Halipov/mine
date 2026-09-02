import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Раскладка на диске:
 *
 *   <userData>/
 *     settings.json          настройки лаунчера и профили
 *     shared/                переиспользуется всеми сборками
 *       versions/<id>/       version.json + client.jar
 *       libraries/           maven-дерево
 *       assets/              indexes/ + objects/
 *       natives/<id>/        распакованные нативные библиотеки
 *     runtime/<major>/       скачанная JRE
 *     instances/<packId>/    рабочая папка игры: mods, config, saves, options.txt
 *
 * shared вынесен отдельно намеренно: если однажды появится вторая сборка,
 * она переиспользует уже скачанные ассеты и библиотеки, а это сотни мегабайт.
 */
export const paths = {
  root: (): string => app.getPath('userData'),
  settingsFile: (): string => path.join(paths.root(), 'settings.json'),
  shared: (): string => path.join(paths.root(), 'shared'),
  versionDir: (id: string): string => path.join(paths.shared(), 'versions', id),
  versionJson: (id: string): string => path.join(paths.versionDir(id), `${id}.json`),
  versionJar: (id: string): string => path.join(paths.versionDir(id), `${id}.jar`),
  libraries: (): string => path.join(paths.shared(), 'libraries'),
  assets: (): string => path.join(paths.shared(), 'assets'),
  assetIndex: (name: string): string =>
    path.join(paths.assets(), 'indexes', `${name}.json`),
  assetObject: (hash: string): string =>
    path.join(paths.assets(), 'objects', hash.slice(0, 2), hash),
  natives: (versionId: string): string =>
    path.join(paths.shared(), 'natives', versionId),
  runtime: (major: number): string => path.join(paths.root(), 'runtime', String(major)),
  instance: (packId: string): string => path.join(paths.root(), 'instances', packId),
  /** Реестр файлов, которые лаунчер положил сам. См. mods.ts. */
  managedFile: (packId: string): string =>
    path.join(paths.instance(packId), '.launcher-managed.json')
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(file))
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8')
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}
