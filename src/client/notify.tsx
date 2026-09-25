/**
 * dsh-web-enhance 功能五「跑完提醒」(浏览器半,不渲染任何可见 UI)。
 *
 * 迁移自已停维护的 @yangzhe1991/dsh-task-notify@0.2.0,行为口径不变:
 * 1. 监视每个顶层会话的「忙闲」,在真正的收尾点提醒 —— 判定口径见
 *    `./notify-monitor.ts` 的文件头(核心:agent 停止 + 无运行中后台任务 +
 *    无等待用户选择的弹框,再安静 2 秒才响)。旧版「回合结束就响 / 任务结束
 *    就响」会在一段活里响很多次且大多是误报,已废弃。
 * 2. 提醒方式(同一个开关一起管):
 *    a. 播放合成提示音(Web Audio,无音频资源;正常结束上行双音,
 *       本次忙活里有后台任务 failed/killed 则下行双音);
 *    b. 页面不在当前标签(document.hidden)时改标签页标题,回到前台恢复。
 *
 * 与 task-notify 版本的差异(仅这三处,算法未动):
 * - 新增设置开关「跑完提醒」(设置 → 通用),默认开启,存 localStorage;
 * - jobs 服务从 `ctx.jobs` 直接读改成 `ctx.inject(['jobs'], cb)` 等待 —— 提醒是
 *   web-enhance 的一个功能,不能让「jobs 服务缺失」把插件的其它功能一起拖没
 *   (直接读未声明服务会抛,等于整页崩);代价是 jobs 一直不到时提醒静默缺席,
 *   所以这里有显式的诊断出口 `dataset.dshWebeNotify`;
 * - 日志前缀与诊断属性统一成 `[dsh-web-enhance]` / `dshWebe*`(见 AGENTS.md
 *   「日志戳要统一」的教训),不再单列一套 `[task-notify]`。
 *
 * 数据来自三处官方契约(dsh 0.1.7 起):
 *   - `useSessions`(会话列表快照:ids / byId.origin)决定「监视哪些顶层会话」;
 *   - `useSessionStatus`(每会话 running + pendingInteraction)给出「agent 在不在跑 /
 *     有没有弹框等着用户选」;
 *   - `ctx.jobs`(任务控制服务,dsh 0.1.7 从列表快照的 jobsBySession 迁到这里)按会话
 *     订阅任务列表(`watchRows`),用于判断「还有没有后台任务在跑」。
 *
 * 浏览器限制:autoplay 策略要求 AudioContext 在用户交互后才可发声,
 * 插件监听首次 pointerdown/keydown 解锁;未解锁前提示音静默跳过,
 * 标题提醒不受影响。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
// 官方模式:ClientContext 就是 cordis 的 Context(服务经声明合并挂在上面)。
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
// 声明合并(仅类型,esbuild 擦除):
// - ui-renderer 提供 ctx.slots;
// - ui-session 把 useSessions / useSessionStatus 挂进 GlobalStandardProps;
// - ui-layout 声明 shell.overlay 这个 slot;
// - ui-settings 声明 settings.general.item 这个 slot;
// - api-job-controller 把 `ctx.jobs` 合并进 Context,并提供 IJobs / JobsSnapshot 类型。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { IJobs, JobsSnapshot } from '@deepseek-ai/dsh-api-job-controller/client'
import { createMonitor, type NotifyKind, type SessionInput } from './notify-monitor'
import { PLUGIN_BUILD, PLUGIN_VERSION } from './version.generated'

// —— 可调参数 ——

/** 提醒的开关键(localStorage;与「思维链默认展开」「文件用系统程序打开」同一套约定)。 */
const ENABLED_KEY = 'dsh.web-enhance.notify'
/** 标签页标题里提醒文案的前缀。 */
const ALERT_PREFIX = '🔔'
/**
 * 「忙转闲」之后的安静窗口(毫秒):任务 settled 与宿主唤醒 agent 是同一拍的两件事,
 * 客户端分两条流到达,必须等一个窗口确认没有新回合接手,才算真的干完。
 */
const QUIET_MS = 2000

// —— 开关(纯浏览器侧偏好,不走官方 settings 文档,与功能二/四同款做法) ——

