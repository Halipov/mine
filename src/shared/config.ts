/**
 * Единственное место, которое нужно поправить под себя перед первой сборкой.
 */
export const APP = {
  /** Название в заголовке окна и в имени папки с данными. */
  name: 'Mine Launcher',

  /**
   * Репозиторий на GitHub, где лежат манифест сборки и релизы лаунчера.
   * Отсюда же берутся обновления самого лаунчера.
   */
  github: {
    owner: 'CHANGE-ME',
    repo: 'minecraft-pack'
  },

  /**
   * Ссылка на манифест сборки по умолчанию. Игрок может переопределить её
   * в настройках, но обычно этого никогда не потребуется.
   */
  get manifestUrl(): string {
    return `https://raw.githubusercontent.com/${APP.github.owner}/${APP.github.repo}/main/pack.json`
  },

  /** Базовое имя файлов релиза — должно совпадать с artifactName в electron-builder.yml. */
  artifactPrefix: 'MineLauncher'
} as const
