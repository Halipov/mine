import { useState } from 'react'
import type { MemoryLimits, Settings } from '@shared/types'
import { formatRam } from '../format'

interface Props {
  settings: Settings
  memory: MemoryLimits
  defaultManifestUrl: string
  onPatch: (patch: Partial<Settings>) => Promise<void>
  onProfilesChanged: (settings: Settings) => void
}

export function SettingsPanel({
  settings,
  memory,
  defaultManifestUrl,
  onPatch,
  onProfilesChanged
}: Props): JSX.Element {
  const [nickname, setNickname] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [ram, setRam] = useState(settings.ramMb)
  const [manifestUrl, setManifestUrl] = useState(settings.manifestUrlOverride ?? '')
  const [jvmArgs, setJvmArgs] = useState(settings.extraJvmArgs)

  const addProfile = async (): Promise<void> => {
    setError(null)
    try {
      onProfilesChanged(await window.launcher.addProfile(nickname))
      setNickname('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="panel">
      <h2>Профили</h2>
      <p className="muted">
        Вход без аккаунта Mojang: ник и есть весь профиль. Он же определяет,
        какого игрока увидит сервер, — сменишь ник, начнёшь с новым инвентарём.
      </p>

      <ul className="profiles">
        {settings.profiles.map((profile) => (
          <li
            key={profile.id}
            className={`profiles__item ${
              profile.id === settings.activeProfileId ? 'profiles__item--active' : ''
            }`}
          >
            <button
              type="button"
              className="profiles__pick"
              onClick={async () => onProfilesChanged(await window.launcher.selectProfile(profile.id))}
            >
              <span className="avatar avatar--sm">{profile.name.slice(0, 1).toUpperCase()}</span>
              <span>{profile.name}</span>
            </button>
            <button
              type="button"
              className="link link--danger"
              onClick={async () => onProfilesChanged(await window.launcher.removeProfile(profile.id))}
            >
              удалить
            </button>
          </li>
        ))}
      </ul>

      <div className="row">
        <input
          className="input"
          placeholder="Новый ник"
          value={nickname}
          maxLength={16}
          onChange={(e) => setNickname(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addProfile()
          }}
        />
        <button type="button" className="btn" onClick={() => void addProfile()}>
          Добавить
        </button>
      </div>
      {error && <div className="alert alert--error">{error}</div>}

      <h2>Память</h2>
      <p className="muted">
        Сколько оперативной памяти отдать игре. Больше — не всегда лучше:
        системе тоже надо чем-то дышать, поэтому ползунок не пускает дальше
        {' '}{formatRam(memory.max)}.
      </p>
      <div className="row row--slider">
        <input
          type="range"
          min={memory.min}
          max={memory.max}
          step={512}
          value={ram}
          onChange={(e) => setRam(Number(e.target.value))}
          onMouseUp={() => void onPatch({ ramMb: ram })}
          onTouchEnd={() => void onPatch({ ramMb: ram })}
          onKeyUp={() => void onPatch({ ramMb: ram })}
        />
        <span className="slider__value">{formatRam(ram)}</span>
      </div>

      <h2>Поведение</h2>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.keepLauncherOpen}
          onChange={(e) => void onPatch({ keepLauncherOpen: e.target.checked })}
        />
        Не прятать лаунчер после запуска игры
      </label>

      <h2>Для продвинутых</h2>
      <label className="field">
        <span>
          Адрес манифеста сборки. Пусто — как в лаунчере ({defaultManifestUrl})
        </span>
        <input
          className="input"
          value={manifestUrl}
          placeholder={defaultManifestUrl}
          onChange={(e) => setManifestUrl(e.target.value)}
          onBlur={() => void onPatch({ manifestUrlOverride: manifestUrl.trim() || null })}
          spellCheck={false}
        />
      </label>
      <label className="field">
        <span>Дополнительные аргументы JVM, по одному в строке</span>
        <textarea
          className="input input--area"
          rows={3}
          value={jvmArgs}
          onChange={(e) => setJvmArgs(e.target.value)}
          onBlur={() => void onPatch({ extraJvmArgs: jvmArgs })}
          spellCheck={false}
        />
      </label>
    </div>
  )
}
