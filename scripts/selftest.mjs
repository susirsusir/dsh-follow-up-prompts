#!/usr/bin/env node
/**
 * 自检：验证写入面守卫与建议请求的关键路径，不需要真实 DSH 进程。
 *
 * 1. 写入面可用 → 事件带 `ignorable` 与 `plugin:` 前缀写进日志，projection 能折叠出建议；
 *    同时断言请求把推理档降到 off、预算为 1024，避免推理模型把预算吃光；
 * 2. 模型没有推理能力 → 不传推理档，请求照常成功；
 * 3. 模型把预算花在推理上（finish=max-tokens 且文本为空）→ 不写事件，但留下可定位的诊断；
 * 4. 写入面缺失（DSH 升级后方法消失）→ 不抛错、不请求模型，并告警一次；
 * 5. 写入面抛错（DSH 收紧校验）→ 不抛错，记录 append-failed 并告警一次；
 * 6. 模型选型（1.1.3）：目录里有轻模型就换过去；目录里没有轻模型、目录读不到、
 *    或显式配置指向不存在的模型 → 都退回本轮模型，最坏情况不劣于 1.1.2；
 * 7. 超时（1.1.3）：上游迟迟不回 → 中止并留下 `suggest/timeout`，而不是无声消失。
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
const CASES = [
  'ok',
  'no-reasoning',
  'truncated',
  'missing',
  'throw',
  'auto-flash',
  'auto-none',
  'auto-broken',
  'fixed-ok',
  'fixed-missing',
  'session-pinned',
  'auto-already-cheap',
  'timeout',
]
/**
 * 每个用例的模型目录与插件配置。
 *
 * 缺省目录只有本轮在用的 `test`：1.1.2 的行为，用来保证老用例的断言不变。
 */
const SCENARIOS = {
  'auto-flash': { models: [{ id: 'test' }, { id: 'test-flash' }] },
  'auto-none': { models: [{ id: 'test' }, { id: 'pro-max' }] },
  'auto-broken': { models: 'throw' },
  'fixed-ok': { models: [{ id: 'test' }, { id: 'test-flash' }], config: { suggestionModel: 'test-flash' } },
  'fixed-missing': { models: [{ id: 'test' }], rejected: ['ghost'], config: { suggestionModel: 'ghost' } },
  'session-pinned': { models: [{ id: 'test' }, { id: 'test-flash' }], config: { suggestionModel: 'session' } },
  'auto-already-cheap': { models: [{ id: 'test' }, { id: 'test-flash' }], sessionModel: 'test-flash' },
  timeout: { models: [{ id: 'test' }] },
}
/** 与 index.js 里的 SUGGESTION_MAX_TOKENS 保持一致。 */
const SUGGESTION_MAX_TOKENS = 1_024
/** 假宿主声明的推理档，顺序与真实 adapter 一致：由弱到强。 */
const EFFORTS = [
  { id: 'off', name: 'Off' },
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
]

