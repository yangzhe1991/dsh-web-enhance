/**
 * dsh-web-enhance 插件,GLM Coding Plan 套餐额度功能的宿主侧纯计算部分。
 *
 * 口径(与智谱官方文档一致,积分制订阅,非按 token 计费):
 * - 触发:只在「GLM 请求正在流式进行」时查询 quota API(由 index.ts 的
 *   llm/stream 瀑布监听器驱动),流结束时补拉一次,其余时间零外部流量;
 * - 数据源:GET {endpoint}/api/monitor/usage/quota/limit,Bearer 鉴权。
 *   端点在 2026-10-13 用真实 key 实测通过,返回账号级真实用量
 *   (Claude Code 等其它工具的消耗也统计在内,比本地按 token 估算可靠);
 * - 只读不写:本模块不做任何本地积分估算 —— Coding Plan 是订阅额度,
 *   「本会话按系数折算积分」对用户没有决策价值(官方口径与峰谷规则
 *   还会变),展示一律以服务端返回为准。
 *
 * 本文件保持纯函数(无 cordis / 无文件系统),便于 node 探针独立验证;
 * 唯一的 I/O(fetch)由 index.ts 注入回调完成,不在本文件。
 */

/** 一对「凭据引用名 → 所属端点」:key 存在哪一侧,quota API 就打哪一侧。 */
export interface KeyEndpointPair {
  /** 凭据引用名(≈ 环境变量名),经 credentials 服务按请求解析。 */
  ref: string
  /** 该凭据所属平台根地址(不带路径)。 */
  endpoint: string
}

/**
 * 已知的 GLM Coding Plan 平台与默认凭据引用名(与 dsh-llm-pi-ai 底下
 * pi-ai 内置 provider 的 envApiKeyAuth 变量名一致,见
 * pi-ai/dist/providers/zai-coding-cn.js 的 ["ZAI_CODING_CN_API_KEY"])。
 * 顺序即尝试顺序:国内 bigmodel.cn 优先。
 */
export const KEY_ENDPOINT_PAIRS: readonly KeyEndpointPair[] = [
  { ref: 'ZAI_CODING_CN_API_KEY', endpoint: 'https://open.bigmodel.cn' },
  { ref: 'ZAI_API_KEY', endpoint: 'https://api.z.ai' },
]

/** quota API 的路径(挂在平台根地址后)。 */
export const QUOTA_PATH = '/api/monitor/usage/quota/limit'

/**
 * 判定一次模型请求是否走 GLM(决定要不要触发 quota 查询)。
 *
 * 两层判定:
 * 1. provider 路由名在已知 GLM 路由集合里 —— 覆盖 pi-ai 内置的两条
 *    coding 路由与普通 OpenAPI 路由(zhipu);
 * 2. 兜底:model id 以 `glm` 开头(不区分大小写)—— 用户完全可能给
 *    pi-ai 配任意名字的自定义路由指向 GLM 网关,路由名兜不住时靠模型名。
 *
 * 注意:浏览器半(cost.ts)有一份同口径的客户端副本用于渲染门控,
 * 两处必须同步改。
 */
export function isGlmRequest(provider: string | undefined, model: string | undefined): boolean {
  if (provider !== undefined && GLM_PROVIDER_ROUTES.has(provider)) return true
  if (model !== undefined && model.toLowerCase().startsWith('glm')) return true
  return false
}

/** 已知 GLM provider 路由名(小写)。 */
export const GLM_PROVIDER_ROUTES: ReadonlySet<string> = new Set(['zai-coding-cn', 'zai', 'zhipu'])

/**
 * quota API 原始返回里单个限额条目的最小形状(宽松声明,字段缺失都容忍)。
 * 实测(2026-10-13,Max 套餐)返回两个 CREDIT_LIMIT 条目:
 * {unit:3, number:5} ≈ 5 小时窗口;{unit:6, number:1} ≈ 周窗口。
 */
export interface RawLimit {
  type?: unknown
  unit?: unknown
  number?: unknown
  usage?: unknown
  currentValue?: unknown
  remaining?: unknown
  percentage?: unknown
  nextResetTime?: unknown
}

/** quota API 原始返回的最小形状。 */
export interface RawQuotaResponse {
  code?: unknown
  success?: unknown
  data?: { limits?: unknown; level?: unknown } | unknown
}

/**
 * 归一化后的单个时间窗口。字段均为展示所需的最小集:
 * - kind:'short' = 5 小时级窗口,'week' = 周窗口(按窗口时长 ≥ 1 天划分);
 * - windowMs / startMs / resetMs:窗口时长、起点(= 重置时刻 - 时长)、重置时刻
 *   (epoch ms)。startMs 供「本周已过多久」计算,不假设服务端语义;
 * - current / total / remaining / percentage:已用 / 总额 / 剩余 / 服务端算好的百分比。
 */
export interface QuotaWindow {
  kind: 'short' | 'week'
  windowMs: number
  startMs: number
  resetMs: number
  current: number
  total: number
  remaining: number
  percentage: number
}

