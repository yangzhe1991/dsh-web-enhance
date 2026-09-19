/**
 * dsh-web-enhance 插件,浏览器半 —— 前端增强功能集合。
 *
 * 功能一:以「轮」(turn:你问一句 → agent 完整回复一段)为单位的对话导航。
 * - 摁「上」:回到当前正在看的这一轮的「开头」(最终结果正文起点,跳过
 *   思考、工具和过程性的过渡句);若滚动位置已停在该轮开头附近,则跳到
 *   上一轮的开头。
 * - 摁「下」:跳到当前轮的「结尾」(最终结果行底);若已停在该轮结尾附近,
 *   则跳到下一轮的结尾。
 *
 * 功能二:思维链默认展开。官方把每条 reasoning 块渲染成「Think」折叠条
 * (DisclosureRow),默认收起、只露一行摘要;打开开关后,本插件自动点开
 * 对话里全部(包括流式过程中新挂载的)Think 折叠条,直接看思维链全文。
 * 开关是悬浮按钮组里带灯泡图标的第三个按钮,状态持久化在 localStorage,
 * 默认开启。用户手动收起某条折叠条不会被强制展开(只对「新增」的子树
 * 生效,不监听属性变化)。
 *
 * 功能三:会话价格统计(仅 DeepSeek 官方 API)。当前会话的请求走
 * provider 路由 `deepseek-official` 时,在官方 stats 行(输入/输出 token
 * 那行)正下方渲染一行「≈ ¥0.83」:已加载历史窗口内的请求逐条按真实
 * 时间戳分峰谷(北京时间 9-12、14-18 为峰时,价格为闲时 2 倍)、按模型
 * 单价精确计价;tokenUsage 投影里窗口外(未翻页加载)的历史没有时间戳,
 * 差额按当前模型闲时价估算并以「≈」前缀标示。价格表未收录的模型(官网
 * 新上线、插件价格表还没同步)按已知 DeepSeek 模型里最便宜的价格兜底
 * 计价,同样计入「≈」并在悬停明细里如实标注。算法见 cost.ts,价格表
 * 数据源:https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *
 * 实现:注册到 conversation.session.header.actions(session 作用域,轮导航
 * 按钮组,createPortal 到 document.body)与 conversation.composer.dock
 * (价格行,挂在官方 stats 行下方)。通过 useSession 订阅 chat 快照与
 * trajectory 视图,useProjection 读 tokenUsage 全量投影。
 *
 * 轮的数据契约:chat.timeline.turnOrder 为轮序,chat.locations.getTurn(turn)
 * 返回该轮按顺序排列的节点 key。轮的「最终结果」= 轮内最后一个「含非空
 * 正文 text 块、且 blocks 以 text 结尾」的 assistant / assistant-step 节点
 * (过渡句 blocks 形如 [思考, 文字, 工具…],最终结果形如 [思考, 文字] 或
 * [文字]);整轮没有收尾总结时回退到轮内最后一个含正文的节点。DOM 定位
 * 复用官方标记(data-chat-anchor-key + [data-conversation-scroll]),开头
 * 锚点越过思考块根元素(data-variant="think",展开态含整条思维链)落在
 * 正文起点。
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
// 官方模式:ClientContext 就是 cordis 的 Context(服务经声明合并挂在上面)。
// 旧版本从这里导入过 @deepseek-ai/dsh-client-runtime/client,该包已随 dsh 0.1.2 停产。
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 声明合并:ctx.slots 由 ui-renderer 挂载到 cordis Context(官方同款导入)。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import {
  IconChevronDownOutline14,
  IconChevronUpOutline14,
  IconThinkOutline14,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
// 触发 SlotMap / Context 声明合并:
// - conversation 声明 conversation.session.header.actions 与 ctx.sessions;
// - settings 声明 settings.general.item;
// - sidebar-right 声明 ctx.sidebarRight / ctx.sidebarRightTabs;
// - api-remotes 声明 ctx.remote(远端命名空间)。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import {
  DEEPSEEK_PROVIDER,
  formatCostYuan,
  formatTokens,
  loadAccumulator,
  saveAccumulator,
  summarizeCost,
} from './cost'
import type { RequestInspectionSnapshot } from './cost'
// 功能四:点文件交系统默认程序打开(拦截 ctx.sidebarRight.openResource)。
import {
  NativeOpenRow,
  installNativeFileOpen,
  registerNativeOpenCopy,
  setNativeOpenText,
} from './open-native'

/** 注入的 <style> 是否已存在(按钮样式,避免重复注入)。 */
let styleInjected = false

