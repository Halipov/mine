'use strict'

const { execFileSync } = require('node:child_process')
const path = require('node:path')

/**
 * Ad-hoc подпись macOS-сборки.
 *
 * Сертификата Apple Developer у нас нет, но и совсем без подписи нельзя:
 * на Apple Silicon неподписанный бинарь система откажется запускать вообще,
 * а не просто предупредит. Подпись пустым идентификатором ("-") эту проблему
 * снимает. Останется обычное окно «неизвестный разработчик» при первом
 * запуске — оно обходится через правый клик по приложению и «Открыть».
 */
module.exports = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)

  console.log(`[adhoc-sign] подписываю ${appPath}`)
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--options', 'runtime', appPath],
    { stdio: 'inherit' }
  )
}
