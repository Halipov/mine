import { useState } from 'react'
import type { PackManifest, Profile, Progress, Settings } from '@shared/types'
import { formatBytes, formatRam } from '../format'

interface Props {
  manifest: PackManifest | null
  manifestError: string | null
  settings: Settings
  profile: Profile | null
  progress: Progress
  busy: boolean
  logVisible: boolean
  onLaunch: (directJoin: boolean) => void
  onRefresh: () => void
  onKill: () => void
  onOpenFolder: () => void
  onToggleLog: () => void
}

export function Play(props: Props): JSX.Element {
  const { manifest, manifestError, settings, profile, progress, busy } = props
  const [directJoin, setDirectJoin] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const running = progress.stage === 'running'
  const failed = progress.stage === 'error'
  const address = manifest?.server
    ? manifest.server.port === 25565
      ? manifest.server.host
      : `${manifest.server.host}:${manifest.server.port}`
    : null

  const canPlay = Boolean(manifest && profile) && !busy

  return (
    <div className="panel">
      <section className="hero">
        <div className="hero__head">
          <h1>{manifest?.name ?? 'Сборка недоступна'}</h1>
          {manifest && (
            <span className="hero__packversion">сборка {manifest.packVersion}</span>
          )}
        </div>

        {manifest && (
          <div className="chips">
            <span className="chip">Minecraft {manifest.minecraft}</span>
            <span className="chip">
              Fabric {manifest.fabricLoader === 'latest' ? '(последний)' : manifest.fabricLoader}
            </span>
            <span className="chip">
              {manifest.mods.filter((mod) => mod.side !== 'server').length} модов
            </span>
            <span className="chip">{formatRam(settings.ramMb)} памяти</span>
          </div>
        )}

        {address && (
          <div className="server">
            <span className="server__dot" />
            <span className="server__name">{manifest?.server?.name}</span>
            <code className="server__address">{address}</code>
            <span className="server__hint">уже добавлен в список серверов</span>
          </div>
        )}
      </section>

      {manifestError && <div className="alert alert--warn">{manifestError}</div>}
      {!profile && (
        <div className="alert alert--warn">
          Придумай себе ник во вкладке «Настройки» — без него игра не запустится.
        </div>
      )}
      {failed && <div className="alert alert--error">{progress.label}</div>}

      <section className="launch">
        <div className="launch__row">
          <button
            type="button"
            className="btn btn--play"
            disabled={!canPlay}
            onClick={() => props.onLaunch(directJoin)}
          >
            {running ? 'Игра запущена' : busy ? 'Готовлю…' : 'Играть'}
          </button>

          {running ? (
            <button type="button" className="btn btn--ghost" onClick={props.onKill}>
              Остановить
            </button>
          ) : (
            <label className="check">
              <input
                type="checkbox"
                checked={directJoin}
                disabled={!address}
                onChange={(e) => setDirectJoin(e.target.checked)}
              />
              Подключиться к серверу сразу
            </label>
          )}
        </div>

        {(busy || running) && (
          <div className="progress">
            <div className="progress__label">
              <span>{progress.label}</span>
              {progress.bytesTotal ? (
                <span className="progress__bytes">
                  {formatBytes(progress.bytesDone ?? 0)} / {formatBytes(progress.bytesTotal)}
                </span>
              ) : null}
            </div>
            <div className={`bar ${progress.value === null ? 'bar--indeterminate' : ''}`}>
              <div
                className="bar__fill"
                style={progress.value === null ? undefined : { width: `${progress.value * 100}%` }}
              />
            </div>
          </div>
        )}

        <div className="launch__links">
          <button
            type="button"
            className="link"
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true)
              props.onRefresh()
              setTimeout(() => setRefreshing(false), 600)
            }}
          >
            {refreshing ? 'проверяю…' : 'проверить обновления сборки'}
          </button>
          <button type="button" className="link" onClick={props.onOpenFolder}>
            открыть папку игры
          </button>
          <button type="button" className="link" onClick={props.onToggleLog}>
            {props.logVisible ? 'скрыть лог' : 'показать лог'}
          </button>
        </div>
      </section>
    </div>
  )
}
