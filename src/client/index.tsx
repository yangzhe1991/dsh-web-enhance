/**
 * dsh-web-enhance 插件,浏览器半 —— 前端增强功能集合。
 *
 * 功能一:思维链默认展开。官方把每条 reasoning 块渲染成「Think」折叠条
 * (ReasoningRow),默认收起、只露一行摘要;打开开关后,本插件自动点开
 * 对话里全部(包括流式过程中新挂载的)Think 折叠条,直接看思维链全文。
 * 开关是右下角悬浮的灯泡按钮(⚙ 位置见 styles.ts 的 .dsh-webe-float),
 * 状态持久化在 localStorage,默认开启。用户手动收起某条折叠条不会被强制
 * 展开(只对「新增」的子树生效,不监听属性变化)。
 *
 * 功能二:会话价格统计(仅 DeepSeek 官方 API)。当前会话的请求走
 * provider 路由 `deepseek-official` 时,在官方 stats 行(输入/输出 token
 * 那行)同一行最左侧渲染一行「≈ ¥0.83」:已加载历史窗口内的请求逐条按真实
 * 时间戳分峰谷(北京时间 9-12、14-18 为峰时,价格为闲时 2 倍)、按模型
 * 单价精确计价;tokenUsage 投影里窗口外(未翻页加载)的历史没有时间戳,
 * 差额按当前模型闲时价估算并以「≈」前缀标示。价格表未收录的模型(官网
 * 新上线、插件价格表还没同步)按已知 DeepSeek 模型里最便宜的价格兜底
 * 计价,同样计入「≈」并在悬停明细里如实标注。算法见 cost.ts,价格表
 * 数据源:https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *
 * 请求的 provider/model 字段形态随 dsh 版本变过(0.1.7 起是
 * requestConfig/providerMetadata,旧的 provenance 已被移除),三种形态
 * 的读取都收敛在 cost.ts 的 requestRoute 里。
 *
 * 功能三:点对话里的文件路径,交本机默认程序打开,不再弹右侧栏(见 open-native.tsx)。
 *
 * 功能四:跑完提醒 —— 会话真正干完活(agent 停止、没有后台任务在跑、没有等你
 * 选择的弹框)时播一声提示音,页面不在前台时同时把标签页标题改成提醒;有后台
 * 任务失败时改用下行提示音。默认开启,设置 → 通用 里可关。该功能从已停维护的
 * @yangzhe1991/dsh-task-notify 迁移而来,决策口径见 notify-monitor.ts 的文件头。
 *
 * 已移除:逐轮对话导航(上/下箭头)。dsh 0.1.7 官方已内置回合导航轨
 * (TurnNavigator,对话右侧的刻度条),自己再放一对箭头是重复功能;而且官方
 * 0.1.7 改了对话列的 DOM 结构(分步过程组内部也有 [data-chat-flow]、折叠行改用
 * hidden 属性且几何全 0),维护成本明显高于收益。删除位置见 git 历史。
 *
 * 实现:注册到 conversation.composer.dock(价格行)、settings.general.item
 * (两个设置开关行)、shell.overlay(root 作用域:跑完提醒的监视器 + 思维链
 * 开关按钮,都用 createPortal 渲染到 document.body)。价格行通过 useSession /
 * useTrajectory 订阅轨迹、useProjection 读 tokenUsage 全量投影。
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
// 官方模式:ClientContext 就是 cordis 的 Context(服务经声明合并挂在上面)。
// 旧版本从这里导入过 @deepseek-ai/dsh-client-runtime/client,该包已随 dsh 0.1.2 停产。
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 声明合并:ctx.slots 由 ui-renderer 挂载到 cordis Context(官方同款导入)。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// 图标名必须取「运行中的宿主实际导出的那一个」:dsh 0.1.7 起官方图标的命名从
// 尺寸后缀(`IconThinkOutline14`)改成语义后缀(`…OutlineMedium` / `…OutlineRegular`),
// 旧名字在运行时是 undefined,React 渲染时抛 "Element type is invalid",整个
// 客户端组合树白屏 —— 而与「插件没加载」在界面上长得一样,极难定位。
import { IconThinkOutlineMedium, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
// 触发 SlotMap / Context 声明合并:
// - conversation 声明 conversation.composer.dock 与 ctx.sessions;
// - settings 声明 settings.general.item;
// - sidebar-right 声明 ctx.sidebarRight / ctx.sidebarRightTabs;
// - api-remotes 声明 ctx.remote(远端命名空间);
// - layout 声明 shell.overlay(功能四的监视器与思维链按钮挂在这里)。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import {
  DEEPSEEK_PROVIDER,
  formatCostYuan,
  formatTokens,
  loadAccumulator,
  requestRoute,
  saveAccumulator,
  summarizeCost,
} from './cost'
import type { RequestInspectionSnapshot } from './cost'
// 功能三:点文件交系统默认程序打开(拦截 ctx.sidebarRight.openResource)。
import {
  NativeOpenRow,
  installNativeFileOpen,
  registerNativeOpenCopy,
  setNativeOpenText,
} from './open-native'
// 功能四:跑完提醒(提示音 + 标签页标题),从已停维护的 dsh-task-notify 迁移而来。
import { applyNotify, registerNotifyCopy, setNotifyText } from './notify'
import { ensureStyle } from './styles'
import { PLUGIN_BUILD, PLUGIN_VERSION } from './version.generated'

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

/** Client 插件 body:注册 composer.dock 价格行、设置开关行、思维链按钮与提醒监视器,并接管文件点击。 */
export function apply(ctx: ClientContext): void {
  // 装配打点(与提醒功能的打点同一套戳):排查「页面上跑的是哪份构建」,
  // 控制台一行 + dataset.dshWebeVersion 即可,不必翻 DevTools 的 network。
  try {
    console.info(`[dsh-web-enhance] v${PLUGIN_VERSION} 已装配 (build ${PLUGIN_BUILD})`)
    document.documentElement.dataset.dshWebeVersion = `${PLUGIN_VERSION} (build ${PLUGIN_BUILD})`
  } catch (error) {
    console.warn('[dsh-web-enhance] 装配打点失败(已忽略):', error)
  }
  ensureStyle()
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
  // 思维链默认展开的开关按钮:root 作用域,渲染 null 的条目里 createPortal
  // 一个右下角悬浮按钮(与跑完提醒同为 root 级,不随会话切换重挂载)。
  ctx.slots.inject(
    'shell.overlay',
    () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'web-enhance-think-toggle',
    }, ThinkToggleButton),
  )
  registerNativeOpenRow(ctx)
  installNativeFileOpenFeature(ctx)
  // 功能四:跑完提醒(监视条目 + 设置开关行 + 文案注册)。
  applyNotify(ctx)
  ctx.inject(['locale'], (scoped: ClientContext) => {
    setNotifyText(registerNotifyCopy(scoped.locale))
  })
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


