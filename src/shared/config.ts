/**
 * Единственное место, которое нужно поправить под себя перед первой сборкой.
 */
export const APP = {
  /** Название в заголовке окна и в имени папки с данными. */
  name: 'Mine Launcher',

  /**
   * Корень раздачи: VPS, которая же служит входом на сервер Minecraft.
   *
   * Пока это голый IP, здесь http, а не https: сертификат Let's Encrypt
   * на IP-адрес не выдаётся. Появится домен — поменять на https здесь и
   * в filesBaseUrl серверного проекта.
   *
   * Для локальной обкатки: http://127.0.0.1:8080 плюс `npm run serve`.
   */
  baseUrl: 'http://193.124.224.225',

  /** Манифест сборки: состав модов, версия игры, адрес сервера. */
  get manifestUrl(): string {
    return `${APP.baseUrl}/pack.json`
  },

  /** Описание последней версии лаунчера для самообновления. */
  get updateUrl(): string {
    return `${APP.baseUrl}/launcher/latest.json`
  }
} as const
