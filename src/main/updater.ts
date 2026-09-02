import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import extractZip from 'extract-zip'
import { APP } from '@shared/config'
import type { UpdateInfo } from '@shared/types'
import { downloadFile, fetchJson } from './core/http'
import { compareVersions } from './core/manifest'

/**
 * Описание последней версии, которое лежит на сервере рядом с файлами.
 * Генерируется командой `npm run launcher:publish`.
 */
interface LatestJson {
  version: string
  notes?: string
  files: Record<
    string,
    { url: string; size: number; sha256: string } | undefined
  >
}

/**
 * Самообновление лаунчера.
 *
 * Штатный electron-updater на macOS требует приложения, подписанного
 * сертификатом Apple Developer: Squirrel.Mac проверяет подпись и без неё
 * молча отказывается ставить апдейт. Поэтому обновляемся сами — скачиваем
 * файл с нашего же сервера и подменяем приложение. Побочный плюс: файл,
 * скачанный самим приложением, не получает атрибут карантина, и Gatekeeper
 * к нему не придирается.
 *
 * Раздача своя, а не GitHub, поэтому целостность проверяем сами: в latest.json
 * лежит SHA-256, и без совпадения обновление не ставится.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const latest = await fetchJson<LatestJson>(`${APP.updateUrl}?_=${Date.now().toString(36)}`)
  if (compareVersions(latest.version, app.getVersion()) <= 0) return null

  const key = platformKey()
  const file = latest.files?.[key]
  if (!file) return null

  return {
    version: latest.version,
    notes: latest.notes ?? '',
    url: file.url,
    fileName: path.basename(new URL(file.url).pathname),
    size: file.size,
    sha256: file.sha256
  }
}

/**
 * Ключ платформы в latest.json. Intel-сборку на Apple Silicon подсовывать
 * нельзя: она запустится через Rosetta и будет заметно тормозить.
 */
function platformKey(): string {
  if (process.platform === 'win32') return 'win-x64'
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  }
  return `${process.platform}-${process.arch}`
}

export async function downloadAndApply(
  info: UpdateInfo,
  onProgress: (value: number | null) => void
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mine-launcher-update-'))
  const file = path.join(dir, info.fileName)

  await downloadFile(
    { url: info.url, dest: file, size: info.size, sha256: info.sha256 },
    onProgress
  )

  if (process.platform === 'win32') {
    // Инсталлятор NSIS в тихом режиме сам перезапустит лаунчер.
    spawn(file, ['/S'], { detached: true, stdio: 'ignore' }).unref()
    app.quit()
    return
  }

  await applyMacUpdate(file, dir)
}

async function applyMacUpdate(zipFile: string, workDir: string): Promise<void> {
  const unpacked = path.join(workDir, 'unpacked')
  await extractZip(zipFile, { dir: unpacked })

  const entries = await fs.readdir(unpacked)
  const bundleName = entries.find((name) => name.endsWith('.app'))
  if (!bundleName) throw new Error('В архиве обновления не нашлось .app')

  // .../Mine Launcher.app/Contents/MacOS/Mine Launcher → поднимаемся к бандлу.
  const currentBundle = path.resolve(app.getPath('exe'), '..', '..', '..')
  if (!currentBundle.endsWith('.app')) {
    throw new Error('Лаунчер запущен не как приложение — обнови его вручную')
  }

  // Удалить работающий бандл на macOS можно: файлы живут, пока открыт процесс.
  await fs.rm(currentBundle, { recursive: true, force: true })
  await fs.rename(path.join(unpacked, bundleName), currentBundle)

  spawn('open', ['-n', currentBundle], { detached: true, stdio: 'ignore' }).unref()
  app.quit()
}
