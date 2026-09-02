import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import extractZip from 'extract-zip'
import { APP } from '@shared/config'
import { downloadFile, fetchJson } from './core/http'
import { compareVersions } from './core/manifest'

interface GithubRelease {
  tag_name: string
  body: string
  draft: boolean
  prerelease: boolean
  assets: Array<{ name: string; browser_download_url: string; size: number }>
}

export interface UpdateInfo {
  version: string
  notes: string
  url: string
  fileName: string
  size: number
}

/**
 * Самообновление лаунчера.
 *
 * Штатный electron-updater на macOS требует приложения, подписанного
 * сертификатом Apple Developer: Squirrel.Mac проверяет подпись и без неё
 * молча отказывается ставить апдейт. Поэтому обновляемся сами — скачиваем
 * ассет релиза и подменяем бандл. Побочный плюс: файл, скачанный самим
 * приложением, не получает атрибут карантина, и Gatekeeper к нему не лезет.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  // Список, а не releases/latest: в том же репозитории живут релизы сборки
  // с модами (теги pack-*), и «последним» вполне может оказаться один из них.
  // Релизами лаунчера считаем только теги вида v1.2.3.
  const url = `https://api.github.com/repos/${APP.github.owner}/${APP.github.repo}/releases?per_page=30`
  const releases = await fetchJson<GithubRelease[]>(url)

  for (const release of releases) {
    if (release.draft || release.prerelease) continue
    if (!/^v\d/.test(release.tag_name)) continue

    const latest = release.tag_name.replace(/^v/, '')
    if (compareVersions(latest, app.getVersion()) <= 0) return null

    const asset = pickAsset(release.assets, latest)
    // Сборка под эту платформу могла не доехать (упал раннер) — тогда смотрим
    // на предыдущий релиз лаунчера, а не сдаёмся совсем.
    if (asset) {
      return {
        version: latest,
        notes: release.body ?? '',
        url: asset.browser_download_url,
        fileName: asset.name,
        size: asset.size
      }
    }
  }
  return null
}

function pickAsset(
  assets: GithubRelease['assets'],
  version: string
): GithubRelease['assets'][number] | undefined {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'win32') {
    return assets.find((a) => a.name.endsWith('.exe') && a.name.includes(version))
  }
  // На маке важно не перепутать сборки: Intel-бинарь на Apple Silicon
  // запустится через Rosetta и будет заметно тормозить.
  return (
    assets.find((a) => a.name.endsWith(`-mac-${arch}.zip`)) ??
    assets.find((a) => a.name.endsWith('-mac.zip'))
  )
}

export async function downloadAndApply(
  info: UpdateInfo,
  onProgress: (value: number | null) => void
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mine-launcher-update-'))
  const file = path.join(dir, info.fileName)

  await downloadFile({ url: info.url, dest: file, size: info.size }, onProgress)

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
