#!/usr/bin/env node
/**
 * 自检：验证写入面守卫的三条路径，不需要真实 DSH 进程。
 *
 * 1. 写入面可用 → 事件带 `ignorable` 与 `plugin:` 前缀写进日志，projection 能折叠出建议；
 * 2. 写入面缺失（DSH 升级后方法消失）→ 不抛错、不请求模型，并告警一次；
 * 3. 写入面抛错（DSH 收紧校验）→ 不抛错，记录 append-failed 并告警一次。
 *
 * 诊断日志写在 `os.tmpdir()` 下，所以每个用例都由父进程用独立 TMPDIR 起子进程，
 * 既互不干扰，也避免覆盖真实运行留下的日志。
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = path.join(HERE, '..', 'index.js')
const EVENT_TYPE = 'plugin:dsh-follow-up-prompts/ready'
const CASES = ['ok', 'missing', 'throw']

/** 构造假宿主：只实现插件实际用到的 ctx 成员。 */
function makeHarness(mode) {
  const handlers = []
  const warns = []
  const committed = []
  const calls = { llm: 0 }
  let projectionSpec

  const ctx = {
    effect(fn) {
      const cleanup = fn()
      return { dispose() { if (typeof cleanup === 'function') cleanup() } }
    },
    on(type, fn) {
      if (type === 'session/event') handlers.push(fn)
      return () => {}
    },
    sessionProjections: {
      register(spec) {
        projectionSpec = spec
        return Promise.resolve({ dispose() {} })
      },
    },
    llm: {
      stream() {
        calls.llm += 1
        return (async function* stream() {
          yield { type: 'text-delta', text: '{"suggestions":[{"prompt":"补充单测"}]}' }
        })()
      },
    },
    logger: { warn(message) { warns.push(String(message)) } },
  }

  const session = {
    id: 'selftest',
    seq: 42,
    header: { id: 'selftest' },
    requestHeader: () => ({ config: { provider: 'test', model: 'test' } }),
  }
  if (mode !== 'missing') {
    session.publicationEntry = () => ({})
    session.commit = (event) => {
      if (mode === 'throw') throw new Error('commit rejected')
      committed.push(event)
    }
  }

  const fire = (event) => {
    for (const handler of handlers) handler(session, event)
  }

  return { ctx, fire, warns, committed, calls, get projectionSpec() { return projectionSpec } }
}

/** 一轮对话需要的最小事件序列。 */
const TURN = [
  { type: 'request/header', data: { header: { config: { provider: 'test', model: 'test' } } } },
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '加一个单测' }] } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的' }] } } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
]

async function runCase(name) {
  const { apply } = await import(pathToFileURL(ENTRY).href)
  const harness = makeHarness(name)
  apply(harness.ctx)
  for (const event of TURN) harness.fire(event)
  // turn/end 之后的建议写入让了一拍（setTimeout 0），留足时间再断言。
  await new Promise((resolve) => setTimeout(resolve, 120))
  const logFile = path.join(os.tmpdir(), 'dsh-follow-up-prompts.log')
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''

  const assertions = []
  const check = (label, condition) => assertions.push({ label, ok: Boolean(condition) })

  if (name === 'ok') {
    const event = harness.committed[0]
    check('写入了一条事件', harness.committed.length === 1)
    check('事件类型是 plugin: 前缀', event?.type === EVENT_TYPE)
    check('事件带 ignorable 标记', event?.ignorable === true)
    check('事件带 items 数据', Array.isArray(event?.data?.items) && event.data.items[0]?.prompt === '补充单测')
    check('记录了 append 成功', log.includes('suggest/appended'))
    const spec = harness.projectionSpec
    const folded = spec?.apply(spec.init({ id: 'selftest' }), event)
    check('projection 能折叠出建议', folded?.items?.length === 1)
    const view = spec?.wire?.view(folded)
    check('可用时视图不带提示', view?.unavailable === null)
    check('可用时视图保留建议', view?.items?.length === 1)
    check('没有误报告警', harness.warns.length === 0)
  }

  if (name === 'missing') {
    check('没有写入事件', harness.committed.length === 0)
    check('没有请求模型（省掉无效调用）', harness.calls.llm === 0)
    check('首次事件即告警', harness.warns.some((message) => /publicationEntry|commit/.test(message)))
    check('诊断日志记录守卫原因', log.includes('guard/report'))
    const spec = harness.projectionSpec
    const view = spec?.wire?.view(spec.init({ id: 'selftest' }))
    check('视图带不可用提示', view?.unavailable !== null && typeof view?.unavailable?.reason === 'string')
    check('不可用时不展示旧建议', Array.isArray(view?.items) && view.items.length === 0)
  }

  if (name === 'throw') {
    check('没有写入事件', harness.committed.length === 0)
    check('仍然请求了模型（写入前无法预判）', harness.calls.llm === 1)
    check('记录了 append 失败', log.includes('suggest/append-failed'))
    check('告警包含失败原因', harness.warns.some((message) => message.includes('commit rejected')))
    const spec = harness.projectionSpec
    const view = spec?.wire?.view(spec.init({ id: 'selftest' }))
    check('写入失败后视图提示不可用', view?.unavailable !== null)
  }

  const failed = assertions.filter((assertion) => !assertion.ok)
  return {
    case: name,
    ok: failed.length === 0,
    assertions,
    warns: harness.warns,
  }
}

function runChild() {
  const name = process.argv[process.argv.indexOf('--child') + 1]
  runCase(name)
    .then((result) => {
      process.stdout.write(JSON.stringify(result))
    })
    .catch((error) => {
      process.stdout.write(JSON.stringify({ case: name, ok: false, error: String(error?.stack ?? error), assertions: [] }))
      process.exitCode = 1
    })
}

function runParent() {
  let failed = 0
  for (const name of CASES) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `fup-selftest-${name}-`))
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', name], {
      env: { ...process.env, TMPDIR: tmp },
      encoding: 'utf8',
    })
    let result
    try {
      result = JSON.parse(child.stdout.trim() || '{}')
    } catch {
      result = { case: name, ok: false, error: child.stdout + child.stderr, assertions: [] }
    }
    if (!result.ok) failed += 1
    console.log(`${result.ok ? '✅' : '❌'} ${name}${result.error ? `：${result.error}` : ''}`)
    for (const assertion of result.assertions ?? []) {
      if (!assertion.ok) console.log(`   - 未通过：${assertion.label}`)
    }
  }
  console.log(failed === 0 ? '\n全部用例通过' : `\n${failed} 个用例失败`)
  return failed === 0 ? 0 : 1
}

if (process.argv.includes('--child')) {
  runChild()
} else {
  process.exitCode = runParent()
}