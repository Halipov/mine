import fs from 'node:fs/promises'
import path from 'node:path'
import type { PackManifest } from '@shared/types'
import { downloadAll, isSatisfied, type DownloadTask } from './http'
import { ensureDir, exists, paths, readJson, writeJson } from './paths'

/**
 * Реестр файлов, которые положил лаунчер.
 *
 * Ключевая идея: мы удаляем только то, что скачали сами. Если игрок докинул
 * в mods свой мод на миникарту, он переживёт любое обновление сборки —
 * а вот мод, убранный из манифеста, исчезнет, потому что он есть в реестре.
 */
interface ManagedState {
  packVersion: string
  /** Пути относительно папки инстанса, всегда через прямой слэш. */
  files: string[]
}

function modFileName(url: string, explicit?: string): string {
  if (explicit) return explicit
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
  if (!name) throw new Error(`Не могу вывести имя файла из ссылки ${url}`)
  return name
}

export interface SyncResult {
  added: number
  removed: string[]
}

/**
 * Приводит папку инстанса в соответствие манифесту: докачивает недостающее,
 * обновляет изменившееся, убирает то, что из сборки удалили.
 */
export async function syncPackFiles(
  manifest: PackManifest,
  onProgress: (value: number | null, label: string) => void
): Promise<SyncResult> {
  const instance = paths.instance(manifest.id)
  await ensureDir(path.join(instance, 'mods'))

  const desired = new Map<string, DownloadTask>()

  for (const mod of manifest.mods) {
    const relative = `mods/${modFileName(mod.url, mod.name)}`
    desired.set(relative, {
      url: mod.url,
      dest: path.join(instance, relative),
      sha1: mod.sha1,
      size: mod.size
    })
  }

  for (const file of manifest.extraFiles) {
    const relative = file.path.replace(/\\/g, '/').replace(/^\/+/, '')
    if (relative.split('/').includes('..')) {
      throw new Error(`Небезопасный путь в манифесте: ${file.path}`)
    }
    const dest = path.join(instance, relative)
    // Файлы режима "once" нужны только при первой установке: дальше это
    // личные настройки игрока, и перезаписывать их каждый раз было бы хамством.
    if (file.mode === 'once' && (await exists(dest))) continue
    desired.set(relative, { url: file.url, dest, sha1: file.sha1, size: file.size })
  }

  const previous = (await readJson<ManagedState>(paths.managedFile(manifest.id))) ?? {
    packVersion: '',
    files: []
  }

  // Считаем, что действительно предстоит качать — иначе на «всё уже на месте»
  // мы бы показали пустую полосу прогресса и мигнули ей.
  const tasks = [...desired.values()]
  let toDownload = 0
  for (const task of tasks) if (!(await isSatisfied(task))) toDownload++

  if (toDownload > 0) {
    onProgress(0, `Обновляю моды: ${toDownload} ${plural(toDownload)}`)
    await downloadAll(tasks, (done, total) => {
      onProgress(total > 0 ? done / total : 1, `Обновляю моды: ${toDownload} ${plural(toDownload)}`)
    })
  }

  const removed: string[] = []
  for (const relative of previous.files) {
    if (desired.has(relative)) continue
    const target = path.join(instance, relative)
    if (await exists(target)) {
      await fs.rm(target, { force: true })
      removed.push(relative)
    }
  }

  await writeJson(paths.managedFile(manifest.id), {
    packVersion: manifest.packVersion,
    files: [...desired.keys()]
  } satisfies ManagedState)

  return { added: toDownload, removed }
}

function plural(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'файл'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'файла'
  return 'файлов'
}
