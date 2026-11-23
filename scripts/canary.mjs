#!/usr/bin/env node
/**
 * 升级后自检（canary）：确认本插件写进会话日志的事件仍然「可被读取端接受」。
 *
 * 背景：本插件用 `plugin:` 前缀 + `ignorable: true` 写自定义事件。DSH 读取端对
 * 「未知且不可忽略」的事件是 fail-closed 的——整份会话日志会被拒绝解释，表现为
 * 「历史加载失败」。这条规则和写入面都不在对外契约里，升级后可能变化，所以每次
 * 升级 DSH 之后跑一遍这个脚本，比等到某个会话打不开才发现要早。
 *
 * 只读，不修改任何文件。用法：
 *   node scripts/canary.mjs                 # 默认扫 ~/.dsh/sessions，最近 14 天
 *   node scripts/canary.mjs --days 3        # 只看最近 3 天写过的会话
 *   node scripts/canary.mjs --dir <path>    # 指定会话目录
 *   node scripts/canary.mjs --all           # 全量扫描（包括很旧的会话）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const EVENT_TYPE = 'plugin:dsh-follow-up-prompts/ready'
const LEGACY_EVENT_TYPE = 'follow-up-prompts/ready'
const ZSTD_MAGIC = 0xfd2fb528
const SESSION_FILE = 'session.v4.jsonl.zstd'

/** 解析命令行参数；只支持长选项，保持零依赖。 */
function parseArgs(argv) {
  const options = { dir: path.join(os.homedir(), '.dsh', 'sessions'), days: 14, all: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--all') options.all = true
    else if (arg === '--days') options.days = Number(argv[(index += 1)])
    else if (arg === '--dir') options.dir = path.resolve(argv[(index += 1)])
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  if (!Number.isFinite(options.days) || options.days <= 0) throw new Error('--days 需要正整数')
  return options
}

/**
 * 会话日志是多个 zstd 帧首尾相接写成的，`zstdDecompressSync` 只认第一帧，
 * 因此先按帧格式切分再逐帧解压。这里只需要切分，不重写文件。
 */
function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, torn: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`帧魔数不符（偏移 ${offset}）`)
    offset += 4
    if (offset === buffer.length) return { frames, torn: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remaining = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remaining) return { frames, torn: start }
    offset += remaining
    for (;;) {
      if (buffer.length - offset < 3) return { frames, torn: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const last = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`保留的块类型（偏移 ${offset}）`)
      const payload = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payload) return { frames, torn: start }
      offset += payload
      if (last) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, torn: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** 递归收集会话日志，跳过修复过程留下的备份与临时文件。 */
function collectSessionFiles(root) {
  const files = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === SESSION_FILE) files.push(full)
    }
  }
  walk(root)
  return files
}

/** 逐行读事件；返回事件数组与解析错误的行号，供 canary 判断日志是否健康。 */
function readEvents(file) {
  const buffer = fs.readFileSync(file)
  const { frames, torn } = scanFrames(buffer)
  if (torn !== undefined) throw new Error(`尾部存在不完整帧（偏移 ${torn}）`)
  let text = ''
  for (const { start, end } of frames) text += zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
  const events = []
  const badLines = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      badLines.push(index + 1)
    }
  }
  return { events, badLines, frames: frames.length }
}

