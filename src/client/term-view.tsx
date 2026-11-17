/**
 * xterm.js 模拟器组件：渲染宿主 webTerminals 视图模型的屏幕。
 *
 * 帧协议照宿主的规矩：`state.render` 是待渲染帧，snapshot 必须重放
 * （reset + resize + 写屏），output 直接追加；xterm 的写回调里调
 * `model.acknowledge(revision)` 放行下一帧——不 ack 就永远停在当前帧。
 *
 * 颜色不写死：容器样式用 --dsw-alias-* token 上色，xterm 的具体色值经
 * getComputedStyle 读回来（暗色/亮色切换时重读）。
 * @module dsh-plugin-zn-agent-client/client/term-view
 */

import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import React, { useLayoutEffect, useRef } from 'react'
import type { HostTerminalEnvironment, HostTerminalView, HostTerminalViewState } from './term-model.ts'

/** 与宿主终端一致的等宽字体栈（主题可经 --dsw-font-mono 覆盖）。 */
const TERMINAL_FONT_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/** 单个模拟器单元的 props。 */
export interface TermScreenProps {
  /** 宿主视图模型（写输入、发尺寸、收帧确认都走它）。 */
  model: HostTerminalView
  /** 最新可观察状态（帧、可写、环境限制）。 */
  state: HostTerminalViewState
  /** 页签是否可见（不可见时不适配尺寸、不抢焦点）。 */
  visible: boolean
  /** 无障碍名称。 */
  label: string
}

/**
 * 模拟器单元：模型不变就复用同一个 xterm 实例，状态变化只是外围重渲染。
 */
export function TermScreen(props: TermScreenProps): React.ReactElement {
  const { model, state, visible, label } = props
  const element = useRef<HTMLDivElement | null>(null)
  const emulator = useRef<Terminal | undefined>(undefined)
  const fit = useRef<FitAddon | undefined>(undefined)
  const lastRevision = useRef(0)
  const scheme = useColorScheme()
  // xterm effect 里读实时值而不重建模拟器：模型绑定模拟器，活标志走 ref。
  const current = useRef({ state, visible, label })
  current.current = { state, visible, label }

  useLayoutEffect(() => {
    const node = element.current
    if (node === null) return
    // 字体按 CSS px 理解——不要乘 devicePixelRatio（WebGL 渲染器内部已按 DPR
    // 建 backing store/glyph atlas，外面再乘一次就会出现“老人大字体”）。
    // lineHeight/letterSpacing 走默认，避免把 cell 尺寸搞坏。
    // 字体族用宿主终端同款等宽栈，不跟随容器（容器的 fontFamily 是正文/系统
    // 字体，会让终端用比例字体，看起来又怪又大）。
    const xterm = new Terminal({
      fontFamily: TERMINAL_FONT_STACK,
      fontSize: 13,
      lineHeight: 1.0,
      letterSpacing: 0,
      minimumContrastRatio: 4.5,
      cursorBlink: true,
      scrollback: current.current.state.environment?.scrollback ?? 2000,
    })
    const addon = new FitAddon()
    xterm.loadAddon(addon)
    xterm.open(node)
    // 高性能路径：WebGL2（GPU 渲染）——全屏 TUI 的输出/交互明显更流畅。
    // 不支持 WebGL2 时回退到默认渲染器，功能不受影响。
    let webgl: WebglAddon | undefined
    try {
      webgl = new WebglAddon()
      webgl.onContextLoss(() => { webgl?.dispose() })
      xterm.loadAddon(webgl)
    } catch {
      webgl = undefined // 无 WebGL2：保留默认渲染
    }
    xterm.textarea?.setAttribute('aria-label', current.current.label)
    emulator.current = xterm
    fit.current = addon
    lastRevision.current = 0
    const input = xterm.onData((data) => { model.write(data) })
    const measure = (): void => {
      const live = current.current
      if (!live.visible || !live.state.writable || node.clientWidth === 0 || node.clientHeight === 0) return
      fitScreen(xterm, addon, live.state.environment, model)
    }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(node)
    return () => {
      observer?.disconnect()
      input.dispose()
      webgl?.dispose()
      xterm.dispose()
      emulator.current = undefined
      fit.current = undefined
    }
  }, [model])

  // xterm 要具体色值：从容器元素读 token 渲染出来的实际颜色；换主题重读。
  useLayoutEffect(() => {
    const node = element.current
    const xterm = emulator.current
    if (node === null || xterm === undefined) return
    const style = getComputedStyle(node)
    xterm.options.theme = {
      background: style.backgroundColor,
      foreground: style.color,
      cursor: style.color,
      cursorAccent: style.backgroundColor,
      selectionBackground: style.color,
      selectionForeground: style.backgroundColor,
    }
  }, [scheme, model, state.phase])

  // 帧协议：snapshot 重放（reset+resize+写屏），output 追加；写回调 ack 放行下一帧。
  useLayoutEffect(() => {
    const xterm = emulator.current
    const render = state.render
    if (xterm === undefined || render === undefined || render.revision <= lastRevision.current) return
    lastRevision.current = render.revision
    if (render.frame.type === 'snapshot') {
      xterm.reset()
      xterm.resize(render.frame.info.cols, render.frame.info.rows)
    }
    xterm.write(render.frame.type === 'snapshot' ? render.frame.screen : render.frame.data, () => {
      model.acknowledge(render.revision)
    })
  }, [state.render, model])

  // 尺寸与输入权都跟着视图状态走：给没握控制权的视图 fit 会和别的窗口打架。
  // 依赖里只放子对象（environment/info 的引用只在内容变化时更替）——整份
  // state 每帧都是新对象，放进来会让本 effect 每帧都跑。
  const { writable, environment, info } = state
  useLayoutEffect(() => {
    const xterm = emulator.current
    if (xterm === undefined) return
    xterm.options.disableStdin = !writable
    if (visible && writable) fitScreen(xterm, fit.current, environment, model)
    else if (info !== undefined && !writable) xterm.resize(info.cols, info.rows)
  }, [visible, writable, environment, info, model])

  return <div className="znac-term-screen" ref={element} role="application" aria-label={label} />
}

/**
 * 把模拟器适配到容器盒并上报尺寸（钳到宿主上限；宿主拒绝的尺寸会让
 * shell 自己的窗口认知出错）。
 */
function fitScreen(
  xterm: Terminal,
  addon: FitAddon | undefined,
  environment: HostTerminalEnvironment | undefined,
  model: HostTerminalView,
): void {
  const maxCols = environment?.maxCols
  const maxRows = environment?.maxRows
  if (maxCols === undefined || maxRows === undefined) return
  const dimensions = addon?.proposeDimensions()
  if (dimensions === undefined) return
  const cols = Math.min(dimensions.cols, maxCols)
  const rows = Math.min(dimensions.rows, maxRows)
  if (cols < 2 || rows < 1) return
  xterm.resize(cols, rows)
  model.resize(cols, rows)
}

/** 读页面明暗方案（只用于在切换时触发主题重读）。 */
function useColorScheme(): 'dark' | 'light' {
  const [scheme, setScheme] = React.useState<'dark' | 'light'>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  )
  React.useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent): void => { setScheme(event.matches ? 'dark' : 'light') }
    query.addEventListener('change', onChange)
    return () => { query.removeEventListener('change', onChange) }
  }, [])
  return scheme
}
