import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as nbt from 'prismarine-nbt'
import type { PackManifest, Profile, Progress, Settings } from '@shared/types'
import { prepare } from './core/installer'
import { buildCommand, offlineUuid } from './core/launch'
import { fetchManifest } from './core/manifest'
import { exists, paths } from './core/paths'
import { memoryLimitsMb } from './core/platform'
import { syncPackFiles } from './core/sync'

const run = promisify(execFile)

/**
 * Прогон всего конвейера без запуска игры: скачивание Java, библиотек,
 * модов, распаковка нативов, запись servers.dat и сборка командной строки.
 *
 *   npm run selftest              — быстрый прогон, ресурсы игры пропускаются
 *   npm run selftest -- --full    — вместе с ресурсами (несколько тысяч файлов)
 *
 * Переменной SELFTEST_MANIFEST можно подсунуть свой манифест сборки.
 */
export async function runSelfTest(): Promise<number> {
  const full = process.argv.includes('--full')
  const mcVersion = process.env.SELFTEST_MC ?? '1.21.1'
  let failures = 0

  const check = (name: string, ok: boolean, detail = ''): void => {
    if (!ok) failures++
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
  }

  console.log(`\n=== Самопроверка лаунчера ===`)
  console.log(`Данные: ${paths.root()}`)
  console.log(`Ресурсы игры: ${full ? 'качаем' : 'пропускаем (--full чтобы включить)'}\n`)

  // 1. Оффлайн-UUID должен быть стабильным и корректным по формату.
  const uuid = offlineUuid('Steve')
  check('оффлайн-UUID детерминирован', uuid === offlineUuid('Steve'), uuid)
  check('оффлайн-UUID третьей версии', uuid[14] === '3')
  check('оффлайн-UUID с правильным variant', '89ab'.includes(uuid[19]))

  // 2. Манифест: либо настоящий, либо собранный из свежих версий с Modrinth.
  console.log('\n--- манифест ---')
  const manifest = process.env.SELFTEST_MANIFEST
    ? await fetchManifest(process.env.SELFTEST_MANIFEST)
    : await syntheticManifest(mcVersion)
  check('манифест получен', true, `${manifest.name}, модов: ${manifest.mods.length}`)

  // 3. Основной конвейер.
  console.log('\n--- подготовка ---')
  const settings: Settings = {
    profiles: [],
    activeProfileId: null,
    ramMb: Math.min(4096, memoryLimitsMb().max),
    extraJvmArgs: '',
    keepLauncherOpen: true,
    manifestUrl: ''
  }
  const profile: Profile = { id: 'selftest', name: 'Steve', uuid: offlineUuid('Steve') }

  // Печатаем только заметные изменения: вывод часто уходит в файл, где
  // возврат каретки не спасает, а сотни строк подряд читать невозможно.
  let lastLine = ''
  const report = (progress: Progress): void => {
    const percent = progress.value === null ? null : Math.floor(progress.value * 10) * 10
    const line = `      ${progress.label}${percent === null ? '' : ` ${percent}%`}`
    if (line === lastLine) return
    lastLine = line
    console.log(line)
  }

  const launchOptions = await prepare({
    manifest,
    settings,
    profile,
    launcherName: 'Mine Launcher',
    launcherVersion: '0.0.0-selftest',
    directJoin: false,
    skipAssets: !full,
    report,
    onLog: () => {}
  })

  // 4. Java должна не просто скачаться, а запускаться.
  console.log('\n--- проверки результата ---')
  const { stderr } = await run(launchOptions.javaPath, ['-version'])
  const javaLine = stderr.split('\n')[0]?.trim() ?? ''
  check('скачанная Java запускается', javaLine.length > 0, javaLine)

  // 5. Classpath: client.jar, загрузчик Fabric и никаких нативных архивов.
  const cp = launchOptions.classpath
  check('client.jar в classpath', cp.some((p) => p.endsWith(`${mcVersion}.jar`)))
  check(
    'загрузчик Fabric в classpath',
    cp.some((p) => p.includes(`fabric-loader`)),
    `всего библиотек: ${cp.length}`
  )
  check(
    'дубликатов в classpath нет',
    new Set(cp.map((p) => path.basename(p))).size === cp.length
  )

  // 6. Нативные библиотеки. До 1.19 их распаковывали в отдельную папку,
  //    с 1.19 они остаются в classpath — подходит любой из вариантов,
  //    но хотя бы один должен сработать, иначе игра упадёт на LWJGL.
  const nativeToken =
    process.platform === 'win32'
      ? 'natives-windows'
      : process.platform === 'darwin'
        ? 'natives-macos'
        : 'natives-linux'
  const nativeExt =
    process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so'
  const onClasspath = cp.filter((p) => path.basename(p).includes(nativeToken))
  const unpacked = (await fs.readdir(launchOptions.nativesDir).catch((): string[] => [])).filter(
    (f) => f.endsWith(nativeExt)
  )
  check(
    'нативные библиотеки доступны игре',
    onClasspath.length > 0 || unpacked.length > 0,
    onClasspath.length > 0
      ? `в classpath: ${onClasspath.length}`
      : `распаковано: ${unpacked.length}`
  )
  check('папка для нативов создана', await fs.stat(launchOptions.nativesDir).then(
    (s) => s.isDirectory(),
    () => false
  ))

  // 7. Моды на месте, лишнего нет. Манифест общий с сервером, поэтому
  //    считаем только те, что предназначены клиенту.
  const modsDir = path.join(launchOptions.gameDir, 'mods')
  const clientMods = manifest.mods.filter((mod) => mod.side !== 'server')
  const serverOnly = manifest.mods.filter((mod) => mod.side === 'server')
  const modFiles = (await fs.readdir(modsDir).catch((): string[] => [])).filter((f) =>
    f.endsWith('.jar')
  )
  check(
    'клиентские моды скачаны',
    modFiles.length === clientMods.length,
    `${modFiles.length} из ${clientMods.length}`
  )
  check(
    'серверные моды на клиент не поехали',
    serverOnly.every((mod) => !modFiles.includes(mod.name ?? '')),
    serverOnly.length > 0 ? `серверных в манифесте: ${serverOnly.length}` : 'таких в сборке нет'
  )

  // 8. Синхронизация состава: убранный из сборки мод должен исчезнуть,
  //    а мод, который игрок положил сам, — остаться. Это ровно то место,
  //    где легко случайно стереть чужие файлы.
  if (clientMods.length > 0) {
    const personal = path.join(modsDir, 'moy-lichniy-mod.jar')
    await fs.writeFile(personal, 'это не настоящий мод')

    // Убираем именно клиентский мод: серверный на диск и не попадал,
    // проверка на нём ничего бы не значила.
    const dropped = clientMods[clientMods.length - 1]
    const droppedFile = path.join(
      modsDir,
      dropped.name ?? decodeURIComponent(new URL(dropped.url).pathname.split('/').pop() ?? '')
    )
    const without = manifest.mods.filter((mod) => mod !== dropped)

    await syncPackFiles({ ...manifest, mods: without }, () => {})
    check('мод, убранный из сборки, удалён', !(await exists(droppedFile)), path.basename(droppedFile))
    check('чужой мод не тронут', await exists(personal))

    await syncPackFiles(manifest, () => {})
    check('мод возвращается, если его вернули в сборку', await exists(droppedFile))
    check('чужой мод пережил и это обновление', await exists(personal))

    await fs.rm(personal, { force: true })
  }

  // 9. servers.dat читается обратно и содержит наш сервер первым.
  if (manifest.server) {
    const file = path.join(launchOptions.gameDir, 'servers.dat')
    const { parsed } = await nbt.parse(await fs.readFile(file))
    const list = nbt.simplify(parsed).servers as Array<{ ip: string; name: string }>
    const expected =
      manifest.server.port === 25565
        ? manifest.server.host
        : `${manifest.server.host}:${manifest.server.port}`
    check('servers.dat читается', Array.isArray(list), `записей: ${list?.length ?? 0}`)
    check('наш сервер первый в списке', list?.[0]?.ip === expected, list?.[0]?.ip)
  }

  // 10. Командная строка.
  const command = buildCommand(launchOptions)
  check('main-класс от Fabric', command.includes(launchOptions.version.mainClass), launchOptions.version.mainClass)
  check('classpath передан', command.includes('-cp') || command.includes('-classpath'))
  check('ник подставлен', command.includes('Steve'))
  check(
    'нераскрытых подстановок не осталось',
    !command.some((arg) => arg.includes('${')),
    command.filter((a) => a.includes('${')).join(' ')
  )
  if (process.platform === 'darwin') {
    check('на macOS добавлен -XstartOnFirstThread', command.includes('-XstartOnFirstThread'))
  }

  console.log(`\nКоманда запуска:\n  ${launchOptions.javaPath} ${command.join(' ')}\n`)
  console.log(failures === 0 ? '=== Всё в порядке ===\n' : `=== Провалено проверок: ${failures} ===\n`)
  return failures === 0 ? 0 : 1
}