/** 构造假宿主：只实现插件实际用到的 ctx 成员。 */
function makeHarness(mode) {
  const handlers = []
  const warns = []
  const committed = []
  const calls = { llm: 0, list: 0 }
  const results = { prepared: undefined, options: undefined }
  let projectionSpec

  const scenario = SCENARIOS[mode] ?? {}
  const models = scenario.models ?? [{ id: 'test' }]
  const rejected = scenario.rejected ?? []
  const config = scenario.config
  const sessionModel = scenario.sessionModel ?? 'test'

  /**
   * 模拟 LlmRuntime.prepareCall：用模型元数据跑 configure、校验推理档、
   * 物化默认值，并要求后续 stream 回传完全相同的 call config。
   */
  const prepareCall = async (rawConfig, _signal, configure) => {
    calls.llm += 1
    // 模拟「配置/缓存里的模型已经不在服务端目录」：宿主以 UNKNOWN_MODEL 拒绝。
    if (rejected.includes(rawConfig.model)) throw new Error(`UNKNOWN_MODEL ${rawConfig.model}`)
    const config = rawConfig
    const model = {
      provider: config.provider,
      id: config.model,
      defaultMaxTokens: 256_000,
      ...(mode === 'no-reasoning' ? {} : { reasoning: { efforts: EFFORTS, defaultEffort: 'high' } }),
    }
    const { provider, model: modelId, ...controls } = config
    const proposed = typeof configure === 'function'
      ? { ...configure(controls, model), provider, model: modelId }
      : config
    let resolved = proposed
    if (proposed.reasoningEffort !== undefined) {
      if (model.reasoning === undefined || !model.reasoning.efforts.some((effort) => effort.id === proposed.reasoningEffort)) {
        throw new Error(`UNSUPPORTED_REASONING_EFFORT ${proposed.reasoningEffort}`)
      }
    } else if (model.reasoning?.defaultEffort !== undefined) {
      resolved = { ...proposed, reasoningEffort: model.reasoning.defaultEffort }
    }
    if (resolved.maxTokens === undefined && model.defaultMaxTokens !== undefined) {
      resolved = { ...resolved, maxTokens: model.defaultMaxTokens }
    }
    results.prepared = resolved
    return {
      config: resolved,
      stream(options) {
        results.options = options
        for (const key of ['provider', 'model', 'reasoningEffort', 'temperature', 'maxTokens']) {
          if (options[key] !== resolved[key]) throw new Error(`INVALID_PREPARED_CALL ${key}`)
        }
        return (async function* stream() {
          if (mode === 'timeout') {
            // 上游迟迟不回：一直等到被 abort，再按真实适配器的样子给出 finish=aborted。
            await new Promise((resolve) => {
              if (options.signal?.aborted) resolve()
              else options.signal?.addEventListener('abort', resolve, { once: true })
            })
            yield { type: 'finish', reason: { kind: 'aborted' } }
            return
          }
          if (mode === 'truncated') {
            // V4-Pro high 的表现：预算全花在 reasoning 上，可见文本为 0。
            yield { type: 'reasoning-delta', text: '先想想用户想要什么……' }
            yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 600, reasoningTokens: 600 } }
            yield { type: 'finish', reason: { kind: 'max-tokens' } }
            return
          }
          yield { type: 'text-delta', text: '{"suggestions":[{"prompt":"补充单测"}]}' }
          yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 18, reasoningTokens: 0 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
  }

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
      prepareCall,
      // 与真正的 pi-ai 适配器一致：只读本地目录，不联网，所以可以安全地每轮调用。
      async listModels() {
        calls.list += 1
        if (models === 'throw') throw new Error('model catalog unavailable')
        return models
      },
    },
    logger: { warn(message) { warns.push(String(message)) } },
  }

  const session = {
    id: 'selftest',
    seq: 42,
    header: { id: 'selftest' },
    requestHeader: () => ({ config: { provider: 'test', model: sessionModel, reasoningEffort: 'high' } }),
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

  return { ctx, config, sessionModel, fire, warns, committed, calls, results, get projectionSpec() { return projectionSpec } }
}

/** 一轮对话需要的最小事件序列；模型按用例可换，其余固定。 */
const TURN = (model = 'test') => [
  { type: 'request/header', data: { header: { config: { provider: 'test', model, reasoningEffort: 'high' } } } },
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '加一个单测' }] } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的' }] } } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
]

