'use strict'

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

/**
 * Ad-hoc подпись macOS-сборки.
 *
 * Сертификата Apple Developer у нас нет, но и совсем без подписи нельзя:
 * на Apple Silicon неподписанный бинарь система запускать откажется.
 * Подпись пустым идентификатором ("-") эту проблему снимает.
 *
 * Две вещи, на которых легко обжечься и на которых мы уже обожглись:
 *
 * 1. Никакого --options runtime. Hardened runtime включает library
 *    validation: все загружаемые библиотеки обязаны иметь тот же Team ID,
 *    что и главный бинарь. У ad-hoc подписи Team ID нет, и приложение
 *    падает при старте с «different Team IDs», не дойдя до кода.
 *
 * 2. Никакого --deep. Apple не рекомендует его для подписи, а на Electron
 *    он особенно ненадёжен: внутри бандла фреймворки, четыре приложения-
 *    хелпера и отдельные dylib, и часть из них остаётся с прежней подписью.
 *    Смесь подписей даёт ровно ту же ошибку. Подписываем изнутри наружу
 *    поимённо: вложенное раньше внешнего, иначе подпись контейнера
 *    сломается при следующей же правке содержимого.
 */
module.exports = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )

  const targets = collectTargets(appPath)
  console.log(`[adhoc-sign] подписываю ${targets.length} объектов в ${appPath}`)

  for (const target of targets) {
    execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', target], {
      stdio: ['ignore', 'ignore', 'inherit']
    })
  }

  // Проверяем сразу здесь: несогласованную подпись иначе обнаружит только
  // тот, кто первым запустит приложение, и увидит он падение без объяснений.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit'
  })
  console.log('[adhoc-sign] подпись согласована')
}

/** Пути к подписываемому, в порядке «изнутри наружу». */
function collectTargets(appPath) {
  const targets = []
  const frameworks = path.join(appPath, 'Contents', 'Frameworks')

  if (fs.existsSync(frameworks)) {
    for (const name of fs.readdirSync(frameworks)) {
      const full = path.join(frameworks, name)

      if (name.endsWith('.framework')) {
        // У версионированного фреймворка подписывается Versions/A, а не
        // обёртка из симлинков.
        const versioned = path.join(full, 'Versions', 'A')
        const root = fs.existsSync(versioned) ? versioned : full

        for (const sub of ['Libraries', 'Helpers']) {
          const dir = path.join(root, sub)
          if (!fs.existsSync(dir)) continue
          for (const file of fs.readdirSync(dir)) targets.push(path.join(dir, file))
        }
        targets.push(root)
      } else if (name.endsWith('.app') || name.endsWith('.dylib')) {
        // Приложения-хелперы Electron и отдельные библиотеки.
        targets.push(full)
      }
    }
  }

  targets.push(appPath)
  return targets
}
