/**
 * dsh-web-enhance 插件,会话价格统计的纯计算部分(无 React,便于独立
 * 验证算法;仅 localStorage 读写,且做了 node/隐私模式兜底)。
 *
 * 口径(与官网「模型 & 价格」页一致,人民币 元/百万 tokens):
 * - 只统计走 DeepSeek 官方 API(provider 路由 `deepseek-official`)的请求;
 * - 每条请求按真实时间戳分峰谷计价:峰时 = 北京时间 9:00-12:00、
 *   14:00-18:00(价格为闲时的 2 倍),其余时段为闲时;
 * - 输入分「缓存命中」(折扣价)与「缓存未命中」两档,输出(含思考
 *   内容)按输出价计;缓存写入 token 按未命中价计(DeepSeek 不单列)。
 *
 * 数据源与「边发生边累计」:
 * - trajectory 视图(session.views.get('trajectory')的 requests)逐请求带
 *   provider/model/usage/startedAt/startSeq —— 精确计价的基础;
 * - 浏览器只加载会话最近约 50 条消息的历史分页,更早的要手动点
 *   「加载更早」。为了让长会话的总价不因分页而变估算,插件把每一条
 *   观测到 usage 的请求按 startSeq 持久化累计(localStorage,按会话,
 *   last-wins:同一请求重试后 usage 更新时整体替换、不重复计)。会话
 *   从创建起就用本插件时,所有请求都被累计过,总价全程精确;只有
 *   「从未被任何窗口加载过的历史」(装插件之前、别的设备)才没有
 *   逐请求数据,差额用 tokenUsage 投影(全量 token 合计)扣除已累计
 *   部分后按闲时价估算,UI 用「≈」标注。
 */
import type { RequestInspectionSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
// 触发 SessionProjectionMap 声明合并:tokenUsage 由 dsh-token-meter 声明
// (类型导入会被 esbuild 擦除,不进入浏览器 bundle)。
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'

/** DeepSeek 官方 API 的 provider 路由名(host 注册的 provider id)。 */
export const DEEPSEEK_PROVIDER = 'deepseek-official'

/**
 * 官网人民币价格表(元/百万 tokens),每个字段为 [闲时价, 峰时价]。
 * 数据源:https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * (官网改价时同步更新这里)。
 */
export interface ModelRates {
  /** 输入未命中缓存(普通输入)。 */
  miss: readonly [number, number]
  /** 输入命中缓存(折扣价)。 */
  hit: readonly [number, number]
  /** 输出(含思考内容)。 */
  out: readonly [number, number]
}

/** 已收录价格表的模型。 */
export const DEEPSEEK_RATES: Readonly<Record<string, ModelRates>> = {
  'deepseek-v4-flash': { miss: [1.5, 3.0], hit: [0.05, 0.1], out: [4.5, 9.0] },
  'deepseek-v4-pro': { miss: [4.5, 9.0], hit: [0.15, 0.3], out: [13.5, 27.0] },
}

/**
 * 时间戳(Unix epoch ms)是否落在北京时间的峰时。
 * 峰时 = 北京时间 9:00-12:00、14:00-18:00(官网口径,其余为闲时)。
 */
export function isPeakHour(ms: number): boolean {
  const hour = Math.floor(ms / 3600000 + 8) % 24
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

/** 单个请求 usage 的归一化形状(inputTokens 为「未命中缓存」的输入)。 */
export interface UsageTokens {
  miss: number
  hit: number
  write: number
  out: number
}

/** usage 字段是 wire 上的 unknown,逐字段校验后归一化;全 0/缺字段返回 null。 */
export function readUsage(value: unknown): UsageTokens | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  const miss = num(record.inputTokens)
  const hit = num(record.cacheReadTokens)
  const write = num(record.cacheWriteTokens)
  const out = num(record.outputTokens)
  if (miss + hit + write + out <= 0) return null
  return { miss, hit, write, out }
}

/** 归一化 tokenUsage 投影的值(shape 与 usage 事件一致,只是键名不同)。 */
export function readProjection(value: unknown): UsageTokens | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  const miss = num(record.uncachedInputTokens)
  const hit = num(record.cacheReadTokens)
  const write = num(record.cacheWriteTokens)
  const out = num(record.outputTokens)
  if (miss + hit + write + out <= 0) return null
  return { miss, hit, write, out }
}

/**
 * 一条请求的费用(元):token × 单价,峰值按峰时价。
 * 模型未收录在价格表时返回 null(调用方记入 unknownModels,不硬猜价格)。
 */
export function requestCost(tokens: UsageTokens, model: string, peak: boolean): number | null {
  const rates = DEEPSEEK_RATES[model]
  if (rates === undefined) return null
  const i = peak ? 1 : 0
  // 缓存写入没有单独价格,按未命中输入价计(保守口径)。
  return (tokens.miss * rates.miss[i] + tokens.hit * rates.hit[i] + tokens.write * rates.miss[i] + tokens.out * rates.out[i]) / 1e6
}

/**
 * 一条已观测请求的计价记录,按 startSeq(会话日志全局唯一的请求起始
 * seq)键控、last-wins:同一请求(如重试后 usage 更新)整体替换,
 * 不会重复计费。
 */
