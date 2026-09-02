import fs from 'node:fs/promises'
import path from 'node:path'
import extractZip from 'extract-zip'
import * as tar from 'tar'
import { adoptiumArch, adoptiumOs, javaBinary } from './platform'
import { downloadFile, fetchJson } from './http'
import { ensureDir, exists, paths } from './paths'

const ADOPTIUM = 'https://api.adoptium.net/v3'

interface AdoptiumAsset {
  release_name: string
  binary: {
    package: { link: string; name: string; size: number; checksum: string }
  }
}

/**
 * Java у друзей либо не установлена, либо не та. Поэтому лаунчер держит
 * собственную JRE: скачивает её с Adoptium под нужную ОС и архитектуру
 * (включая Apple Silicon) и никогда не трогает системную.
 */
export async function ensureJava(
  major: number,
  onProgress: (value: number | null, label: string) => void
): Promise<string> {
  const runtimeDir = paths.runtime(major)
  const home = path.join(runtimeDir, 'home')
  const marker = path.join(runtimeDir, '.release')

  if (await exists(javaBinary(home))) return javaBinary(home)

  onProgress(null, `Ищу Java ${major} для ${adoptiumOs}/${adoptiumArch}`)
  const query = new URLSearchParams({
    architecture: adoptiumArch,
    image_type: 'jre',
    os: adoptiumOs,
    vendor: 'eclipse',
    jvm_impl: 'hotspot',
    heap_size: 'normal',
    project: 'jdk'
  })
  const assets = await fetchJson<AdoptiumAsset[]>(
    `${ADOPTIUM}/assets/latest/${major}/hotspot?${query}`
  )
  if (assets.length === 0) {
    throw new Error(
      `Adoptium не отдаёт Java ${major} для ${adoptiumOs}/${adoptiumArch}. ` +
        'Возможно, версия Minecraft слишком свежая или слишком старая для этой платформы.'
    )
  }

  const asset = assets[0]
  const archive = path.join(runtimeDir, asset.binary.package.name)
  onProgress(0, `Скачиваю Java ${major} (${asset.release_name})`)
  await downloadFile(
    {
      url: asset.binary.package.link,
      dest: archive,
      sha256: asset.binary.package.checksum,
      size: asset.binary.package.size
    },
    (value) => onProgress(value, `Скачиваю Java ${major} (${asset.release_name})`)
  )

  onProgress(null, 'Распаковываю Java')
  const staging = path.join(runtimeDir, 'unpack')
  await fs.rm(staging, { recursive: true, force: true })
  await ensureDir(staging)

  if (archive.endsWith('.zip')) {
    await extractZip(archive, { dir: staging })
  } else {
    await tar.x({ file: archive, cwd: staging })
  }

  const extractedHome = await findJavaHome(staging)
  if (!extractedHome) throw new Error('В скачанном архиве Java не нашёлся исполняемый файл')

  await fs.rm(home, { recursive: true, force: true })
  await fs.rename(extractedHome, home)
  await fs.rm(staging, { recursive: true, force: true })
  await fs.rm(archive, { force: true })
  await fs.writeFile(marker, asset.release_name, 'utf8')

  // Zip не хранит права доступа, да и после переноса их стоит выставить явно —
  // иначе на macOS java просто не запустится.
  if (process.platform !== 'win32') await makeExecutable(home)

  return javaBinary(home)
}

/**
 * Внутри архива лежит одна папка вида jdk-21.0.5+11-jre.
 * На macOS настоящий JAVA_HOME спрятан ещё глубже — в Contents/Home.
 */
async function findJavaHome(root: string): Promise<string | null> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const base = path.join(root, entry.name)
    for (const candidate of [base, path.join(base, 'Contents', 'Home')]) {
      if (await exists(javaBinary(candidate))) return candidate
    }
  }
  return null
}

async function makeExecutable(home: string): Promise<void> {
  for (const dir of [path.join(home, 'bin'), path.join(home, 'lib')]) {
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const file = path.join(dir, name)
      const stat = await fs.stat(file).catch(() => null)
      if (stat?.isFile()) await fs.chmod(file, 0o755).catch(() => {})
    }
  }
}

/** Какая Java нужна версии игры. Mojang указывает это прямо в version.json. */
export function requiredJavaMajor(
  versionJavaMajor: number | undefined,
  override: number | undefined
): number {
  return override ?? versionJavaMajor ?? 17
}
