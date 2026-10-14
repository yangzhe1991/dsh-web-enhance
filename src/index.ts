/**
 * dsh-web-enhance 插件,node 半(宿主侧)。
 *
 * 功能六:GLM Coding Plan 套餐额度 —— 会话走 GLM 时,在价格统计的同一
 * 位置改显套餐额度用量(5 小时窗口 + 周窗口)。其余五个功能(思维链默认
 * 展开、会话价格统计、文件用系统程序打开、跑完提醒、设置开关行)全部在
 * 浏览器半实现,本文件历史上只有一个空 apply;这次是第一次长出宿主侧
 * 行为,原因是硬性的:quota API 要用 API key 鉴权,而 key 只存在于宿主
 * 的凭据区(credentials 服务按设计不向浏览器回传密钥值),浏览器半拿不到。
 *
 * 数据通路(全部官方面,无自定义 RPC 通道 —— dsh 0.2.0-rc.1 起 gateway
 * 独占 /api 面,插件不能再注册自己的通道):
 *
 *   触发   llm/stream 瀑布事件 —— 宿主本来就看得见每一次模型调用。
 *          provider/model 命中 GLM 才开始拉取;流结束(正常/出错/被取消)
 *          补拉一次;没有任何 GLM 流在跑时零外部请求、零定时器。
 *          这比「客户端发现会话在动 → 通知宿主」少一条反向通道,而且
 *          天然覆盖子代理等宿主侧并发调用(设计确认:用户 2026-10-13,
 *          「正在更新内容时才查询」)。
 *   拉取   GET {endpoint}/api/monitor/usage/quota/limit(Bearer key),
 *          key 从 credentials 服务解析,引用名自动配对端点(见 quota.ts;
 *          端点与应答形状 2026-10-13 用真实 key 实测通过)。
 *   中继   写进本插件 settings 条目的 volatile 字段(glmQuota):
 *          volatile 字段只进运行时配置,客户端经 remote.settings.describe()
 *          读取。只在载荷「实质变化」时写(百分比/剩余/重置点变了才写),
 *          因为每次 settings 写入都要走 configEditor.edit → profile patch
 *          文件改写 + 配置 reconcile,高频写不可接受。
 *   展示   浏览器半:正在查看的会话最近路由是 GLM 时,每 5s 轮询一次
 *          describe(本地 RPC,无外部流量),渲染徽章;见 client/glm-quota.ts。
 *
 * 注入的服务(llm / credentials / settings)声明在模块级 `inject` 导出里。
 * 任一服务缺失(如 headless 组合没有 settings 条目)时对应的 inject 回调
 * 永不触发,功能整体静默缺席 —— 与浏览器半「服务缺失即降级」的惯例一致。
 */
import z from '@deepseek-ai/schemastery'
import {
  KEY_ENDPOINT_PAIRS,
  QUOTA_PATH,
  isGlmRequest,
  normalizeQuota,
  payloadSignature,
} from './quota'
import type { QuotaPayload } from './quota'

/** settings 条目 id:必须与 cordis.patch.yml insert 行的 id 一致。 */
const ENTRY_ID = 'web-enhance'

/** 本插件 settings 条目里承载 quota 载荷的 volatile 字段名。 */
export const GLM_QUOTA_FIELD = 'glmQuota'

/** 插件配置里「固定开销日均预算」的字段名(普通配置,非 volatile)。 */
export const GLM_FIXED_DAILY_FIELD = 'fixedDaily'

/**
 * 固定开销日均预算的默认值(积分/天)。
 *
 * 口径(2026-10-15 与用户确认):常驻自动化负载(key 0ca4ef8e…)实测
 * 2026-10-13 单日 ≈12518 积分,留安全裕度取整 13000;账单积累几天后
 * 可经插件配置覆盖(见 Config.fixedDaily)。
 */
export const GLM_FIXED_DAILY_DEFAULT = 13000

