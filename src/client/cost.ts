/**
 * dsh-web-enhance 插件,会话价格统计的纯计算部分(无 React,便于独立
 * 验证算法;仅 localStorage 读写,且做了 node/隐私模式兜底)。
 *
 * 口径(与官网「模型 & 价格」页一致,人民币 元/百万 tokens):
 * - 只统计走 DeepSeek 官方 API(provider 路由 `deepseek-official`)的请求;
 * - 每条请求按真实时间戳分峰谷计价:峰时 = 北京时间周一至周五
 *   9:00-12:00、14:00-18:00(价格为闲时的 2 倍),其余(含周末)为闲时;
 * - 输入分「缓存命中」(折扣价)与「缓存未命中」两档,输出(含思考
 *   内容)按输出价计;缓存写入 token 按未命中价计(DeepSeek 不单列);
 * - 模型不在已知价格表里(如官网刚上线、插件价格表还没同步的模型)时,
 *   按已知 DeepSeek 模型里**最便宜**的价格兜底计价(见 CHEAPEST_RATES),
 *   而不是记 0 价 —— 宁可略微低估,也不让新模型的用量白算。
 *
 * 数据源与「边发生边累计」:
 * - trajectory 视图(session.views.get('trajectory')的 requests,或会话标准
 *   hook useTrajectory)逐请求带 provider/model/usage/startedAt/startSeq ——
 *   精确计价的基础;
 * - 浏览器只加载会话最近约 50 条消息的历史分页,更早的要手动点
 *   「加载更早」。为了让长会话的总价不因分页而变估算,插件把每一条
 *   观测到 usage 的请求按 startSeq 持久化累计(localStorage,按会话,
 *   last-wins:同一请求重试后 usage 更新时整体替换、不重复计)。会话
 *   从创建起就用本插件时,所有请求都被累计过,总价全程精确;只有
 *   「从未被任何窗口加载过的历史」(装插件之前、别的设备)才没有
 *   逐请求数据,差额用 tokenUsage 投影(全量 token 合计)扣除已累计
 *   部分后按闲时价估算,UI 用「≈」标注。
 */
/**
 * trajectory 请求的最小形状:新旧前端都提供,只声明本插件消费的字段。
 *
 * provider/model 的**所在字段随 dsh 版本变过三次**,本插件三种都读(见
 * requestRoute 的优先级说明),任一种形态都能计价:
 * - 0.1.7-rc+ (ui-trajectory 重构后把请求统一成 `RequestView`):
 *   `requestConfig`(来自 `request/header` 的生效配置,请求一发起就有)与
 *   `providerMetadata`(来自 `assistant/message` 的 source,请求落成消息后
 *   才有)。**旧的 `provenance` 字段在 0.1.7 里已被彻底移除** —— 这正是
 *   0.1.10 升到 0.1.7 后价格行整个消失的原因:读不到 provider → 合并阶段
 *   跳过所有请求 → summary 为 null → 组件返回 null(没有任何报错,静默
 *   消失,只有从 DOM 属性 dshWebeCost 才看得出来);
 * - 0.1.2-alpha ~ 0.1.5:请求条目带 `provenance: { provider, model }`;
 * - 旧前端(0.1.0-rc.x):会话快照 views.get('trajectory').requests,
 *   字段与 provenance 形态一致。
 *
 * usage 走宽松读取(readUsage),不依赖官方类型。
 */
export interface InspectionRequest {
  startSeq: number
  startedAt: number
  /** 0.1.7-rc+:该请求生效的请求头配置(provider/model 在这里)。 */
  requestConfig?: { provider?: string; model?: string } | undefined
  /** 0.1.7-rc+:host 记录的「实际服务该请求的 provider/model」(更权威)。 */
  providerMetadata?: { provider?: string; model?: string } | undefined
  /** 0.1.2-alpha ~ 0.1.5 的旧字段(0.1.7 起已移除,仅为兼容旧宿主保留)。 */
  provenance?: { provider?: string; model?: string } | undefined
  usage?: unknown
}

