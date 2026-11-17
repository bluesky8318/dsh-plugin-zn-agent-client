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
   左下角锚定的小弹框（不是全屏遮罩）：border: 0 + elevation-panel 抬升。
   只有浮层自己占一小块；不铺满屏幕，不影响宿主其它区域。 */
.znac-overlay-launcher {
  position: fixed;
  left: 12px;
  bottom: 56px;
  z-index: 30;
}
.znac-launcher {
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-sizing: border-box;
  width: min(320px, calc(100vw - 32px));
  max-height: min(420px, calc(100vh - 120px));
  padding: 12px 14px;
  border: 0;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  box-shadow: var(--dsw-elevation-panel);
  overflow: auto;
}
.znac-overlay-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
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

/* ---- agent picker 卡片内容 ---- */
.znac-launcher-title {
  font-weight: 500;
  font-size: 13px;
  line-height: 20px;
}
.znac-launcher-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.znac-launcher-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-md);
}
.znac-launcher-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.znac-launcher-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.znac-launcher-name {
  font-size: 13px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
}
.znac-launcher-cmd {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.znac-launcher-status {
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
}
.znac-launcher-actions {
  display: flex;
  flex: none;
  gap: 6px;
}
.znac-launcher-copy {
  flex: none;
  padding: 4px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.znac-launcher-copy:hover { background: var(--dsw-alias-interactive-bg-hover); }
.znac-launcher-empty {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.znac-launcher-hint {
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}

/* ---- Plugins 页配置表单 ---- */
.znac-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.znac-form-title {
  margin: 0;
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.znac-summary {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.znac-note {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.znac-invalid {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
}
.znac-field { display: flex; flex-direction: column; gap: 6px; }
.znac-field-inline {
  flex-direction: row;
  align-items: flex-start;
  gap: 8px;
}
.znac-field-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
.znac-field-hint {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.znac-badge {
  font-style: normal;
  font-size: 12px;
  line-height: 16px;
  padding: 1px 6px;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-tertiary);
}
.znac-form input[type='text'],
.znac-form input[type='number'] {
  box-sizing: border-box;
  width: 100%;
  padding: 5px 8px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 20px;
}
.znac-agent {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 8px 10px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md);
}
.znac-agent-title {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  padding: 0 4px;
}
.znac-agent-grid {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 6px 10px;
  align-items: center;
}
.znac-sublabel {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.znac-agent-remove,
.znac-agent-add {
  align-self: flex-start;
  padding: 4px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.znac-agent-remove:hover,
.znac-agent-add:hover { background: var(--dsw-alias-interactive-bg-hover); }
.znac-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.znac-form-actions button {
  padding: 5px 14px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}
.znac-form-actions button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.znac-form-actions button[type='submit'] {
  border-color: transparent;
  background: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-label-primary);
}

/* ---- 侧栏底栏：主启动钮 + "..." 钮 ---- */
.znac-foot-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  corner-shape: round;
  background: var(--dsw-alias-label-tertiary);
}
.znac-foot-dot[data-on='true'] { background: var(--dsw-alias-state-success-primary); }
.znac-foot-failed { color: var(--dsw-alias-state-error-primary); }
.znac-foot-dots {
  flex: none;
  width: 36px;
  justify-content: center;
  color: var(--dsw-alias-label-secondary);
  font-size: 14px;
  line-height: 22px;
  letter-spacing: 2px;
}

/* ---- 主会话区 CLI Agent 视图 ---- */
.znac-view {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
  padding: 8px;
  box-sizing: border-box;
}
.znac-view-empty {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.znac-view-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.znac-view-chip {
  padding: 3px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.znac-view-chip:hover { background: var(--dsw-alias-interactive-bg-hover); }
.znac-view-chip[data-active='true'] {
  background: var(--dsw-alias-state-business-primary);
  border-color: transparent;
  color: var(--dsw-alias-label-primary);
}
.znac-view-term {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-base);
}

/* xterm.js 的必要骨架规则（内联自 @xterm/xterm 的 xterm.css——bundle 不加载
   外部 css 文件），配色交给容器上的主题 token。 */
.znac-term-screen {
  position: relative;
  height: 100%;
  min-height: 0;
  padding: 6px;
  box-sizing: border-box;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  cursor: text;
  user-select: none;
}
.znac-term-screen .xterm { position: relative; height: 100%; }
.znac-term-screen .xterm-helpers { position: absolute; top: 0; z-index: 5; }
.znac-term-screen .xterm-helper-textarea {
  position: absolute;
  opacity: 0;
  left: -9999em;
  top: 0;
  width: 0;
  height: 0;
  z-index: -5;
  white-space: nowrap;
  overflow: hidden;
  resize: none;
}
.znac-term-screen .composition-view {
  position: absolute;
  z-index: 1;
  display: none;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
}
.znac-term-screen .composition-view.active { display: block; }
.znac-term-screen .xterm-viewport {
  position: absolute;
  inset: 0;
  overflow-y: scroll;
  cursor: default;
  background-color: var(--dsw-alias-bg-base);
}
.znac-term-screen .xterm-screen { position: relative; }
.znac-term-screen .xterm-screen canvas { position: absolute; left: 0; top: 0; }
.znac-term-screen .xterm-char-measure-element {
  position: absolute;
  top: 0;
  left: -9999em;
  line-height: normal;
  visibility: hidden;
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