/** 只读内存镜像:localStorage 不可用(隐私模式)时退化为页面生命周期内的偏好。 */
let notifyEnabled: boolean | undefined

/** 读取开关:默认开启(task-notify 的老行为;不想要的人在设置里关掉)。 */
export function loadNotifyEnabled(): boolean {
  if (notifyEnabled !== undefined) return notifyEnabled
  let enabled = true
  try {
    enabled = localStorage.getItem(ENABLED_KEY) !== '0'
  } catch {
    // 隐私模式等场景:读不到就按默认值,不抛
  }
  notifyEnabled = enabled
  return enabled
}

/** 开关变化订阅者(设置行与监视组件都订阅它,保证「关掉立刻不响」)。 */
const listeners = new Set<() => void>()

/** 写入开关(localStorage 不可用时只更新内存镜像,本次页面内仍生效)并通知订阅者。 */
export function saveNotifyEnabled(enabled: boolean): void {
  notifyEnabled = enabled
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0')
  } catch {
    // 静默忽略:内存镜像已更新
  }
  for (const listener of listeners) listener()
}

/** 注册一个开关变化监听,返回注销函数。 */
export function subscribeNotifyEnabled(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// —— 文案(内置中文兜底 + 官方 locale 可用时切换,排版照功能四) ——

/** 提醒相关的全部文案(标题提醒里的计数走 `{count}` 插值)。 */
const COPY = {
  zh: {
    alertChoice: '需要你选择',
    alertDone: '{count} 个会话跑完了',
    title: '跑完提醒',
    description: '会话真正干完活(agent 停止、没有后台任务在跑、没有等你选择的弹框)时播一声提示音;页面不在前台时同时把标签页标题改成提醒。有后台任务失败时改用下行提示音。',
  },
  en: {
    alertChoice: 'waiting for your choice',
    alertDone: '{count} session(s) finished',
    title: 'Completion alert',
    description: 'Play a chime when a session really finishes its work (agent stopped, no background job running, no dialog waiting for you), and change the tab title while the page is in the background. A background job that failed switches to a descending tone.',
  },
} as const

/** 当前语言下的文案键。 */
type CopyKey = keyof typeof COPY.zh

/** 插件自有 locale 命名空间(不合并进官方 LocaleNamespaceMap,用非类型化形态注册)。 */
const NS = 'web-enhance-notify'

/**
 * 当前生效的取词函数:默认内置中文,不等 locale 服务 —— 设置行在 `apply()` 里
 * 无条件注册,若文案要等官方 locale 就绪,一旦那个回调没跑整行就会消失。
 */
let text: (key: CopyKey, params?: Record<string, string | number>) => string = (key) => COPY.zh[key]

/** 文案变化订阅者(设置行与监视组件订阅,换词后重渲染,组件不重挂载)。 */
const textListeners = new Set<() => void>()

/**
 * 注册文案并返回取词函数;locale 服务缺失或注册失败时退回内置中文。
 *
 * 两种 locale API 形态都兼容:官方 `bind(ns)` 返回的取词函数既可能自己接受
 * 插值参数(`t(key, params)`),也可能是 `t(key)` + `t(key, params)` 返回字符串
 * (如 `{count}` 占位符);这里把参数透传 + 捕获返回值两条路都留着,拿不到结果
 * 就自己替换 `{name}` 占位符。
 */
export function registerNotifyCopy(
  locale:
    | {
        register: (ns: string, locale: string, dict: Record<string, string>) => unknown
        bind: (ns: string) => (key: string, params?: Record<string, string | number>) => string
      }
    | undefined,
): (key: CopyKey, params?: Record<string, string | number>) => string {
  const interpolate = (key: CopyKey, params?: Record<string, string | number>): string => {
    // COPY 是 as const,取词结果是字面量联合;显式标注成 string 再拼接,
    // 否则 replaceAll 的返回值赋回字面量类型会报 TS2322。
    let value: string = COPY.zh[key]
    if (params !== undefined) {
      for (const [name, replacement] of Object.entries(params)) value = value.replaceAll(`{${name}}`, String(replacement))
    }
    return value
  }
  if (locale === undefined || typeof locale.register !== 'function' || typeof locale.bind !== 'function') return interpolate
  try {
    locale.register(NS, 'zh', { ...COPY.zh })
    locale.register(NS, 'en', { ...COPY.en })
    const t = locale.bind(NS)
    return (key, params) => {
      let value: unknown
      try {
        value = t(key, params)
      } catch {
        return interpolate(key, params)
      }
      // 插值型 API 返回 string;占位符型 API 可能返回非字符串,此时自己兜底插值。
      if (typeof value !== 'string') return interpolate(key, params)
      return value
    }
  } catch {
    return interpolate
  }
}

/** 换掉当前取词函数并通知已挂载的组件(语言切换、locale 晚到时调用)。 */
export function setNotifyText(next: (key: CopyKey, params?: Record<string, string | number>) => string): void {
  text = next
  for (const listener of textListeners) listener()
}

// —— 提示音:Web Audio 合成,无需音频资源 ——

/** 全局唯一的 AudioContext(浏览器限制:需用户交互后 state 才为 running)。 */
let audioContext: AudioContext | null = null

/** 获取并尽力解锁音频上下文;不可用时返回 null(调用方静默跳过)。 */
function ensureAudio(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null
  if (audioContext === null) {
    try {
      audioContext = new AudioContext()
    } catch {
      return null
    }
  }
  // 首次用户交互后 resume 才会真正成功;这里尽力而为。
  if (audioContext.state === 'suspended') void audioContext.resume()
  return audioContext.state === 'running' ? audioContext : null
}

/** 播放一个正弦音(带音量包络,避免爆音)。 */
function tone(ctx: AudioContext, frequency: number, start: number, duration: number): void {
  const oscillator = ctx.createOscillator()
  const gain = ctx.createGain()
  oscillator.type = 'sine'
  oscillator.frequency.value = frequency
  // 快速起音 + 指数衰减,峰值音量 0.25。
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  oscillator.connect(gain)
  gain.connect(ctx.destination)
  oscillator.start(start)
  oscillator.stop(start + duration + 0.05)
}

/**
 * 播放提示音:正常收尾为上行双音(do → mi),本次忙活里有任务失败/被杀为
 * 下行双音(mi → do)。「弹框等你选」与「跑完了」用同一个音(用户口径)。
 */
function playChime(failed: boolean): void {
  const ctx = ensureAudio()
  if (ctx === null) return
  const now = ctx.currentTime
  if (!failed) {
    tone(ctx, 880, now, 0.18)
    tone(ctx, 1318.5, now + 0.18, 0.35)
  } else {
    tone(ctx, 659.25, now, 0.18)
    tone(ctx, 440, now + 0.18, 0.4)
  }
}

// —— 标签页标题提醒 ——

/**
 * 标题提醒的小状态机(工厂函数:状态装在闭包里,由组件用 ref 持有)。
 *
 * 计数只在「页面隐藏期间」累计:同一个提醒重复触发只会让标题里的数字变大,
 * 回到前台一次性清零并还原原标题。
 */
interface TitleAlerter {
  /** 记一次提醒(kind 决定文案);页面可见时什么都不做。 */
  alert: (kind: NotifyKind) => void
  /** 回到前台/关闭开关时还原原标题并清零。 */
  clear: () => void
}

function createTitleAlerter(): TitleAlerter {
  /** 尚未清除的「跑完了」计数。 */
  let pendingDone = 0
  /** 尚未清除的「等你选择」计数。 */
  let pendingChoices = 0
  /** 设置提醒前保存的原标题,用于恢复(非 null 即表示当前标题被改过)。 */
  let savedTitle: string | null = null

  const apply = (): void => {
    if (savedTitle === null) savedTitle = document.title
    // 有等待用户选择的弹框时优先显示「需要你选择」(那条更急)。
    const alert = pendingChoices > 0
      ? `${ALERT_PREFIX} ${text('alertChoice')}`
      : `${ALERT_PREFIX} ${text('alertDone', { count: pendingDone })}`
    document.title = `${alert} — ${savedTitle}`
  }

  return {
    alert: (kind) => {
      if (document.hidden !== true) return
      if (kind === 'choice') pendingChoices += 1
      else pendingDone += 1
      apply()
    },
    clear: () => {
      pendingChoices = 0
      pendingDone = 0
      if (savedTitle === null) return
      document.title = savedTitle
      savedTitle = null
    },
  }
}

// —— 诊断出口 ——

/**
 * 把装配与运行状态写到 DOM 属性(排查用)。
 *
 * 为什么要有:`jobs` 服务缺失、插件的提醒条目没进组合、快照形状变了 —— 这三件事
 * 在界面上都表现为「不响」,只有 Console 日志的话用户可能已经过滤了。一行
 * `document.documentElement.dataset.dshWebeNotify` 就能定位断在哪一环
 * (与功能四/价格行的 dshWebeOpenNative / dshWebeCost 同一套路)。
 */
interface NotifyDiag {
  /** 装配层级:-1 = 还在等 jobs 服务,0 = 已装。 */
  tier: number
  /** 装配失败原因(空串 = 无)。 */
  error: string
  /** 开关状态。 */
  enabled: boolean
  /** 正在监视的顶层会话数。 */
  sessions: number
  /** 已订阅任务列表的会话数。 */
  watched: number
  /** 每会话阶段(idle / busy / quiet)。 */
  phases: Record<string, string>
  /** 当前是否停在「等你选择」上。 */
  pending: string[]
}

function publish(diag: NotifyDiag): void {
  try {
    document.documentElement.dataset.dshWebeNotify = JSON.stringify(diag)
  } catch {
    // 非浏览器环境(探针)忽略:诊断属性不是功能本身
  }
}

// —— 插件装配(由 index.tsx 调用) ——

/**
 * 注册「跑完提醒」的两处装配:全局监视条目 + 设置开关行。
 *
 * 监视条目等 `jobs` 服务:`ctx.inject(['jobs'], cb)` 在服务到位时才回调,服务
 * 永远不到时提醒静默缺席(其余功能不受影响),诊断属性里能看到 tier 停在 -1。
 * 这一点是刻意的 —— 提醒是 web-enhance 的一个功能,不能让它的依赖把插件其它
 * 四个功能一起拖下水(直接读 `ctx.jobs` 在服务缺失时会抛,进而让整个 entry
 * 应用失败)。
 */
export function applyNotify(ctx: ClientContext): void {
  try {
    console.info(`[dsh-web-enhance] v${PLUGIN_VERSION} 提醒功能已装配:会话安静 / 弹框等待时提醒 (build ${PLUGIN_BUILD})`)
    document.documentElement.dataset.dshWebeNotifyVersion = `${PLUGIN_VERSION} (build ${PLUGIN_BUILD})`
  } catch (error) {
    console.warn('[dsh-web-enhance] 提醒功能装配打点失败(已忽略):', error)
  }

  const diag: NotifyDiag = {
    tier: -1,
    error: '',
    enabled: loadNotifyEnabled(),
    sessions: 0,
    watched: 0,
    phases: {},
    pending: [],
  }
  publish(diag)

  // 设置开关行:无条件注册(与功能四同理 —— 它是用户唯一能看见的入口,
  // 不该被无关链路的时序绑架)。
  ctx.slots.inject(
    'settings.general.item',
    () => ctx.slots.register({
      name: 'settings.general.item',
      id: 'web-enhance-notify',
      // 官方功能行:transcript-view=12、composer-enter=20;功能四(native-open)取 14。
      // 取 16:紧跟功能四之后,且不与任何现有条目并列。
      order: 16,
    }, NotifyRow),
  )

  // jobs 服务到位后再挂监视条目(服务缺失即静默缺席,诊断属性里可见)。
  //
  // registered 闸门:ctx.inject 会在依赖服务「重新 provide」时再次回调(如宿主
  // 断线重连重建了任务控制器),而同一个 slot id 重复注册是冲突;这里只注册一次,
  // 后续回调只刷新诊断状态。
  let registered = false
  ctx.inject(['jobs'], (scoped: ClientContext) => {
    try {
      const jobs = scoped.jobs
      diag.tier = 0
      diag.error = ''
      publish(diag)
      if (registered) return
      registered = true
      scoped.slots.inject(
        'shell.overlay',
        () => scoped.slots.register({
          name: 'shell.overlay',
          id: 'web-enhance-notify',
        }, (props: GlobalStandardProps) => <NotifyWatcher {...props} jobs={jobs} diag={diag} />),
      )
    } catch (error) {
      diag.error = `装配抛异常: ${error instanceof Error ? error.message : String(error)}`
      publish(diag)
      console.warn('[dsh-web-enhance] 提醒功能装配失败(已忽略,其余功能不受影响):', error)
    }
  })
}

// —— 设置行 ——

/** 设置行组件的 props:没有来自组合的字段(文案与状态都自持)。 */
export type NotifyRowProps = Record<string, never>

/** 「通用」分区里的开关行:跑完提醒(提示音 + 标签页标题一起管)。 */
export function NotifyRow() {
  const [enabled, setEnabled] = useState(loadNotifyEnabled)
  // 文案变化(语言切换 / locale 晚到)时重渲染,组件实例与开关状态都不受影响
  const [, setTextRevision] = useState(0)
  useEffect(() => {
    const rerender = (): void => setTextRevision((revision) => revision + 1)
    textListeners.add(rerender)
    const unsubscribeSwitch = subscribeNotifyEnabled(() => setEnabled(loadNotifyEnabled()))
    return () => {
      textListeners.delete(rerender)
      unsubscribeSwitch()
    }
  }, [])
  const title = text('title')
  return (
    <div className="dsh-webe-setting-row">
      <div className="dsh-webe-setting-text">
        <div className="dsh-webe-setting-title">{title}</div>
        <div className="dsh-webe-setting-desc">{text('description')}</div>
      </div>
      <Switch
        checked={enabled}
        label={title}
        onChange={(next) => {
          // 先写持久值再更新本地状态:监视组件读的是同一个来源(loadNotifyEnabled),
          // 订阅回调会同步触发它重新读值,保证「关掉立刻不响」。
          saveNotifyEnabled(next)
          setEnabled(next)
        }}
      />
    </div>
  )
}

// —— 监视组件 ——

/** 首次用户交互解锁音频(pointerdown/keydown 各一次,取先到者)。 */
function useAudioUnlock(): void {
  useEffect(() => {
    const unlock = (): void => {
      void ensureAudio()
    }
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [])
}

/**
 * 订阅官方任务服务的每会话任务列表(`JobsSnapshot.rows`)。
 *
 * dsh 0.1.7 起任务不再随会话列表快照下发,而是按会话订阅(`watchRows`):
 * 没人订阅的会话在 rows 里没有键,所以「会话有没有在跑的任务」必须先订阅再读。
 * 用 useSyncExternalStore 直接订阅官方 observable(官方组件同款写法,
 * 见 ui-chat / ui-commands)。
 */
function useJobRows(jobs: IJobs): JobsSnapshot['rows'] {
  return useSyncExternalStore(
    (onChange) => jobs.state.subscribe(onChange),
    () => jobs.state.getSnapshot().rows,
  )
}

/**
 * 全局监视组件(root 作用域,渲染 null):把官方快照投影成「每会话事实」喂给
 * 状态机,状态机决定何时提醒;同时按状态机给出的活跃集合维护任务订阅。
 */
function NotifyWatcher({ useSessions, useSessionStatus, jobs, diag }: GlobalStandardProps & { jobs: IJobs; diag: NotifyDiag }) {
  // 会话 id 列表(宿主列表序);byId 只用来取 origin 判 subagent 子会话。
  const ids = useSessions((state) => state.ids)
  const byId = useSessions((state) => state.byId)
  // 每会话 UI 状态:running(agent 在不在跑)+ pendingInteraction(有没有弹框等你选)。
  const status = useSessionStatus((snapshot) => snapshot)
  const rows = useJobRows(jobs)

  // 开关:订阅后关闭/打开都立刻生效(关闭时状态机不再安排提醒)。
  const enabled = useSyncExternalStore(subscribeNotifyEnabled, loadNotifyEnabled)

  // 提醒回调:在「响的那一刻」才读开关与文案,避免把过期的闭包写进状态机。
  const alerterRef = useRef<TitleAlerter | null>(null)
  alerterRef.current ??= createTitleAlerter()
  const monitor = useMemo(
    () => createMonitor({
      quietMs: QUIET_MS,
      isEnabled: loadNotifyEnabled,
      notify: (kind, failed) => {
        if (!loadNotifyEnabled()) return
        playChime(failed)
        alerterRef.current?.alert(kind)
      },
    }),
    [],
  )

  // 投影:跳过 subagent 子会话 —— 它的结束必然唤醒父会话继续干活,
  // 单独提醒就是「没跑完就叫」(父会话那一侧的后台任务仍在 live,不会漏报)。
  //
  // 防御性写法:渲染期抛异常会让整个客户端组合树崩成白屏(比「不提醒」严重得多),
  // 所以宿主快照形状不符预期时一律降级为「这一帧不提醒」,绝不抛。
  const inputs = useMemo(() => {
    const next = new Map<string, SessionInput>()
    if (!Array.isArray(ids) || byId === null || typeof byId !== 'object') return next
    for (const id of ids) {
      const row = byId[id]
      if (row === undefined || row.origin === 'subagent') continue
      const live = status?.get(id)
      next.set(id, {
        // SessionStatus.running 为 undefined 时(还没建立基线)退回列表快照的宿主状态。
        running: live?.running ?? row.running === true,
        // 没有订阅任务列表的会话在 rows 里没有键 ⇒ 当作「当前看不到任务」。
        jobs: rows?.[id] ?? [],
        pendingChoiceKey: live?.pendingInteraction?.key,
      })
    }
    return next
  }, [ids, byId, status, rows])

  /** 当前维持的任务订阅:会话 id → 取消函数。 */
  const watchesRef = useRef(new Map<string, () => void>())

  useEffect(() => {
    // 状态机自己也不允许把异常抛进 React(定时器回调/adapter 里抛会静默丢失),
    // 这里兜底并留一条可见日志,便于以后排查契约变化。
    try {
      monitor.update(inputs)
    } catch (error) {
      console.warn('[dsh-web-enhance] 推进提醒状态机失败(已忽略):', error)
    }

    // 订阅集合 = agent 正在跑的会话 ∪ 状态机仍认为活跃的会话(忙 / 等安静窗口)。
    // 后半句是必须的:agent 让出回合等后台任务时 running 已经是 false,
    // 但那时恰恰最需要盯着任务列表 —— 否则会把「还有任务在跑」误判成「干完了」。
    const wanted = new Set<string>()
    for (const [id, input] of inputs) if (input.running) wanted.add(id)
    for (const id of monitor.activeSessions()) if (inputs.has(id)) wanted.add(id)

    const watches = watchesRef.current
    for (const [id, stop] of watches) {
      if (wanted.has(id)) continue
      watches.delete(id)
      try {
        stop()
      } catch (error) {
        console.warn(`[dsh-web-enhance] 释放会话 ${id} 的任务订阅失败(已忽略):`, error)
      }
    }
    // 新增订阅:遍历官方的会话 id 列表(带品牌类型,watchRows 需要它),
    // 而不是遍历上面那个纯 string 的集合。
    for (const id of ids) {
      if (!wanted.has(id) || watches.has(id)) continue
      try {
        watches.set(id, jobs.watchRows(id))
      } catch (error) {
        console.warn(`[dsh-web-enhance] 订阅会话 ${id} 的任务列表失败(已忽略):`, error)
      }
    }

    // 诊断出口:装配状态 + 运行期事实,一行 DOM 属性读取即可定位。
    diag.enabled = enabled
    diag.sessions = inputs.size
    diag.watched = watches.size
    diag.phases = Object.fromEntries(monitor.phases())
    diag.pending = [...inputs].filter(([, input]) => input.pendingChoiceKey !== undefined).map(([id]) => id)
    publish(diag)
  }, [monitor, inputs, jobs, ids, enabled, diag])

  // 回到前台时清除标题提醒(页面隐藏期间累计的计数一并清零)。
  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (!document.hidden) alerterRef.current?.clear()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  // 开关被关掉:立刻还原标题(铃声由状态机那条路拦住)。
  useEffect(() => {
    if (!enabled) alerterRef.current?.clear()
  }, [enabled])

  // 卸载(插件被移除 / 组合树重建)时清掉在途定时器与全部订阅,避免幽灵提醒,
  // 并把可能被改过的标题还原。
  useEffect(() => () => {
    for (const stop of watchesRef.current.values()) {
      try {
        stop()
      } catch {
        // 卸载期释放失败无需上报:服务很可能已经随上下文一起销毁。
      }
    }
    watchesRef.current.clear()
    monitor.dispose()
    alerterRef.current?.clear()
  }, [monitor])

  useAudioUnlock()

  return null
}
