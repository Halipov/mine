import { useState } from 'react'
import type { UpdateInfo } from '@shared/types'
import { formatBytes } from '../format'

export function About({
  appVersion,
  platform
}: {
  appVersion: string
  platform: string
}): JSX.Element {
  const [state, setState] = useState<'idle' | 'checking' | 'found' | 'fresh' | 'error'>('idle')
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const check = async (): Promise<void> => {
    setState('checking')
    setMessage(null)
    try {
      const found = await window.launcher.checkUpdate()
      setUpdate(found)
      setState(found ? 'found' : 'fresh')
    } catch (err) {
      setState('error')
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const apply = async (): Promise<void> => {
    if (!update) return
    try {
      await window.launcher.applyUpdate(update)
    } catch (err) {
      setState('error')
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="panel">
      <h2>О лаунчере</h2>
      <dl className="facts">
        <div>
          <dt>Версия</dt>
          <dd>{appVersion}</dd>
        </div>
        <div>
          <dt>Платформа</dt>
          <dd>{platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform}</dd>
        </div>
      </dl>

      <p className="muted">
        Состав модов и версия игры обновляются сами при каждом запуске — для этого
        обновлять лаунчер не нужно. Кнопка ниже нужна, только когда меняется он сам.
      </p>

      <div className="row">
        <button type="button" className="btn" onClick={() => void check()} disabled={state === 'checking'}>
          {state === 'checking' ? 'Проверяю…' : 'Проверить обновления'}
        </button>
        {state === 'found' && update && (
          <button type="button" className="btn btn--play btn--sm" onClick={() => void apply()}>
            Обновить до {update.version} ({formatBytes(update.size)})
          </button>
        )}
      </div>

      {state === 'fresh' && <div className="alert alert--ok">Установлена последняя версия.</div>}
      {state === 'error' && <div className="alert alert--error">{message}</div>}
      {state === 'found' && update?.notes && (
        <pre className="notes">{update.notes}</pre>
      )}
    </div>
  )
}
