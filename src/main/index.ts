import type { ChildProcess } from 'node:child_process'
import path from 'node:path'
import { BrowserWindow, app, ipcMain, shell } from 'electron'
import type { PackManifest, Profile, Progress, Settings } from '@shared/types'
import { APP } from '@shared/config'
import { prepareAndLaunch } from './core/installer'
import { cacheManifest, compareVersions, fetchManifest, loadCachedManifest } from './core/manifest'
import { paths } from './core/paths'
import { memoryLimitsMb } from './core/platform'
import {
  NICKNAME_PATTERN,
  activeProfile,
  loadSettings,
  makeProfile,
  saveSettings
} from './settings'
import { checkForUpdate, downloadAndApply, type UpdateInfo } from './updater'

app.setName(APP.name)

let window: BrowserWindow | null = null
let game: ChildProcess | null = null
let manifest: PackManifest | null = null
const log: string[] = []
const LOG_LIMIT = 400

function send(channel: string, payload?: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
}

function pushLog(line: string): void {
  for (const part of line.split(/\r?\n/)) {
    const trimmed = part.trimEnd()
    if (!trimmed) continue
    log.push(trimmed)
    if (log.length > LOG_LIMIT) log.shift()
    send('log', trimmed)
  }
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1020,
    height: 660,
    minWidth: 900,
    minHeight: 580,
    show: false,
    backgroundColor: '#0e1014',
    title: APP.name,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay:
      process.platform === 'win32'
        ? { color: '#12151b', symbolColor: '#98a2b3', height: 40 }
        : undefined,
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.once('ready-to-show', () => window?.show())

  // Внешние ссылки (страница релиза, страница мода) — в системном браузере.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// --- IPC --------------------------------------------------------------------

interface BootState {
  settings: Settings
  manifest: PackManifest | null
  manifestError: string | null
  memory: ReturnType<typeof memoryLimitsMb>
  appVersion: string
  platform: NodeJS.Platform
  log: string[]
}

async function refreshManifest(): Promise<{ manifest: PackManifest | null; error: string | null }> {
  const settings = await loadSettings()
  try {
    manifest = await fetchManifest(settings.manifestUrl)
    await cacheManifest(manifest)
    return { manifest, error: null }
  } catch (err) {
    // Без сети играем по последнему известному составу сборки.
    const cached = await loadCachedManifest()
    manifest = cached
    return {
      manifest: cached,
      error: cached
        ? `Не удалось проверить обновления сборки (${describe(err)}). Играем по сохранённой версии.`
        : describe(err)
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function registerIpc(): void {
  ipcMain.handle('boot', async (): Promise<BootState> => {
    const settings = await loadSettings()
    const refreshed = await refreshManifest()
    return {
      settings,
      manifest: refreshed.manifest,
      manifestError: refreshed.error,
      memory: memoryLimitsMb(),
      appVersion: app.getVersion(),
      platform: process.platform,
      log: [...log]
    }
  })

  ipcMain.handle('manifest:refresh', async () => refreshManifest())

  ipcMain.handle('settings:save', async (_e, patch: Partial<Settings>) => saveSettings(patch))

  ipcMain.handle('profile:add', async (_e, name: string): Promise<Settings> => {
    const clean = name.trim()
    if (!NICKNAME_PATTERN.test(clean)) {
      throw new Error('Ник: 3–16 символов, латинские буквы, цифры и подчёркивание')
    }
    const settings = await loadSettings()
    if (settings.profiles.some((p) => p.name.toLowerCase() === clean.toLowerCase())) {
      throw new Error(`Профиль «${clean}» уже есть`)
    }
    const profile = makeProfile(clean)
    return saveSettings({
      profiles: [...settings.profiles, profile],
      activeProfileId: profile.id
    })
  })

  ipcMain.handle('profile:remove', async (_e, id: string): Promise<Settings> => {
    const settings = await loadSettings()
    const profiles = settings.profiles.filter((p) => p.id !== id)
    return saveSettings({
      profiles,
      activeProfileId: settings.activeProfileId === id ? (profiles[0]?.id ?? null) : settings.activeProfileId
    })
  })

  ipcMain.handle('profile:select', async (_e, id: string) => saveSettings({ activeProfileId: id }))

  ipcMain.handle('game:launch', async (_e, options: { directJoin: boolean }) => {
    if (game) throw new Error('Игра уже запущена')

    const settings = await loadSettings()
    const profile: Profile | null = await activeProfile()
    if (!profile) throw new Error('Сначала создай профиль с ником')
    if (!manifest) {
      const refreshed = await refreshManifest()
      if (!refreshed.manifest) throw new Error(refreshed.error ?? 'Манифест сборки недоступен')
    }
    const pack = manifest as PackManifest

    if (pack.minLauncherVersion && compareVersions(app.getVersion(), pack.minLauncherVersion) < 0) {
      throw new Error(
        `Сборка требует лаунчер версии ${pack.minLauncherVersion} или новее. Обнови лаунчер во вкладке «О лаунчере».`
      )
    }

    const report = (progress: Progress): void => send('progress', progress)

    try {
      game = await prepareAndLaunch({
        manifest: pack,
        settings,
        profile,
        launcherName: APP.name,
        launcherVersion: app.getVersion(),
        directJoin: options.directJoin,
        report,
        onLog: pushLog
      })
    } catch (err) {
      game = null
      report({ stage: 'error', label: describe(err), value: null })
      throw err
    }

    attachGameHandlers(settings)
    report({ stage: 'running', label: 'Minecraft запущен', value: 1 })
  })

  ipcMain.handle('game:kill', async () => {
    game?.kill()
  })

  ipcMain.handle('folder:open', async () => {
    if (!manifest) return
    await shell.openPath(paths.instance(manifest.id))
  })

  ipcMain.handle('update:check', async (): Promise<UpdateInfo | null> => checkForUpdate())

  ipcMain.handle('update:apply', async (_e, info: UpdateInfo) => {
    await downloadAndApply(info, (value) =>
      send('progress', { stage: 'launching', label: 'Обновляю лаунчер', value })
    )
  })
}

function attachGameHandlers(settings: Settings): void {
  const child = game
  if (!child) return

  child.stdout?.on('data', (chunk: Buffer) => pushLog(chunk.toString('utf8')))
  child.stderr?.on('data', (chunk: Buffer) => pushLog(chunk.toString('utf8')))

  // Прячем лаунчер не сразу: если игра падает на старте, окно должно остаться
  // на экране вместе с логом, иначе диагностировать будет нечем.
  const hideTimer = setTimeout(() => {
    if (game && !settings.keepLauncherOpen) window?.hide()
  }, 15_000)

  child.on('error', (err) => {
    pushLog(`Не удалось запустить процесс игры: ${err.message}`)
  })

  child.on('exit', (code) => {
    clearTimeout(hideTimer)
    game = null
    const wasHidden = window ? !window.isVisible() : false

    if (code !== 0 && code !== null) {
      window?.show()
      send('progress', {
        stage: 'error',
        label: `Minecraft завершился с кодом ${code}. Смотри лог ниже.`,
        value: null
      })
      return
    }

    if (wasHidden) {
      app.quit()
      return
    }
    send('progress', { stage: 'idle', label: 'Готово к запуску', value: null })
  })
}

// --- Жизненный цикл ---------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (window) {
      window.show()
      window.focus()
    }
  })

  void app.whenReady().then(async () => {
    // Диагностический режим: прогоняем всю установку и выходим, окно не нужно.
    if (process.argv.includes('--selftest')) {
      const { runSelfTest } = await import('./selftest')
      let code = 1
      try {
        code = await runSelfTest()
      } catch (err) {
        console.error(`\nСамопроверка упала: ${describe(err)}`)
      }
      app.exit(code)
      return
    }

    registerIpc()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else window?.show()
    })
  })

  app.on('window-all-closed', () => {
    // Игра запущена отдельным процессом и живёт своей жизнью,
    // но сам лаунчер на macOS принято оставлять в доке.
    if (process.platform !== 'darwin' || !game) app.quit()
  })
}
