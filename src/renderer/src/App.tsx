import { useCallback, useEffect, useRef, useState } from 'react'
import type { BootState, PackManifest, Progress, Settings } from '@shared/types'
import { Play } from './panels/Play'
import { Mods } from './panels/Mods'
import { SettingsPanel } from './panels/Settings'
import { About } from './panels/About'
import { LogView } from './components/LogView'

type Tab = 'play' | 'mods' | 'settings' | 'about'

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'play', label: 'Играть', icon: '▶' },
  { id: 'mods', label: 'Моды', icon: '◆' },
  { id: 'settings', label: 'Настройки', icon: '⚙' },
  { id: 'about', label: 'О лаунчере', icon: 'i' }
]

const IDLE: Progress = { stage: 'idle', label: 'Готово к запуску', value: null }

export function App(): JSX.Element {
  const [boot, setBoot] = useState<BootState | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [manifest, setManifest] = useState<PackManifest | null>(null)
  const [manifestError, setManifestError] = useState<string | null>(null)
  const [progress, setProgress] = useState<Progress>(IDLE)
  const [log, setLog] = useState<string[]>([])
  const [tab, setTab] = useState<Tab>('play')
  const [showLog, setShowLog] = useState(false)
  const [busy, setBusy] = useState(false)

  // Лог может приходить пачками по несколько сотен строк в секунду,
  // поэтому копим их и отдаём в состояние раз в кадр.
  const pendingLog = useRef<string[]>([])

  useEffect(() => {
    void window.launcher.boot().then((state) => {
      setBoot(state)
      setSettings(state.settings)
      setManifest(state.manifest)
      setManifestError(state.manifestError)
      setLog(state.log)
    })

    const offProgress = window.launcher.onProgress((next) => {
      setProgress(next)
      if (next.stage === 'error' || next.stage === 'running' || next.stage === 'idle') {
        setBusy(next.stage === 'running')
      }
      if (next.stage === 'error') setShowLog(true)
    })

    let frame = 0
    const offLog = window.launcher.onLog((line) => {
      pendingLog.current.push(line)
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const batch = pendingLog.current
        pendingLog.current = []
        setLog((prev) => [...prev, ...batch].slice(-400))
      })
    })

    return () => {
      offProgress()
      offLog()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  const patchSettings = useCallback(async (patch: Partial<Settings>) => {
    setSettings(await window.launcher.saveSettings(patch))
  }, [])

  const refresh = useCallback(async () => {
    const result = await window.launcher.refreshManifest()
    setManifest(result.manifest)
    setManifestError(result.error)
  }, [])

  const launch = useCallback(async (directJoin: boolean) => {
    setBusy(true)
    setProgress({ stage: 'manifest', label: 'Готовлю запуск', value: null })
    try {
      await window.launcher.launch(directJoin)
    } catch (err) {
      setBusy(false)
      setShowLog(true)
      setProgress({
        stage: 'error',
        label: err instanceof Error ? err.message : String(err),
        value: null
      })
    }
  }, [])

  if (!boot || !settings) {
    return (
      <div className="app app--loading">
        <div className="spinner" />
      </div>
    )
  }

  const activeProfile = settings.profiles.find((p) => p.id === settings.activeProfileId) ?? null

  return (
    <div className="app">
      <header className="titlebar">
        <span className="titlebar__title">{manifest?.name ?? 'Mine Launcher'}</span>
      </header>

      <div className="body">
        <nav className="sidebar">
          <div className="sidebar__brand">
            <div className="sidebar__cube" />
            <div>
              <div className="sidebar__name">{manifest?.name ?? 'Сборка'}</div>
              <div className="sidebar__version">
                {manifest ? `${manifest.minecraft} · Fabric` : 'нет связи'}
              </div>
            </div>
          </div>

          <ul className="tabs">
            {TABS.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`tab ${tab === item.id ? 'tab--active' : ''}`}
                  onClick={() => setTab(item.id)}
                >
                  <span className="tab__icon">{item.icon}</span>
                  {item.label}
                </button>
              </li>
            ))}
          </ul>

          <div className="sidebar__footer">
            <div className="sidebar__player">
              <div className="avatar">{(activeProfile?.name ?? '?').slice(0, 1).toUpperCase()}</div>
              <div className="sidebar__playername">
                {activeProfile?.name ?? 'Профиль не выбран'}
              </div>
            </div>
            <button type="button" className="link" onClick={() => setTab('settings')}>
              сменить
            </button>
          </div>
        </nav>

        <main className="content">
          {tab === 'play' && (
            <Play
              manifest={manifest}
              manifestError={manifestError}
              settings={settings}
              profile={activeProfile}
              progress={progress}
              busy={busy}
              onLaunch={launch}
              onRefresh={refresh}
              onKill={() => void window.launcher.kill()}
              onOpenFolder={() => void window.launcher.openFolder()}
              onToggleLog={() => setShowLog((v) => !v)}
              logVisible={showLog}
            />
          )}
          {tab === 'mods' && <Mods manifest={manifest} />}
          {tab === 'settings' && (
            <SettingsPanel
              settings={settings}
              memory={boot.memory}
              onPatch={patchSettings}
              onProfilesChanged={setSettings}
            />
          )}
          {tab === 'about' && <About appVersion={boot.appVersion} platform={boot.platform} />}

          {showLog && <LogView lines={log} onClose={() => setShowLog(false)} />}
        </main>
      </div>
    </div>
  )
}
