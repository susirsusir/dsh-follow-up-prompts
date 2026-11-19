window.__ModuleLoader__.load({
  id: '@local/dsh-next-suggestions',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    /** 本插件在 locale 服务里的命名空间。 */
    const NS = 'next-suggestions'
    /** 与 Host 半保持一致：读取建议的 projection key。 */
    const PROJECTION_KEY = 'nextSuggestions'

    /** 组件内文案兜底（locale 未注册时也能显示英文）。 */
    const FALLBACK = {
      'suggestions.label': 'Next suggestions',
      'suggestion.send': 'Send',
      'suggestion.sendHint': 'Send this instruction',
      'suggestion.dismiss': 'Hide suggestions',
    }

    /** 两类词典；扁平点分 key，与 locale 服务约定一致。 */
    const en = {
      'suggestions.label': 'Next suggestions',
      'suggestion.send': 'Send',
      'suggestion.sendHint': 'Send this instruction',
      'suggestion.dismiss': 'Hide suggestions',
    }
    const zh = {
      'suggestions.label': '下一步建议',
      'suggestion.send': '发送',
      'suggestion.sendHint': '直接发送这条指令',
      'suggestion.dismiss': '隐藏这些建议',
    }

    const CSS = [
      // 整条与 composer 同宽，靠宿主的 stack gap 与输入框隔开。
      '.nsx-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,0px) * 2 - var(--dsh-composer-dock-inset,0px) * 4);margin:0 auto;}',
      '.nsx-row{display:flex;align-items:center;flex-wrap:nowrap;gap:6px;max-width:calc(var(--dsh-composer-card-max-width,100%) - var(--dsh-composer-dock-inset,0px) * 4);margin:0 auto;}',
      '.nsx-card{display:flex;align-items:center;flex:1 1 0;min-width:0;height:32px;box-sizing:border-box;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-specific-menu);}',
      '.nsx-label{flex:1 1 auto;min-width:0;height:100%;padding:0 12px;border:0;background:transparent;color:var(--dsw-alias-label-primary-dimmed);font:inherit;font-size:13px;line-height:20px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;transition:background-color 120ms ease,color 120ms ease;}',
      '.nsx-label:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.nsx-label:focus-visible,.nsx-send:focus-visible,.nsx-dismiss:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-label-primary));outline-offset:-2px;}',
      '.nsx-divider{flex:0 0 auto;align-self:stretch;width:1px;background:var(--dsw-alias-border-l2);}',
      '.nsx-send{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:26px;height:100%;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color 120ms ease,color 120ms ease;}',
      '.nsx-send:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.nsx-dismiss{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background-color 120ms ease,color 120ms ease;}',
      '.nsx-dismiss:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '@media (prefers-reduced-motion:no-preference){.nsx-card{animation:nsx-in 140ms ease-out;}@keyframes nsx-in{from{opacity:0;transform:translateY(2px);}to{opacity:1;transform:none;}}}',
      // 窄屏只保留第一条，避免两面都只剩省略号。
      '@media (max-width:560px){.nsx-card{flex:1 1 auto;}.nsx-card + .nsx-card{display:none;}}',
    ].join('')

    /** 向上箭头。 */
    function ArrowUpIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M8 12.6V3.6M4.3 7.3 8 3.6l3.7 3.7',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** 右向尖角。 */
    function ChevronRightIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M6.2 3.4 10.8 8l-4.6 4.6',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** 输入框上方的建议条。 */
    function NextSuggestionsDock(props) {
      const { useProjection, useInput, useSession, inputActions, sessionId, t } = props

      // 三个 hook 座位由 slot 保证存在；仍做函数存在性判断，避免宿主变体下崩溃。
      const projection = typeof useProjection === 'function' ? useProjection(PROJECTION_KEY) : undefined
      const draft = typeof useInput === 'function' ? useInput((state) => state.draft) : undefined
      const phase = typeof useInput === 'function' ? useInput((state) => state.phase) : undefined
      const running = typeof useSession === 'function' ? useSession((snapshot) => Boolean(snapshot && snapshot.running)) : false

      /** 用户主动隐藏的轮次：`{ sessionId, turn }`。 */
      const [dismissed, setDismissed] = useState(null)
      /** 等待输入框同步后直接发送的请求：`{ prompt, baseline }`。 */
      const [pendingSend, setPendingSend] = useState(null)

      const translate = useCallback(
        (key) => {
          let localized
          try {
            localized = typeof t === 'function' ? t(key) : undefined
          } catch {
            localized = undefined
          }
          if (typeof localized === 'string' && localized !== '' && localized !== key) return localized
          return FALLBACK[key] ?? key
        },
        [t],
      )

      const dismiss = useCallback(() => {
        const turn = projection && typeof projection.turn === 'number' ? projection.turn : 0
        setDismissed({ sessionId, turn })
      }, [projection, sessionId])

      // setDraft 通过编辑器异步投影回 InputState，等草稿真的变了再提交；
      // 文本未变化（或宿主处于审批态）时只把内容留在输入框，让用户自己按回车。
      useEffect(() => {
        if (pendingSend === null) return undefined
        const settle = () => {
          setPendingSend(null)
          if (phase !== 'plain') return
          try {
            inputActions.submit()
          } catch {
            // 宿主拒绝提交时保留已填入的文本，用户可手动发送。
          }
        }
        const landed = draft !== pendingSend.baseline
        if (landed) {
          settle()
          return undefined
        }
        const timer = setTimeout(settle, 600)
        return () => {
          clearTimeout(timer)
        }
      }, [draft, phase, pendingSend, inputActions])

      const fill = useCallback(
        (prompt) => {
          dismiss()
          inputActions.setDraft(prompt)
        },
        [dismiss, inputActions],
      )

      const sendNow = useCallback(
        (prompt) => {
          dismiss()
          setPendingSend({ prompt, baseline: typeof draft === 'string' ? draft : '' })
          inputActions.setDraft(prompt)
        },
        [dismiss, draft, inputActions],
      )

      const items = projection && Array.isArray(projection.items) ? projection.items : []
      if (items.length === 0) return null
      if (running) return null
      if (dismissed !== null && dismissed.sessionId === sessionId && dismissed.turn === projection.turn) return null

      const cards = []
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]
        if (item === null || typeof item !== 'object') continue
        const label = typeof item.label === 'string' ? item.label : ''
        const prompt = typeof item.prompt === 'string' ? item.prompt : ''
        if (label === '' || prompt === '') continue
        cards.push(
          h(
            'div',
            { key: `${projection.turn}-${index}`, className: 'nsx-card' },
            h(
              'button',
              {
                type: 'button',
                className: 'nsx-label',
                title: prompt,
                onClick: () => fill(prompt),
              },
              label,
            ),
            h('span', { className: 'nsx-divider', 'aria-hidden': true }),
            h(
              'button',
              {
                type: 'button',
                className: 'nsx-send',
                title: translate('suggestion.send'),
                'aria-label': translate('suggestion.sendHint'),
                onClick: () => sendNow(prompt),
              },
              h(ArrowUpIcon),
            ),
          ),
        )
      }
      if (cards.length === 0) return null

      return h(
        'div',
        { className: 'nsx-dock' },
        h('style', { key: 'nsx-style' }, CSS),
        h(
          'div',
          { className: 'nsx-row', role: 'group', 'aria-label': translate('suggestions.label') },
          cards,
          h(
            'button',
            {
              type: 'button',
              className: 'nsx-dismiss',
              title: translate('suggestion.dismiss'),
              'aria-label': translate('suggestion.dismiss'),
              onClick: dismiss,
            },
            h(ChevronRightIcon),
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'next-suggestions: dictionaries')
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'next-suggestions',
              order: 30,
              locale: NS,
            },
            NextSuggestionsDock,
          ),
        )
      },
    }
  },
})