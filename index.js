/**
 * Host 半：在一轮对话结束（turn/end 且 reason 为 completed）后，调用一次模型，
 * 让模型给出「下一步可以发送的指令」，并把结果作为自定义 durable 事件写入会话日志，
 * 由同名 projection 折叠成 Client 可直接读取的视图数据。
 */

import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 诊断日志路径：宿主日志不可见时用它定位「没有出现建议」的原因。 */
const DEBUG_FILE = join(tmpdir(), 'dsh-follow-up-prompts.log')

function debug(stage, detail) {
  try {
    const body = detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail)
    appendFileSync(DEBUG_FILE, `${new Date().toISOString()} [${stage}] ${body}\n`)
  } catch {
    // 诊断日志写不进去不影响插件功能。
  }
}

function describe(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * 写入面可用性：按会话记，只活在内存里。
 *
 * 它不进会话日志（写入面坏了就写不进去），也不进 projection state（旧会话
 * 恢复时会读到过期结论），只作为 `wire.view` 的输入：投影视图每次被读取时
 * 顺带带上当前结论，Client 据此把「没有建议」换成「建议功能不可用」。
 */
const availability = new Map()
/** 上限只防止异常情况下无限增长；正常使用远到不了。 */
const AVAILABILITY_LIMIT = 256

function noteAvailability(session, status) {
  const id = typeof session?.id === 'string' ? session.id : ''
  if (id === '') return
  availability.delete(id)
  availability.set(id, status)
  if (availability.size > AVAILABILITY_LIMIT) {
    const oldest = availability.keys().next().value
    if (oldest !== undefined) availability.delete(oldest)
  }
}

function markUnavailable(session, reason) {
  noteAvailability(session, { available: false, reason })
}

function markAvailable(session) {
  noteAvailability(session, { available: true, reason: '' })
}

/**
 * 同一个会话的同一个原因只报一次：既有宿主日志（`ctx.logger.warn`），
 * 也留一条诊断记录。升级导致写入面变化时，宿主日志能直接看到，不必去翻临时目录。
 */
function createReporter(ctx) {
  const reported = new Set()
  return (session, key, message) => {
    // 即使已经报过，也要让建议条切到「不可用」：状态是给用户看的，告警是给日志看的。
    markUnavailable(session, message)
    const scoped = `${typeof session?.id === 'string' ? session.id : ''}\u0000${key}`
    if (reported.has(scoped)) return
    reported.add(scoped)
    debug('guard/report', { key, message })
    try {
      ctx.logger?.warn?.(`[dsh-follow-up-prompts] ${message}`)
    } catch {
      // 宿主没有 logger 时只留诊断日志。
    }
  }
}

/** 降级时展示的空列表；固定引用，避免视图被误判成变化。 */
const NO_ITEMS = Object.freeze([])
/** Client 视图：未降级时就是折叠出的数据，降级时换成一行提示。按会话缓存。 */
const VIEW_CACHE_LIMIT = 32
const viewCache = new Map()

function viewOf(state) {
  const status = state.sessionId === '' ? undefined : availability.get(state.sessionId)
  const reason = status !== undefined && status.available === false ? status.reason : ''
  // 写入面不可用时，上一轮的建议已经过期，直接不展示，换成提示行。
  const items = reason === '' ? state.items : NO_ITEMS
  const cached = viewCache.get(state.sessionId)
  // 视图对象必须复用引用，否则每次驱赶都当作变化推给 Client。
  if (
    cached !== undefined &&
    cached.reason === reason &&
    cached.items === items &&
    cached.turn === state.turn &&
    cached.createdAt === state.createdAt
  ) {
    return cached.view
  }
  const view = {
    turn: state.turn,
    items,
    createdAt: state.createdAt,
    unavailable: reason === '' ? null : { reason },
  }
  viewCache.delete(state.sessionId)
  viewCache.set(state.sessionId, { reason, items, turn: state.turn, createdAt: state.createdAt, view })
  if (viewCache.size > VIEW_CACHE_LIMIT) {
    const oldest = viewCache.keys().next().value
    if (oldest !== undefined) viewCache.delete(oldest)
  }
  return view
}

/** projection key，Client 通过 useProjection('followUpPrompts') 读取。 */
const PROJECTION_KEY = 'followUpPrompts'
/**
 * 自定义 durable 事件类型。
 *
 * DSH 的持久化层只接受两类事件：核心白名单内的类型，或者带 `ignorable: true`
 * 标记的外部事件。外部插件必须用 `plugin:` 前缀声明自己的记录，否则读取端会
 * 拒绝解释整份日志（表现为「历史加载失败」）。
 */
const EVENT_TYPE = 'plugin:dsh-follow-up-prompts/ready'
/** 1.0.0 及更早版本写下的旧类型；读取端继续折叠，历史建议不会丢。 */
const LEGACY_EVENT_TYPE = 'follow-up-prompts/ready'
/** 单次模型请求的超时时间。 */
const REQUEST_TIMEOUT_MS = 20_000
/**
 * 建议请求的输出预算。
 *
 * 这里只要求三条短指令加一层 JSON 外壳，关掉推理后 1024 足够；留出余量是
 * 为了模型偶尔不守约（多写几条或加解释）时仍能解析，而不是写满预算。
 */
const SUGGESTION_MAX_TOKENS = 1_024
/** 最多保留三条建议；超出后由客户端横向滚动展示。 */
const MAX_SUGGESTIONS = 3
/** 单条建议与上下文的长度上限，避免把整轮长文塞进请求。 */
const MAX_PROMPT_CHARS = 80
const USER_EXCERPT_CHARS = 2_000
const ASSISTANT_EXCERPT_CHARS = 4_000

/**
 * 写入面守卫：`publicationEntry` 与 `commit` 是 DSH 的内部方法，没有对外契约，
 * 升级时可能被移除或收紧。它们不可用时建议既写不进日志、也折叠不出视图，
 * 所以必须显式报出来，而不是每轮静默丢弃。
 */
const REQUIRED_WRITE_METHODS = ['publicationEntry', 'commit']

/**
 * 自检开关：设为 1 时把本插件当作「写入面不可用」，用来在实际界面上确认
 * 提示行长什么样，而不用真的等一次 DSH 升级把它弄坏。
 */
const FORCE_ENV = 'DSH_FOLLOW_UP_PROMPTS_FORCE_UNAVAILABLE'

function forcedUnavailable() {
  try {
    return process.env[FORCE_ENV] === '1'
  } catch {
    return false
  }
}

/** 返回当前会话缺失的写入面方法名（空数组表示可用）。 */
function missingWriteMethods(session) {
  return REQUIRED_WRITE_METHODS.filter((name) => typeof session?.[name] !== 'function')
}

/**
 * 追加一条建议记录到会话日志。
 *
 * `session.append` 只接受 type/data 与 surface 选项，无法携带 `ignorable`
 * 标记，用它写外部类型会产出「未知且不可忽略」的事件，导致整份会话日志
 * 在校验时被拒绝（历史加载失败）。这里改为自行构造完整信封，再交给
 * `session.commit`：它负责顺序校验、写盘与观察者通知。
 *
 * 写入面缺失时抛出带固定前缀的错误，调用方据此降级并报一次告警。
 */
function appendReadyRecord(session, payload) {
  const missing = missingWriteMethods(session)
  if (missing.length !== 0) throw new Error(`write surface missing: ${missing.join(', ')}`)
  const entry = session.publicationEntry()
  const event = Object.freeze({
    type: EVENT_TYPE,
    seq: session.seq,
    time: Date.now(),
    data: payload,
    ignorable: true,
  })
  session.commit(event, entry)
  markAvailable(session)
}

const SYSTEM_PROMPT = [
  'You suggest the next instructions a user may want to send after an assistant turn.',
  '',
  'Rules:',
  '- Read the user request and the assistant answer below.',
  '- Each suggestion is one complete instruction the user can send as-is: what the user reads is exactly what gets sent.',
  '- Start with a verb, keep it under 40 characters, and write it in the same language as the user request.',
  '- Never repeat the previous request, never restate what was just completed, never add explanations.',
  '- Return 2 or 3 distinct suggestions, ordered by how likely the user wants them next.',
  '- Reply with JSON only, no markdown fence: {"suggestions":[{"prompt":"..."}]}',
].join('\n')

export const inject = ['llm', 'sessionProjections']

export function apply(ctx) {
  /** 按会话累积本轮的输入、输出与模型路由（WeakMap 不会阻止会话被回收）。 */
  const states = new WeakMap()
  const report = createReporter(ctx)
  /** 每个会话首次见到时检查一次写入面，让「升级后不兼容」在第一条事件上就现形。 */
  const probed = new WeakSet()

  const stateOf = (session) => {
    let state = states.get(session)
    if (state === undefined) {
      state = { turn: 0, route: undefined, user: '', assistant: '', busy: false, hasItems: false, controller: undefined }
      states.set(session, state)
    }
    return state
  }

  /** 日志只写不读：这里把写入结果暴露成视图。 */
  const projection = ctx.effect(() => {
    let handle
    let disposed = false
    void ctx.sessionProjections
      .register({
        key: PROJECTION_KEY,
        // 纯 JS 插件不依赖 zod，运行时只需要 parse 方法存在。
        stateSchema: { parse: (value) => value },
        // sessionId 进入 state，视图才能查到该会话的运行时可用性。
        init: (header) => ({
          sessionId: typeof header?.id === 'string' ? header.id : '',
          turn: 0,
          items: [],
          createdAt: 0,
          rev: 0,
        }),
        apply: (state, event) => {
          // 每条事件都推进一次 rev：投影只在 state 引用变化时才重算视图，
          // 而「写入面是否可用」是运行时状态、不可能写进日志。少了这一步，
          // 可用性一变 Client 也读不到，提示行永远不会出现。
          const rev = (Number(state.rev) || 0) + 1
          // 新旧两种记录都折叠，保证升级后历史建议仍然可见。
          if (event.type !== EVENT_TYPE && event.type !== LEGACY_EVENT_TYPE) return { ...state, rev }
          const data = event.data
          if (data === null || typeof data !== 'object' || !Array.isArray(data.items)) return { ...state, rev }
          return {
            ...state,
            rev,
            turn: Number(data.turn) || 0,
            items: data.items,
            createdAt: Number(data.createdAt) || 0,
          }
        },
        wire: {
          viewSchema: { parse: (value) => value },
          view: viewOf,
        },
        // rev 让旧 checkpoints 的重放计数与新版本不一致，索性整体作废一次。
        stateVersion: 3,
      })
      .then(
        (value) => {
          handle = value
          if (disposed) void value.dispose()
        },
        (error) => {
          debug('projection/failed', describe(error))
          // key 冲突等注册失败只影响本插件，不打断会话。
        },
      )
    return () => {
      disposed = true
      void handle?.dispose()
    }
  }, 'follow-up-prompts: projection')

  const onEvent = (session, event) => {
    if (event === null || typeof event !== 'object') return
    if (!probed.has(session)) {
      probed.add(session)
      // 子会话本来就不产生建议，不必为它探测写入面，也不会在子会话界面挂提示。
      if (session.header?.origin !== 'subagent') {
        if (forcedUnavailable()) {
          report(session, 'forced', `建议功能不可用（${FORCE_ENV}=1，自检用）`)
          return
        }
        const missing = missingWriteMethods(session)
        if (missing.length !== 0) {
          report(session, 'write-surface', `当前 DSH 未提供 ${missing.join(' / ')}，建议功能不可用（本轮起不再请求模型）`)
        }
      }
    }
    const type = event.type
    const data = event.data

    if (type === 'request/header') {
      const config = data?.header?.config
      if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
        stateOf(session).route = {
          provider: config.provider,
          model: config.model,
          ...(typeof config.reasoningEffort === 'string' ? { reasoningEffort: config.reasoningEffort } : {}),
        }
      }
      return
    }

    if (type === 'turn/start') {
      const state = stateOf(session)
      state.turn = Number(data?.turn) || 0
      state.user = ''
      state.assistant = ''
      // 新一轮开始时取消上一轮还在路上的请求，并清空旧建议，避免结束时闪回上一条。
      state.controller?.abort()
      state.controller = undefined
      if (state.hasItems) {
        state.hasItems = false
        const turn = state.turn
        setTimeout(() => {
          try {
            appendReadyRecord(session, { turn, items: [], createdAt: 0 })
          } catch (error) {
            // 会话已销毁时同样落到这里：只记一条，不打断新一轮。
            debug('guard/clear-failed', { turn, error: describe(error) })
            report(session, `clear:${describe(error)}`, `清空上一轮建议失败：${describe(error)}`)
          }
        }, 0)
      }
      return
    }

    if (type === 'user/message') {
      // 只统计真人输入，工具或注入的消息不算。
      if (data?.source?.kind !== 'user') return
      const text = textOf(data.content)
      if (text !== '') stateOf(session).user = text
      return
    }

    if (type === 'assistant/message') {
      const text = textOf(data?.message?.content)
      if (text === '') return
      const state = stateOf(session)
      state.assistant = state.assistant === '' ? text : `${state.assistant}\n\n${text}`
      return
    }

    if (type !== 'turn/end') return

    const reason = data?.reason?.kind
    const state = stateOf(session)
    const snapshot = {
      turn: Number(data?.turn) || state.turn,
      user: state.user,
      assistant: state.assistant,
    }
    // 只有正常完成且确实有助手输出才给建议。
    if (reason !== 'completed') {
      debug('skip/reason', { turn: snapshot.turn, reason })
      return
    }
    if (snapshot.assistant.trim() === '') {
      debug('skip/empty-assistant', { turn: snapshot.turn })
      return
    }
    if (session.header?.origin === 'subagent') {
      debug('skip/subagent', { turn: snapshot.turn })
      return
    }
    // append 在发布边界内会被拒绝，所以先让出一拍再做外部调用。
    setTimeout(() => {
      void suggest(session, snapshot)
    }, 0)
  }

  const suggest = async (session, snapshot) => {
    const state = stateOf(session)
    if (state.busy) return
    // 写入面不可用时建议写不进日志、也折叠不出视图，直接跳过，别白烧一次模型调用。
    const missing = missingWriteMethods(session)
    if (missing.length !== 0) {
      debug('skip/no-write-surface', { turn: snapshot.turn, missing })
      return
    }
    if (forcedUnavailable()) {
      debug('skip/forced-unavailable', { turn: snapshot.turn })
      return
    }
    // 请求头事件只在配置变化时写入，长时间未变更时会缺省，因此优先读会话缓存的 header。
    const route = readRoute(session) ?? state.route
    if (route === undefined) {
      debug('skip/no-route', { turn: snapshot.turn })
      return
    }
    debug('suggest/start', {
      turn: snapshot.turn,
      route,
      userChars: snapshot.user.length,
      assistantChars: snapshot.assistant.length,
    })

    state.busy = true
    const controller = new AbortController()
    state.controller = controller
    const timer = setTimeout(() => {
      controller.abort()
    }, REQUEST_TIMEOUT_MS)
    let text = ''
    let finish
    let usage
    const startedAt = Date.now()
    try {
      // 先按模型声明的能力挑推理档，再派发：直接在 stream 里沿用本轮强度会
      // 让推理模型把预算花在思考上（见 cheapestEffort）。prepareCall 解析出的
      // 配置必须原样回传，否则宿主以 INVALID_PREPARED_CALL 拒绝派发。
      const prepared = await ctx.llm.prepareCall(
        {
          provider: route.provider,
          model: route.model,
          temperature: 0.5,
          maxTokens: SUGGESTION_MAX_TOKENS,
        },
        controller.signal,
        (controls, model) => {
          const effort = cheapestEffort(model?.reasoning)
          return effort === undefined ? controls : { ...controls, reasoningEffort: effort }
        },
      )
      const stream = prepared.stream({
        ...prepared.config,
        messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt(snapshot) }] }],
        system: SYSTEM_PROMPT,
        sessionId: session.id,
        signal: controller.signal,
      })
      debug('suggest/controls', {
        turn: snapshot.turn,
        routeEffort: route.reasoningEffort ?? null,
        reasoningEffort: prepared.config.reasoningEffort ?? null,
        maxTokens: prepared.config.maxTokens ?? null,
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        else if (chunk?.type === 'finish') finish = chunk.reason?.kind
        else if (chunk?.type === 'usage') usage = chunk.usage
      }
    } catch (error) {
      debug('suggest/failed', { turn: snapshot.turn, error: describe(error) })
      return
    } finally {
      clearTimeout(timer)
      state.busy = false
      if (state.controller === controller) state.controller = undefined
    }

    const items = parseSuggestions(text)
    const elapsedMs = Date.now() - startedAt
    debug('suggest/parsed', {
      turn: snapshot.turn,
      chars: text.length,
      items: items.length,
      finish: finish ?? 'none',
      reasoningTokens: usage?.reasoningTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      ms: elapsedMs,
    })
    if (items.length === 0) {
      // 预算被推理吃光时文本为空、finish 为 max-tokens；留一条能直接定位的
      // 记录，而不是每轮静默不显示建议。
      if (finish === 'max-tokens') {
        debug('suggest/truncated', {
          turn: snapshot.turn,
          chars: text.length,
          reasoningTokens: usage?.reasoningTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          ms: elapsedMs,
        })
      }
      return
    }
    try {
      appendReadyRecord(session, { turn: snapshot.turn, items, createdAt: Date.now() })
      state.hasItems = true
      debug('suggest/appended', { turn: snapshot.turn, items: items.length })
    } catch (error) {
      debug('suggest/append-failed', { turn: snapshot.turn, error: describe(error) })
      // 会话已销毁或数据不可序列化时静默放弃；同样的原因只告警一次。
      report(session, `append:${describe(error)}`, `第 ${snapshot.turn} 轮建议写入失败：${describe(error)}`)
    }
  }

  ctx.on('session/event', onEvent)
  // projection 注册依赖 effect 清理，这里只保证 effect 被引用以免被裁剪。
  void projection
}