/**
 * 取一条请求的 provider/model,按字段权威性排序:
 *
 * 1. `providerMetadata` —— host 落消息时记录的 provider/model(真实服务方),
 *    只在请求产出消息后才有;有就用它;
 * 2. `requestConfig` —— 该请求生效的请求头配置,请求一发起就有(流式期间
 *    也拿得到),所以「最近一条请求是不是 deepseek-official」的门控在
 *    流式过程中依然成立;请求头落在加载窗口之外时可能缺失;
 * 3. `provenance` —— 旧版 dsh 的字段。
 *
 * 三者都没有时返回 `{ provider: undefined, model: undefined }`,调用方按
 * 「拿不到路由信息」处理(不计价、门控不成立)。
 */
export function requestRoute(request: InspectionRequest): { provider: string | undefined; model: string | undefined } {
  const source = request.providerMetadata ?? request.requestConfig ?? request.provenance
  return { provider: source?.provider, model: source?.model }
}

export interface RequestInspectionSnapshot {
  requests: readonly InspectionRequest[]
}

/**
 * tokenUsage 投影的最小形状:读全量 token 合计推算未观测历史的成本。
 * 新旧前端该投影的字段一致(uncachedInputTokens/cacheReadTokens/
 * cacheWriteTokens/outputTokens),宽松声明,不依赖官方类型。
 */
