import fs from 'node:fs/promises'
import path from 'node:path'
import extractZip from 'extract-zip'
import { ensureDir, exists, paths } from './paths'

export interface NativeJar {
  file: string
  exclude: string[]
}

/**
 * LWJGL и прочие нативные библиотеки приезжают в jar-архивах, а JVM хочет
 * видеть .dll/.dylib/.so распакованными в отдельной папке. Разбираем их один
 * раз на версию: штамп не даёт делать это при каждом запуске.
 */
export async function extractNatives(
  versionId: string,
  jars: NativeJar[],
  stamp: string
): Promise<string> {
  const dir = paths.natives(versionId)
  const stampFile = path.join(dir, '.stamp')

  if ((await exists(stampFile)) && (await fs.readFile(stampFile, 'utf8')) === stamp) {
    return dir
  }

  await fs.rm(dir, { recursive: true, force: true })
  await ensureDir(dir)

  for (const jar of jars) {
    await extractZip(jar.file, { dir })
    for (const pattern of [...jar.exclude, 'META-INF']) {
      await fs.rm(path.join(dir, pattern.replace(/\/$/, '')), {
        recursive: true,
        force: true
      })
    }
  }

  await fs.writeFile(stampFile, stamp, 'utf8')
  return dir
}