/**
 * 插件配置:
 * - fixedDaily —— 固定开销日均预算(积分/天),安全线的输入。普通配置
 *   (非 volatile),可经 profile 的 cordis patch 行 config 覆盖;
 * - glmQuota —— volatile 的 quota 载荷缓存(由宿主自己写入,见下)。
 */
export const Config = z.object({
  [GLM_FIXED_DAILY_FIELD]: z.number(),
  [GLM_QUOTA_FIELD]: z.any().volatile(),
})

/**
 * 从插件配置里解析固定开销日均预算:非负有限数才采纳,否则回退默认值。
 * schemastery 这份分支没有 .default() 原型方法,缺省值在代码里兜底,
 * 顺带把「配了负数/非数字」这类脏输入一并拦下。
 */
export function resolveFixedDaily(config: unknown): number {
  const raw = (config as { [GLM_FIXED_DAILY_FIELD]?: unknown } | undefined)?.[GLM_FIXED_DAILY_FIELD]
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : GLM_FIXED_DAILY_DEFAULT
}

/** 需要的宿主服务:llm(触发源)、credentials(key)、settings(中继)。 */
export const inject = ['llm', 'credentials', 'settings']

/** 一次模型调用里本插件消费的最小字段(完整定义见 dsh-llm 的 GenerateOptions)。 */
interface StreamCallInfo {
  provider?: string
  model?: string
}

/** 凭据服务解析结果的最小形状。 */
interface CredentialHit {
  value: string
}

/** 凭据服务用到的最小接口(只声明本插件调用的方法)。 */
interface CredentialsService {
  resolve(ref: string): Promise<CredentialHit | undefined>
}

/** settings 服务用到的最小接口(只声明本插件调用的方法)。 */
interface SettingsService {
  /** 关闭本插件条目的自动表单(条目只为 describe 提供数据出口,不给人编辑)。 */
  configure(presentation: { auto: boolean }, owner: unknown): void
  /** 合并写入一个条目的 volatile 字段(expectedRevision 传 undefined 跳过冲突检查)。 */
  update(ns: string, patch: Record<string, unknown>, expectedRevision: number | undefined): Promise<unknown>
}

/** 本插件消费的宿主上下文最小形状(cordis Context 的运行时子集)。 */
interface HostContext {
  /** 瀑布事件监听;options 为 cordis 全局选项(global 让监听覆盖子代理作用域)。 */
  on(event: 'llm/stream', listener: (options: StreamCallInfo, next: () => AsyncIterable<unknown>) => unknown, options?: { global?: boolean; prepend?: boolean }): void
  /** 带 disposer 的作用域 effect(插件卸载时清理定时器)。 */
  effect(setup: () => (() => void) | void, label?: string): void
  /** 等服务就绪再回调;任一服务缺失时回调永不触发(静默降级)。 */
  inject(services: string[], callback: (scope: HostContext) => void): void
  logger: { warn(message: unknown): void }
  fiber?: unknown
}

/** 两次外部拉取之间的最小间隔(毫秒):流开始的即时拉取与定时器/并发流去重。 */
const MIN_FETCH_GAP_MS = 15_000

/** GLM 流式进行中的定时拉取节奏(毫秒)。 */
const ACTIVE_FETCH_INTERVAL_MS = 20_000

/** 单次 quota 请求的超时(毫秒):偶发慢不应拖住后续节奏。 */
const FETCH_TIMEOUT_MS = 10_000

/** 同一条警告日志的最小重复间隔(毫秒):失败时避免按拉取节奏刷日志。 */
const LOG_REPEAT_MS = 60_000

