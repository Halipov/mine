import path from 'node:path'
import { mavenToPath, mojangArch, mojangOs } from './platform'
import { paths } from './paths'
import type { DownloadTask } from './http'

// --- Формат version.json от Mojang ------------------------------------------

export interface Rule {
  action: 'allow' | 'disallow'
  os?: { name?: string; arch?: string; version?: string }
  features?: Record<string, boolean>
}

export interface Artifact {
  path?: string
  url: string
  sha1?: string
  size?: number
}

export interface Library {
  name: string
  downloads?: { artifact?: Artifact; classifiers?: Record<string, Artifact> }
  /** Fabric отдаёт библиотеки без блока downloads — только базовый URL репозитория. */
  url?: string
  sha1?: string
  size?: number
  natives?: Record<string, string>
  extract?: { exclude?: string[] }
  rules?: Rule[]
}

export interface ArgumentRule {
  rules: Rule[]
  value: string | string[]
}

export type Argument = string | ArgumentRule

export interface VersionJson {
  id: string
  inheritsFrom?: string
  type?: string
  mainClass: string
  /** Формат аргументов до 1.13. Fabric работает с 1.14+, но пусть будет. */
  minecraftArguments?: string
  arguments?: { game?: Argument[]; jvm?: Argument[] }
  libraries: Library[]
  assetIndex?: { id: string; url: string; sha1: string; size: number; totalSize?: number }
  assets?: string
  downloads?: { client?: Artifact; server?: Artifact }
  javaVersion?: { component: string; majorVersion: number }
  releaseTime?: string
}

// --- Правила ----------------------------------------------------------------

/**
 * Правила Mojang: список allow/disallow, где выигрывает последнее совпавшее.
 * Пустой список правил означает «разрешено».
 */
export function rulesAllow(rules: Rule[] | undefined, features: Record<string, boolean>): boolean {
  if (!rules || rules.length === 0) return true
  let allowed = false
  for (const rule of rules) {
    if (!ruleMatches(rule, features)) continue
    allowed = rule.action === 'allow'
  }
  return allowed
}

function ruleMatches(rule: Rule, features: Record<string, boolean>): boolean {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== mojangOs) return false
    if (rule.os.arch && rule.os.arch !== mojangArch) return false
    if (rule.os.version && !new RegExp(rule.os.version).test(String(process.getSystemVersion?.() ?? '')))
      return false
  }
  if (rule.features) {
    for (const [key, expected] of Object.entries(rule.features)) {
      if ((features[key] ?? false) !== expected) return false
    }
  }
  return true
}

// --- Слияние version.json (Fabric наследуется от ванильного) ----------------

/**
 * Fabric отдаёт профиль с inheritsFrom. Склеиваем его с ванильным так же,
 * как это делает официальный лаунчер: поля потомка перекрывают родительские,
 * библиотеки потомка идут первыми в classpath.
 */
export function mergeVersions(child: VersionJson, parent: VersionJson): VersionJson {
  return {
    ...parent,
    ...child,
    inheritsFrom: undefined,
    // Ассеты и client.jar всегда берутся из ванили — у Fabric их нет.
    assetIndex: child.assetIndex ?? parent.assetIndex,
    assets: child.assets ?? parent.assets,
    downloads: parent.downloads,
    javaVersion: child.javaVersion ?? parent.javaVersion,
    libraries: dedupeLibraries([...child.libraries, ...parent.libraries]),
    arguments: {
      game: [...(parent.arguments?.game ?? []), ...(child.arguments?.game ?? [])],
      jvm: [...(parent.arguments?.jvm ?? []), ...(child.arguments?.jvm ?? [])]
    }
  }
}

/**
 * Fabric поставляет свои версии ASM и прочих библиотек, которые обязаны
 * победить ванильные. Оставляем первое вхождение каждой пары group:artifact.
 * Классификатор входит в ключ: иначе нативная библиотека затёрла бы обычную,
 * ведь у них совпадают группа и артефакт.
 */
function dedupeLibraries(libraries: Library[]): Library[] {
  const seen = new Set<string>()
  const result: Library[] = []
  for (const lib of libraries) {
    const parts = lib.name.split('@')[0].split(':')
    const key = [parts[0], parts[1], parts[3] ?? ''].join(':')
    if (seen.has(key)) continue
    seen.add(key)
    result.push(lib)
  }
  return result
}

// --- Библиотеки: что качать и что попадёт в classpath -----------------------

export interface ResolvedLibrary {
  /** Обычный jar для classpath. */
  classpath?: string
  /** Архив с нативными библиотеками, который надо распаковать. */
  nativeJar?: { file: string; exclude: string[] }
  tasks: DownloadTask[]
}

export function resolveLibrary(lib: Library): ResolvedLibrary {
  const out: ResolvedLibrary = { tasks: [] }
  if (!rulesAllow(lib.rules, {})) return out

  const root = paths.libraries()

  // Обычный артефакт.
  if (lib.downloads?.artifact) {
    const artifact = lib.downloads.artifact
    const file = path.join(root, artifact.path ?? mavenToPath(lib.name))
    out.classpath = file
    out.tasks.push({ url: artifact.url, dest: file, sha1: artifact.sha1, size: artifact.size })
  } else if (!lib.natives) {
    // Так выглядят библиотеки Fabric: имя плюс базовый URL репозитория.
    const relative = mavenToPath(lib.name)
    const file = path.join(root, relative)
    const base = (lib.url ?? 'https://libraries.minecraft.net/').replace(/\/?$/, '/')
    out.classpath = file
    out.tasks.push({
      url: base + relative.split(path.sep).join('/'),
      dest: file,
      sha1: lib.sha1,
      size: lib.size
    })
  }

  // Нативные библиотеки старого формата (до 1.19): отдельный classifier,
  // содержимое которого надо распаковать в отдельную папку и скормить JVM
  // через -Djava.library.path.
  //
  // В 1.19 и новее такие jar-ы — обычные библиотеки с классификатором в имени
  // (org.lwjgl:lwjgl:3.3.3:natives-windows), и они обязаны остаться в classpath:
  // LWJGL сам находит их там и распаковывает в SharedLibraryExtractPath.
  // Забрать их из classpath — верный способ получить UnsatisfiedLinkError.
  if (lib.natives) {
    const classifier = lib.natives[mojangOs]?.replace(
      '${arch}',
      process.arch === 'ia32' ? '32' : '64'
    )
    const artifact = classifier ? lib.downloads?.classifiers?.[classifier] : undefined
    if (artifact) {
      const file = path.join(root, artifact.path ?? mavenToPath(`${lib.name}:${classifier}`))
      out.nativeJar = { file, exclude: lib.extract?.exclude ?? [] }
      out.tasks.push({ url: artifact.url, dest: file, sha1: artifact.sha1, size: artifact.size })
    }
  }

  return out
}
