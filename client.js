window.__ModuleLoader__.load({
  id: 'dsh-follow-up-prompts',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    // 浮层必须挂到 body 上：dock 容器会裁剪超出其范围的定位元素。
    // 宿主没有暴露 react-dom 时退化为不显示浮层，其余能力照常。
    let createPortal = null
    try {
      const ReactDOM = require('react-dom')
      if (ReactDOM !== null && typeof ReactDOM.createPortal === 'function') createPortal = ReactDOM.createPortal
    } catch {
      createPortal = null
    }

    /** 本插件在 locale 服务里的命名空间。 */
    const NS = 'follow-up-prompts'
    /** 与 Host 半保持一致：读取建议的 projection key。 */
    const PROJECTION_KEY = 'followUpPrompts'
    /** 卡片上最多显示的字符数，超出截断成省略号，完整文案交给悬停浮层。 */
    const MAX_CARD_CHARS = 40
    /** 悬停多久后弹出浮层，避免鼠标划过时闪一下。 */
    const HINT_DELAY = 250
    /** 单击后等多久再填入草稿：这段时间内的第二击按双击（直接发送）处理。 */
    const CLICK_DELAY = 250

    /** 组件内文案兜底（locale 未注册时也能显示英文）。 */
    const FALLBACK = {
      'suggestions.label': 'Follow-up prompts',
      'suggestion.send': 'Send',
      'suggestion.sendHint': 'Send this instruction',
      'suggestion.dismiss': 'Hide these suggestions',
      'nav.prev': 'Scroll suggestions left',
      'nav.next': 'Scroll suggestions right',
      'hint.rule': 'Click to add to the input (double-click to send) · ↑ sends now',
      'notice.unavailable': 'Suggestions unavailable',
    }

    /** 两类词典；扁平点分 key，与 locale 服务约定一致。 */
    const en = {
      'suggestions.label': 'Follow-up prompts',
      'suggestion.send': 'Send',
      'suggestion.sendHint': 'Send this instruction',
      'suggestion.dismiss': 'Hide these suggestions',
      'nav.prev': 'Scroll suggestions left',
      'nav.next': 'Scroll suggestions right',
      'hint.rule': 'Click to add to the input (double-click to send) · ↑ sends now',
      'notice.unavailable': 'Suggestions unavailable',
    }
    const zh = {
      'suggestions.label': '后续指令建议',
      'suggestion.send': '发送',
      'suggestion.sendHint': '直接发送这条指令',
      'suggestion.dismiss': '收起这些建议',
      'nav.prev': '向左查看更多建议',
      'nav.next': '向右查看更多建议',
      'hint.rule': '点击添加到输入框（双击以选择并发送）· ↑ 立即发送',
      'notice.unavailable': '建议功能不可用',
    }

    const CSS = [
      // 整条与 composer 同宽，靠宿主的 stack gap 与输入框隔开。
      '.nsx-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,0px) * 2 - var(--dsh-composer-dock-inset,0px) * 4);margin:0 auto;}',
      '.nsx-bar{display:flex;align-items:center;max-width:calc(var(--dsh-composer-card-max-width,100%) - var(--dsh-composer-dock-inset,0px) * 4);margin:0 auto;}',
      '.nsx-row{position:relative;flex:1 1 auto;min-width:0;}',
      // 建议横向排列；放不下时在这里横向滚动，滚动条隐藏，靠两端箭头提示还有内容。
      '.nsx-viewport{display:flex;align-items:stretch;gap:6px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;-ms-overflow-style:none;}',
      '.nsx-viewport::-webkit-scrollbar{display:none;}',
      '.nsx-card{display:flex;flex:0 0 auto;height:32px;align-items:stretch;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-specific-menu);}',
      '.nsx-label{flex:0 1 auto;min-width:0;display:flex;align-items:center;padding:0 12px;border:0;background:transparent;color:var(--dsw-alias-label-primary-dimmed);font:inherit;font-size:13px;line-height:20px;text-align:left;white-space:nowrap;cursor:pointer;transition:background-color 120ms ease,color 120ms ease;}',
      '.nsx-label:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.nsx-label:focus-visible,.nsx-send:focus-visible,.nsx-nav:focus-visible,.nsx-dismiss:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-label-primary));outline-offset:-2px;}',
      '.nsx-divider{flex:0 0 auto;align-self:stretch;width:1px;background:var(--dsw-alias-border-l2);}',
      '.nsx-send{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:26px;align-self:stretch;height:auto;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color 120ms ease,color 120ms ease;}',
      '.nsx-send:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      // 两端箭头贴在建议条外侧，不占滚动区域的宽度，避免出现与消失引起抖动。
      '.nsx-nav{position:absolute;top:50%;z-index:2;display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-tertiary);cursor:pointer;transform:translateY(-50%);transition:background-color 120ms ease,color 120ms ease;}',
      '.nsx-nav:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.nsx-nav-prev{left:-30px;}',
      '.nsx-nav-next{right:-30px;}',
      // 收起按钮始终占位，只在悬停或键盘聚焦时显形，避免出现与消失时整条跳动。
      '.nsx-dismiss{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:24px;height:24px;margin-left:6px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;opacity:0;pointer-events:none;transition:opacity 120ms ease,background-color 120ms ease,color 120ms ease;}',
      // 右侧还有未展示的建议（出现 › ）时收起按钮不显形：两者在同一个格子里，同时出现会重叠。
      '.nsx-bar:hover .nsx-dismiss:not([data-held="true"]),.nsx-dismiss:not([data-held="true"]):focus-visible{opacity:1;pointer-events:auto;}',
      '.nsx-dismiss:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '@media (prefers-reduced-motion:no-preference){.nsx-card{animation:nsx-in 140ms ease-out;}@keyframes nsx-in{from{opacity:0;transform:translateY(2px);}to{opacity:1;transform:none;}}}',
      // 写入面不可用时的提示行：与建议卡同高，虚线边框表示这是状态而不是建议。
      '.nsx-notice{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:32px;padding:0 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;}',
      '.nsx-notice svg{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);}',
      '.nsx-notice-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      // 悬停浮层：完整文案 + 操作规则。挂到 body 上，宽度随内容，最大与对话框同宽，不限行数。
      '.nsx-hint{position:fixed;z-index:2147483000;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:10px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-specific-menu);box-shadow:var(--dsw-elevation-panel);pointer-events:none;opacity:0;transition:opacity 120ms ease;}',
      '.nsx-hint-visible{opacity:1;}',
      '.nsx-hint-text{font-size:15px;line-height:22px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}',
      '.nsx-hint-rule{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);}',
      // 窄屏没有外侧空间：箭头压在滚动区域两端，用 padding 让内容不被盖住。
      '@media (max-width:600px){.nsx-nav-prev{left:0;}.nsx-nav-next{right:0;}.nsx-viewport{padding:0 28px;}}',
    ].join('')

    /** 按字符截断卡片文案：超过上限时保留完整前缀并补省略号。 */
    function clipCardText(text) {
      const chars = Array.from(text)
      if (chars.length <= MAX_CARD_CHARS) return text
      return `${chars.slice(0, MAX_CARD_CHARS).join('')}…`
    }

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

    /** 警示三角：写入面失效时提示行前面的小图标。 */
    function AlertIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M8 2.6 14.2 13.4H1.8L8 2.6Z',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M8 6.6v2.9', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('circle', { cx: 8, cy: 11.4, r: 0.8, fill: 'currentColor' }),
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
      // Host 在写入面失效时把这一项填上：此时没有任何事件可写，只能靠视图带过来。
      const unavailable =
        projection && projection.unavailable !== null && typeof projection.unavailable === 'object'
          ? projection.unavailable
          : null

      /** 用户主动收起的轮次：`{ sessionId, turn }`。 */
      const [dismissed, setDismissed] = useState(null)
      /** 等待输入框同步后直接发送的请求：`{ prompt, baseline }`。 */
      const [pendingSend, setPendingSend] = useState(null)
      /** 左右两端是否还能滚动；只在状态真的变化时更新，避免多余渲染。 */
      const [edges, setEdges] = useState({ left: false, right: false })
      /** 是否已测量过滚动容器：未测量前不显示收起按钮，避免先闪一下再被收起条件藏起来。 */
      const [measured, setMeasured] = useState(false)
      /** 横向滚动容器。 */
      const viewportRef = useRef(null)
      /** 整条建议条：用来取对话框宽度，作为浮层的最大宽度。 */
      const dockRef = useRef(null)
      /** 浮层节点：渲染后据其实际宽度校正水平位置。 */
      const hintRef = useRef(null)
      /** 悬停浮层：{ text, anchor, base, maxRight, bottom }；null 表示不显示。 */
      const [hint, setHint] = useState(null)
      /** 浮层最终的水平位置。 */
      const [hintLeft, setHintLeft] = useState(0)
      /** 浮层是否已完成定位：定位前透明，避免先跳到错位再回弹。 */
      const [hintShown, setHintShown] = useState(false)
      /** 悬停计时器。 */
      const hintTimer = useRef(null)
      /** 单击计时器：在 CLICK_DELAY 内没等到第二击就当作单击。 */
      const clickTimer = useRef(null)

      const hidden = dismissed !== null && dismissed.sessionId === sessionId && dismissed.turn === turn
      /** 右侧还有未展示的建议时，收起按钮与 › 抢同一个格子，先把收起按钮藏起来。 */
      const holdDismiss = !measured || edges.right

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
        // 容差放到 2px：平滑滚动到最右时可能差零点几像素，阈值太紧会让 › 一直不消失。
        const left = node.scrollLeft > 2
        const right = max > 2 && node.scrollLeft < max - 2
        setMeasured((prev) => (prev ? prev : true))
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

      /** 收起浮层并取消未触发的悬停计时。 */
      const hideHint = useCallback(() => {
        if (hintTimer.current !== null) {
          clearTimeout(hintTimer.current)
          hintTimer.current = null
        }
        setHintShown(false)
        setHint(null)
      }, [])

      /**
       * 悬停 HINT_DELAY 后在卡片上方弹出浮层；拿不到 portal 时静默跳过。
       * `via` 区分指针悬停与键盘聚焦，两种来源的失效条件不同。
       */
      const showHint = useCallback((node, text, via) => {
        if (createPortal === null || node === null || node === undefined) return
        if (hintTimer.current !== null) clearTimeout(hintTimer.current)
        hintTimer.current = setTimeout(() => {
          hintTimer.current = null
          // 计时器可能在切到后台或卡片已被卸载之后才到点，此时弹出来就是幽灵浮层。
          if (!node.isConnected || document.hidden) return
          if (via === 'hover' ? !node.matches(':hover') : !node.contains(document.activeElement)) return
          const rect = node.getBoundingClientRect()
          const dockRect = dockRef.current !== null ? dockRef.current.getBoundingClientRect() : null
          const base = dockRect !== null && dockRect.width > 0 ? dockRect.left : rect.left
          const maxRight = dockRect !== null && dockRect.width > 0 ? dockRect.right : rect.left + rect.width
          // 上方空间不足时改为在卡片下方展开，避免浮层跑出视口。
          const place = rect.top >= 160 ? 'above' : 'below'
          setHintShown(false)
          setHintLeft(rect.left)
          setHint({
            text,
            node,
            via,
            anchor: rect,
            base,
            maxRight,
            place,
            edge: place === 'above' ? window.innerHeight - rect.top + 8 : rect.bottom + 8,
          })
        }, HINT_DELAY)
      }, [])

      // 浮层宽度随内容变化，渲染后按实际宽度把它拉回对话框范围内，再显形。
      useEffect(() => {
        if (hint === null) return undefined
        // 来源卡片已经被卸载（比如换了一轮），浮层没有可信坐标，直接收掉。
        if (!hint.node.isConnected || document.hidden) {
          hideHint()
          return undefined
        }
        const node = hintRef.current
        if (node === null) return undefined
        const width = node.getBoundingClientRect().width
        let left = hint.anchor.left
        if (left + width > hint.maxRight) left = hint.maxRight - width
        if (left < hint.base) left = hint.base
        if (Math.abs(left - hintLeft) > 0.5) {
          setHintLeft(left)
          return undefined
        }
        setHintShown(true)
        return undefined
      }, [hint, hintLeft, hideHint])

      // 卸载时清掉两个计时器，避免离开会话后还回调。
      useEffect(
        () => () => {
          if (hintTimer.current !== null) clearTimeout(hintTimer.current)
          if (clickTimer.current !== null) clearTimeout(clickTimer.current)
        },
        [],
      )

      // 浮层只该在当前轮、当前可见、且来源仍然有效时存在。
      // 轮次切换会让卡片整体重建，旧元素被卸载时不会派发 mouseleave，这一处是兜底。
      useEffect(() => {
        hideHint()
      }, [turn, running, hidden, hideHint])

      // 窗口失焦、页面隐藏、指针取消都属于「输入已经离开」，浮层必须收掉。
      useEffect(() => {
        if (hint === null) return undefined
        const onBlur = () => hideHint()
        const onVisibility = () => {
          if (document.hidden) hideHint()
        }
        window.addEventListener('blur', onBlur)
        document.addEventListener('visibilitychange', onVisibility)
        window.addEventListener('pointercancel', onBlur)
        // fixed 定位的坐标在任何滚动或改尺寸之后都会失真，与其重算不如直接收起。
        window.addEventListener('scroll', onBlur, true)
        window.addEventListener('resize', onBlur)
        return () => {
          window.removeEventListener('blur', onBlur)
          document.removeEventListener('visibilitychange', onVisibility)
          window.removeEventListener('pointercancel', onBlur)
          window.removeEventListener('scroll', onBlur, true)
          window.removeEventListener('resize', onBlur)
        }
      }, [hint, hideHint])

      // 指针一旦离开来源卡片就收起：不依赖 mouseleave，浏览器漏发时也能自愈。
      useEffect(() => {
        if (hint === null) return undefined
        const node = hint.node
        let frame = 0
        const onMove = (event) => {
          const x = event.clientX
          const y = event.clientY
          if (frame !== 0) return
          frame = requestAnimationFrame(() => {
            frame = 0
            if (!node.isConnected) {
              hideHint()
              return
            }
            const rect = node.getBoundingClientRect()
            if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) hideHint()
          })
        }
        window.addEventListener('pointermove', onMove, { passive: true })
        return () => {
          window.removeEventListener('pointermove', onMove)
          if (frame !== 0) cancelAnimationFrame(frame)
        }
      }, [hint, hideHint])

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

      if (hidden) return null
      if (unavailable !== null) {
        // 写入面失效：不显示（已经过期的）建议，改成一行状态说明，并保留悬浮提示的原因。
        const reason = typeof unavailable.reason === 'string' ? unavailable.reason : ''
        return h(
          'div',
          { className: 'nsx-dock', ref: dockRef, 'data-state': 'unavailable' },
          h('style', { key: 'nsx-style' }, CSS),
          h(
            'div',
            { className: 'nsx-bar' },
            h(
              'div',
              { className: 'nsx-notice', role: 'status', title: reason === '' ? undefined : reason },
              h(AlertIcon),
              h('span', { className: 'nsx-notice-text' }, translate('notice.unavailable')),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'nsx-dismiss',
                title: translate('suggestion.dismiss'),
                'aria-label': translate('suggestion.dismiss'),
                tabIndex: 0,
                onClick: dismiss,
              },
              h(CloseIcon),
            ),
          ),
        )
      }
      if (items.length === 0) return null
      if (running) return null

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
            {
              key: `${turn}-${index}`,
              className: 'nsx-card',
              onMouseEnter: (event) => showHint(event.currentTarget, text, 'hover'),
              onMouseLeave: hideHint,
            },
            h(
              'button',
              {
                type: 'button',
                className: 'nsx-label',
                // 单击先等一拍：这段时间里出现第二击就说明用户要的是双击发送。
                onClick: () => {
                  if (clickTimer.current !== null) clearTimeout(clickTimer.current)
                  clickTimer.current = setTimeout(() => {
                    clickTimer.current = null
                    fill(text)
                  }, CLICK_DELAY)
                },
                onDoubleClick: () => {
                  if (clickTimer.current !== null) {
                    clearTimeout(clickTimer.current)
                    clickTimer.current = null
                  }
                  sendNow(text)
                },
                onFocus: (event) => showHint(event.currentTarget, text, 'focus'),
                onBlur: hideHint,
              },
              clipCardText(text),
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

      const hintNode =
        hint !== null && createPortal !== null
          ? createPortal(
              h(
                'div',
                {
                  ref: hintRef,
                  className: hintShown ? 'nsx-hint nsx-hint-visible' : 'nsx-hint',
                  role: 'tooltip',
                  style:
                    hint.place === 'above'
                      ? { left: `${hintLeft}px`, bottom: `${hint.edge}px`, maxWidth: `${hint.maxRight - hint.base}px` }
                      : { left: `${hintLeft}px`, top: `${hint.edge}px`, maxWidth: `${hint.maxRight - hint.base}px` },
                },
                h('div', { className: 'nsx-hint-text' }, hint.text),
                h('div', { className: 'nsx-hint-rule' }, translate('hint.rule')),
              ),
              document.body,
            )
          : null

      return h(
        'div',
        { className: 'nsx-dock', ref: dockRef },
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
              'aria-hidden': holdDismiss ? 'true' : undefined,
              'data-held': holdDismiss ? 'true' : undefined,
              tabIndex: holdDismiss ? -1 : 0,
              onClick: dismiss,
            },
            h(CloseIcon),
          ),
        ),
        hintNode,
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