export interface TokenUsageProjection {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

/** DeepSeek 官方 API 的 provider 路由名(host 注册的 provider id)。 */
export const DEEPSEEK_PROVIDER = 'deepseek-official'

/**
 * 官网人民币价格表(元/百万 tokens),每个字段为 [闲时价, 峰时价]。
 * 数据源:https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * (官网改价/新模型时同步更新这里;2026-09-26 核对,在售 2 款)。
 *
 * 2026-09-26 核对结论(与 2026-09-08 那版价格表相比有**改名 + 降价**):
 * - 官网现售 `deepseek-flash`(模型版本 DeepSeek-V4.1-Flash)与
 *   `deepseek-v4-pro`(DeepSeek-V4-Pro-0813);flash 三档全部降价:
 *   未命中输入 1.5→1、命中输入 0.05→0.02、输出 4.5→4(峰时同为 2 倍),
 *   pro 未变;
 * - 旧模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 官方
 *   说明「仍可调用,但对应模型已下线,请求由 DeepSeek-V4.1-Flash 提供
 *   服务,并按 Flash 价格计费」—— 所以这三个名字共用同一份现价
 *   (FLASH_RATES),而不是各自留一份历史价:**表里的价是「现在计费
 *   多少」**,不是「历史上多少钱」;
 * - 历史累计条目**不做重算**(用户 2026-09-26 确认的口径):已经落盘的
 *   条目是当时按当时价表算的,约等于当时的实际计费,不该被新价改写;
 *   只有 est(当时未收录、按兜底价记)与 cost=0 的条目会在载入时补账
 *   (见 migrateAccumulator)。
 */
export interface ModelRates {
  /** 输入未命中缓存(普通输入)。 */
  miss: readonly [number, number]
  /** 输入命中缓存(折扣价)。 */
  hit: readonly [number, number]
  /** 输出(含思考内容)。 */
  out: readonly [number, number]
}

/** DeepSeek-V4.1-Flash 现价(旧模型名 deepseek-v4-flash / vision-exp 同价同服务)。 */
const FLASH_RATES: ModelRates = { miss: [1, 2], hit: [0.02, 0.04], out: [4, 8] }

/** 已收录价格表的模型(键 = host 报上来的 model id,含仍可调用的旧名)。 */
export const DEEPSEEK_RATES: Readonly<Record<string, ModelRates>> = {
  'deepseek-flash': FLASH_RATES,
  'deepseek-v4-pro': { miss: [4.5, 9.0], hit: [0.15, 0.3], out: [13.5, 27.0] },
  // 旧模型名:官方仍接受调用、由 V4.1-Flash 服务并按 Flash 价计费,故同价。
  'deepseek-v4-flash': FLASH_RATES,
  'deepseek-v4-flash-vision-exp': FLASH_RATES,
}

/**
 * 兜底价:价格表未收录的模型按「已知 DeepSeek 模型里最便宜的价格」计。
 *
 * 逐档(未命中输入 / 命中输入 / 输出)取所有已收录模型的最小值,而不是
 * 硬编码某个模型名 —— 以后官网调价或新增模型时,兜底价自动跟着价格表
 * 走,不会出现「表里已经更便宜了、兜底价还是老价」的脱节。当前表里
 * flash 与 vision-exp 同价且三档都最低,所以兜底价 = flash 价。
 *
 * 为什么逐档取最小、而不是「挑一个最便宜的模型」:三档单价互相独立,
 * 并不存在一个统一的「模型便宜程度」排序键;逐档取最小既是对「最便宜
 * 的价格」最直白的解释,也避免为排序键另造一套口径。代价是极端情况下
 * 可能混合多个模型的档位(实际不会:最低价都来自同一个模型),且属于
 * **偏低估**的估算口径。
 */
export const CHEAPEST_RATES: ModelRates = cheapestRates(DEEPSEEK_RATES)

/** 从一张价格表里算出逐档最低价(兜底价的计算,导出仅供独立验证)。 */
export function cheapestRates(table: Readonly<Record<string, ModelRates>>): ModelRates {
  const rows = Object.values(table)
  // 表为空理论上不会发生(常量表非空),防御性返回全 0:宁可算出 0 元,
  // 也不要 Math.min() 得到 Infinity 污染累计器。
  if (rows.length === 0) return { miss: [0, 0], hit: [0, 0], out: [0, 0] }
  /** 取某一档(闲时价/峰时价两列分别取最小)。 */
  const pick = (select: (rates: ModelRates) => readonly [number, number]): readonly [number, number] => [
    Math.min(...rows.map((rates) => select(rates)[0])),
    Math.min(...rows.map((rates) => select(rates)[1])),
  ]
  return { miss: pick((rates) => rates.miss), hit: pick((rates) => rates.hit), out: pick((rates) => rates.out) }
}

/** 取某模型的单价:未收录在价格表里时回退到 CHEAPEST_RATES(最便宜价兜底)。 */
export function ratesFor(model: string): ModelRates {
  return DEEPSEEK_RATES[model] ?? CHEAPEST_RATES
}

/**
 * 时间戳(Unix epoch ms)是否落在北京时间的峰时。
 * 官网口径:高峰时段为北京时间**周一至周五** 9:00-12:00、
 * 14:00-18:00,其余时间(含周六周日全天)为闲时。
 */
export function isPeakHour(ms: number): boolean {
  // 北京时间 = UTC+8(中国无夏令时),加 8 小时后用 UTC 方法读取的
  // 墙钟时刻即北京本地时刻(日、小时都准)。
  const bj = new Date(ms + 8 * 3600000)
  const day = bj.getUTCDay() // 0=周日 ... 6=周六
  const hour = bj.getUTCHours()
  // 周末全天闲时:官网峰时仅限周一至周五(2026-09-08 核对原文)。
  if (day === 0 || day === 6) return false
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
 * 模型未收录在价格表时按 CHEAPEST_RATES(已知模型里最便宜的价格)计,
 * 因此永远有价可算、不再返回 null —— 调用方不必再处理「算不出来」。
 */
export function requestCost(tokens: UsageTokens, model: string, peak: boolean): number {
  const rates = ratesFor(model)
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
  /** 请求模型(用于明细)。 */
  model: string
  /** 请求是否发生在峰时(按请求真实时间)。 */
  peak: boolean
  /** 按提交时价格表计算的费用(元)。 */
  cost: number
  /**
   * 是否按兜底价(CHEAPEST_RATES,未收录模型的最便宜价)计价。
   * 只在未收录模型上写 true(收录模型不写该字段,保持持久化 JSON 精简)。
   *
   * 为什么要标记而不是靠 cost === 0 判断:上一版把未收录模型记成 0 价,
   * 补账迁移能用「cost 为 0」认出它们;现在未收录模型也有非 0 的兜底价,
   * 必须显式标记,迁移才能在「模型后来被收录进价格表」时把它们按新价
   * 重算(历史教训:vision-exp 上线时正是靠补账把 0 价条目修正的)。
   */
  est?: boolean
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
 * localStorage 键前缀(按会话存)。价格表改价(同模型价格变化)时
 * bump 版本号:旧累计器按旧价格算的 cost 作废,新键从零重新累计;
 * 仅「新增模型」不必 bump,由 loadAccumulator 里的 migrateAccumulator
 * 对旧 cost=0 条目补账即可。
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
 *
 * 载入时做一次「补账」迁移(见 migrateAccumulator):价格表变化后,旧累计器
 * 里按兜底价/0 价记的条目需要在展示前按当前价格表重算,否则用户看到的
 * 价格会一直是旧值。
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
  const base = acc ?? emptyAccumulator()
  const result = migrateAccumulator(base)
  accumulatorCache.set(sessionId, result)
  // 迁移有变化时立即落盘(持久化补账结果);无变化返回原引用,不写。
  if (result !== base) saveAccumulator(sessionId, result)
  return result
}

/**
 * 累计器迁移(载入时补账):把「当时没价或按兜底价算的条目」用当前价格表
 * 重算。两类条目需要重算:
 *
 * 1. `est === true` —— 当时模型未收录,按兜底价(最便宜价)计的。之后
 *    模型被收录进价格表(用模型自己的价),或兜底价随价格表变化(官网
 *    调价/新增更便宜的模型),都要按新价修正;
 * 2. `cost === 0` —— 0.1.8 及以前对未收录模型记的 0 价(那时没有 est
 *    标记),首次载入本版时补成兜底价。
 *
 * 其余条目(cost > 0 且非兜底价)是当时按已收录价格表算的精确值,不动。
 *
 * 为什么不做整体版本 bump:版本 bump 的语义是「按旧价格算的 cost 作废、
 * 从零重来」,适用于同模型改价;本次只是「未收录 → 有兜底价」以及
 * 「兜底价可能变化」,精确条目依然有效,bump 会把有效数据白白降级成
 * 「≈ 估算」。补账迁移幂等(重复执行结果一致),无变化返回原引用。
 */
export function migrateAccumulator(acc: CostAccumulator): CostAccumulator {
  let changed = false
  const entries: Record<string, CostEntry> = { ...acc.entries }
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.est !== true && entry.cost !== 0) continue
    // 当前价格表下该模型是否仍未收录 → 决定新的 est 标记。
    const est = DEEPSEEK_RATES[entry.model] === undefined
    const cost = requestCost(
      { miss: entry.miss, hit: entry.hit, write: entry.write, out: entry.out },
      entry.model,
      entry.peak,
    )
    // 幂等:价格没变、标记也没变时不动这个条目(否则每次载入都要落盘)。
    if (cost === entry.cost && est === (entry.est ?? false)) continue
    const next: CostEntry = { ...entry, cost }
    if (est) next.est = true
    else delete next.est
    entries[key] = next
    changed = true
  }
  return changed ? { version: 1, entries } : acc
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
    // provider/model 的读取走 requestRoute(0.1.7 起字段换名,见其注释)。
    const route = requestRoute(request)
    if (route.provider !== DEEPSEEK_PROVIDER) continue
    // 防御:startSeq 是请求的唯一身份(契约上必有),缺失时跳过,
    // 避免多条请求塌缩进同一个键互相覆盖。
    if (typeof request.startSeq !== 'number') continue
    const tokens = readUsage(request.usage)
    if (tokens === null) continue
    const key = String(request.startSeq)
    const peak = isPeakHour(request.startedAt)
    const model = route.model ?? ''
    // 未收录的模型(含 model 缺失)按最便宜价兜底,并打上 est 标记,
    // 供以后「模型被收录/兜底价变化」时补账重算。
    const est = DEEPSEEK_RATES[model] === undefined
    const cost = requestCost(tokens, model, peak)
    const prev = entries[key]
    if (prev !== undefined
      && prev.miss === tokens.miss && prev.hit === tokens.hit
      && prev.write === tokens.write && prev.out === tokens.out
      && prev.model === model && prev.peak === peak && prev.cost === cost
      && (prev.est ?? false) === est) {
      continue
    }
    const entry: CostEntry = { miss: tokens.miss, hit: tokens.hit, write: tokens.write, out: tokens.out, model, peak, cost }
    if (est) entry.est = true
    entries[key] = entry
    changed = true
  }
  // 无变化返回原引用;有变化克隆一份(旧引用只可能被改成相同内容,无害)。
  return changed ? { version: 1, entries: { ...entries } } : acc
}

