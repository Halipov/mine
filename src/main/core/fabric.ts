import { fetchJson } from './http'
import type { VersionJson } from './version'

const META = 'https://meta.fabricmc.net/v2'

interface LoaderEntry {
  loader: { version: string; stable: boolean; build: number }
  intermediary: { version: string; stable: boolean }
}

interface GameEntry {
  version: string
  stable: boolean
}

/** Поддерживает ли Fabric эту версию Minecraft. */
export async function isGameSupported(mcVersion: string): Promise<boolean> {
  const games = await fetchJson<GameEntry[]>(`${META}/versions/game`)
  return games.some((g) => g.version === mcVersion)
}

/**
 * Разрешает "latest" в конкретную версию загрузчика.
 * Fabric отдаёт список от новых к старым, поэтому берём первый стабильный.
 */
export async function resolveLoaderVersion(
  mcVersion: string,
  requested: string
): Promise<string> {
  if (requested !== 'latest') return requested

  const entries = await fetchJson<LoaderEntry[]>(
    `${META}/versions/loader/${encodeURIComponent(mcVersion)}`
  )
  if (entries.length === 0) {
    throw new Error(
      `Fabric не поддерживает Minecraft ${mcVersion}. Выбери другую версию в манифесте сборки.`
    )
  }
  const stable = entries.find((e) => e.loader.stable)
  return (stable ?? entries[0]).loader.version
}

/**
 * Профиль Fabric — это готовый version.json с inheritsFrom на ванильную версию.
 * Именно поэтому Fabric на порядок проще Forge: никаких installer-процессоров,
 * достаточно склеить два JSON и скачать перечисленные в них библиотеки.
 */
export async function loadFabricProfile(
  mcVersion: string,
  loaderVersion: string
): Promise<VersionJson> {
  const url = `${META}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(
    loaderVersion
  )}/profile/json`
  return fetchJson<VersionJson>(url)
}
