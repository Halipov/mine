import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Блокнот и PowerShell охотно сохраняют JSON с меткой порядка байтов,
 * на которой JSON.parse спотыкается с совершенно невнятной ошибкой.
 */
export async function readJsonFile(file) {
  const text = await fs.readFile(file, 'utf8')
  return JSON.parse(text.replace(/^﻿/, ''))
}

export async function writeJsonFile(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

export async function hashFile(file, algorithm = 'sha1') {
  return createHash(algorithm)
    .update(await fs.readFile(file))
    .digest('hex')
}

export async function walk(dir) {
  const out = []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

export async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/** GitHub и прочие хостинги переименовывают файлы с необычными символами. */
export const safeName = (name) => name.replace(/[^A-Za-z0-9._-]/g, '.')

/**
 * Оффлайн-UUID игрока: UUID третьей версии от строки "OfflinePlayer:<ник>".
 * Ровно так его считает и сам Minecraft, поэтому whitelist и ops,
 * составленные этой функцией, сервер понимает без оговорок.
 */
export function offlineUuid(name) {
  const md5 = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest()
  md5[6] = (md5[6] & 0x0f) | 0x30
  md5[8] = (md5[8] & 0x3f) | 0x80
  const hex = md5.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-')
}

export function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}

/** Скачивает файл, если его ещё нет или он не той длины. */
export async function download(url, dest, { label } = {}) {
  const existing = await fs.stat(dest).catch(() => null)
  if (existing?.isFile() && existing.size > 0) return false

  if (label) console.log(`  скачиваю ${label}`)
  const res = await fetch(url, { headers: { 'user-agent': 'mine-launcher/tools' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} при загрузке ${url}`)

  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()))
  return true
}