/**
 * 思维链默认展开的开关按钮(root 作用域,渲染为右下角悬浮圆钮)。
 *
 * 为什么挂在 shell.overlay 而不是 conversation.session.header.actions:
 * 那个 slot 的作用只是让按钮随会话切换重挂载 —— 而这个开关是全局偏好
 * (localStorage + MutationObserver 全文档扫描),本来就不需要会话上下文。
 * 挂在 root 上少一处会话级 slot 依赖,也少一次重挂载。
 */
function ThinkToggleButton() {
  // 思维链默认展开开关:默认开,持久化在 localStorage,跨会话/刷新生效。
  const [expandThink, setExpandThink] = useState(readExpandThink)

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

  return createPortal(
    <span className="dsh-webe-float">
      <button
        type="button"
        className="dsh-webe-float-button"
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
        <IconThinkOutlineMedium />
      </button>
    </span>,
    document.body,
  )
}

/**
 * 价格行(conversation.composer.dock)从会话标准 props 拿到的 hook:
 * trajectory(逐请求明细,新前端是 useTrajectory、旧前端退回会话视图)与
 * tokenUsage 投影。新前端(0.1.2-alpha+)由 ui-chat / ui-trajectory 通过
 * uiSession.provide({ hooks }) 注册成会话标准 hook;旧前端(0.1.0-rc.x)则分别
 * 是 useSession((s) => s.chat) 与 useSession((s) => s.views.get('trajectory'))。
 * 两处都保留旧路径兜底,同一环境内恒走同一分支,不违反 React hook 顺序规则。
 */