/**
 * 插件样式。
 * - .dsh-webe-jump-float:悬浮容器,定位在视口右下角、官方「滚到底部」
 *   圆钮(toBottomSlot,z-index 8)的正上方,竖排圆钮;
 * - .dsh-webe-jump:圆钮本体,外观照官方 .Md3f7G_toBottom(34px 圆形、
 *   悬浮底色 + 阴影),hover 变亮;
 * - .dsh-webe-jump[data-active='true']:思维链默认展开开关的开启态,
 *   底色加深 + 图标用品牌强调色,与关闭态区分;
 * - 价格行与官方 stats 行合流(见下):官方把 dock 出口包装渲染成
 *   display:contents(行内样式),条目各自成块;价格存在时用 :has() 把
 *   包装还原成真实 flex 行(!important 盖过行内样式),价格(order 0)
 *   排最左、stats 行(order 2)跟在后面。
 */
const BUTTON_CSS = `
.dsh-webe-jump-float {
  position: fixed;
  right: 20px;
  bottom: calc(var(--dsh-composer-height, 152px) + 64px);
  z-index: 9;
  flex-direction: column;
  gap: 8px;
  display: flex;
}
.dsh-webe-jump {
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
.dsh-webe-jump:hover,
.dsh-webe-jump:focus-visible {
  background: var(--dsw-alias-button-floating-hover);
}
.dsh-webe-jump[data-active='true'] {
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
/* 设置「通用」分区里的功能行(功能四):标题 + 说明两行,右侧开关。
   排版照官方功能行(row / rowText / title / desc),类名自带前缀,
   不与官方模块类耦合。 */
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

/** 全局注入一次按钮样式(浏览器端 bundle 的模块级副作用)。 */
function ensureStyle(): void {
  if (styleInjected || typeof document === 'undefined') return
  styleInjected = true
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-web-enhance'
  tag.textContent = BUTTON_CSS
  document.head.appendChild(tag)
}

// —— 思维链默认展开 ——
//
// 官方把每条 reasoning 块渲染成 ReasoningRow(根节点 data-variant="think"),
// 内部用 useState 控制 DisclosureRow 的展开态:收起时只挂载一行摘要,
// 展开时才挂载思维链全文(children)。所以「默认展开」没法用 CSS 盖,
// 只能点击折叠条触发官方 onToggle,翻转它内部的 React 状态。
// 折叠条可整行点击(expandOnRowClick),特征:data-disclosure-row +
// aria-expanded="false"。

/** 思维链默认展开开关的 localStorage 键。 */
const EXPAND_THINK_KEY = 'dsh-web-enhance.expand-think'

/** 读取开关持久值:默认开启(产品诉求即「默认展开」),localStorage 异常也按开处理。 */
function readExpandThink(): boolean {
  try {
    return localStorage.getItem(EXPAND_THINK_KEY) !== '0'
  } catch {
    return true
  }
}

/** 写入开关持久值(localStorage 不可用,如隐私模式,静默忽略)。 */
function writeExpandThink(enabled: boolean): void {
  try {
    localStorage.setItem(EXPAND_THINK_KEY, enabled ? '1' : '0')
  } catch {
    // 忽略:开关状态只在本次会话内生效
  }
}

/**
 * 展开 root 子树内所有「折叠的思维链行」。
 *
 * 选择器只匹配官方 Think 折叠条:根 data-variant="think" 下的
 * data-disclosure-row(展开态为 aria-expanded="true",折叠态为 "false")。
 * 对每个折叠行调用 click(),等价于用户点了一下整行,触发官方 onToggle。
 *
 * autoExpandedRows 是去重保险:同一个折叠条元素可能同时被两个观察者
 * (如多会话各挂一份 header.actions)扫到,而官方 onToggle 用的是
 * setExpanded(v => !v) 更新器 —— 同一 tick 里点两次会翻转回去,等于
 * 没点。WeakSet 保证同一元素只自动点一次;用户手动收起后再点开的行
 * 是属性变化,本就不在扫描范围,不会被重新展开。
 */
const autoExpandedRows = new WeakSet<HTMLElement>()

function expandThinkRowsWithin(root: ParentNode): void {
  const rows = root.querySelectorAll('[data-variant="think"] [data-disclosure-row][aria-expanded="false"]')
  for (const row of rows) {
    if (!(row instanceof HTMLElement) || autoExpandedRows.has(row)) continue
    autoExpandedRows.add(row)
    row.click()
  }
}

/** 需要的 client 服务:sessions(会话数据)、slots(slot 注册)。 */
export const inject = ['sessions', 'slots']

/** Client 插件 body:注册 header 按钮组、composer.dock 价格行、设置开关行,并接管文件点击。 */
export function apply(ctx: ClientContext): void {
  ensureStyle()
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'web-enhance-jump-reply-ends',
      // 官方已有条目:agent-preset=-10、subagent-catalog=10、job-list=20。
      // 取 15:排在 job-list 之前,且不与 subagent-catalog(10)并列,
      // 渲染位置确定。
      order: 15,
    }, JumpToReplyEnds),
  )
  ctx.slots.inject(
    'conversation.composer.dock',
    () => ctx.slots.register({
      name: 'conversation.composer.dock',
      id: 'web-enhance-session-cost',
      // 官方 stats 行(输入/输出 token)取 0;取 10 渲染在其下方,
      // 且不与未来官方条目并列。
      order: 10,
    }, SessionCostMeter),
  )
  registerNativeOpenRow(ctx)
  installNativeFileOpenFeature(ctx)
}

/**
 * 功能四的设置行:在 `apply()` 里**无条件注册**,不等任何服务。
 *
 * 早期版本把这行注册在「服务齐了」的回调里,结果是只要有一个服务没到位
 * (或该回调因为别的原因没跑),开关就整行消失 —— 而开关是用户唯一能看见
 * 的功能入口,不该被无关链路的时序绑架。现在:
 * - 行立即出现,文案默认走插件内置中文;
 * - locale 服务可用后再注册词典并用 `setText` 换成当前语言,组件不重挂载。
 */
function registerNativeOpenRow(ctx: ClientContext): void {
  ctx.slots.inject(
    'settings.general.item',
    () => {
      return ctx.slots.register({
        name: 'settings.general.item',
        id: 'web-enhance-native-open',
        // 官方功能行:transcript-view=12、composer-enter=20。
        // 取 14:紧跟转写视图行之后,且不与任何现有条目并列。
        order: 14,
      }, NativeOpenRow)
    },
  )
  ctx.inject(['locale'], (scoped: ClientContext) => {
    setNativeOpenText(registerNativeOpenCopy(scoped.locale))
  })
}

/**
 * 功能四的拦截装配:就地把 `ctx.sidebarRight.openResource` 包一层,点文件交
 * 系统默认程序打开。
 *
 * 服务读取用 `ctx.inject([...], cb)`:这件事依赖别的插件提供的服务
 * (`sidebarRight` / `sidebarRightTabs` 来自 ui-sidebar-right,`remote` 来自
 * api-remotes),加载顺序不保证;带服务名的 inject 在服务齐了才触发回调,任一
 * 服务缺失时回调永不触发 —— 结果是拦截静默缺席(点文件回官方右栏)、其余功能
 * 照常,而不是在 undefined 上炸掉整棵组合树。
 *
 * 只等 `remote` 这一层:远端命名空间服务(`ctx.remote.session`)由 api-remotes
 * 挂载贡献时创建,可能晚于 `remote` 本身出现;拿不到时 installNativeFileOpen
 * 会走「host 不支持」这条已有的回退路径,不会报错。
 */
function installNativeFileOpenFeature(ctx: ClientContext): void {
  // 装配约束(三次踩坑后的硬规则):
  // 1) 绝不用 `ctx.get()` 探测服务(未声明即抛,会让整页加载失败);
  // 2) 只用 `ctx.inject([...], cb)` 等待依赖 —— 但它**静默**:依赖不齐就永不触发;
  // 3) 因此必须有「迟到再试」与「自我修复」:装配没成功时监听服务到达事件重试,
  //    并把最终状态写到 DOM 属性上,不再只依赖 Console;
  // 4) 每一步都 try/catch:cordis 会把 step 里的异常吞掉,不接住就完全无痕。
  const state = { tier: -1, installed: false, error: '' }
  const publish = (): void => {
    try {
      document.documentElement.dataset.dshWebeOpenNative = JSON.stringify(state)
    } catch {
      // 非浏览器环境(探针)忽略
    }
  }
  publish()

  const tiers: readonly (readonly string[])[] = [
    ['sidebarRight', 'sessions'],
    ['sidebarRight', 'sidebarRightTabs', 'sessions'],
  ]
  const triedTiers = new Set<number>()
  const signal = new AbortController()
  let installed = false
  let disposed = false
  ctx.effect(() => () => {
    disposed = true
    signal.abort()
  }, 'web-enhance: native file open lifetime')

  const attemptTier = (index: number): void => {
    if (disposed || installed || triedTiers.has(index)) return
    const tier = tiers[index]
    if (tier === undefined) return
    triedTiers.add(index)
    try {
      ctx.inject(tier, (scoped: ClientContext) => {
        if (disposed || installed) return
        try {
          // 只读**本级已声明**的服务:读未声明的服务名会被 cordis 直接抛错
          // (`cannot get property "x" without inject`)——那是我前面整页崩溃的
          // 同一个坑。tier 0 只声明了 sidebarRight+sessions,就不能碰
          // sidebarRightTabs;缺注册表时按「文档预览」这一默认 kind 判定。
          const sidebarRight = scoped.sidebarRight
          const sessions = scoped.sessions
          const sidebarRightTabs = tier.includes('sidebarRightTabs') ? scoped.sidebarRightTabs : undefined
          const handle = installNativeFileOpen(
            sidebarRight,
            sidebarRightTabs,
            sessions,
            signal.signal,
          )
          if (handle === undefined) {
            state.error = `tier ${String(index)}: sidebarRight.openResource 不是函数 (${typeof scoped.sidebarRight?.openResource})`
            publish()
            console.warn('[dsh-web-enhance] 接管失败,点文件仍走官方右栏:', state.error)
            return
          }
          installed = true
          state.tier = index
          state.installed = true
          state.error = ''
          publish()
          // 唯一保留的常规日志:装上了(排查时看这一行即可确认功能在用)
          console.info(`[dsh-web-enhance] 点文件改用系统默认程序打开:已接管(依赖集合=${tier.join('+')})`)
          scoped.effect(() => () => handle.dispose(), 'web-enhance: native file open')
        } catch (error) {
          state.error = `tier ${String(index)} 装配抛异常: ${error instanceof Error ? error.message : String(error)}`
          publish()
          console.debug('[dsh-web-enhance] 该级装配未成功,继续尝试其它组合:', error)
        }
      })
    } catch (error) {
      // ctx.inject 本身抛错(例如上下文已失效):记下来,别静默
      state.error = `tier ${String(index)}: ctx.inject 抛错 ${error instanceof Error ? error.message : String(error)}`
      publish()
      console.warn('[dsh-web-enhance] ctx.inject 抛错', error)
    }
  }

  // 依赖就绪即装配(正常路径)
  attemptTier(0)
  setTimeout(() => attemptTier(1), 1200)

  // 自我修复:任一相关服务迟到,就重新尝试尚未成功的组合。此前版本用一次性闸门
  // (settled),导致「首级回调没触发」时后续级别也永不尝试 —— 功能彻底静默。
  // 这里监听 cordis 的全局服务到达事件(只读通知,不触碰服务解析),不会抛错。
  const retryDelays = [0, 500, 1500, 3000, 6000]
  let retryIndex = 0
  const tryRetry = (): void => {
    if (disposed || installed) return
    // 关键:必须清掉「已尝试」标记,否则迟到重试会被自己挡在门外 ——
    // 那样自我修复形同虚设(探针场景 B 抓到的正是这个 bug)。
    triedTiers.clear()
    attemptTier(0)
    attemptTier(1)
    const delay = retryDelays[retryIndex]
    if (delay !== undefined) {
      retryIndex += 1
      setTimeout(tryRetry, delay)
    }
  }
  try {
    ctx.on('internal/service', () => tryRetry())
  } catch (error) {
    state.error = `ctx.on('internal/service') 不可用: ${error instanceof Error ? error.message : String(error)}`
    publish()
  }
  setTimeout(() => {
    if (!installed && state.error === '') {
      state.error = '依赖一直未就绪(sidebarRight / sessions 未到达);点文件仍走官方右栏'
      publish()
      console.warn('[dsh-web-enhance]', state.error)
    }
  }, 8000)
}

/** blocks 的轻量结构(只取判断所需的字段)。 */
interface BlockLike {
  kind: string
  text?: string
}

/** 判断对象是否携带 blocks 数组字段(类型守卫,避免 as any)。 */
function hasBlocks(value: unknown): value is { blocks?: readonly BlockLike[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { blocks?: unknown }).blocks)
}

/** 取节点的 blocks:assistant 节点在自身,assistant-step 节点在 data。 */
function nodeBlocks(node: { kind: string; data: unknown }): readonly BlockLike[] | undefined {
  if (node.kind === 'assistant' && hasBlocks(node)) return node.blocks
  if (node.kind === 'assistant-step' && hasBlocks(node.data)) return node.data.blocks
  return undefined
}

/** blocks 里是否存在非空正文(text 块)。与官方 hasTextAssistant 同口径。 */
function hasTextBlocks(blocks: readonly BlockLike[] | undefined): boolean {
  return blocks?.some((block) => block.kind === 'text' && (block.text ?? '').trim() !== '') ?? false
}

/** 一个 chat 节点是否算「真正的回复正文」:可见、且含非空正文。 */
function isRealReply(node: { kind: string; data: unknown; visibility: string }): boolean {
  if (node.kind !== 'assistant' && node.kind !== 'assistant-step') return false
  return node.visibility === 'visible' && hasTextBlocks(nodeBlocks(node))
}

/**
 * 一个节点是否算「最终结果」:含非空正文,且 blocks 以正文(text)结尾。
 *
 * 一轮里 agent 会在思考/工具之间蹦出过渡句(blocks 形如
 * [思考, 文字, 工具…] —— 说完还要继续干活),最终结果则是
 * [思考, 文字] 或 [文字](正文后面不再跟工具/思考)。用户要的
 * 「轮的第一行」锚点就是最终结果,过渡句要跳过。
 */
function isFinalReply(node: { kind: string; data: unknown; visibility: string }): boolean {
  if (!isRealReply(node)) return false
  const blocks = nodeBlocks(node)
  // blocks 非空(isRealReply 已保证有 text);取最后一个块的 kind 判断。
  return blocks !== undefined && blocks.length > 0 && blocks[blocks.length - 1].kind === 'text'
}

/** 所需的 chat 快照结构(新前端 useChat / 旧前端 useSession((s) => s.chat) 均满足该形状)。 */
interface ChatLike {
  order: readonly string[]
  nodes: { get(key: string): { kind: string; data: unknown; visibility: string } | undefined }
  locations: { getTurn(turn: number): readonly string[] }
  timeline: { turnOrder: readonly number[] }
}

/**
 * 会话标准 props 的最小形状:新前端(0.1.2-alpha+)里 chat 快照改由
 * dsh-client-ui-chat 通过 uiSession.provide({ hooks: ["chat"] }) 注册成
 * 会话标准 hook useChat;trajectory 由 ui-trajectory 注册成 useTrajectory。
 * 旧前端(0.1.0-rc.x)则分别是 useSession((s) => s.chat) 与
 * useSession((s) => s.views.get('trajectory'))。两处都保留旧路径兜底,
 * 同一环境内恒走同一分支,不违反 React hook 顺序规则。
 */
interface HeaderActionsProps {
  useSession<T>(selector: (snapshot: { chat?: ChatLike }) => T): T
  useChat?: <T>(selector: (snapshot: ChatLike) => T) => T
}

interface ComposerDockProps {
  sessionId: string
  useSession<T>(selector: (snapshot: { views?: { get(key: string): RequestInspectionSnapshot | undefined } }) => T): T
  useTrajectory?: <T>(selector: (snapshot: RequestInspectionSnapshot) => T) => T
  useProjection?: (key: string) => unknown
}

/** 节点 key 属于哪个轮(轮序从前到后找第一个包含它的轮)。 */
function turnOfKey(chat: ChatLike, key: string): number | null {
  for (const turn of chat.timeline.turnOrder) {
    if (chat.locations.getTurn(turn).includes(key)) return turn
  }
  return null
}

/**
 * 某轮的「最终结果」节点 key:轮内最后一个 isFinalReply 的节点;
 * 整轮都没有最终结果(全是一边干活一边说话,没有收尾总结)时,
 * 回退到轮内最后一个含正文的节点。
 */
function finalTextNodeKey(chat: ChatLike, turn: number): string | null {
  const keys = chat.locations.getTurn(turn)
  let fallback: string | null = null
  for (const key of keys) {
    const node = chat.nodes.get(key)
    if (node === undefined || !isRealReply(node)) continue
    fallback = key
    if (isFinalReply(node)) return key
  }
  return fallback
}

/** 会话里是否存在任何含正文的轮(决定按钮组是否渲染)。 */
function hasAnyTextTurn(chat: ChatLike | undefined): boolean {
  if (chat === undefined) return false
  return chat.timeline.turnOrder.some((turn) => finalTextNodeKey(chat, turn) !== null)
}

/**
 * 消息流容器内,视口上 1/3 高度处正在显示的那一行。
 * 用视口上部而非最顶部一行判定「当前在看」的轮:若视口顶部恰好压着
 * 上一轮的尾巴,顶部行会属于上一轮,而用户实际在看的内容属于下一轮。
 */
function rowAtUpperThird(flow: Element): Element | null {
  const scrollport = flow.closest('[data-conversation-scroll]')
  const viewport = (scrollport ?? flow).getBoundingClientRect()
  const point = viewport.top + viewport.height / 3
  for (const row of flow.querySelectorAll('[data-chat-anchor-key]')) {
    const rect = row.getBoundingClientRect()
    // 完全在取样点上方(底部未越过取样点)的行跳过;第一个越过取样点的行即是。
    if (rect.bottom > point) return row
  }
  return null
}

/** 在消息流容器里按 key 找渲染行(避免 key 含特殊字符时 querySelector 转义问题)。 */
function findRow(flow: Element, key: string): Element | null {
  for (const el of flow.querySelectorAll('[data-chat-anchor-key]')) {
    if (el.getAttribute('data-chat-anchor-key') === key) return el
  }
  return null
}

/**
 * 计算某轮「开头/结尾」锚点对应的目标 scrollTop(不做实际滚动)。
 *
 * - edge 'start':该轮最终结果正文起点对齐视口顶部。定位规则(数据驱动,
 *   避免 DOM 猜测):若该节点 blocks 以 reasoning 开头(先思考后正文),
 *   取行内最后一个思考块根元素([data-variant="think"])的底部 + 12px;
 *   否则正文从行顶开始,取行顶。
 *
 *   为什么取思考块「根元素」而不是折叠条:官方 ReasoningRow 的展开内容
 *   (思维链全文)挂在折叠条([aria-expanded])下方的兄弟节点里 —— 展开态
 *   下折叠条自身只有一行高,取它的 bottom 会落在思维链开头;根元素在
 *   展开态下包含整条链,折叠态下等于折叠条本身,两种状态都正确。
 * - edge 'end':该轮最后一个已渲染节点的行底对齐视口底部(轮尾 = 该轮
 *   内容结束的位置,最终结果之后可能还有空思考节点,一并算进轮尾)。
 *
 * @returns 目标 scrollTop;目标行未渲染或找不到时返回 null。
 */
function turnTargetScrollTop(chat: ChatLike, flow: Element, scrollport: Element, turn: number, edge: 'start' | 'end'): number | null {
  const viewport = scrollport.getBoundingClientRect()
  if (edge === 'end') {
    // 从后往前找该轮第一个已渲染的行,它的行底就是轮尾。
    const keys = chat.locations.getTurn(turn)
    for (let i = keys.length - 1; i >= 0; i -= 1) {
      const row = findRow(flow, keys[i])
      if (row !== null) return scrollport.scrollTop + (row.getBoundingClientRect().bottom - viewport.bottom)
    }
    return null
  }
  const key = finalTextNodeKey(chat, turn)
  if (key === null) return null
  const row = findRow(flow, key)
  if (row === null) return null
  const node = chat.nodes.get(key)
  const blocks = node !== undefined ? nodeBlocks(node) : undefined
  let anchorTop: number
  if (blocks?.[0]?.kind === 'reasoning') {
    // 思考块根元素(data-variant="think")才是整条思维链的容器:折叠态下
    // 它等于折叠条,展开态下思维链全文挂载在折叠条([aria-expanded])下方
    // 的兄弟节点里。若取折叠条的 bottom,展开时会落在思维链开头而不是
    // 正文起点 —— 锚点必须取最后一个思考块根的底部(blocks 以 reasoning
    // 开头时,正文紧随最后一个思考块之后)。
    const thinkRoots = row.querySelectorAll('[data-variant="think"]')
    const lastThink = thinkRoots[thinkRoots.length - 1]
    anchorTop = (lastThink !== undefined ? lastThink.getBoundingClientRect().bottom : row.getBoundingClientRect().top) + 12
  } else {
    anchorTop = row.getBoundingClientRect().top
  }
  return scrollport.scrollTop + (anchorTop - viewport.top)
}

/**
 * 执行一次「上/下」轮导航(上下对称的逐轮翻页)。
 *
 * - up:回到当前轮的「开头」(最终结果正文起点);若滚动位置已经停在该轮
 *   开头附近,则跳到上一轮的开头;已是第一轮则不动。
 * - down:跳到当前轮的「结尾」(轮内最后一行行底);若滚动位置已经停在该轮
 *   结尾附近,则跳到下一轮的结尾;已是最后一轮则不动。
 *
 * 「已经停在开头/结尾」用滚动位置与锚点的距离判定(小于 60px,即锚点
 * 已贴着视口边缘),而不是宽泛的视口比例 —— 最终结果很长占满整屏时,
 * 锚点可能仍在视口内但用户其实停在行中段,宽阈值会误判成「已在开头」
 * 而直接翻页。
 */
function navigate(chat: ChatLike | undefined, direction: 'up' | 'down'): void {
  if (chat === undefined) return
  const flow = document.querySelector('[data-chat-flow]')
  if (flow === null) return
  const scrollport = flow.closest('[data-conversation-scroll]')
  if (scrollport === null) return
  const sampleRow = rowAtUpperThird(flow)
  if (sampleRow === null) return
  const sampleKey = sampleRow.getAttribute('data-chat-anchor-key')
  if (sampleKey === null) return

  // 当前轮:取样行所属轮;取样行不属于任何轮(user/context 等节点)时,
  // 向后找最近一个属于轮的节点,把它的轮当作当前轮。
  let currentTurn = turnOfKey(chat, sampleKey)
  if (currentTurn === null) {
    const order = chat.order
    const index = order.indexOf(sampleKey)
    for (let i = index; i < order.length; i += 1) {
      currentTurn = turnOfKey(chat, order[i])
      if (currentTurn !== null) break
    }
  }
  if (currentTurn === null) return

  const turnOrder = chat.timeline.turnOrder
  const currentIndex = turnOrder.indexOf(currentTurn)
  if (currentIndex < 0) return

  const edge: 'start' | 'end' = direction === 'up' ? 'start' : 'end'
  const currentScroll = scrollport.scrollTop

  // 当前轮锚点对应的目标 scrollTop。
  const targetScroll = turnTargetScrollTop(chat, flow, scrollport, currentTurn, edge)
  if (targetScroll === null) return

  // 已经停在当前轮的开头/结尾(锚点距视口边缘 < 60px)→ 翻相邻轮。
  if (Math.abs(currentScroll - targetScroll) < 60) {
    const nextIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1
    if (nextIndex < 0 || nextIndex >= turnOrder.length) return // 已是第一轮/最后一轮
    const nextScroll = turnTargetScrollTop(chat, flow, scrollport, turnOrder[nextIndex], edge)
    if (nextScroll === null) return
    scrollport.scrollTop = nextScroll
    return
  }

  // 否则:回到当前轮的开头 / 跳到当前轮的结尾。
  scrollport.scrollTop = targetScroll
}

/**
 * 会话价格行(conversation.composer.dock,渲染在官方 stats 行同一行、
 * 行内容最左侧)。算法与口径见 cost.ts。
 *
 * 「边发生边累计」:每条观测到 usage 的请求立刻计价并持久化到
 * localStorage(按会话,last-wins),历史分页把旧请求挤出窗口也不影响
 * 累计;只有从未被观测过的历史才走闲时价估算(≈ 前缀)。渲染门控:
 * 最近一次请求不是 deepseek-official 时不渲染(已切到其它 provider)。
 */
function SessionCostMeter({ useSession, useTrajectory, useProjection, sessionId }: ComposerDockProps) {
  // trajectory 请求列表:新前端走会话标准 hook useTrajectory;旧前端退回
  // useSession((s) => s.views.get('trajectory'))。两条数据源的请求条目
  // 字段一致(startSeq/provenance/usage/startedAt),成本算法不变。
  const trajectory = useTrajectory !== undefined
    ? useTrajectory((state) => state)
    : useSession((state) => state.views?.get('trajectory'))
  const usage = useProjection?.('tokenUsage')

  // 合并窗口里的新请求 → 累计器;mergeAccumulator 无变化时返回原引用,
  // 下面的 effect 凭引用相等跳过落盘(流式期间不会反复写 localStorage)。
  const { summary, next } = useMemo(
    () => summarizeCost(trajectory, usage, loadAccumulator(sessionId)),
    [trajectory, usage, sessionId],
  )

  useEffect(() => {
    if (next !== loadAccumulator(sessionId)) saveAccumulator(sessionId, next)
  }, [next, sessionId])

  if (summary === null || !summary.current) return null

  const inputTokens = summary.tokens.miss + summary.tokens.hit + summary.tokens.write
  // 「≈」= 总价里含估算成分:未加载历史的差额,或价格表未收录的模型
  // (按已知模型里最便宜的价格兜底)。两者都会让数字不是全精确。
  const approx = summary.estimated > 0 || summary.unknownModels.length > 0
  const label = [
    `DeepSeek 官方 API(${DEEPSEEK_PROVIDER}) · 模型 ${summary.latestModel ?? '未知'}`,
    `输入 ${formatTokens(inputTokens)} · 输出 ${formatTokens(summary.tokens.out)}`,
    summary.peakCount > 0 || summary.offpeakCount > 0
      ? `峰时 ${summary.peakCount} 次 · 闲时 ${summary.offpeakCount} 次(北京时间)`
      : null,
    summary.estimated > 0 ? '未加载历史差额按闲时价估算' : null,
    summary.unknownModels.length > 0 ? `价格表未收录,按最低价估算:${summary.unknownModels.join('、')}` : null,
  ].filter((part): part is string => part !== null).join(' · ')

  return (
    <Tooltip label={label} side="top" delayMs={500}>
      <span className="dsh-webe-cost">
        {approx ? '≈ ' : ''}{formatCostYuan(summary.total)}
      </span>
    </Tooltip>
  )
}

/**
 * 「轮导航 + 思维链默认展开」悬浮按钮组:上箭头回到当前轮开头(已停在
 * 轮首则翻上一轮),下箭头跳到当前轮结尾(已停在轮尾则翻下一轮),灯泡
 * 按钮是思维链默认展开开关(开启态高亮)。会话里没有任何含正文的轮时
 * 不渲染。
 *
 * 挂载点仍是 header.actions(session 作用域,随会话切换自动重订阅),
 * 但用 createPortal 渲染到 document.body 并以 fixed 定位在右下角,
 * 不占用头部空间。
 */
function JumpToReplyEnds({ useSession, useChat }: HeaderActionsProps) {
  // Chat 快照:新前端走会话标准 hook useChat;旧前端退回 useSession 的
  // chat 字段。快照形状一致(order/nodes/locations/timeline)。
  const chat = useChat !== undefined
    ? useChat((state) => state)
    : useSession((state) => state.chat)

  // 思维链默认展开开关:默认开,持久化在 localStorage,跨会话/刷新生效。
  const [expandThink, setExpandThink] = useState(readExpandThink)

  // 首次渲染时注入样式(按需,避免空白 <style> 常驻)。
  useEffect(() => {
    ensureStyle()
  }, [])

  // 开关打开时自动展开思维链:先全量扫一遍已有行(初次开启/页面加载时
  // 已渲染的历史行),再挂 MutationObserver 盯「新增」的子树 —— 流式
  // 渲染过程中新挂载的 Think 行会被立刻点开,展开态下官方才会挂载全文。
  //
  // 只扫新增子树、不监听属性变化:用户手动收起某条折叠条时,React 只是
  // 把摘要换回 DOM(属性 + 节点替换),不会命中「新增的折叠行」,因此
  // 手动操作不会被插件强行展开回去,尊重用户。
  useEffect(() => {
    if (!expandThink) return
    expandThinkRowsWithin(document)
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue
        for (const added of mutation.addedNodes) {
          if (added instanceof Element) expandThinkRowsWithin(added)
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [expandThink])

  // 会话里还没有任何含正文的轮(新会话/加载中)时整个按钮组不渲染。
  if (!hasAnyTextTurn(chat)) return null

  return createPortal(
    <span className="dsh-webe-jump-float">
      <button
        type="button"
        className="dsh-webe-jump"
        onClick={() => navigate(chat, 'up')}
        title="回到本轮开头(已停在开头则跳上一轮)"
        aria-label="回到本轮开头(已停在开头则跳上一轮)"
      >
        <IconChevronUpOutline14 />
      </button>
      <button
        type="button"
        className="dsh-webe-jump"
        onClick={() => navigate(chat, 'down')}
        title="跳到本轮结尾(已停在结尾则跳下一轮)"
        aria-label="跳到本轮结尾(已停在结尾则跳下一轮)"
      >
        <IconChevronDownOutline14 />
      </button>
      <button
        type="button"
        className="dsh-webe-jump"
        data-active={expandThink || undefined}
        aria-pressed={expandThink}
        onClick={() => {
          const next = !expandThink
          setExpandThink(next)
          writeExpandThink(next)
        }}
        title={expandThink ? '思维链默认展开:开(点击关闭)' : '思维链默认展开:关(点击开启)'}
        aria-label={expandThink ? '思维链默认展开:开(点击关闭)' : '思维链默认展开:关(点击开启)'}
      >
        <IconThinkOutline14 />
      </button>
    </span>,
    document.body,
  )
}
