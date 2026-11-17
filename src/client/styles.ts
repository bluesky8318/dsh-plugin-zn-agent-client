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
  /* 头部固定、只有列表区滚动（overflow:auto 在卡片上会让标题跟着滚出去）。 */
  overflow: hidden;
}
.znac-launcher-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.znac-overlay-headbtns {
  display: flex;
  align-items: center;
  gap: 6px;
}
.znac-launcher-setnote {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
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
/* CLI Agent 视图激活时隐藏会话自带的消息输入框（composer seat）：
   视图根节点带 data-znacp-cli-view，视图只在自身 tab 激活时挂载，
   因此纯 CSS :has() 即可随 tab 切换即时生效/恢复，无需状态同步。
   会话结构：scrollBody[data-conversation-scroll] > (views… + seat[data-composer-seat])。 */
[data-conversation-scroll]:has([data-znacp-cli-view]) > [data-composer-seat] {
  display: none !important;
}

/* 宿主的对话宽度拖拽条（ConversationRoot.module.css 的 .widthHandle，
   data-side=left|right，cursor:col-resize，绝对定位在对话 body 两侧）：
   类名被 CSS modules 哈希不可引用，但 data-side 属性稳定。CLI 视图占满
   可视带时拖拽条无意义还压在终端左右边缘 —— html:has 联动隐藏，切回
   对话视图自动恢复。 */
html:has([data-znacp-cli-view]) [data-side='left'],
html:has([data-znacp-cli-view]) [data-side='right'] {
  display: none !important;
}

.znac-view {
  display: flex;
  flex-direction: column;
  gap: 8px;
  /* 宿主在 active 阶段把 viewArea 放开为 flex:1 0 auto + min-height:auto
     （不约束高度），height:100% 解析不到边界 → xterm 自撑高度溢出滚动区。
     宿主在滚动容器上发布的 --dsh-conversation-viewport-height 是可视带的
     真实高度（ConversationContent.tsx 用 ResizeObserver 实时更新），官方
     约定的视图尺寸来源。旧宿主无此变量时回退 100%。 */
  height: var(--dsh-conversation-viewport-height, 100%);
  flex: none;
  min-height: 0;
  padding: 8px;
  box-sizing: border-box;
  overflow: hidden;
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
.znac-view-external {
  margin-left: auto;
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
.znac-view-external:hover { background: var(--dsw-alias-interactive-bg-hover); }
.znac-view-external[data-state='opened'] { color: var(--dsw-alias-state-success-primary); }
.znac-view-external[data-state='failed'] { color: var(--dsw-alias-state-error-primary); }
.znac-view-external:disabled { cursor: default; opacity: 0.6; }
.znac-view-term {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-base);
}
.znac-agent-term {
  flex: 1;
  min-height: 0;
  padding: 6px;
  box-sizing: border-box;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  cursor: text;
  user-select: none;
}
/* FitAddon 以 xterm 元素的父节点量高：这层若 height:auto（默认），父高=
   xterm 当前渲染高，fit 永远量不到容器真实高度 → 行数卡在初始值（半屏）。 */
.znac-agent-term-screen {
  height: 100%;
  overflow: hidden;
}
.znac-view-term-note {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.znac-view-restart {
  margin-left: auto;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-sm);
  padding: 2px 10px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 1.5;
  cursor: pointer;
}
.znac-view-restart:hover { background: var(--dsw-alias-interactive-bg-hover); }

/* 方案C 会话区：控件条（新会话/继续最近/历史▾）+ 终端。 */
.znac-view-sesarea {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.znac-view-topbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l4);
}
.znac-view-sesbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
}
.znac-view-spacer { flex: 1; }
.znac-view-sesid {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.znac-view-sescwd {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.znac-view-toast {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 14;
  background: var(--dsw-alias-bg-layer-1);
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-sm);
  padding: 5px 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
.znac-view-sbtn {
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-sm);
  padding: 3px 10px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 1.5;
  cursor: pointer;
  white-space: nowrap;
}
.znac-view-sbtn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.znac-view-sbtn[data-kind='primary'] { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); }
.znac-view-sbtn:disabled { cursor: default; opacity: 0.6; }
.znac-view-histwrap { position: relative; }
.znac-view-hist {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  /* Popover API 生效时（浏览器把节点渲染进顶层）改用固定定位坐标，
   * 并覆盖 UA 的居中默认样式；不支持时保持上面的 absolute 回落。 */

  z-index: 12;
  min-width: 320px;
  max-width: 480px;
  max-height: 280px;
  overflow: auto;
  background: var(--dsw-alias-bg-layer-1);
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  padding: 4px;
}
.znac-view-hist[popover] {
  position: fixed;
  inset: auto;
  margin: 0;
  display: block;
  width: 320px;
}
.znac-view-idle {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: 16px;
  min-height: 0;
}

