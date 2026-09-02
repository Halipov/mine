import { randomUUID } from 'node:crypto'
import type { Profile, Settings } from '@shared/types'
import { APP } from '@shared/config'
import { offlineUuid } from './core/launch'
import { memoryLimitsMb } from './core/platform'
import { paths, readJson, writeJson } from './core/paths'

/** Ник в Minecraft: латиница, цифры и подчёркивание, от 3 до 16 символов. */
export const NICKNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/

function defaults(): Settings {
  return {
    profiles: [],
    activeProfileId: null,
    ramMb: memoryLimitsMb().recommended,
    extraJvmArgs: '',
    keepLauncherOpen: false,
    manifestUrl: APP.manifestUrl
  }
}

let cache: Settings | null = null

export async function loadSettings(): Promise<Settings> {
  if (cache) return cache
  const stored = await readJson<Partial<Settings>>(paths.settingsFile())
  const merged: Settings = { ...defaults(), ...(stored ?? {}) }

  // Границы ползунка памяти зависят от машины, а settings.json мог приехать
  // с другого компьютера вместе с папкой профиля.
  const limits = memoryLimitsMb()
  merged.ramMb = Math.min(Math.max(merged.ramMb, limits.min), limits.max)
  merged.profiles = merged.profiles.filter((p) => NICKNAME_PATTERN.test(p.name))
  if (!merged.profiles.some((p) => p.id === merged.activeProfileId)) {
    merged.activeProfileId = merged.profiles[0]?.id ?? null
  }

  cache = merged
  return merged
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings()
  cache = { ...current, ...patch }
  await writeJson(paths.settingsFile(), cache)
  return cache
}

export function makeProfile(name: string): Profile {
  return { id: randomUUID(), name, uuid: offlineUuid(name) }
}

export async function activeProfile(): Promise<Profile | null> {
  const settings = await loadSettings()
  return settings.profiles.find((p) => p.id === settings.activeProfileId) ?? null
}