/** 插件 body:装配 quota 触发器。其余功能全部在浏览器半,这里不碰。 */
export function apply(ctx: HostContext, config: unknown): void {
  // 固定开销日均预算:安全线的输入,随载荷下发(见 quota.ts QuotaPayload)。
  const fixedDaily = resolveFixedDaily(config)
  // —— 状态(每个插件实例一份,随 fiber 释放) ——
  /** 正在流式进行的 GLM 请求数(引用计数:并发请求/子代理都算)。 */
  let activeStreams = 0
  /** 定时器句柄;null = 当前没有 GLM 流在进行(此时不应存在任何定时器)。 */
  let timer: ReturnType<typeof setInterval> | null = null
  /** 上一次外部拉取时刻(0 = 从未拉过);MIN_FETCH_GAP 去重用。 */
  let lastFetchAt = 0
  /** 上一次写入 settings 的载荷签名(空串 = 尚未写过)。 */
  let lastSignature = ''
  /** 限频警告的上次记录。 */
  let lastWarn: { message: string; at: number } = { message: '', at: 0 }
  /** settings 中继写手;settings 服务就绪前为 null,载荷先暂存。 */
  let writeQuota: ((payload: QuotaPayload) => Promise<void>) | null = null
  /** 凭据解析手;credentials 服务就绪前为 null(此时拉取直接跳过)。 */
  let resolveKey: (() => Promise<{ key: string; endpoint: string } | null>) | null = null
  /** 暂存:settings 未就绪期间拉到的最新载荷,服务就绪后立即补写。 */
  let pending: QuotaPayload | null = null

  /** 同内容限频警告:LOG_REPEAT_MS 内的重复消息只打一次。 */
  const warnOnce = (message: string): void => {
    const now = Date.now()
    if (lastWarn.message === message && now - lastWarn.at < LOG_REPEAT_MS) return
    lastWarn = { message, at: now }
    ctx.logger.warn(`[dsh-web-enhance] ${message}`)
  }

  // —— settings 中继:volatile 字段写入 + 隐藏自动表单 ——
  // auto:false:本插件的 settings 条目只为 describe() 提供一个数据出口,
  // 不该在设置页渲染成一张表单(字段是机器写的载荷,对人没有编辑意义)。
  ctx.inject(['settings'], (scope) => {
    const settings = (scope as unknown as { settings?: SettingsService }).settings
    if (settings === undefined) return
    try {
      settings.configure({ auto: false }, ctx.fiber)
    } catch (error) {
      // configure 对同一 fiber 重复注册会抛「已配置」——策略已在就继续用。
      warnOnce(`settings 呈现策略注册失败(忽略): ${String(error)}`)
    }
    writeQuota = async (payload) => {
      await settings.update(ENTRY_ID, { [GLM_QUOTA_FIELD]: payload }, undefined)
    }
    // 服务就绪前积压的载荷立即补写(时序兜底:GLM 流可能先于 settings 就绪)。
    if (pending !== null) {
      const delayed = pending
      pending = null
      void writeQuota(delayed).catch((error) => warnOnce(`settings 补写失败: ${String(error)}`))
    }
  })

  // —— 凭据解析:按 KEY_ENDPOINT_PAIRS 顺序找第一个已设置的 key ——
  ctx.inject(['credentials'], (scope) => {
    const credentials = (scope as unknown as { credentials?: CredentialsService }).credentials
    if (credentials === undefined) return
    resolveKey = async () => {
      for (const pair of KEY_ENDPOINT_PAIRS) {
        const hit = await credentials.resolve(pair.ref)
        if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) {
          return { key: hit.value, endpoint: pair.endpoint }
        }
      }
      return null
    }
  })

  /**
   * 拉一次 quota 并按需写入 settings。所有失败路径都只记日志、绝不抛出:
   * 本函数挂在 llm/stream 触发的异步链上,quota 展示是纯增益功能,
   * 任何异常都不允许反噬模型调用主链路。
   */
  const fetchAndPublish = async (): Promise<void> => {
    const now = Date.now()
    // 最小间隔去重:流开始的即时拉取、20s 定时器、多条并发流共用于本函数,
    // 密集触发时只保留第一次。
    if (now - lastFetchAt < MIN_FETCH_GAP_MS) return
    lastFetchAt = now
    if (resolveKey === null) {
      warnOnce('credentials 服务未就绪,跳过 quota 拉取')
      return
    }
    const pair = await resolveKey()
    if (pair === null) {
      warnOnce(`凭据区没有 GLM API key(尝试过:${KEY_ENDPOINT_PAIRS.map((p) => p.ref).join('、')}),quota 功能保持沉默`)
      return
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(`${pair.endpoint}${QUOTA_PATH}`, {
        headers: { authorization: `Bearer ${pair.key}`, accept: 'application/json' },
        signal: controller.signal,
      })
    } catch (error) {
      warnOnce(`quota 请求失败(${pair.endpoint}): ${String(error)}`)
      return
    } finally {
      clearTimeout(timeout)
    }
    if (!response.ok) {
      warnOnce(`quota 请求 answered ${String(response.status)}(${pair.endpoint})`)
      return
    }
    let raw: unknown
    try {
      raw = await response.json()
    } catch (error) {
      warnOnce(`quota 应答不是 JSON: ${String(error)}`)
      return
    }
    const payload = normalizeQuota(raw as Parameters<typeof normalizeQuota>[0], Date.now(), fixedDaily)
    if (payload === null) {
      warnOnce('quota 应答格式不认识(code/success/limits 不符合预期),保持上一次载荷')
      return
    }
    // 实质变化才写(见文件头「中继」说明):签名含窗口起止/剩余/百分比,
    // 不含 fetchedAt —— 纯时间戳刷新不值得一次文件改写。
    const signature = payloadSignature(payload)
    if (signature === lastSignature) return
    lastSignature = signature
    if (writeQuota === null) {
      pending = payload
      warnOnce('settings 服务未就绪,quota 载荷已暂存(就绪后补写)')
      return
    }
    try {
      await writeQuota(payload)
    } catch (error) {
      warnOnce(`quota 载荷写入 settings 失败: ${String(error)}`)
    }
  }

  /** GLM 流开始:引用计数 +1,并保证「立即拉一次 + 20s 节奏」在跑。 */
  const onStreamStart = (): void => {
    activeStreams += 1
    if (timer !== null) return
    timer = setInterval(() => { void fetchAndPublish() }, ACTIVE_FETCH_INTERVAL_MS)
    void fetchAndPublish()
  }

  /** GLM 流结束:引用计数 -1,归零时停表并补拉一次(抓刚消费掉的额度)。 */
  const onStreamEnd = (): void => {
    activeStreams = Math.max(0, activeStreams - 1)
    if (activeStreams > 0 || timer === null) return
    clearInterval(timer)
    timer = null
    void fetchAndPublish()
  }

  // —— 触发源:llm/stream 瀑布监听器 ——
  // 瀑布契约与包流手法照抄官方 dsh-session-checkpoint-policy:非 GLM 请求
  // 零开销直通;GLM 请求用 `yield* next()` 把下游流逐分片原样透传(只读、
  // 不复制不改写),async 生成器的 finally 同时覆盖正常结束 / 下游抛错 /
  // 消费方提前终止三种收尾。global:true 让子代理等子作用域的调用也被看到
  // (官方 session-title 同款选项)。
  ctx.effect(() => {
    ctx.on('llm/stream', (options, next) => {
      if (!isGlmRequest(options.provider, options.model)) return next()
      onStreamStart()
      return (async function* (): AsyncGenerator<unknown, void, void> {
        try {
          yield* next()
        } finally {
          onStreamEnd()
        }
      })()
    }, { global: true })
    // 插件卸载(热重载/禁用)时,若有 GLM 流还在跑,定时器必须跟着 fiber 走。
    return () => {
      if (timer !== null) clearInterval(timer)
      timer = null
      activeStreams = 0
    }
  }, 'dsh-web-enhance: glm quota trigger')
}