/** 从会话缓存的请求头里读出模型路由。 */
function readRoute(session) {
  try {
    const config = session.requestHeader?.()?.config
    if (typeof config?.provider !== 'string' || typeof config?.model !== 'string') return undefined
    return {
      provider: config.provider,
      model: config.model,
      ...(typeof config.reasoningEffort === 'string' ? { reasoningEffort: config.reasoningEffort } : {}),
    }
  } catch {
    // 会话未建立请求头时退回事件累积的路由。
    return undefined
  }
}

/** 把内容块数组拼接成纯文本。 */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n\n').trim()
}

/**
 * 从模型声明的推理档里挑最省的一档。
 *
 * 生成建议只是照抄三条短指令，推理没有收益，反而会吃掉输出预算：V4-Pro 在
 * high 档会把整个预算花在 reasoning 上，可见文本为 0，建议条就再也不出现。
 * 各 adapter 都按「由弱到强」声明档位，因此优先取 off；没有 off 时取第一档。
 * 模型没有推理能力（`reasoning` 缺省）时返回 undefined，表示不要传推理档，
 * 否则宿主会以 UNSUPPORTED_REASONING_EFFORT 拒绝整个请求。
 */
function cheapestEffort(reasoning) {
  if (reasoning === null || typeof reasoning !== 'object' || !Array.isArray(reasoning.efforts)) return undefined
  for (const effort of reasoning.efforts) {
    if (effort?.id === 'off') return 'off'
  }
  const first = reasoning.efforts[0]?.id
  return typeof first === 'string' ? first : undefined
}

