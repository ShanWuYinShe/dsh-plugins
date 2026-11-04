#!/usr/bin/env node
// scripts/test-stability.mjs — 测试确定性压测：连续多轮全量 + 多并发档位。
//
// 目的：把「测试是否稳定」变成可复核的命令，而不是靠人工偶发观察。任何一轮
// 失败即整体非零退出，失败日志留在 .workwork/stability-<时间戳>/ 下。
//
// 用法：
//   bun run test:stability                 # 默认 3 轮全量 + 3 个并发档位
//   bun run test:stability --rounds 5      # 指定轮数
//   bun run test:stability --workers 1,2,4 # 指定并发档位（逗号分隔，省略则默认 1,2,4）
//
// 说明：这里刻意不跑 build（与 test:ci 的区别仅在此）；发布前仍以
// bun run test:ci 为准，本命令用于反复验证确定性。

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

/** 读取 --name value / --name=value 形式的参数。 */
function option(name, fallback) {
  const eq = argv.find(arg => arg.startsWith('--' + name + '='))
  if (eq !== undefined) return eq.slice(name.length + 3)
  const at = argv.indexOf('--' + name)
  return at === -1 || argv[at + 1] === undefined ? fallback : argv[at + 1]
}

const rounds = Number(option('rounds', '3'))
const workers = option('workers', '1,2,4').split(',').map(value => value.trim()).filter(value => value !== '')
if (!Number.isInteger(rounds) || rounds < 1) {
  console.error('test:stability: --rounds 必须是正整数')
  process.exit(2)
}
for (const worker of workers) {
  if (!Number.isInteger(Number(worker)) || Number(worker) < 1) {
    console.error('test:stability: --workers 必须是正整数列表（如 1,2,4）')
    process.exit(2)
  }
}

const vitest = join(ROOT, 'node_modules', '.bin', 'vitest')
const logDir = join(ROOT, '.workwork', 'stability-' + String(Date.now()))
mkdirSync(logDir, { recursive: true })

/** 跑一轮 vitest，返回退出码。 */
function run(label, args) {
  const result = spawnSync(vitest, ['run', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  })
  const log = join(logDir, label + '.log')
  writeFileSync(log, String(result.stdout ?? '') + String(result.stderr ?? ''))
  const status = result.status === null ? 1 : result.status
  if (status === 0) {
    console.log('ok   ' + label)
  } else {
    console.log('FAIL ' + label + '（日志: ' + log + '）')
    const stdout = String(result.stdout ?? '')
    for (const line of stdout.split('\n').filter(text => text.startsWith(' FAIL')).slice(0, 5)) console.log('     ' + line)
  }
  return status
}

let failed = 0
console.log('test:stability — ' + String(rounds) + ' 轮全量 + 并发档位 ' + workers.join('/'))
for (let round = 1; round <= rounds; round += 1) {
  failed += run('full-' + String(round), []) === 0 ? 0 : 1
}
for (const worker of workers) {
  failed += run('workers-' + worker, ['--maxWorkers=' + worker]) === 0 ? 0 : 1
}
console.log('')
console.log('日志目录: ' + logDir)
if (failed > 0) {
  console.log('结果: ' + String(failed) + ' 轮失败（测试不确定，必须修测试/实现，不能靠重跑）')
  process.exit(1)
}
console.log('结果: 全部通过（' + String(rounds + workers.length) + ' 轮）')
