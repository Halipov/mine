import os from 'node:os'
import path from 'node:path'

/** Имя ОС в терминах правил Mojang. */
export type MojangOs = 'windows' | 'osx' | 'linux'

export const mojangOs: MojangOs =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'

/** Архитектура в терминах правил Mojang. */
export const mojangArch: string =
  process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'arm64' : 'x86'

/** Ключ классификатора нативных библиотек для старых version.json (до 1.19). */
export const legacyNativesKey =
  mojangOs === 'windows' ? 'natives-windows' : mojangOs === 'osx' ? 'natives-osx' : 'natives-linux'

export const classpathSeparator = process.platform === 'win32' ? ';' : ':'

/** Как называется JRE у Adoptium. */
export const adoptiumOs = mojangOs === 'osx' ? 'mac' : mojangOs
export const adoptiumArch = process.arch === 'arm64' ? 'aarch64' : 'x64'

/**
 * Сколько памяти можно отдать игре. Оставляем системе минимум 2 ГБ,
 * иначе на 8-гигабайтной машине ползунок предложит уйти в своп.
 */
export function memoryLimitsMb(): { min: number; max: number; recommended: number } {
  const totalMb = Math.floor(os.totalmem() / 1024 / 1024)
  const max = Math.max(2048, totalMb - 2048)
  const recommended = Math.min(max, Math.max(2048, Math.floor(totalMb / 2 / 512) * 512))
  return { min: 1024, max, recommended }
}

/** Путь к исполняемому java внутри распакованной JRE. */
export function javaBinary(runtimeDir: string): string {
  return process.platform === 'win32'
    ? path.join(runtimeDir, 'bin', 'javaw.exe')
    : path.join(runtimeDir, 'bin', 'java')
}

/**
 * Превращает maven-координату Fabric/Mojang в путь внутри libraries/.
 * Формат: group:artifact:version[:classifier][@extension]
 */
export function mavenToPath(coordinate: string): string {
  const [withoutExt, ext = 'jar'] = coordinate.split('@')
  const parts = withoutExt.split(':')
  const [group, artifact, version] = parts
  const classifier = parts[3]
  const fileName = classifier
    ? `${artifact}-${version}-${classifier}.${ext}`
    : `${artifact}-${version}.${ext}`
  return path.join(...group.split('.'), artifact, version, fileName)
}