/** 归一化后的 quota 载荷(写入 settings volatile 字段的最终形状)。 */
export interface QuotaPayload {
  /** 本插件归一化结构的版本(未来字段变化时供客户端识别)。 */
  version: 1
  /** 拉取时刻(epoch ms),客户端展示「更新于」。 */
  fetchedAt: number
  /** 套餐等级(如 "max" / "pro"),服务端原样。 */
  level: string | null
  /** 时间窗口列表(最多两条:5 小时 + 周;异常时可能只有一条)。 */
  windows: readonly QuotaWindow[]
}

/**
 * 时间单位换算表:unit 字段是服务端的时长枚举,实测 3=小时、6=周
 * (由两次 nextResetTime 的间隔反推:5h 窗口 reset 在 ~4h 后、周窗口在
 * ~167h 后)。其余取值按常见枚举惯例防御性收录(1=秒?分?无法确证,
 * 但收录了也不会被误用 —— 未知 unit 的条目直接丢弃,不猜)。
 */
const UNIT_MS: Readonly<Record<number, number>> = {
  1: 1000, // 秒(未实测,防御性)
  2: 60_000, // 分钟(未实测,防御性)
  3: 3_600_000, // 小时(实测:unit 3 × number 5 ≈ 5 小时窗口)
  4: 86_400_000, // 天(未实测,防御性)
  6: 604_800_000, // 周(实测:unit 6 × number 1 ≈ 7 天后重置)
}

/** 一天毫秒数,用于「短窗口 vs 周窗口」的分界。 */
const DAY_MS = 86_400_000

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)

/**
 * 把 quota API 原始返回归一化成展示载荷。
 *
 * - 只认 `code === 200 && success === true` 的应答(该 API 业务失败也回
 *   HTTP 200,必须看业务码);limits 非数组视为无效;
 * - 每个 limit 条目:unit/number 换算窗口时长,换不出的(未知 unit 或
 *   非正数)整条丢弃 —— 宁可少显示一个窗口,也不显示错误的「已过/剩余」;
 * - 窗口按时长分类:< 1 天为 'short'(小时级),≥ 1 天为 'week';
 * - percentage 缺失时按 current/total 自算(四舍五入,与官方口径可能差
 *   1%,仅兜底,正常应答都有现成值)。
 * @returns 无效应答返回 null(调用方保持上一次的载荷不动)。
 */
export function normalizeQuota(raw: RawQuotaResponse, fetchedAt: number): QuotaPayload | null {
  if (raw.code !== 200 || raw.success !== true) return null
  const data = raw.data
  if (typeof data !== 'object' || data === null) return null
  const limits = (data as { limits?: unknown }).limits
  if (!Array.isArray(limits)) return null
  const level = (data as { level?: unknown }).level
  const windows: QuotaWindow[] = []
  for (const item of limits) {
    if (typeof item !== 'object' || item === null) continue
    const limit = item as RawLimit
    const unit = num(limit.unit)
    const count = num(limit.number)
    const factor = UNIT_MS[unit]
    if (factor === undefined || !(count > 0)) continue
    const resetMs = num(limit.nextResetTime)
    if (!(resetMs > 0)) continue
    const windowMs = factor * count
    const current = num(limit.currentValue)
    const total = num(limit.usage)
    const remaining = num(limit.remaining)
    const stated = num(limit.percentage)
    // 服务端百分比是整数;缺失时自算兜底(不四舍五入到整数反而更精确,
    // 但为了与服务端口径一致,同样取整)。
    const percentage = Number.isFinite(stated)
      ? stated
      : Number.isFinite(current) && Number.isFinite(total) && total > 0
        ? Math.round((current / total) * 100)
        : 0
    windows.push({
      kind: windowMs >= DAY_MS ? 'week' : 'short',
      windowMs,
      startMs: resetMs - windowMs,
      resetMs,
      current: Number.isFinite(current) ? current : 0,
      total: Number.isFinite(total) ? total : 0,
      remaining: Number.isFinite(remaining) ? remaining : Math.max(0, total - current),
      percentage,
    })
  }
  if (windows.length === 0) return null
  // 稳定排序:短窗口在前(徽章文案「5h 13% · 周 2%」的顺序依赖这里)。
  windows.sort((a, b) => a.windowMs - b.windowMs)
  return {
    version: 1,
    fetchedAt,
    level: typeof level === 'string' && level.length > 0 ? level : null,
    windows,
  }
}

/**
 * 载荷的「实质变化」签名:写入 settings 之前比较用。
 *
 * 为什么不直接 JSON.stringify 整个载荷:fetchedAt 每次拉取必然变化,
 * 直接比较会把「数据没变、只是时间戳新了」也当成变化,造成无意义写入
 * (settings 写入会走 profile patch 文件改写 + 插件配置 reconcile,
 * 必须省着用)。签名只含展示会变的部分:窗口的百分比/剩余/窗口起止。
 */
export function payloadSignature(payload: QuotaPayload | null): string {
  if (payload === null) return ''
  return JSON.stringify([
    payload.version,
    payload.level,
    payload.windows.map((w) => [w.kind, w.windowMs, w.startMs, w.resetMs, w.current, w.total, w.remaining, w.percentage]),
  ])
}