interface ComposerDockProps {
  sessionId: string
  useSession<T>(selector: (snapshot: { views?: { get(key: string): RequestInspectionSnapshot | undefined } }) => T): T
  useTrajectory?: <T>(selector: (snapshot: RequestInspectionSnapshot) => T) => T
  useProjection?: (key: string) => unknown
}

/**
 * 会话价格行(conversation.composer.dock,渲染在官方 stats 行同一行、
 * 行内容最左侧)。算法与口径见 cost.ts。
 *
 * 「边发生边累计」:每条观测到 usage 的请求立刻计价并持久化到
 * localStorage(按会话,last-wins),历史分页把旧请求挤出窗口也不影响
 * 累计;只有从未被观测过的历史才走闲时价估算(≈ 前缀)。渲染门控:
 * 最近一次请求不是 deepseek-official 时不渲染(已切到其它 provider)。
 *
 * 排查出口:「不显示了」有且只有两种可能 —— ① 窗口里压根没有带
 * deepseek-official 路由的请求(summary 为 null,新会话或字段形态又变了);
 * ② 有数据但门控为 false(最近一次请求换了 provider)。两者在 UI 上
 * 都是「什么都不显示」,所以本组件把判定过程写到 DOM 属性
 * `document.documentElement.dataset.dshWebeCost`(与功能四的
 * dshWebeOpenNative 同一套路),一行读取即可定位断在哪一环,不必再靠
 * 反复刷新 + 贴 Console 二分。
 */
function SessionCostMeter({ useSession, useTrajectory, useProjection, sessionId }: ComposerDockProps) {
  // trajectory 请求列表:新前端走会话标准 hook useTrajectory;旧前端退回
  // useSession((s) => s.views.get('trajectory'))。两条数据源的请求条目
  // 字段一致(startSeq/startedAt/usage + 路由字段),路由字段随 dsh 版本
  // 变过形(0.1.7 起是 requestConfig/providerMetadata),读取统一走
  // cost.ts 的 requestRoute,不在组件里另写一套判断。
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

  // 排查状态(DOM 属性):窗口请求数 / 其中 deepseek-official 的条数 /
  // 窗口里最近一条请求的路由 / 当前累计价 / 价格行是否渲染。
  // 放在 early return 之前(否则不渲染时反而没有状态可看)。
  useEffect(() => {
    try {
      const requests = trajectory?.requests ?? []
      let deepseek = 0
      let latest: { provider: string | undefined; model: string | undefined; startedAt: number } | null = null
      for (const request of requests) {
        const route = requestRoute(request)
        if (route.provider === DEEPSEEK_PROVIDER) deepseek += 1
        if (route.provider !== undefined && (latest === null || request.startedAt >= latest.startedAt)) {
          latest = { provider: route.provider, model: route.model, startedAt: request.startedAt }
        }
      }
      document.documentElement.dataset.dshWebeCost = JSON.stringify({
        requests: requests.length,
        deepseek,
        latest: latest === null ? null : `${latest.provider ?? '?'}/${latest.model ?? '?'}`,
        total: summary?.total ?? null,
        shown: summary !== null && summary.current,
      })
    } catch {
      // 非浏览器环境(探针)忽略:诊断属性不是功能本身
    }
  }, [trajectory, summary])

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
