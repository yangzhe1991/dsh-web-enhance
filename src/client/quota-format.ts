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
  if (record.version !== 1) return null
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
    version: 1,
    fetchedAt: record.fetchedAt,
    level: typeof record.level === 'string' ? record.level : null,
    windows,
  }
}

/**
 * 紧凑徽章文本:每个窗口一段「{label} {percent}%」,如「5h 13% · 周 2%」。
 * 窗口标签从时长推导(小时级 → 「{n}h」,≥1 天 → 「周」),不硬编码 5h ——
 * 官方哪天调整窗口长度,文案自动跟上。
 */
export function formatQuotaBadge(windows: readonly QuotaWindow[]): string {
  return windows.map((w) => `${windowLabel(w)} ${Math.round(w.percentage)}%`).join(' · ')
}

/** 单窗口的短标签:小时级显示「{n}h」,一天及以上显示「周」。 */
function windowLabel(w: QuotaWindow): string {
  if (w.windowMs >= 86_400_000) return '周'
  const hours = Math.max(1, Math.round(w.windowMs / 3_600_000))
  return `${hours}h`
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
