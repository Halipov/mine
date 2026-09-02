import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

export interface DownloadTask {
  url: string
  dest: string
  sha1?: string
  /** Adoptium публикует для архивов JRE только SHA-256. */
  sha256?: string
  size?: number
  /** Проставить бит исполнения — нужно для бинарников JRE на macOS. */
  executable?: boolean
}

const RETRIES = 4
const CONCURRENCY = 8
const UA = 'MineLauncher'
/**
 * Данные приходят чанками по несколько килобайт, и слать наверх событие на
 * каждый — значит завалить IPC и перерисовку интерфейса. 60 мс между
 * обновлениями глазу неотличимы от непрерывных, а нагрузку убирают.
 */
const PROGRESS_INTERVAL_MS = 60

function throttle<T extends unknown[]>(fn: (...args: T) => void): (...args: T) => void {
  let last = 0
  return (...args: T) => {
    const now = Date.now()
    if (now - last < PROGRESS_INTERVAL_MS) return
    last = now
    fn(...args)
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function hashFile(
  file: string,
  algorithm: 'sha1' | 'sha256'
): Promise<string | null> {
  try {
    const hash = createHash(algorithm)
    const handle = await fs.open(file, 'r')
    try {
      await pipeline(handle.createReadStream({ autoClose: false }), hash)
    } finally {
      await handle.close()
    }
    return hash.digest('hex')
  } catch {
    return null
  }
}

export function sha1OfFile(file: string): Promise<string | null> {
  return hashFile(file, 'sha1')
}

/**
 * Файл считается готовым, если совпал SHA-1. Когда хеша нет (Fabric его для
 * части библиотек не публикует), довольствуемся совпадением размера.
 */
export async function isSatisfied(task: DownloadTask): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(task.dest)
  } catch {
    return false
  }
  if (!stat.isFile() || stat.size === 0) return false
  if (task.sha1) return (await hashFile(task.dest, 'sha1')) === task.sha1.toLowerCase()
  if (task.sha256) return (await hashFile(task.dest, 'sha256')) === task.sha256.toLowerCase()
  if (task.size) return stat.size === task.size
  return true
}

export async function fetchJson<T>(url: string, retries = RETRIES): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA } })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`)
      return (await res.json()) as T
    } catch (err) {
      lastError = err
      if (attempt < retries - 1) await delay(300 * 2 ** attempt)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function downloadOne(task: DownloadTask, onBytes: (n: number) => void): Promise<void> {
  await fs.mkdir(path.dirname(task.dest), { recursive: true })
  const tmp = `${task.dest}.part`
  let lastError: unknown

  for (let attempt = 0; attempt < RETRIES; attempt++) {
    let written = 0
    try {
      const res = await fetch(task.url, { headers: { 'user-agent': UA } })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} — ${task.url}`)

      const source = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>)
      source.on('data', (chunk: Buffer) => {
        written += chunk.length
        onBytes(chunk.length)
      })
      await pipeline(source, createWriteStream(tmp))

      for (const [algorithm, expected] of [
        ['sha1', task.sha1],
        ['sha256', task.sha256]
      ] as const) {
        if (!expected) continue
        const actual = await hashFile(tmp, algorithm)
        if (actual !== expected.toLowerCase()) {
          throw new Error(`Контрольная сумма не сошлась для ${path.basename(task.dest)}`)
        }
      }
      await fs.rm(task.dest, { force: true })
      await fs.rename(tmp, task.dest)
      if (task.executable) await fs.chmod(task.dest, 0o755).catch(() => {})
      return
    } catch (err) {
      lastError = err
      // Откатываем счётчик, иначе повтор задерёт полосу прогресса выше 100%.
      onBytes(-written)
      await fs.rm(tmp, { force: true }).catch(() => {})
      if (attempt < RETRIES - 1) await delay(400 * 2 ** attempt)
    }
  }
  throw new Error(`Не удалось скачать ${task.url}\n${String(lastError)}`)
}

/** Скачивает одиночный файл, отдавая прогресс долей 0..1. */
export async function downloadFile(
  task: DownloadTask,
  onProgress?: (value: number | null) => void
): Promise<void> {
  if (await isSatisfied(task)) {
    onProgress?.(1)
    return
  }
  let done = 0
  const emit = throttle(() =>
    onProgress?.(task.size ? Math.min(done / task.size, 1) : null)
  )
  await downloadOne(task, (n) => {
    done += n
    emit()
  })
  onProgress?.(1)
}

export interface DownloadReport {
  /** Сколько файлов реально качали — остальные уже лежали на диске. */
  downloaded: number
  skipped: number
}

/**
 * Качает пачку файлов в несколько потоков, пропуская уже готовые.
 * onProgress получает байты, а не число файлов: так полоса движется ровно.
 */
export async function downloadAll(
  tasks: DownloadTask[],
  onProgress: (bytesDone: number, bytesTotal: number) => void
): Promise<DownloadReport> {
  const pending: DownloadTask[] = []
  let skipped = 0
  for (const task of tasks) {
    if (await isSatisfied(task)) skipped++
    else pending.push(task)
  }

  // Размер известен не для всех файлов; для остальных берём грубую оценку,
  // иначе полоса в конце прыгала бы.
  const FALLBACK_SIZE = 512 * 1024
  const total = pending.reduce((sum, t) => sum + (t.size ?? FALLBACK_SIZE), 0)
  let done = 0
  onProgress(0, total)

  const emit = throttle(() => onProgress(Math.max(0, Math.min(done, total)), total))

  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      const task = pending[cursor++]
      await downloadOne(task, (n) => {
        done += n
        emit()
      })
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker())
  )
  onProgress(total, total)

  return { downloaded: pending.length, skipped }
}