/** 构造给模型的提示词：用户请求 + 助手回答摘要。 */
function buildPrompt(snapshot) {
  const user = clip(snapshot.user, USER_EXCERPT_CHARS)
  const assistant = clip(snapshot.assistant, ASSISTANT_EXCERPT_CHARS)
  return ['<user_request>', user, '</user_request>', '', '<assistant_answer>', assistant, '</assistant_answer>'].join('\n')
}

/** 解析模型输出，容忍代码围栏、前后缀文本与非法结构。 */
function parseSuggestions(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return []

  const candidates = []
  const candidatesFrom = (parsed) => {
    if (Array.isArray(parsed)) candidates.push(...parsed)
    else if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.suggestions)) {
      candidates.push(...parsed.suggestions)
    }
  }
  const objectStart = text.indexOf('{')
  const objectEnd = text.lastIndexOf('}')
  if (objectStart !== -1 && objectEnd > objectStart) {
    try {
      candidatesFrom(JSON.parse(text.slice(objectStart, objectEnd + 1)))
    } catch {
      // 继续尝试数组形态。
    }
  }
  if (candidates.length === 0) {
    const arrayStart = text.indexOf('[')
    const arrayEnd = text.lastIndexOf(']')
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
      try {
        candidatesFrom(JSON.parse(text.slice(arrayStart, arrayEnd + 1)))
      } catch {
        // 模型没按约定输出，放弃本轮建议。
      }
    }
  }

  const items = []
  for (const candidate of candidates) {
    if (items.length >= MAX_SUGGESTIONS) break
    if (candidate === null || typeof candidate !== 'object') continue
    // 建议只保留一段文本：显示的就是发送的，避免卡片文案与实际发送内容不一致。
    const raw = typeof candidate.prompt === 'string' ? candidate.prompt : candidate.label
    const prompt = typeof raw === 'string' ? raw.trim() : ''
    if (prompt === '') continue
    const item = { prompt: clip(prompt, MAX_PROMPT_CHARS) }
    if (items.some((existing) => existing.prompt === item.prompt)) continue
    items.push(item)
  }
  return items
}

/** 超长时在最近的标点处收短，不添加省略号（界面上要求完整可读）。 */
function clip(text, limit) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (value.length <= limit) return value
  const head = value.slice(0, limit)
  const boundaries = ['\u3002', '\uff1b', '\uff0c', '\u3001', '. ', '; ', ', ', ' ']
  let cut = -1
  for (const mark of boundaries) {
    const index = head.lastIndexOf(mark)
    if (index > cut) cut = index
  }
  const kept = cut > limit * 0.5 ? head.slice(0, cut) : head
  return kept.trimEnd()
}