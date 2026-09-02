#!/usr/bin/env node
/**
 * Запускает команду с вычищенной переменной ELECTRON_RUN_AS_NODE.
 *
 * Терминалы, встроенные в редакторы на Electron (VS Code и его форки),
 * выставляют её в 1 для своих нужд. Дочерний Electron воспринимает это
 * буквально и стартует как обычный Node: окно не открывается, а
 * require('electron') отдаёт строку с путём вместо API. Ошибка при этом
 * выглядит совершенно не связанной с причиной, поэтому глушим на входе.
 */
import { spawn } from 'node:child_process'

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error('Использование: node scripts/run.mjs <команда> [аргументы...]')
  process.exit(1)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(command, args, {
  stdio: 'inherit',
  env,
  // На Windows бинарники из node_modules/.bin — это .cmd-обёртки.
  shell: process.platform === 'win32'
})

child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
child.on('error', (err) => {
  console.error(err.message)
  process.exit(1)
})