interface ModrinthVersion {
  files: Array<{
    url: string
    filename: string
    primary: boolean
    size: number
    hashes: { sha1: string }
  }>
}

/** Собирает тестовую сборку из пары популярных модов под нужную версию. */
async function syntheticManifest(mcVersion: string): Promise<PackManifest> {
  const slugs = ['fabric-api', 'lithium']
  const mods: PackManifest['mods'] = []

  for (const slug of slugs) {
    const url =
      `https://api.modrinth.com/v2/project/${slug}/version` +
      `?loaders=%5B%22fabric%22%5D&game_versions=%5B%22${mcVersion}%22%5D`
    const res = await fetch(url, { headers: { 'user-agent': 'MineLauncher/selftest' } })
    if (!res.ok) throw new Error(`Modrinth ответил ${res.status} на запрос ${slug}`)
    const versions = (await res.json()) as ModrinthVersion[]
    const file = versions[0]?.files.find((f) => f.primary) ?? versions[0]?.files[0]
    if (!file) throw new Error(`На Modrinth нет ${slug} под Minecraft ${mcVersion}`)
    mods.push({
      name: file.filename,
      url: file.url,
      sha1: file.hashes.sha1,
      size: file.size,
      side: 'both'
    })
  }

  return {
    schema: 1,
    id: 'selftest',
    name: 'Проверочная сборка',
    packVersion: 'selftest',
    minecraft: mcVersion,
    fabricLoader: 'latest',
    server: { name: 'Проверочный сервер', host: 'mc.example.com', port: 25565 },
    mods,
    extraFiles: [],
    recommendedRamMb: 4096
  }
}
