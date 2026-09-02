import type { ChildProcess } from 'node:child_process'
import path from 'node:path'
import type { PackManifest, Profile, Progress, Settings, Stage } from '@shared/types'
import { isGameSupported, loadFabricProfile, resolveLoaderVersion } from './fabric'
import { downloadAll, type DownloadTask } from './http'
import { ensureJava, requiredJavaMajor } from './java'
import { launchGame, offlineUuid, type LaunchOptions } from './launch'
import { assetTasks, clientJarTask, loadVanillaVersion, saveMergedVersion } from './mojang'
import { extractNatives, type NativeJar } from './natives'
import { ensureDir, paths } from './paths'
import { ensureServerInList, serverAddress } from './servers'
import { syncPackFiles } from './sync'
import { mergeVersions, resolveLibrary, type VersionJson } from './version'

export interface PrepareOptions {
  manifest: PackManifest
  settings: Settings
  profile: Profile
  launcherName: string
  launcherVersion: string
  /** Подключиться к серверу сразу, минуя главное меню. */
  directJoin: boolean
  report: (progress: Progress) => void
  onLog: (line: string) => void
  /** Только для самопроверки: пропустить несколько тысяч файлов ресурсов. */
  skipAssets?: boolean
}

export async function prepareAndLaunch(options: PrepareOptions): Promise<ChildProcess> {
  const launchOptions = await prepare(options)
  const { child, command } = launchGame(launchOptions)
  options.onLog(`$ ${launchOptions.javaPath} ${command.join(' ')}`)
  return child
}

/**
 * Приводит установку в готовое к запуску состояние и возвращает всё,
 * что нужно для старта JVM. Вынесено отдельно, чтобы самопроверка могла
 * прогнать весь конвейер, не открывая окно игры.
 */
export async function prepare(options: PrepareOptions): Promise<LaunchOptions> {
  const { manifest, settings, profile, report } = options
  const say = (stage: Stage, label: string, value: number | null = null): void =>
    report({ stage, label, value })

  // 1. Ванильная версия — основа, от которой наследуется профиль Fabric.
  say('vanilla', `Читаю описание Minecraft ${manifest.minecraft}`)
  const vanilla = await loadVanillaVersion(manifest.minecraft)

  // 2. Fabric.
  say('fabric', 'Определяю версию Fabric')
  if (!(await isGameSupported(vanilla.id))) {
    throw new Error(
      `Fabric не поддерживает Minecraft ${vanilla.id}. Поменяй поле minecraft в манифесте сборки.`
    )
  }
  const loaderVersion = await resolveLoaderVersion(vanilla.id, manifest.fabricLoader)
  const fabricProfile = await loadFabricProfile(vanilla.id, loaderVersion)
  const version: VersionJson = mergeVersions(fabricProfile, vanilla)
  await saveMergedVersion(version)

  // 3. Java. Делаем это до тяжёлых загрузок: если платформа не поддержана,
  //    лучше узнать об этом сразу, а не после сотни мегабайт трафика.
  const javaMajor = requiredJavaMajor(version.javaVersion?.majorVersion, manifest.java)
  say('java', `Проверяю Java ${javaMajor}`)
  const javaPath = await ensureJava(javaMajor, (value, label) => report({ stage: 'java', label, value }))

  // 4. Библиотеки и client.jar.
  say('vanilla', 'Собираю список библиотек')
  const libraryTasks: DownloadTask[] = []
  const classpath: string[] = []
  const nativeJars: NativeJar[] = []

  for (const library of version.libraries) {
    const resolved = resolveLibrary(library)
    libraryTasks.push(...resolved.tasks)
    if (resolved.classpath) classpath.push(resolved.classpath)
    if (resolved.nativeJar) nativeJars.push(resolved.nativeJar)
  }

  const clientJar = clientJarTask(vanilla)
  libraryTasks.push(clientJar)
  classpath.push(clientJar.dest)

  say('vanilla', 'Скачиваю библиотеки', 0)
  await downloadAll(libraryTasks, (done, total) =>
    report({
      stage: 'vanilla',
      label: 'Скачиваю библиотеки',
      value: total > 0 ? done / total : 1,
      bytesDone: done,
      bytesTotal: total
    })
  )

  // 5. Ассеты: несколько тысяч мелких файлов, самый долгий шаг при первом запуске.
  if (!options.skipAssets) {
    say('assets', 'Собираю список ресурсов')
    const assets = await assetTasks(vanilla)
    say('assets', 'Скачиваю ресурсы игры', 0)
    await downloadAll(assets, (done, total) =>
      report({
        stage: 'assets',
        label: 'Скачиваю ресурсы игры',
        value: total > 0 ? done / total : 1,
        bytesDone: done,
        bytesTotal: total
      })
    )
  }

  // 6. Нативные библиотеки.
  say('vanilla', 'Распаковываю нативные библиотеки')
  const stamp = nativeJars
    .map((jar) => path.basename(jar.file))
    .sort()
    .join('|')
  const nativesDir = await extractNatives(version.id, nativeJars, stamp)

  // 7. Моды и файлы сборки.
  say('mods', 'Сверяю моды со сборкой')
  const sync = await syncPackFiles(manifest, (value, label) =>
    report({ stage: 'mods', label, value })
  )
  for (const removed of sync.removed) options.onLog(`Удалён файл сборки: ${removed}`)

  // 8. Сервер в списке сетевой игры.
  const gameDir = paths.instance(manifest.id)
  await ensureDir(gameDir)
  if (manifest.server) {
    say('files', 'Прописываю сервер в список')
    await ensureServerInList(manifest.id, manifest.server)
  }

  // 9. Всё готово — собираем параметры запуска.
  say('launching', 'Запускаю Minecraft')
  return {
    version,
    javaPath,
    gameDir,
    nativesDir,
    classpath,
    playerName: profile.name,
    playerUuid: profile.uuid || offlineUuid(profile.name),
    ramMb: settings.ramMb,
    extraJvmArgs: settings.extraJvmArgs
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    launcherName: options.launcherName,
    launcherVersion: options.launcherVersion,
    quickPlayServer:
      options.directJoin && manifest.server ? serverAddress(manifest.server) : undefined
  }
}
