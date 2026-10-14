/**
 * dsh-web-enhance 插件,浏览器半 —— GLM 套餐额度的纯展示函数。
 *
 * 从 glm-quota.tsx 抽出来单独一个文件:这批函数零依赖(不碰 React、不碰
 * 服务),抽出来才能被 node 探针用 esbuild 现场转译后直接加载验证
 * (与 notify-monitor.ts 同一模式,见 probe/glm-quota-client.test.mjs)。
 * 涉及 React/remote 的装配逻辑留在 glm-quota.tsx。
 */
import type { QuotaPayload, QuotaWindow } from '../quota'

/** 宿主半写入的 settings 条目 id(必须与 index.ts 的 ENTRY_ID 一致)。 */
export const QUOTA_ENTRY_ID = 'web-enhance'

/**
 * describe() 返回的本插件条目最小形状:只声明消费的路径
 * (descriptors[].ns / .value.glmQuota),其余字段不关心。
 */
export interface SectionDescriptor {
  ns?: unknown
  value?: unknown
}

/**
 * 从 describe() 的返回值里取条目数组。宿主的实际形状是
 * `{ writable, hasDocument, namespaces: [...] }`(2026-10-13 在隔离实例
 * 用原始 RPC 实测);容忍直接的数组形态,防宿主版本间漂移。
 */
export function namespacesOf(value: unknown): SectionDescriptor[] | undefined {
  if (Array.isArray(value)) return value
  if (typeof value === 'object' && value !== null) {
    const namespaces = (value as Record<string, unknown>).namespaces
    if (Array.isArray(namespaces)) return namespaces
  }
  return undefined
}

/**
 * 从 describe 结果里取出本插件条目的 quota 载荷,并做形状校验。
 * settings 的 value 是普通 JSON,宿主半写入什么这里读到的就是什么;
 * 校验失败(旧版本宿主/字段缺失/结构被改)一律返回 null,徽章隐藏,
 * 不渲染残缺数据。
 */
export function extractPayload(descriptors: SectionDescriptor[] | undefined): QuotaPayload | null {
  const row = descriptors?.find((entry) => entry.ns === QUOTA_ENTRY_ID)
  // 真实宿主(2026-10-13 用原始 RPC 实测)的条目形状是
  // value: { glmQuota: <载荷> } —— describe 的 value 按 settings schema 的
  // 字段名投影,载荷在 glmQuota 字段下面,还要再解一层。
  const raw: unknown = (row?.value as Record<string, unknown> | undefined)?.glmQuota
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  // v2(0.2.5 起)才带 fixedDaily;老载荷(v1)直接拒 —— 两半发布永远
  // 成对,运行中不会出现 v1 载荷,宁可隐藏也不渲染缺口径的残缺数据。
  if (record.version !== 2) return null
  // fixedDaily 是安全线的输入:缺失/负数/非有限数一律整包拒绝。
  if (typeof record.fixedDaily !== 'number' || !Number.isFinite(record.fixedDaily) || record.fixedDaily < 0) return null
  if (typeof record.fetchedAt !== 'number' || !Number.isFinite(record.fetchedAt)) return null
  if (!Array.isArray(record.windows) || record.windows.length === 0) return null
  // windows 逐条最小校验(单条缺字段时只丢该条,不整包丢弃)。
  const windows: QuotaWindow[] = []
  for (const item of record.windows) {
    if (typeof item !== 'object' || item === null) continue
    const w = item as Record<string, unknown>
    if ((w.kind !== 'short' && w.kind !== 'week')
      || typeof w.windowMs !== 'number'
      || typeof w.startMs !== 'number'
      || typeof w.resetMs !== 'number'
      || typeof w.percentage !== 'number') continue
    windows.push({
      kind: w.kind,
      windowMs: w.windowMs,
      startMs: w.startMs,
      resetMs: w.resetMs,
      current: typeof w.current === 'number' ? w.current : 0,
      total: typeof w.total === 'number' ? w.total : 0,
      remaining: typeof w.remaining === 'number' ? w.remaining : 0,
      percentage: w.percentage,
    })
  }
  if (windows.length === 0) return null
  return {
    version: 2,
    fixedDaily: record.fixedDaily,
    fetchedAt: record.fetchedAt,
    level: typeof record.level === 'string' ? record.level : null,
    windows,
  }
}

/**
 * 固定开销安全线(用户 2026-10-15 定稿口径):
 *
 *   安全线 ceiling = 周总额度 − 固定开销预留(fixedDaily × 距重置天数)
 *
 * 已用额度超过 ceiling 时,**即使其余需求立刻全部停手**,剩余额度也不够
 * 固定开销撑到重置 —— 这是「其余需求必须马上让路」的硬临界线。headroom
 * (安全余量)= 剩余额度 − 预留:正数是还能给其余需求烧的量,负数即越线。
 *
 * 纯函数、每个渲染周期现算:倒计时和预留随真实时钟走,不需要等下一次
 * 拉取(拉取只在 GLM 流式期间发生,两次拉取之间安全线照样要准)。
 */
