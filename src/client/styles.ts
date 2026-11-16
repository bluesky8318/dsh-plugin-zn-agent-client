/**
 * 本插件的样式表：一个 <style> 节点，全部规则在下面。
 *
 * 原则：框架的样式就是我们的样式。这里只做两件事——引用主题语义别名，以及
 * **照抄主机自己的几何**。凡是主机已经定过外观的控件，都不重新发明。
 *
 * 通用约定（与宿主 docs/web-styling.md 一致）：
 * - 颜色只用 `--dsw-alias-*`，不写字面色值。
 * - 抬升面用 `border: 0` 加 `box-shadow: var(--dsw-elevation-panel)`。
 * - 圆角走 `--dsw-radius-*`；全圆角必须配 `corner-shape: round`。
 * - 不写 `outline: none`；焦点环由主题的 focus.css 提供。
 *
 * 插槽组件渲染在宿主给的位置上，插件拿不到属于自己的根节点，因此也无法用
 * 根类名限定作用域——`znac-` 前缀必须全局唯一，这是它存在的唯一理由。
 *
 * @module dsh-plugin-zn-agent-client/client/styles
 */

import { NAMESPACE } from './constants.ts'

const CSS = `
/* ---- 侧栏底部动作 ---- */

/* 侧栏底部行：展开态是 42px 高的整宽行，收起态换成 36x36 居中的方钮，
   和侧栏里其它 rail 控件同尺寸。 */
.znac-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  height: 42px;
  padding: 0 10px 0 8px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 14px;
  line-height: 22px;
  text-align: left;
  cursor: pointer;
}
.znac-foot:hover { background: var(--dsw-alias-interactive-bg-hover); }
.znac-foot:disabled { opacity: 0.4; cursor: default; }
.znac-foot-rail {
  flex: none;
  justify-content: center;
  gap: 0;
  width: 36px;
  height: 36px;
  padding: 0;
}
.znac-foot-label {
  overflow: hidden;
  white-space: nowrap;
}
.znac-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  corner-shape: round;
  background: var(--dsw-alias-label-tertiary);
}
.znac-dot[data-on='true'] { background: var(--dsw-alias-state-success-primary); }

/* ---- 帧级浮层（shell.overlay）----
   抬升面：border: 0 + elevation-panel。 */
.znac-overlay {
  position: fixed;
  right: 16px;
  bottom: 16px;
  display: flex;
  align-items: center;
  gap: 10px;
  box-sizing: border-box;
  max-width: min(320px, calc(100vw - 32px));
  padding: 10px 12px;
  border: 0;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  box-shadow: var(--dsw-elevation-panel);
}
.znac-overlay-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.znac-overlay-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 999px;
  corner-shape: round;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: 16px;
  line-height: 20px;
  cursor: pointer;
}
.znac-overlay-close:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
`

/** 注入本插件的样式节点；返回清理函数，插件停用时移除样式。 */
export function injectStyles(): () => void {
  const node = document.createElement('style')
  node.dataset[ZNJ_STYLE_KEY] = NAMESPACE
  node.textContent = CSS
  document.head.append(node)
  return () => {
    node.remove()
  }
}

const ZNJ_STYLE_KEY = 'znAgentClientStyle'