export interface CostEntry {
  /** token 分桶(inputTokens 为「未命中缓存」的输入)。 */
  miss: number
  hit: number
  write: number
  out: number
  /** 请求模型(用于明细;未收录时 cost 为 0)。 */
  model: string
  /** 请求是否发生在峰时(按请求真实时间)。 */
  peak: boolean
  /** 按提交时价格表精确计算的费用(元)。 */
  cost: number
}

/**
 * 一个会话的价格累计器:startSeq → 计价记录。
 * 「边发生边累计」的核心 —— 请求被观测到时立刻计价落盘,之后即使
 * 历史分页把它挤出窗口,它的精确费用仍留在累计器里。
 */
export interface CostAccumulator {
  version: 1
  entries: Record<string, CostEntry>
}

/**
 * localStorage 键前缀(按会话存)。价格表(DEEPSEEK_RATES)变更时
 * bump 版本号:旧累计器按旧价格算的 cost 作废,新键从零重新累计。
 */
const ACCUMULATOR_KEY_PREFIX = 'dsh-web-enhance.cost.v1.'

/** 内存缓存:localStorage 的同步镜像;隐私模式下 localStorage 写失败,退化成页面生命周期内的累计。 */
const accumulatorCache = new Map<string, CostAccumulator>()

/** 空累计器。 */
export function emptyAccumulator(): CostAccumulator {
  return { version: 1, entries: {} }
}

/**
 * 载入某会话的累计器:优先内存缓存,其次 localStorage;
 * 损坏/版本不符/不可用时回到空累计器。
 */
export function loadAccumulator(sessionId: string): CostAccumulator {
  const cached = accumulatorCache.get(sessionId)
  if (cached !== undefined) return cached
  let acc: CostAccumulator | null = null
  try {
    const raw = localStorage.getItem(ACCUMULATOR_KEY_PREFIX + sessionId)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown }
      if (parsed.version === 1 && typeof parsed.entries === 'object' && parsed.entries !== null) {
        acc = { version: 1, entries: parsed.entries as Record<string, CostEntry> }
      }
    }
  } catch {
    // localStorage 不可用(隐私模式)或数据损坏:当作没有历史累计
  }
  const result = acc ?? emptyAccumulator()
  accumulatorCache.set(sessionId, result)
  return result
}

/** 落盘某会话的累计器(localStorage 失败时只更新内存缓存,本次页面内仍累计)。 */
export function saveAccumulator(sessionId: string, acc: CostAccumulator): void {
  accumulatorCache.set(sessionId, acc)
  try {
    localStorage.setItem(ACCUMULATOR_KEY_PREFIX + sessionId, JSON.stringify(acc))
  } catch {
    // 忽略:内存缓存兜底
  }
}

/**
 * 把窗口里新观测到的请求合并进累计器。
 *
 * - 只收 deepseek-official 且带 usage 的请求;
 * - 按 startSeq last-wins:同一条目内容没变时跳过,整个窗口都没有
 *   变化时返回原引用(调用方凭引用相等跳过落盘,避免流式期间反复写);
 * - usage 先到后改(重试)会整体替换旧记录,不会重复计费。
 */
export function mergeAccumulator(acc: CostAccumulator, snapshot: RequestInspectionSnapshot | undefined): CostAccumulator {
  let changed = false
  const entries = acc.entries
  for (const request of snapshot?.requests ?? []) {
    const provenance = request.provenance
    if (provenance?.provider !== DEEPSEEK_PROVIDER) continue
    // 防御:startSeq 是请求的唯一身份(契约上必有),缺失时跳过,
    // 避免多条请求塌缩进同一个键互相覆盖。
    if (typeof request.startSeq !== 'number') continue
    const tokens = readUsage(request.usage)
    if (tokens === null) continue
    const key = String(request.startSeq)
    const peak = isPeakHour(request.startedAt)
    const model = provenance.model ?? ''
    const cost = requestCost(tokens, model, peak) ?? 0
    const prev = entries[key]
    if (prev !== undefined
      && prev.miss === tokens.miss && prev.hit === tokens.hit
      && prev.write === tokens.write && prev.out === tokens.out
      && prev.model === model && prev.peak === peak && prev.cost === cost) {
      continue
    }
    entries[key] = { miss: tokens.miss, hit: tokens.hit, write: tokens.write, out: tokens.out, model, peak, cost }
    changed = true
  }
  // 无变化返回原引用;有变化克隆一份(旧引用只可能被改成相同内容,无害)。
  return changed ? { version: 1, entries: { ...entries } } : acc
}

/**
 * 一个完整会话的价格统计结果。
 * - exact:累计器里所有已观测请求的精确费用之和(元,会话从创建起
 *   就用本插件时,这部分就是全程精确价,不受历史分页影响);
 * - estimated:从未被观测过的历史(装插件之前/其它设备/被截断的流)
 *   的差额,按当前模型闲时价估算;
 * - tokens:展示用的全量 token(优先 tokenUsage 投影,缺失时用累计器合计);
 * - latestModel / peakCount / offpeakCount / unknownModels:明细展示用。
 */