async function runCase(name) {
  // 超时用例要把阈值压到 200ms，否则每个用例都得等 30 秒。
  if (name === 'timeout') process.env.DSH_FOLLOW_UP_PROMPTS_TIMEOUT_MS = '200'
  const { apply } = await import(pathToFileURL(ENTRY).href)
  const harness = makeHarness(name)
  apply(harness.ctx, harness.config)
  for (const event of TURN(harness.sessionModel)) harness.fire(event)
  // turn/end 之后的建议写入让了一拍（setTimeout 0），留足时间再断言。
  await new Promise((resolve) => setTimeout(resolve, name === 'timeout' ? 900 : 120))
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
    // 根因守卫：建议请求不能沿用本轮的高推理档，否则推理会吃光输出预算。
    check('推理档降到 off', harness.results.prepared?.reasoningEffort === 'off')
    check('派发时带的是 off', harness.results.options?.reasoningEffort === 'off')
    check('输出预算是 1024', harness.results.prepared?.maxTokens === SUGGESTION_MAX_TOKENS)
    check('诊断记录了最终控制项', log.includes('"reasoningEffort":"off"'))
    check('诊断记录了 finish 原因与耗时', log.includes('"finish":"stop"') && log.includes('"ms":'))
    const spec = harness.projectionSpec
    const folded = spec?.apply(spec.init({ id: 'selftest' }), event)
    check('projection 能折叠出建议', folded?.items?.length === 1)
    const view = spec?.wire?.view(folded)
    check('可用时视图不带提示', view?.unavailable === null)
    check('可用时视图保留建议', view?.items?.length === 1)
    // 关键机制：投影只在 state 引用变化时重算视图，运行时状态（写入面可用性）
    // 必须靠无关事件推进 rev 才能被 Client 看到。
    const bumped = spec?.apply(folded, { type: 'unrelated/event' })
    check('无关事件也推进 rev（视图才有机会重算）', bumped !== folded && bumped?.rev === folded.rev + 1)
    const sameView = spec?.wire?.view(bumped)
    check('内容未变时复用视图引用（不惊动 Client）', sameView === view)
    check('没有误报告警', harness.warns.length === 0)
  }

  if (name === 'no-reasoning') {
    check('写入了一条事件', harness.committed.length === 1)
    check('没有推理能力时不传推理档', harness.results.prepared?.reasoningEffort === undefined)
    check('请求没有失败', !log.includes('suggest/failed'))
  }

  if (name === 'truncated') {
    check('没有写入事件', harness.committed.length === 0)
    check('请求确实带 off（这里模拟模型不守约）', harness.results.options?.reasoningEffort === 'off')
    check('记录了截断诊断', log.includes('suggest/truncated'))
    check('诊断带 finish 原因', log.includes('"finish":"max-tokens"'))
    check('诊断带推理 token 数', log.includes('"reasoningTokens":600'))
    check('没有把空结果当成功', !log.includes('suggest/appended'))
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
    // 降级发生后才来的事件，必须还能把「不可用」带给 Client。
    const advanced = spec?.apply(spec.init({ id: 'selftest' }), { type: 'unrelated/event' })
    check('无关事件推进后视图仍带提示', spec?.wire?.view(advanced)?.unavailable !== null)
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

  if (name === 'auto-flash') {
    check('写入了一条事件', harness.committed.length === 1)
    check('换到了轻模型', harness.results.prepared?.model === 'test-flash')
    check('选型来源记为 auto', log.includes('"source":"auto"'))
    check('没有误判成降级', !log.includes('suggest/model-fallback'))
    check('列过一次目录', harness.calls.list === 1)
  }

  if (name === 'auto-none') {
    check('写入了一条事件', harness.committed.length === 1)
    check('目录里没有轻模型时沿用本轮模型', harness.results.prepared?.model === 'test')
    check('记录了「保持原样」的原因', log.includes('suggest/model-kept') && log.includes('"pool":2'))
    check('没有把它报成降级', !log.includes('suggest/model-fallback'))
  }

  if (name === 'auto-broken') {
    check('目录读不到时仍能出建议', harness.committed.length === 1)
    check('退回本轮模型', harness.results.prepared?.model === 'test')
    check('记录了探测失败原因', log.includes('suggest/model-kept') && log.includes('model catalog unavailable'))
  }

  if (name === 'fixed-ok') {
    check('写入了一条事件', harness.committed.length === 1)
    check('配置指定的模型生效', harness.results.prepared?.model === 'test-flash')
    check('选型来源记为 config', log.includes('"source":"config"'))
    check('固定模型时不必枚举目录', harness.calls.list === 0)
  }

  if (name === 'fixed-missing') {
    check('配置的模型不存在时仍能出建议', harness.committed.length === 1)
    check('退回本轮模型重试', harness.results.prepared?.model === 'test')
    check('一共请求了两次模型', harness.calls.llm === 2)
    check('记录了降级与原因', log.includes('suggest/model-fallback') && log.includes('UNKNOWN_MODEL ghost'))
  }

  if (name === 'session-pinned') {
    check('写入了一条事件', harness.committed.length === 1)
    check('session 模式不换模型', harness.results.prepared?.model === 'test')
    check('session 模式不枚举目录', harness.calls.list === 0)
    check('没有降级记录', !log.includes('suggest/model-fallback') && !log.includes('suggest/model-kept'))
  }

  if (name === 'auto-already-cheap') {
    check('写入了一条事件', harness.committed.length === 1)
    check('本轮已是轻模型就不换', harness.results.prepared?.model === 'test-flash')
    check('记录了保持原样的原因', log.includes('suggest/model-kept') && log.includes('already-cheap'))
    check('已经够便宜时不再枚举目录', harness.calls.list === 0)
  }

  if (name === 'timeout') {
    check('超时不写事件', harness.committed.length === 0)
    check('留下了超时诊断', log.includes('suggest/timeout'))
    check('诊断带阈值与耗时', log.includes('"timeoutMs":200') && log.includes('"ms":'))
    check('诊断标出阶段是流式阶段', log.includes('"phase":"stream"'))
    check('诊断带 finish 原因', log.includes('"finish":"aborted"'))
    check('没有把它记成成功', !log.includes('suggest/appended'))
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