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

/** projection key，Client 通过 useProjection('followUpPrompts') 读取。 */
const PROJECTION_KEY = 'followUpPrompts'
/** 自定义 durable 事件类型（日志永不丢失，重放后建议仍在）。 */
const EVENT_TYPE = 'follow-up-prompts/ready'
/** 单次模型请求的超时时间。 */
const REQUEST_TIMEOUT_MS = 20_000
/** 最多保留三条建议；超出后由客户端横向滚动展示。 */
const MAX_SUGGESTIONS = 3
/** 单条建议与上下文的长度上限，避免把整轮长文塞进请求。 */
const MAX_PROMPT_CHARS = 120
const USER_EXCERPT_CHARS = 2_000
const ASSISTANT_EXCERPT_CHARS = 4_000

const SYSTEM_PROMPT = [
  'You suggest the next instructions a user may want to send after an assistant turn.',
  '',
  'Rules:',
  '- Read the user request and the assistant answer below.',
  '- Each suggestion is one complete instruction the user can send as-is: what the user reads is exactly what gets sent.',
  '- Start with a verb, keep it under 70 characters, and write it in the same language as the user request.',
  '- Never repeat the previous request, never restate what was just completed, never add explanations.',
  '- Return 2 or 3 distinct suggestions, ordered by how likely the user wants them next.',
  '- Reply with JSON only, no markdown fence: {"suggestions":[{"prompt":"..."}]}',
].join('\n')

export const inject = ['llm', 'sessionProjections']

export function apply(ctx) {
  /** 按会话累积本轮的输入、输出与模型路由（WeakMap 不会阻止会话被回收）。 */
  const states = new WeakMap()

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
        init: () => ({ turn: 0, items: [], createdAt: 0 }),
        apply: (state, event) => {
          if (event.type !== EVENT_TYPE) return state
          const data = event.data
          if (data === null || typeof data !== 'object' || !Array.isArray(data.items)) return state
          return { turn: Number(data.turn) || 0, items: data.items, createdAt: Number(data.createdAt) || 0 }
        },
        wire: {
          viewSchema: { parse: (value) => value },
          view: (state) => state,
        },
        stateVersion: 1,
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
            session.append(EVENT_TYPE, { turn, items: [], createdAt: 0 })
          } catch {
            // 会话已销毁时忽略。
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
    try {
      const stream = ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
        messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt(snapshot) }] }],
        system: SYSTEM_PROMPT,
        maxTokens: 600,
        temperature: 0.5,
        sessionId: session.id,
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
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
    debug('suggest/parsed', { turn: snapshot.turn, chars: text.length, items: items.length })
    if (items.length === 0) return
    try {
      session.append(EVENT_TYPE, { turn: snapshot.turn, items, createdAt: Date.now() })
      state.hasItems = true
      debug('suggest/appended', { turn: snapshot.turn, items: items.length })
    } catch (error) {
      debug('suggest/append-failed', { turn: snapshot.turn, error: describe(error) })
      // 会话已销毁或数据不可序列化时静默放弃。
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