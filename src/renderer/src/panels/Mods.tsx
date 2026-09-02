import type { PackManifest } from '@shared/types'
import { formatBytes } from '../format'

function fileName(url: string, explicit?: string): string {
  if (explicit) return explicit
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? url)
  } catch {
    return url
  }
}

export function Mods({ manifest }: { manifest: PackManifest | null }): JSX.Element {
  if (!manifest) {
    return <div className="panel"><p className="muted">Список модов появится, когда лаунчер получит манифест сборки.</p></div>
  }

  // Манифест общий с сервером, но чисто серверные моды игроку не ставятся —
  // показывать их в списке значило бы вводить в заблуждение.
  const clientMods = manifest.mods.filter((mod) => mod.side !== 'server')

  return (
    <div className="panel">
      <h2>Моды сборки</h2>
      <p className="muted">
        Лаунчер держит эту папку в актуальном состоянии сам. Свои моды можно
        докидывать рядом — они не пропадут при обновлении.
      </p>

      <ul className="modlist">
        {clientMods.map((mod) => (
          <li key={mod.sha1} className="modlist__item">
            <div className="modlist__name">{mod.title ?? fileName(mod.url, mod.name)}</div>
            <div className="modlist__meta">
              <span>{fileName(mod.url, mod.name)}</span>
              {mod.size ? <span>{formatBytes(mod.size)}</span> : null}
            </div>
          </li>
        ))}
      </ul>

      {manifest.extraFiles.length > 0 && (
        <>
          <h2>Дополнительные файлы</h2>
          <ul className="modlist">
            {manifest.extraFiles.map((file) => (
              <li key={file.path} className="modlist__item">
                <div className="modlist__name">{file.path}</div>
                <div className="modlist__meta">
                  <span>
                    {file.mode === 'once'
                      ? 'ставится один раз, потом не трогаем'
                      : 'обновляется вместе со сборкой'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
