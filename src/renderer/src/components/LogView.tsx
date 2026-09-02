import { useEffect, useRef } from 'react'

/**
 * Лог игры. Автопрокрутка отключается, если игрок сам отмотал вверх —
 * иначе прочитать стектрейс во время потока сообщений невозможно.
 */
export function LogView({ lines, onClose }: { lines: string[]; onClose: () => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    const node = ref.current
    if (node && stick.current) node.scrollTop = node.scrollHeight
  }, [lines])

  return (
    <div className="logview">
      <div className="logview__head">
        <span>Лог</span>
        <div className="logview__actions">
          <button
            type="button"
            className="link"
            onClick={() => void navigator.clipboard.writeText(lines.join('\n'))}
          >
            скопировать
          </button>
          <button type="button" className="link" onClick={onClose}>
            закрыть
          </button>
        </div>
      </div>
      <div
        className="logview__body"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {lines.length === 0 ? (
          <div className="muted">Пока пусто.</div>
        ) : (
          lines.map((line, index) => (
            <div key={index} className={logClass(line)}>
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function logClass(line: string): string {
  if (/\b(ERROR|FATAL|Exception|Caused by)\b/.test(line)) return 'logview__line logview__line--error'
  if (/\bWARN\b/.test(line)) return 'logview__line logview__line--warn'
  return 'logview__line'
}