.znac-view-idle p {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
}

.znac-view-switching {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  justify-content: center;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1.5;
  z-index: 3;
}
.znac-view-spin {
  width: 18px;
  height: 18px;
  /* 转圈是功能指示环，不是面板描边——用 longhand 免开 hairline 约束。 */
  border-width: 2px;
  border-style: solid;
  border-color: var(--dsw-alias-border-l4);
  border-top-color: var(--dsw-alias-interactive-bg-hover);
  border-radius: 50%;
  corner-shape: round;
  animation: znac-spin 0.8s linear infinite;
}
@keyframes znac-spin { to { transform: rotate(360deg); } }
.znac-view-hist-empty {
  padding: 8px 10px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.5;
}
.znac-view-hist-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  padding: 6px 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
}
.znac-view-hist-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.znac-view-hist-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.znac-view-hist-meta { color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.znac-view-hist-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.znac-view-seslabel {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* xterm.js 的必要骨架规则（内联自 @xterm/xterm 的 xterm.css——bundle 不加载
   外部 css 文件），配色交给容器上的主题 token。 */
.znac-agent-term {
  position: relative;
  height: 100%;
}
.znac-agent-term .xterm { position: relative; height: 100%; }
.znac-agent-term .xterm-helpers { position: absolute; top: 0; z-index: 5; }
.znac-agent-term .xterm-helper-textarea {
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
.znac-agent-term .composition-view {
  position: absolute;
  z-index: 1;
  display: none;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
}
.znac-agent-term .composition-view.active { display: block; }
.znac-agent-term .xterm-viewport {
  position: absolute;
  inset: 0;
  overflow-y: scroll;
  cursor: default;
  background-color: var(--dsw-alias-bg-base);
}
.znac-agent-term .xterm-screen { position: relative; }
.znac-agent-term .xterm-screen canvas { position: absolute; left: 0; top: 0; }
.znac-agent-term .xterm-char-measure-element {
  position: absolute;
  top: 0;
  left: -9999em;
  line-height: normal;
  visibility: hidden;
}
/* agent 下拉 + 运行状态圆点 */
.znac-view-agentwrap { position: relative; display: inline-flex; }
.znac-view-agentbtn {
  display: inline-flex; align-items: center; gap: 6px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  padding: 4px 10px;
  font-size: 12px; line-height: 1.3; font-weight: 500;
  cursor: pointer;
}
.znac-view-agentbtn:hover { border-color: var(--dsw-alias-border-l4); }
.znac-view-caret { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.3; }
.znac-view-dot {
  width: 7px; height: 7px; border-radius: 999px; flex: none;
  corner-shape: round;
  background: var(--dsw-alias-state-error-primary);
}
.znac-view-dot[data-state='running'] { background: var(--dsw-alias-state-success-primary); }
.znac-view-agentmenu {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 40;
  min-width: 200px; max-height: 320px; overflow-y: auto;
  background: var(--dsw-alias-bg-layer-2);
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  padding: 4px;
}
.znac-view-agentitem {
  display: flex; align-items: center; gap: 8px; width: 100%;
  border: 0; background: transparent; text-align: left;
  color: var(--dsw-alias-label-primary);
  padding: 6px 10px; border-radius: 7px;
  font-size: 12px; line-height: 1.3; cursor: pointer;
}
.znac-view-agentitem:hover { background: var(--dsw-alias-interactive-bg-hover); }
.znac-view-agentitem[data-active='true'] { background: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary); }
.znac-view-agentname { flex: 1; }

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
