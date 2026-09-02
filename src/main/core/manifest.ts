import { PackManifestSchema, type PackManifest } from '@shared/types'
import { paths, readJson, writeJson } from './paths'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Тянет манифест сборки. Raw-ссылки GitHub кешируются на несколько минут,
 * поэтому добиваем запрос меткой времени и просим не брать из кеша —
 * иначе друзья будут получать вчерашний состав модов.
 *
 * Вместо ссылки можно указать путь к локальному файлу: удобно обкатать
 * новую сборку до того, как она уедет к друзьям.
 */
export async function fetchManifest(source: string): Promise<PackManifest> {
  const raw: unknown = /^https?:\/\//i.test(source)
    ? await fetchRemote(source)
    : JSON.parse(await fs.readFile(source, 'utf8'))

  const parsed = PackManifestSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '<корень>'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Манифест сборки заполнен неверно:\n${issues}`)
  }
  return parsed.data
}

async function fetchRemote(url: string): Promise<unknown> {
  const bust = new URL(url)
  bust.searchParams.set('_', Date.now().toString(36))

  const res = await fetch(bust, {
    headers: { 'user-agent': 'MineLauncher', 'cache-control': 'no-cache', pragma: 'no-cache' }
  })
  if (!res.ok) throw new Error(`Манифест сборки недоступен: HTTP ${res.status} по адресу ${url}`)
  return res.json()
}

const cacheFile = (): string => path.join(paths.root(), 'last-manifest.json')

/** Последний удачно полученный манифест — чтобы играть можно было и без сети. */
export async function cacheManifest(manifest: PackManifest): Promise<void> {
  await writeJson(cacheFile(), manifest)
}

export async function loadCachedManifest(): Promise<PackManifest | null> {
  const raw = await readJson<unknown>(cacheFile())
  if (!raw) return null
  const parsed = PackManifestSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** Сравнение версий вида 1.2.3. Возвращает -1, 0 или 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return Math.sign(diff)
  }
  return 0
}
