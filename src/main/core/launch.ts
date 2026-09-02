import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { classpathSeparator } from './platform'
import { paths } from './paths'
import { rulesAllow, type Argument, type VersionJson } from './version'

/**
 * Оффлайн-UUID считается ровно так же, как это делает сам Minecraft:
 * UUID третьей версии от строки "OfflinePlayer:<ник>". Благодаря этому
 * инвентарь и координаты игрока переживают переустановку лаунчера,
 * а сервер узнаёт того же человека.
 */
export function offlineUuid(name: string): string {
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

/** Флаги сборщика мусора, на которых модовые сборки ощутимо ровнее идут. */
const GC_FLAGS = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=200',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC',
  '-XX:G1NewSizePercent=30',
  '-XX:G1MaxNewSizePercent=40',
  '-XX:G1HeapRegionSize=8M',
  '-XX:G1ReservePercent=20',
  '-XX:G1HeapWastePercent=5',
  '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15',
  '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:SurvivorRatio=32',
  '-XX:+PerfDisableSharedMem',
  '-XX:MaxTenuringThreshold=1',
  // Дешёвая страховка от log4shell на версиях до 1.18.1.
  '-Dlog4j2.formatMsgNoLookups=true'
]

export interface LaunchOptions {
  version: VersionJson
  javaPath: string
  gameDir: string
  nativesDir: string
  classpath: string[]
  playerName: string
  playerUuid: string
  ramMb: number
  extraJvmArgs: string[]
  launcherName: string
  launcherVersion: string
  /** Если задано — игра сразу подключится к серверу, минуя главное меню. */
  quickPlayServer?: string
}

/** Раскрывает ${...} в аргументах version.json. */
function substitute(value: string, table: Record<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, key: string) => table[key] ?? match)
}

function collectArguments(
  args: Argument[] | undefined,
  features: Record<string, boolean>,
  table: Record<string, string>
): string[] {
  const out: string[] = []
  for (const arg of args ?? []) {
    if (typeof arg === 'string') {
      out.push(substitute(arg, table))
      continue
    }
    if (!rulesAllow(arg.rules, features)) continue
    const values = Array.isArray(arg.value) ? arg.value : [arg.value]
    for (const value of values) out.push(substitute(value, table))
  }
  return out
}

export function buildCommand(options: LaunchOptions): string[] {
  const { version } = options
  const classpath = options.classpath.join(classpathSeparator)

  const table: Record<string, string> = {
    auth_player_name: options.playerName,
    auth_uuid: options.playerUuid,
    // Игра требует непустой токен, но в оффлайне он никуда не отправляется.
    auth_access_token: '0',
    auth_session: '0',
    auth_xuid: '0',
    clientid: '0',
    user_type: 'legacy',
    user_properties: '{}',
    version_name: version.id,
    version_type: version.type ?? 'release',
    game_directory: options.gameDir,
    assets_root: paths.assets(),
    game_assets: paths.assets(),
    assets_index_name: version.assetIndex?.id ?? version.assets ?? 'legacy',
    natives_directory: options.nativesDir,
    launcher_name: options.launcherName,
    launcher_version: options.launcherVersion,
    classpath,
    classpath_separator: classpathSeparator,
    library_directory: paths.libraries(),
    quickPlayMultiplayer: options.quickPlayServer ?? ''
  }

  const features: Record<string, boolean> = {
    is_demo_user: false,
    has_custom_resolution: false,
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: Boolean(options.quickPlayServer),
    is_quick_play_realms: false
  }

  const xms = Math.min(options.ramMb, 1024)
  const jvm = [
    `-Xmx${options.ramMb}M`,
    `-Xms${xms}M`,
    ...GC_FLAGS,
    ...collectArguments(version.arguments?.jvm, features, table),
    ...options.extraJvmArgs
  ]

  // До 1.13 аргументы игры лежали одной строкой. Fabric работает с 1.14+,
  // но своя сборка на старой версии — не тот случай, когда хочется падать.
  const game = version.minecraftArguments
    ? version.minecraftArguments.split(' ').map((token) => substitute(token, table))
    : collectArguments(version.arguments?.game, features, table)

  const hasClasspathFlag = jvm.includes('-cp') || jvm.includes('-classpath')
  const classpathArgs = hasClasspathFlag ? [] : ['-cp', classpath]

  return [...jvm, ...classpathArgs, version.mainClass, ...game]
}

export interface GameProcess {
  child: ChildProcess
  command: string[]
}

export function launchGame(options: LaunchOptions): GameProcess {
  const command = buildCommand(options)
  const child = spawn(options.javaPath, command, {
    cwd: options.gameDir,
    // Отвязываемся от лаунчера, чтобы его закрытие не убивало игру.
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false
  })
  return { child, command }
}