export interface CostSummary {
  /**
   * 门控:窗口内最近一次请求(startedAt 最大且带 provenance)是否走的
   * DeepSeek 官方 API。为 false 时组件不渲染(当前已换到其它 provider)。
   */
  current: boolean
  /** 精确计价部分(元,累计器合计)。 */
  exact: number
  /** 估算差额部分(元,从未观测过的历史)。 */
  estimated: number
  /** 总价(元)。 */
  total: number
  /** 全量 token 数(展示用)。 */
  tokens: UsageTokens
  /** 最近一次 DeepSeek 官方请求的模型(差额估算的计价模型)。 */
  latestModel: string | null
  /** 累计器里已观测请求的峰时/闲时条数。 */
  peakCount: number
  offpeakCount: number
  /** 累计器里出现过但价格表未收录的模型(其 token 未计入价格)。 */
  unknownModels: readonly string[]
}

/**
 * 从 trajectory 视图 + tokenUsage 投影 + 已有累计器计算会话价格,
 * 并返回合并窗口后的新累计器(组件负责落盘)。
 *
 * - 门控:窗口内最近一次请求(不限 provider)必须走 deepseek-official;
 * - 差额 = 投影全量 - 累计器合计(而非窗口合计),按桶相减、负值截 0:
 *   已观测过的请求即使被分页挤出窗口也不进差额;差额里混入其它
 *   provider 的 token 时无法拆分,UI 文案里如实说明按闲时价估算;
 * - next 与入参同引用 = 窗口没有新计价记录(组件凭此跳过落盘)。
 */
export function summarizeCost(
  snapshot: RequestInspectionSnapshot | undefined,
  projection: TokenUsageProjection | undefined,
  stored: CostAccumulator,
): { summary: CostSummary | null; next: CostAccumulator } {
  const next = mergeAccumulator(stored, snapshot)

  // 窗口内最近一次请求(不限 provider)与最近一次 deepseek-official 请求。
  let latestOverall: { provider: string; startedAt: number } | null = null
  let latestDeepseek: { model: string; startedAt: number } | null = null
  for (const request of snapshot?.requests ?? []) {
    const provenance = request.provenance
    if (provenance !== undefined && (latestOverall === null || request.startedAt >= latestOverall.startedAt)) {
      latestOverall = { provider: provenance.provider, startedAt: request.startedAt }
    }
    if (provenance?.provider === DEEPSEEK_PROVIDER
      && (latestDeepseek === null || request.startedAt >= latestDeepseek.startedAt)) {
      latestDeepseek = { model: provenance.model ?? '', startedAt: request.startedAt }
    }
  }

  // 累计器合计:所有已观测请求的精确费用与 token。
  const seen: UsageTokens = { miss: 0, hit: 0, write: 0, out: 0 }
  let exact = 0
  let peakCount = 0
  let offpeakCount = 0
  const unknownModels = new Set<string>()
  for (const entry of Object.values(next.entries)) {
    seen.miss += entry.miss
    seen.hit += entry.hit
    seen.write += entry.write
    seen.out += entry.out
    exact += entry.cost
    if (entry.peak) peakCount += 1
    else offpeakCount += 1
    if (entry.cost === 0 && entry.model !== '' && DEEPSEEK_RATES[entry.model] === undefined) {
      unknownModels.add(entry.model)
    }
  }

  // 没有任何已观测的 deepseek-official 用量时不产出结果(新会话)。
  if (seen.miss + seen.hit + seen.write + seen.out <= 0) return { summary: null, next }

  // 差额 = 投影全量 - 已观测合计(负值截 0:投影与累计口径不同时不会出现负数)。
  const all = readProjection(projection)
  const gap: UsageTokens | null = all === null ? null : {
    miss: Math.max(0, all.miss - seen.miss),
    hit: Math.max(0, all.hit - seen.hit),
    write: Math.max(0, all.write - seen.write),
    out: Math.max(0, all.out - seen.out),
  }

  // 差额一律按「当前模型闲时价」估算;当前模型未收录时放弃估算。
  let estimated = 0
  const model = latestDeepseek?.model ?? ''
  if (gap !== null && DEEPSEEK_RATES[model] !== undefined) {
    estimated = requestCost(gap, model, false) ?? 0
  }

  const tokens: UsageTokens = all ?? seen
  return {
    summary: {
      current: latestOverall?.provider === DEEPSEEK_PROVIDER,
      exact,
      estimated,
      total: exact + estimated,
      tokens,
      latestModel: latestDeepseek?.model ?? null,
      peakCount,
      offpeakCount,
      unknownModels: [...unknownModels],
    },
    next,
  }
}

/** 紧凑 token 计数(仿官方 StatsLine:三位以下带一位小数)。 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}K`
  return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`
}

/** 价格展示文本:¥0.01 以下显示「<¥0.01」,其余保留两位小数。 */
export function formatCostYuan(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '¥0.00'
  if (n < 0.01) return '<¥0.01'
  return `¥${n.toFixed(2)}`
}