export interface SafetyInfo {
  /** 参与计算的固定开销日均预算(积分/天,来自载荷)。 */
  fixedDaily: number
  /** 距重置天数(小数,钳 ≥0;时钟偏差不产生负天数)。 */
  daysLeft: number
  /** 固定开销预留 = fixedDaily × daysLeft(积分)。 */
  reserve: number
  /** 已用上限 = max(0, 周总额度 − 预留)(积分)。 */
  ceiling: number
  /** 安全线百分比(与「周额度」同刻度,0-100 取整,便于直接对比)。 */
  ceilingPct: number
  /** 安全余量 = 周剩余额度 − 预留(积分;负 = 已越线)。 */
  headroom: number
  /** true = 已越线(headroom < 0)。 */
  risk: boolean
}

/**
 * 算周窗口的固定开销安全线。输入不合法(总额度非正、预算非负数之外)
 * 返回 null,调用方据此省略安全线段 —— 与「不渲染残缺数据」同一纪律。
 */
export function computeSafety(w: QuotaWindow, fixedDaily: number, now: number): SafetyInfo | null {
  if (!(w.total > 0)) return null
  if (!(fixedDaily >= 0) || !Number.isFinite(fixedDaily)) return null
  const daysLeft = Math.max(0, (w.resetMs - now) / 86_400_000)
  const reserve = fixedDaily * daysLeft
  const ceiling = Math.max(0, w.total - reserve)
  const headroom = w.remaining - reserve
  return {
    fixedDaily,
    daysLeft,
    reserve,
    ceiling,
    ceilingPct: Math.max(0, Math.min(100, (ceiling / w.total) * 100)),
    headroom,
    risk: headroom < 0,
  }
}

/**
 * 紧凑徽章文本(用户 2026-10-15 定稿四段式):
 * 「5h额度18%，周额度35%，安全线40%，5d15h后重置」—— 前两段是各窗口的
 * 额度使用百分比,安全线段与「周额度」同刻度(已用逼近/超过它 = 固定
 * 开销有风险),末段是周窗口重置倒计时(用户指定的 d/h 紧凑记法)。
 * 窗口标签从时长推导(小时级 → 「{n}h」),不硬编码「5h」;没有周窗口
 * 或固定开销口径无效时降级:安全线段省略、倒计时段省略。
 */
export function formatQuotaBadge(
  windows: readonly QuotaWindow[],
  now: number,
  safety: SafetyInfo | null = null,
): string {
  const segments: string[] = []
  let week: QuotaWindow | undefined
  for (const w of windows) {
    if (w.windowMs >= 86_400_000) {
      week = w
      segments.push(`周额度${Math.round(w.percentage)}%`)
    } else {
      const hours = Math.max(1, Math.round(w.windowMs / 3_600_000))
      segments.push(`${hours}h额度${Math.round(w.percentage)}%`)
    }
  }
  if (week !== undefined) {
    if (safety !== null) segments.push(`安全线${Math.round(safety.ceilingPct)}%`)
    segments.push(`${formatCountdown(week.resetMs - now)}后重置`)
  }
  return segments.join('，')
}

/**
 * 重置倒计时的紧凑记法(用户 2026-10-15 定稿):「5d15h」;不足一天降为
 * 「15h30m」,不足一小时降为「42m」。向下取整,负值(时钟偏差)按 0。
 * 与悬浮明细的中文 formatDuration 刻意不同:徽章要短,悬浮要可读。
 */
export function formatCountdown(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${minutes}m`
  return `${minutes}m`
}

/**
 * 周窗口的时间进度百分比(0-100,取整):窗口已过时长占窗口总长的比例。
 * 与「额度使用百分比」是两个维度 —— 使用进度跑得比时间快,说明这个
 * 窗口额度消耗超前,用户能据此判断要不要省着点用。
 */
export function windowElapsedPercent(w: QuotaWindow, now: number): number {
  const ratio = (now - w.startMs) / w.windowMs
  return Math.max(0, Math.min(100, Math.round(ratio * 100)))
}

/**
 * 时长中文格式化(向下取整):「42分」「3小时42分」「2天3小时」。
 * 用于「距重置剩余」与「本周已过」两个方向,负值(时钟偏差)按 0 处理。
 */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return hours > 0 ? `${days}天${hours}小时` : `${days}天`
  if (hours > 0) return minutes > 0 ? `${hours}小时${minutes}分` : `${hours}小时`
  return `${minutes}分`
}
