window.__ModuleLoader__.load({
  id: '@local/dsh-follow-up-prompts',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** 本插件在 locale 服务里的命名空间。 */
    const NS = 'follow-up-prompts'
    /** 与 Host 半保持一致：读取建议的 projection key。 */
    const PROJECTION_KEY = 'followUpPrompts'

    /** 组件内文案兜底（locale 未注册时也能显示英文）。 */
    const FALLBACK = {
      'suggestions.label': 'Follow-up prompts',
      'suggestion.send': 'Send',
      'suggestion.sendHint': 'Send this instruction',
      'suggestion.dismiss': 'Hide these suggestions',
      'nav.prev': 'Scroll suggestions left',
      'nav.next': 'Scroll suggestions right',
    }

    /** 两类词典；扁平点分 key，与 locale 服务约定一致。 */
    const en = {
      'suggestions.label': 'Follow-up prompts',
      'suggestion.send': 'Send',
      'suggestion.sendHint': 'Send this instruction',
      'suggestion.dismiss': 'Hide these suggestions',
      'nav.prev': 'Scroll suggestions left',
      'nav.next': 'Scroll suggestions right',
    }
    const zh = {
      'suggestions.label': '后续指令建议',
      'suggestion.send': '发送',
      'suggestion.sendHint': '直接发送这条指令',
      'suggestion.dismiss': '收起这些建议',
      'nav.prev': '向左查看更多建议',
      'nav.next': '向右查看更多建议',
    }

    const CSS = [
      // 整条与 composer 同宽，靠宿主的 stack gap 与输入框隔开。
      '.nsx-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,0px) * 2 - var(--dsh-composer-dock-inset,0px) * 4);margin:0 auto;}',
      '.nsx-bar{display:flex;align-items:center;max-width:calc(var(--dsh-composer-card-max-width,100%) - var(--dsh-composer-dock-inset,0px) * 4);margin:0 auto;}',
      '.nsx-row{position:relative;flex:1 1 auto;min-width:0;}',
      // 建议横向排列；放不下时在这里横向滚动，滚动条隐藏，靠两端箭头提示还有内容。
      '.nsx-viewport{display:flex;align-items:center;gap:6px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;-ms-overflow-style:none;}',
      '.nsx-viewport::-webkit-scrollbar{display:none;}',
      '.nsx-card{display:flex;flex:1 1 0;min-width:200px;align-items:center;height:32px;box-sizing:border-box;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-specific-menu);}',
      '.nsx-label{flex:1 1 auto;min-width:0;height:100%;padding:0 12px;border:0;background:transparent;color:var(--dsw-alias-label-primary-dimmed);font:inherit;font-size:13px;line-height:20px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;transition:background-color 120ms ease,color 120ms ease;}',
      '.nsx-label:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.nsx-label:focus-visible,.nsx-send:focus-visible,.nsx-nav:focus-visible,.nsx-dismiss:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-label-primary));outline-offset:-2px;}',
      '.nsx-divider{flex:0 0 auto;align-self:stretch;width:1px;background:var(--dsw-alias-border-l2);}',
      '.nsx-send{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:26px;height:100%;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color 120ms ease,color 120ms ease;}',
      '.nsx-send:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      // 两端箭头贴在建议条外侧，不占滚动区域的宽度，避免出现与消失引起抖动。
      '.nsx-nav{position:absolute;top:50%;z-index:2;display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-tertiary);cursor:pointer;transform:translateY(-50%);transition:background-color 120ms ease,color 120ms ease;}',
      '.nsx-nav:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.nsx-nav-prev{left:-30px;}',
      '.nsx-nav-next{right:-30px;}',
      // 收起按钮始终占位，只在悬停或键盘聚焦时显形，避免出现与消失时整条跳动。
      '.nsx-dismiss{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:24px;height:24px;margin-left:6px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;opacity:0;pointer-events:none;transition:opacity 120ms ease,background-color 120ms ease,color 120ms ease;}',
      '.nsx-bar:hover .nsx-dismiss,.nsx-dismiss:focus-visible{opacity:1;pointer-events:auto;}',
      '.nsx-dismiss:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '@media (prefers-reduced-motion:no-preference){.nsx-card{animation:nsx-in 140ms ease-out;}@keyframes nsx-in{from{opacity:0;transform:translateY(2px);}to{opacity:1;transform:none;}}}',
      // 窄屏没有外侧空间：箭头压在滚动区域两端，用 padding 让内容不被盖住。
      '@media (max-width:600px){.nsx-nav-prev{left:0;}.nsx-nav-next{right:0;}.nsx-viewport{padding:0 28px;}}',
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

    /** 左向尖角。 */
    function ChevronLeftIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M9.8 3.4 5.2 8l4.6 4.6',
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

    /** 收起用的叉号。 */
    function CloseIcon() {
      return h(
        'svg',
        { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      )
    }

    /** 输入框上方的建议条。 */
    function FollowUpPromptsDock(props) {
      const { useProjection, useInput, useSession, inputActions, sessionId, t } = props

      // 三个 hook 座位由 slot 保证存在；仍做函数存在性判断，避免宿主变体下崩溃。
      const projection = typeof useProjection === 'function' ? useProjection(PROJECTION_KEY) : undefined
      const draft = typeof useInput === 'function' ? useInput((state) => state.draft) : undefined
      const phase = typeof useInput === 'function' ? useInput((state) => state.phase) : undefined
      const running = typeof useSession === 'function' ? useSession((snapshot) => Boolean(snapshot && snapshot.running)) : false

      const items = projection && Array.isArray(projection.items) ? projection.items : []
      const turn = projection && typeof projection.turn === 'number' ? projection.turn : 0

      /** 用户主动收起的轮次：`{ sessionId, turn }`。 */
      const [dismissed, setDismissed] = useState(null)
      /** 等待输入框同步后直接发送的请求：`{ prompt, baseline }`。 */
      const [pendingSend, setPendingSend] = useState(null)
      /** 左右两端是否还能滚动；只在状态真的变化时更新，避免多余渲染。 */
      const [edges, setEdges] = useState({ left: false, right: false })
      /** 横向滚动容器。 */
      const viewportRef = useRef(null)

      const hidden = dismissed !== null && dismissed.sessionId === sessionId && dismissed.turn === turn

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
        setDismissed({ sessionId, turn })
      }, [sessionId, turn])

      // Esc 收起本轮建议；用户正在输入框里按 Esc 时也生效，因为建议条只是辅助信息。
      useEffect(() => {
        if (hidden) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return
          dismiss()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [hidden, dismiss])

      /** 重新测量两端是否还有未展示的建议。 */
      const measure = useCallback(() => {
        const node = viewportRef.current
        if (node === undefined || node === null) {
          setEdges((prev) => (prev.left || prev.right ? { left: false, right: false } : prev))
          return
        }
        const max = node.scrollWidth - node.clientWidth
        const left = node.scrollLeft > 1
        const right = max > 1 && node.scrollLeft < max - 1
        setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }))
      }, [])

      // 建议变化或容器尺寸变化时重新测量；滚动过程中同步更新，让两端箭头跟着出现和消失。
      useEffect(() => {
        const node = viewportRef.current
        if (node === undefined || node === null) return undefined
        measure()
        node.addEventListener('scroll', measure, { passive: true })
        let observer
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(measure)
          observer.observe(node)
        }
        return () => {
          node.removeEventListener('scroll', measure)
          if (observer !== undefined) observer.disconnect()
        }
      }, [measure, turn, items.length])

      /** 滚到某一端：点箭头一次就滑到最左或最右。 */
      const scrollToEdge = useCallback((edge) => {
        const node = viewportRef.current
        if (node === undefined || node === null) return
        const max = node.scrollWidth - node.clientWidth
        node.scrollTo({ left: edge === 'start' ? 0 : max, behavior: 'smooth' })
      }, [])

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
          inputActions.setDraft(prompt)
        },
        [inputActions],
      )

      const sendNow = useCallback(
        (prompt) => {
          setPendingSend({ prompt, baseline: typeof draft === 'string' ? draft : '' })
          inputActions.setDraft(prompt)
        },
        [draft, inputActions],
      )

      if (items.length === 0) return null
      if (running) return null
      if (hidden) return null

      const cards = []
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]
        if (item === null || typeof item !== 'object') continue
        // 显示的就是发送的：统一取 prompt，兼容早期只写了 label 的历史数据。
        const raw = typeof item.prompt === 'string' ? item.prompt : item.label
        const text = typeof raw === 'string' ? raw.trim() : ''
        if (text === '') continue
        cards.push(
          h(
            'div',
            { key: `${turn}-${index}`, className: 'nsx-card' },
            h(
              'button',
              {
                type: 'button',
                className: 'nsx-label',
                title: text,
                onClick: () => fill(text),
              },
              text,
            ),
            h('span', { className: 'nsx-divider', 'aria-hidden': true }),
            h(
              'button',
              {
                type: 'button',
                className: 'nsx-send',
                title: translate('suggestion.send'),
                'aria-label': translate('suggestion.sendHint'),
                onClick: () => sendNow(text),
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
          { className: 'nsx-bar' },
          h(
            'div',
            { className: 'nsx-row', role: 'group', 'aria-label': translate('suggestions.label') },
            edges.left
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'nsx-nav nsx-nav-prev',
                    title: translate('nav.prev'),
                    'aria-label': translate('nav.prev'),
                    onClick: () => scrollToEdge('start'),
                  },
                  h(ChevronLeftIcon),
                )
              : null,
            h('div', { className: 'nsx-viewport', ref: viewportRef }, cards),
            edges.right
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'nsx-nav nsx-nav-next',
                    title: translate('nav.next'),
                    'aria-label': translate('nav.next'),
                    onClick: () => scrollToEdge('end'),
                  },
                  h(ChevronRightIcon),
                )
              : null,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'nsx-dismiss',
              title: translate('suggestion.dismiss'),
              'aria-label': translate('suggestion.dismiss'),
              onClick: dismiss,
            },
            h(CloseIcon),
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'follow-up-prompts: dictionaries')
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'follow-up-prompts',
              order: 30,
              locale: NS,
            },
            FollowUpPromptsDock,
          ),
        )
      },
    }
  },
})