/**
 * 一个完整会话的价格统计结果。
 * - exact:累计器里所有已观测请求的费用之和(元;已收录模型为精确价,
 *   未收录模型按兜底价估算,见 unknownModels)。会话从创建起就用本插件
 *   时,这部分就是全程价,不受历史分页影响;
 * - estimated:从未被观测过的历史(装插件之前/其它设备/被截断的流)
 *   的差额,按当前模型闲时价估算(当前模型未收录时同样走兜底价);
 * - tokens:展示用的全量 token(优先 tokenUsage 投影,缺失时用累计器合计);
 * - latestModel / peakCount / offpeakCount / unknownModels:明细展示用。
 */
export interface CostSummary {
  /**
   * 门控:窗口内最近一次「带路由信息」的请求(startedAt 最大且能读到
   * provider/model)是否走的 DeepSeek 官方 API。为 false 时组件不渲染
   * (当前已换到其它 provider)。路由字段的三种形态见 requestRoute。
   */
  current: boolean
  /** 累计计价部分(元,累计器合计;含未收录模型的兜底价估算)。 */
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
  /** 累计器里出现过但价格表未收录的模型(已按兜底价估算,UI 里如实标注)。 */
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
 *   当前模型未收录时按兜底价(最便宜价)估算;
 * - next 与入参同引用 = 窗口没有新计价记录(组件凭此跳过落盘)。
 */
export function summarizeCost(
  snapshot: RequestInspectionSnapshot | undefined,
  /** tokenUsage 投影:readProjection 做宽松字段校验,新(0.1.2-alpha+)/旧前端键名一致,unknown 兼容。 */
  projection: unknown,
  stored: CostAccumulator,
): { summary: CostSummary | null; next: CostAccumulator } {
  const next = mergeAccumulator(stored, snapshot)

  // 窗口内最近一次请求(不限 provider)与最近一次 deepseek-official 请求。
  // 路由信息可能整个缺失(旧窗口没有请求头、请求还没落到消息),这种请求
  // 只当它不存在:latestOverall 只携带需要的字段,不作为门控依据。
  let latestOverall: { provider: string | undefined; startedAt: number } | null = null
  let latestDeepseek: { model: string; startedAt: number } | null = null
  for (const request of snapshot?.requests ?? []) {
    const route = requestRoute(request)
    if (route.provider !== undefined && (latestOverall === null || request.startedAt >= latestOverall.startedAt)) {
      latestOverall = { provider: route.provider, startedAt: request.startedAt }
    }
    if (route.provider === DEEPSEEK_PROVIDER
      && (latestDeepseek === null || request.startedAt >= latestDeepseek.startedAt)) {
      latestDeepseek = { model: route.model ?? '', startedAt: request.startedAt }
    }
  }

  // 累计器合计:所有已观测请求的费用与 token。
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
    // 未收录模型现在也有价(兜底价),不能再靠 cost === 0 认;空模型名
    // 只兜底计价、不进明细列表(拼进文案会是一串空白,没意义)。
    if (entry.model !== '' && DEEPSEEK_RATES[entry.model] === undefined) {
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

  // 差额一律按「当前模型闲时价」估算;当前模型未收录时走兜底价(最便宜
  // 价),与逐请求计价口径一致 —— 不再因为「模型不认识」就放弃估算。
  let estimated = 0
  const model = latestDeepseek?.model ?? ''
  if (gap !== null) {
    estimated = requestCost(gap, model, false)
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