/** 检查单个会话，返回该会话的问题列表。 */
function inspect(file) {
  const problems = []
  const notes = []
  let parsed
  try {
    parsed = readEvents(file)
  } catch (error) {
    problems.push(`日志无法解析：${error.message}`)
    return { problems, notes }
  }
  const { events, badLines } = parsed
  if (badLines.length !== 0) problems.push(`${badLines.length} 行不是合法 JSON（第 ${badLines.slice(0, 3).join(', ')} 行）`)

  let own = 0
  let legacy = 0
  let legacyReadable = 0
  let lastOwnTime = 0
  let lastOwnSeq = 0
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type === EVENT_TYPE) {
      own += 1
      // 读取端只放行「带 ignorable 的未知事件」，缺了这个标记整份日志会被拒绝。
      if (event.ignorable !== true) problems.push(`seq ${event.seq} 的 ${EVENT_TYPE} 缺少 ignorable 标记`)
      if (event.data === null || typeof event.data !== 'object' || !Array.isArray(event.data.items)) {
        problems.push(`seq ${event.seq} 的 ${EVENT_TYPE} 数据形状不符（缺少 items 数组）`)
      }
      const time = Number(event.time) || 0
      if (time >= lastOwnTime) {
        lastOwnTime = time
        lastOwnSeq = Number(event.seq) || 0
      }
      continue
    }
    if (event.type === LEGACY_EVENT_TYPE) {
      legacy += 1
      // 旧类型对读取端来说是未知事件：没有 ignorable 就会让会话打不开。
      if (event.ignorable !== true) problems.push(`seq ${event.seq} 使用旧类型 ${LEGACY_EVENT_TYPE} 且缺少 ignorable，会导致历史加载失败`)
      else legacyReadable += 1
      const time = Number(event.time) || 0
      if (time >= lastOwnTime) {
        lastOwnTime = time
        lastOwnSeq = Number(event.seq) || 0
      }
    }
  }

  if (legacyReadable !== 0) {
    notes.push(`${legacyReadable} 条旧类型 ${LEGACY_EVENT_TYPE} 事件（带 ignorable，读取端仍会折叠，只是历史遗留）`)
  }
  return { problems, notes, own, legacy, lastOwnTime, lastOwnSeq, events: events.length }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('用法：node scripts/canary.mjs [--dir <会话目录>] [--days <N>] [--all]')
    return 0
  }
  const now = Date.now()
  const windowMs = (options.all ? Infinity : options.days) * 24 * 60 * 60 * 1000
  const files = collectSessionFiles(options.dir)
  if (files.length === 0) {
    console.error(`未找到任何 ${SESSION_FILE}：${options.dir}`)
    return 2
  }

  const failures = []
  const warnings = []
  let ownTotal = 0
  let legacyTotal = 0
  let latestOwn = 0
  let scanned = 0
  let skipped = 0

  for (const file of files) {
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }
    // 窗口外且没有历史问题的文件直接跳过，避免每次扫描都解压全部历史。
    if (!options.all && now - stat.mtimeMs > windowMs) {
      skipped += 1
      continue
    }
    scanned += 1
    const result = inspect(file)
    const short = path.relative(options.dir, path.dirname(file)) || path.basename(path.dirname(file))
    for (const problem of result.problems) failures.push(`${short}: ${problem}`)
    for (const note of result.notes) warnings.push(`${short}: ${note}`)
    ownTotal += result.own ?? 0
    legacyTotal += result.legacy ?? 0
    if (result.lastOwnTime !== undefined && result.lastOwnTime > latestOwn) latestOwn = result.lastOwnTime
  }

  const lines = []
  lines.push(`扫描目录：${options.dir}`)
  lines.push(`会话文件：${files.length}（扫描 ${scanned}，跳过 ${skipped}，窗口 ${options.all ? '全部' : `${options.days} 天`}）`)
  lines.push(`本插件事件：${ownTotal} 条；旧类型事件：${legacyTotal} 条`)
  lines.push(`最近一次写入：${latestOwn === 0 ? '无' : new Date(latestOwn).toISOString()}`)

  if (ownTotal === 0) {
    warnings.push(
      '窗口内没有找到任何本插件事件：要么这段时间没有完成过对话，要么写入面已经失效（升级后常见），先看宿主日志里有没有 [dsh-follow-up-prompts] 告警',
    )
  }
  if (failures.length !== 0) {
    lines.push('', `❌ 发现 ${failures.length} 个问题：`)
    for (const failure of failures.slice(0, 20)) lines.push(`  - ${failure}`)
    if (failures.length > 20) lines.push(`  …… 其余 ${failures.length - 20} 条省略`)
    lines.push('', '修复方式：给这些事件补 ignorable 标记（旧的 /tmp/repair_session.mjs 思路），或删除对应的旧版本进程后再恢复会话。')
  }
  if (warnings.length !== 0) {
    lines.push('', `⚠️  ${warnings.length} 条提示：`)
    for (const warning of warnings.slice(0, 10)) lines.push(`  - ${warning}`)
    if (warnings.length > 10) lines.push(`  …… 其余 ${warnings.length - 10} 条省略`)
  }
  if (failures.length === 0 && ownTotal > 0) lines.push('', '✅ 未发现会让会话打不开的事件。')

  console.log(lines.join('\n'))
  return failures.length === 0 ? 0 : 1
}

process.exitCode = main()