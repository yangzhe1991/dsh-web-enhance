/**
 * dsh-web-enhance 插件,浏览器半 —— GLM Coding Plan 套餐额度徽章(功能六)。
 *
 * 职责只有「读 + 画」:
 * - 读:宿主半区在 GLM 流式期间把 quota 载荷写进本插件 settings 条目的
 *   volatile 字段(glmQuota,写手见 node 半 index.ts);这里经官方
 *   remote.settings.describe() 读取。轮询节奏 5s、只在徽章挂载(= 正在
 *   查看 GLM 会话)时轮询,纯本地 RPC,无外部流量 —— 外部查询的触发
 *   完全由宿主半的 llm/stream 监听器控制,两边职责不重叠;
 * - 画:紧凑徽章「5h 13% · 周 2%」+ 悬浮明细。悬浮口径(用户 2026-10-13
 *   确认):5 小时窗口给百分比 + 距重置剩余时间;周窗口给百分比 +
 *   本窗口已过时长。重置/已过时刻由 nextResetTime 与窗口时长推算
 *   (start = reset - windowMs),不依赖服务端额外字段。
 *
 * 悬浮明细与徽章互为补充,数据一律来自服务端真实用量(账号级,含
 * Claude Code 等其它工具的消耗),本地不做任何按 token 的积分估算。
 */
import { useEffect, useState } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
// 与宿主半 quota.ts 同源的载荷形状(纯类型导入,构建时擦除,无运行时依赖)。
import type { QuotaPayload } from '../quota'
// 纯展示函数(校验/格式化)在 quota-format.ts,便于 node 探针独立加载验证;
// 本文件只留涉及 React/remote 的装配与渲染。
import { extractPayload, formatDuration, formatQuotaBadge, namespacesOf, windowElapsedPercent } from './quota-format'
import type { SectionDescriptor } from './quota-format'

const ENTRY_ID = 'web-enhance'

/** describe 轮询节奏(毫秒):本地 RPC,便宜;5s 足够「流式期间跟手」。 */
const POLL_INTERVAL_MS = 5_000

/** remote.settings.describe() 结果的最小形状(RemoteResult 折叠错误不抛)。 */
interface DescribeOutcome {
  ok: boolean
  /** 实际形状是 { writable, hasDocument, namespaces }(见 quota-format 的 namespacesOf)。 */
  value?: unknown
}

/** remote 服务的最小形状(完整类型由 @deepseek-ai/dsh-api-remotes 合并声明)。 */
interface QuotaRemote {
  settings: { describe(): Promise<DescribeOutcome> }
}

/** 本组件消费的 client ctx 最小形状。 */
interface QuotaClientContext {
  remote?: QuotaRemote
}

/** 模块级 ctx 引用:apply() 时注入(describe 走 remote,必须是已声明服务)。 */
let clientCtx: QuotaClientContext | undefined

/** 由 index.tsx 的 apply() 调用,把 client ctx 交给本模块。 */
export function setQuotaClientCtx(ctx: QuotaClientContext): void {
  clientCtx = ctx
}

/** hook 的全部状态:载荷 + 最近一次 describe 结果(诊断用)。 */
interface QuotaState {
  payload: QuotaPayload | null
  /** true/false = 最近一次 describe 成/败;null = 还没拉过。 */
  describeOk: boolean | null
  /** 最近一次 describe 异常(折叠前的原始错误字符串化)。 */
  error: string | null
}

/**
 * quota 视图 hook:active(徽章应当出现)时每 5s describe 一次。
 * 不 active 时不发起任何调用(本地流量也为零),并保留最后一次载荷 —
 * 会话在 GLM/DeepSeek 间来回切时徽章不必重新等待。
 */
export function useQuotaView(active: boolean): QuotaState {
  const [state, setState] = useState<QuotaState>({ payload: null, describeOk: null, error: null })

  useEffect(() => {
    if (!active) return
    let disposed = false
    /** 拉一次 describe;任何失败都保留旧载荷(徽章不闪没)。 */
    const pull = async (): Promise<void> => {
      const remote = clientCtx?.remote
      // remote 未就绪(老宿主没有 api-remotes)属于「服务缺失即降级」,
      // 不算错误,安静保持 null。
      if (remote === undefined) return
      try {
        const outcome = await remote.settings.describe()
        if (disposed) return
        if (outcome.ok) {
          setState({ payload: extractPayload(namespacesOf(outcome.value)), describeOk: true, error: null })
        } else {
          setState((prev) => ({ ...prev, payload: prev.payload, describeOk: false, error: null }))
        }
      } catch (error) {
        if (disposed) return
        setState((prev) => ({ ...prev, payload: prev.payload, describeOk: false, error: String(error) }))
      }
    }
    void pull()
    const timer = setInterval(() => { void pull() }, POLL_INTERVAL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [active])

  // 排查出口(与价格行的 dshWebeCost 同一套路):一行 DOM 属性定位
  // 「徽章为什么不显示」—— remote 是否就绪、describe 成败、有没有载荷、
  // 载荷几岁了、最近一次错误。放在独立 effect 里,不在渲染期写副作用。
  useEffect(() => {
    try {
      document.documentElement.dataset.dshWebeQuota = JSON.stringify({
        remoteReady: clientCtx?.remote !== undefined,
        active,
        describeOk: state.describeOk,
        hasPayload: state.payload !== null,
        payloadAgeMs: state.payload === null ? null : Date.now() - state.payload.fetchedAt,
        error: state.error,
      })
    } catch {
      // 非浏览器环境(探针)忽略:诊断属性不是功能本身
    }
  }, [state, active])

  return state
}

/** 本地时刻 HH:MM:SS(悬浮明细的「更新于」)。 */
function formatClock(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 套餐额度徽章(conversation.composer.dock,与 DeepSeek 的 ¥ 价格同一
 * 位置、同一行样式;两者按「最近请求路由」互斥渲染)。
 * @param active 会话门控:最近路由命中 GLM 时为 true。
 */
export function GlmQuotaBadge({ active }: { active: boolean }) {
  const { payload } = useQuotaView(active)
  if (!active || payload === null) return null

  const level = payload.level === null ? '' : `（${payload.level}）`
  const now = Date.now()
  // 悬浮明细行:每窗口一行,方向按用户口径 —— 小时级窗口看「距重置还剩」,
  // 周窗口看「本周已过多久」。
  const lines = payload.windows.map((w) => {
    if (w.kind === 'week') {
      // 周窗口三段式(用户 2026-10-13 定稿口径):额度使用百分比 +
      // 窗口时间进度百分比 + 距重置剩余时长。时间进度与使用进度对照,
      // 能看出「这周的额度是不是花超了节奏」。
      return `本周 ${Math.round(w.percentage)}%，本窗口已过 ${windowElapsedPercent(w, now)}%，距离重置 ${formatDuration(w.resetMs - now)}`
    }
    const remaining = w.resetMs - now
    const shortLabel = w.windowMs >= 3_600_000
      ? `${Math.round(w.windowMs / 3_600_000)} 小时窗口`
      : `${Math.round(w.windowMs / 60_000)} 分钟窗口`
    return `${shortLabel} ${Math.round(w.percentage)}%（距重置 ${formatDuration(remaining)}）`
  })
  const label = [
    `GLM Coding Plan${level} · 用量为账号级真实数据`,
    ...lines,
    `更新于 ${formatClock(payload.fetchedAt)}`,
  ].join('\n')

  return (
    <Tooltip label={label} side="top" delayMs={500}>
      <span className="dsh-webe-cost">{formatQuotaBadge(payload.windows, now)}</span>
    </Tooltip>
  )
}
