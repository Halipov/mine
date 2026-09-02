#!/usr/bin/env node
/**
 * Раздаёт папку web/ по HTTP — то же самое, что потом будет делать nginx
 * на сервере, только локально и без настройки.
 *
 *   npm run web:serve
 *
 * Пока он запущен, лаунчер с baseUrl http://127.0.0.1:8080 работает ровно
 * так же, как будет работать у друзей.
 */
import { createServer } from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { repoRoot } from './util.mjs'

const webDir = path.join(repoRoot, 'web')
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 8080

const TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.jar': 'application/java-archive',
  '.exe': 'application/octet-stream',
  '.zip': 'application/zip',
  '.dmg': 'application/octet-stream'
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')

  // Не выпускаем запрос за пределы web/: путь может прийти каким угодно.
  const target = path.resolve(webDir, relative)
  if (target !== webDir && !target.startsWith(webDir + path.sep)) {
    res.writeHead(403).end('403')
    return
  }

  try {
    const stat = await fs.stat(target)
    if (stat.isDirectory()) {
      const entries = await fs.readdir(target)
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(entries.join('\n'))
      return
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(target)] ?? 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-cache'
    })
    res.end(await fs.readFile(target))
    console.log(`  200 ${relative}`)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('404')
    console.log(`  404 ${relative}`)
  }
})

await fs.mkdir(webDir, { recursive: true })
server.listen(port, () => {
  console.log(`Раздаю ${path.relative(repoRoot, webDir)} на http://127.0.0.1:${port}`)
  console.log('Ctrl+C чтобы остановить.\n')
})
