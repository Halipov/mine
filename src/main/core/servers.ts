import fs from 'node:fs/promises'
import path from 'node:path'
import * as nbt from 'prismarine-nbt'
import { ensureDir, paths } from './paths'

export interface ServerEntry {
  name: string
  host: string
  port: number
}

/** Minecraft опускает порт в адресе, если он стандартный. */
export function serverAddress(server: ServerEntry): string {
  return server.port === 25565 ? server.host : `${server.host}:${server.port}`
}

type TagCompound = Record<string, nbt.Tags[keyof nbt.Tags]>

/**
 * Прописывает наш сервер первым в списке сетевой игры.
 *
 * servers.dat нельзя просто перезаписать: игрок мог добавить туда свои
 * серверы, и стереть их — верный способ получить вопрос «а где мой сервер?».
 * Поэтому читаем существующий файл, выкидываем только запись с нашим адресом
 * (чтобы обновить название) и возвращаем её наверх списка.
 */
export async function ensureServerInList(packId: string, server: ServerEntry): Promise<void> {
  const file = path.join(paths.instance(packId), 'servers.dat')
  const address = serverAddress(server)

  const existing = await readServers(file)
  const others = existing.filter((entry) => {
    const ip = entry.ip
    return !(ip && ip.type === 'string' && String(ip.value).toLowerCase() === address.toLowerCase())
  })

  const ours: TagCompound = {
    name: nbt.string(server.name),
    ip: nbt.string(address),
    acceptTextures: nbt.byte(1)
  }

  const value = nbt.comp({
    servers: nbt.list(nbt.comp([ours, ...others] as never))
  })

  await ensureDir(path.dirname(file))
  await fs.writeFile(file, nbt.writeUncompressed(value as never, 'big'))
}

async function readServers(file: string): Promise<TagCompound[]> {
  let buffer: Buffer
  try {
    buffer = await fs.readFile(file)
  } catch {
    return []
  }
  try {
    const { parsed } = await nbt.parse(buffer)
    const servers = (parsed.value as TagCompound).servers
    if (!servers || servers.type !== 'list') return []
    const inner = servers.value as { type: string; value: unknown }
    if (inner.type !== 'compound' || !Array.isArray(inner.value)) return []
    return inner.value as TagCompound[]
  } catch {
    // Битый servers.dat — не повод не дать поиграть. Начнём список заново.
    return []
  }
}
