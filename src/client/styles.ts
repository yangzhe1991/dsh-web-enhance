/**
 * dsh-web-enhance 的插件样式(浏览器半:模块级副作用注入一次 <style>)。
 *
 * 从 index.tsx 抽出来单独一个文件:样式已经跨了三个功能(悬浮按钮、价格行、
 * 设置行),混在组件文件里越读越乱;放这里也方便和组件文件对照。
 *
 * 命名前缀统一 `dsh-webe-`(web-enhance),不与官方模块类耦合。
 */
import { PLUGIN_VERSION } from './version.generated'

/** 注入的 <style> 是否已存在(避免重复注入)。 */
let styleInjected = false

/**
 * 插件样式。
 * - .dsh-webe-float:悬浮容器,定位在视口右下角、官方「滚到底部」
 *   圆钮(toBottomSlot,z-index 8)的正上方(竖排,当前只有一个按钮);
 * - .dsh-webe-float-button:圆钮本体,外观照官方 .Md3f7G_toBottom(34px 圆形、
 *   悬浮底色 + 阴影),hover 变亮;
 * - .dsh-webe-float-button[data-active='true']:思维链默认展开开关的开启态,
 *   底色加深 + 图标用品牌强调色,与关闭态区分;
 * - 价格行与官方 stats 行合流(见下):官方把 dock 出口包装渲染成
 *   display:contents(行内样式),条目各自成块;价格存在时用 :has() 把
 *   包装还原成真实 flex 行(!important 盖过行内样式),价格(order 0)
 *   排最左、stats 行(order 2)跟在后面。
 */
const PLUGIN_CSS = `
.dsh-webe-float {
  position: fixed;
  right: 20px;
  bottom: calc(var(--dsh-composer-height, 152px) + 64px);
  z-index: 9;
  flex-direction: column;
  gap: 8px;
  display: flex;
}
.dsh-webe-float-button {
  width: 34px;
  height: 34px;
  min-height: 0;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  background: var(--dsw-alias-button-floating-fill);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 100px;
  box-shadow: var(--dsw-shadow-lv2);
  align-items: center;
  justify-content: center;
  padding: 0;
  display: inline-flex;
}
.dsh-webe-float-button:hover,
.dsh-webe-float-button:focus-visible {
  background: var(--dsw-alias-button-floating-hover);
}
.dsh-webe-float-button[data-active='true'] {
  background: var(--dsw-alias-button-floating-hover);
  color: var(--dsw-alias-state-business-primary);
}
/* 价格行存在时(第二个条目),dock 出口包装变成整宽 flex 行:
   价格 + stats 作为一个整体居中(与原 stats 行居中的视觉一致),
   价格是行内第一个元素(flex:none,永不压缩、永不溢出);stats 行
   不再限死 748px、不撑满剩余宽度,只在整体真正超出屏幕时才收缩
   省略(justify-content:center 下唯一可收缩项,价格始终可见)。 */
[data-slot="conversation.composer.dock"]:has(> :nth-child(2)) {
  display: flex !important;
  align-items: baseline;
  gap: 10px;
  justify-content: center;
  width: 100%;
  max-width: none;
  margin: 0;
  padding: 4px calc(var(--dsh-composer-side-clearance) + 16px) 0;
  box-sizing: border-box;
}
/* 官方 stats 行(条目里 DOM 序第一个):挪到价格之后,让出自身
   块级布局与固定宽度,只在剩余空间不足时收缩省略。 */
[data-slot="conversation.composer.dock"]:has(> :nth-child(2)) > :first-child {
  order: 2;
  width: auto;
  max-width: none;
  margin: 0;
  padding: 0;
  text-align: left;
  flex: 0 1 auto;
  min-width: 0;
}
/* 价格本体:flex:none 的行首项,永不压缩、永不溢出。 */
.dsh-webe-cost {
  order: 0;
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 20px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* 设置「通用」分区里的功能行(功能四「文件用系统程序打开」/ 功能五「跑完提醒」):
   标题 + 说明两行,右侧开关。排版照官方功能行(row / rowText / title / desc),
   类名自带前缀,不与官方模块类耦合。 */
/* 分隔线与内边距照官方功能行(lats3W_row:.5px 下边框 + 16px 上下内边距),
   否则一行没有分隔线的设置项在「通用设置」页里会被当成不存在的空白。 */
.dsh-webe-setting-row {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
  width: 100%;
  padding: 16px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-webe-setting-text {
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 4px;
  min-width: 0;
  padding-right: 48px;
}
.dsh-webe-setting-title {
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 22px;
}
.dsh-webe-setting-desc {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 20px;
}
`

/**
 * 全局注入一次插件样式。
 *
 * 由 `apply()` 在最外层调用一次(不再由某个组件在 useEffect 里按需注入):
 * 功能多了以后「某个功能的组件没渲染 ⇒ 另一个功能的样式也缺」是没必要
 * 承担的风险,而这一整段 CSS 的字符串常量代价可以忽略。
 */
export function ensureStyle(): void {
  if (styleInjected || typeof document === 'undefined') return
  styleInjected = true
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-web-enhance'
  tag.dataset.pluginVersion = PLUGIN_VERSION
  tag.textContent = PLUGIN_CSS
  document.head.appendChild(tag)
}
