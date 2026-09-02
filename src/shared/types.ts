import { z } from 'zod'

/**
 * Манифест сборки — единственный конфиг, который ты редактируешь, когда
 * меняешь версию Minecraft, состав модов или адрес сервера.
 * Лежит на GitHub, лаунчер тянет его при каждом старте.
 */
export const ModEntrySchema = z.object({
  /** Имя файла в папке mods. Если не задано — берётся из конца url. */
  name: z.string().optional(),
  /**
   * Идентификатор проекта на Modrinth. Нужен только инструменту сборки:
   * по нему видно, что мод обновился, а не был заменён другим — имя файла
   * для этого не годится, в нём меняется версия.
   */
  project: z.string().optional(),
  url: z.string().url(),
  /** SHA-1 файла. Обязателен: по нему решаем, качать заново или файл уже на месте. */
  sha1: z.string().length(40),
  size: z.number().int().positive().optional(),
  /** Человекочитаемое описание — показываем в списке модов. */
  title: z.string().optional()
})

export const ExtraFileSchema = z.object({
  /** Путь относительно папки игры, например "config/sodium-options.json". */
  path: z.string(),
  url: z.string().url(),
  sha1: z.string().length(40),
  size: z.number().int().positive().optional(),
  /**
   * overwrite — перезаписывать всегда (общие конфиги сборки).
   * once — положить, если файла нет, и больше не трогать (личные настройки игрока).
   */
  mode: z.enum(['overwrite', 'once']).default('overwrite')
})

export const PackManifestSchema = z.object({
  schema: z.literal(1),
  /** Идентификатор сборки. Определяет имя папки инстанса — менять нельзя. */
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'только строчные латинские буквы, цифры и дефис'),
  name: z.string(),
  /** Версия сборки. Достаточно поменять её, чтобы лаунчер пересинхронил файлы. */
  packVersion: z.string(),
  minecraft: z.string(),
  /** Версия загрузчика Fabric либо "latest" — тогда берём последний стабильный. */
  fabricLoader: z.string().default('latest'),
  /** Мажорная версия Java. Обычно не нужна: берём ту, что указал Mojang. */
  java: z.number().int().optional(),
  /** Сервер, который лаунчер сам добавит в список сетевой игры. */
  server: z
    .object({
      name: z.string(),
      host: z.string(),
      port: z.number().int().default(25565)
    })
    .optional(),
  mods: z.array(ModEntrySchema).default([]),
  extraFiles: z.array(ExtraFileSchema).default([]),
  /** Рекомендуемая память в МБ — значение по умолчанию для новых игроков. */
  recommendedRamMb: z.number().int().default(4096),
  /** Если у игрока лаунчер старее — попросим обновиться перед запуском. */
  minLauncherVersion: z.string().optional()
})

export type ModEntry = z.infer<typeof ModEntrySchema>
export type ExtraFile = z.infer<typeof ExtraFileSchema>
export type PackManifest = z.infer<typeof PackManifestSchema>

/** Профиль игрока. Оффлайн-режим: ник плюс детерминированный UUID. */
export interface Profile {
  id: string
  name: string
  uuid: string
}

export interface Settings {
  profiles: Profile[]
  activeProfileId: string | null
  ramMb: number
  /** Дополнительные аргументы JVM, по одному на строку. Для тех, кто знает зачем. */
  extraJvmArgs: string
  keepLauncherOpen: boolean
  /** Куда лаунчер ходит за манифестом сборки. */
  manifestUrl: string
}

/** Этапы подготовки, которые видит игрок. */
export type Stage =
  | 'idle'
  | 'manifest'
  | 'java'
  | 'vanilla'
  | 'fabric'
  | 'assets'
  | 'mods'
  | 'files'
  | 'launching'
  | 'running'
  | 'error'

export interface Progress {
  stage: Stage
  /** Что происходит прямо сейчас — короткой строкой. */
  label: string
  /** 0..1, либо null для неопределённого прогресса. */
  value: number | null
  bytesDone?: number
  bytesTotal?: number
}

export interface MemoryLimits {
  min: number
  max: number
  recommended: number
}

/** Всё, что интерфейсу нужно знать при старте, одним запросом. */
export interface BootState {
  settings: Settings
  manifest: PackManifest | null
  /** Непустая строка, если манифест не удалось получить или он с ошибкой. */
  manifestError: string | null
  memory: MemoryLimits
  appVersion: string
  platform: string
  log: string[]
}

export interface UpdateInfo {
  version: string
  notes: string
  url: string
  fileName: string
  size: number
}
