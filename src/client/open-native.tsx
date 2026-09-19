/**
 * 功能四:会话里的文件用系统默认程序打开,不再自动弹右侧栏。
 *
 * 背景(dsh 0.1.5-rc.2 实测口径,非猜测):
 * - 官方 `ui-chat` 的 `openFile` 回调把每一次「点文件」都硬编码成
 *   `ctx.sidebarRight.openResource(url)`,url 由 `fileAddressFor()` 造出,
 *   形如 `dsh-resource://file/session/<sessionId>/<相对或绝对路径>`;
 *   工具行(ui-tool)的文件路径摘要走同一条路;
 * - 官方 `ui-sidebar-documentpreview` 认领 `dsh-resource://file/**`,把它开成
 *   右栏的文档预览 tab,于是「点文件 = 右栏弹出来」;
 * - `ui-chat` / `ui-sidebar-*` 的 settings schema 里都没有能关掉这个行为的
 *   开关(ui-chat 只有 transcriptView),所以只能由插件接管。
 *
 * 接管点选在 `ctx.sidebarRight.openResource(address, options)`:
 * 它是「点文件」唯一的公共入口(ui-chat 与 ui-tool 都只经它),而右栏自己的
 * 导航走 `openTab(kind)` / 树行拿到的 `tab.actions.openResource`,不会被误伤 ——
 * 后者经 `openResourceIn(sessionId, …)` 落到 `placeResource`,不经过本包装。
 *
 * 只拦「文件」这一种文档:
 * - 地址必须是 `dsh-resource://file/…`(右栏还开别的资源类型,例如图片附件);
 * - 打开类型必须是文档预览(资源类型注册表认领后为 `document`;页类型如
 *   `files` 文件树、`guide` 引导页走 openTab,天然不在此列);
 * - 显式指定了别的 kind 时放行(调用方明确要右栏里的某个 tab)。
 *
 * 真正打开动作交给官方 host 的 `session.openWorkspacePath`(见
 * `dsh-api-session-controller` 与 `dsh-client-ui-deliverables` 的同款用法):
 * 它把路径交给本机默认程序,不经过浏览器下载。桌面打不开(纯远程部署、
 * 无桌面会话)时返回 false,调用方退回官方右栏行为 —— 不报错、不吞点击。
 */
import { useEffect, useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
// 声明合并(仅类型,esbuild 会擦除):
// - sidebar-right 把 `ctx.sidebarRight` / `ctx.sidebarRightTabs` 合并进 cordis Context;
// - api-remotes 把 `ctx.remote` 的远端命名空间合并进 Context;
// - settings 把 `settings.general.item` 合并进 SlotMap。
// 与官方插件同款写法(官方包同样靠 import type 触发声明合并)。
import type { ISidebarRight } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

/** 开关的 localStorage 键(与功能二的思维链开关同一套约定)。 */
const NATIVE_OPEN_KEY = 'dsh.web-enhance.open-file-native'

/** 只读内存镜像:localStorage 不可用(隐私模式)时退化为页面生命周期内的偏好。 */
let nativeOpenEnabled: boolean | undefined

/** 读取开关:默认开启(产品诉求即「不要弹右栏」),localStorage 异常也按开启处理。 */
export function loadNativeOpenEnabled(): boolean {
  if (nativeOpenEnabled !== undefined) return nativeOpenEnabled
  let enabled = true
  try {
    enabled = localStorage.getItem(NATIVE_OPEN_KEY) !== '0'
  } catch {
    // 隐私模式等场景:读不到就按默认值,不抛
  }
  nativeOpenEnabled = enabled
  return enabled
}

/** 写入开关(localStorage 不可用时只更新内存镜像,本次页面内仍生效)。 */
export function saveNativeOpenEnabled(enabled: boolean): void {
  nativeOpenEnabled = enabled
  try {
    localStorage.setItem(NATIVE_OPEN_KEY, enabled ? '1' : '0')
  } catch {
    // 静默忽略:内存镜像已更新
  }
}

/** 订阅开关变化(开关行自己写、这里读,跨组件同步靠订阅)。 */
const listeners = new Set<() => void>()

/** 注册一个开关变化监听,返回注销函数。 */
export function subscribeNativeOpenEnabled(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// —— 资源地址解析 ——

/**
 * 一段 `dsh-resource://file/session/<sessionId>/<path>` 地址解析后的载荷。
 * `path` 保留前导斜杠语义:`/etc/hosts` 是绝对路径,`src/a.ts` 是工作区相对路径。
 */
export interface FileAddress {
  sessionId: string
  path: string
}

/**
 * 解析官方的会话文件地址;不是会话文件地址一律返回 undefined(于是放行)。
 *
 * 语法与 `@deepseek-ai/dsh-util-workspace-path` 的 `parseFileAddress` 对齐:
 * `dsh-resource://file/session/<sessionId>/<path>`,每段单独 decodeURIComponent,
 * 路径段允许含编码后的 `/`。这里自带一份极简实现而不是 require 官方包,是
 * 为了让浏览器半 bundle 保持「只依赖已有 externals」——多一个平台模块名会
 * 多一处版本耦合,而这段语法是产品契约、不是内部实现细节。
 */
function parseSessionFileAddress(address: string): FileAddress | undefined {
  const PREFIX = 'dsh-resource://file/session/'
  if (!address.startsWith(PREFIX)) return undefined
  // 去掉查询串与片段(官方地址可能带 ?line= 之类的定位参数)
  const rest = address.slice(PREFIX.length).split(/[?#]/, 1)[0]
  const slash = rest.indexOf('/')
  // 没有路径段(new URL 语义下 path 为空)时不算文件地址:交给官方处理
  if (slash <= 0) return undefined
  let sessionId: string
  let path: string
  try {
    sessionId = decodeURIComponent(rest.slice(0, slash))
    path = rest
      .slice(slash + 1)
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/')
  } catch {
    // 非法转义:按「不是文件地址」处理,走官方路径
    return undefined
  }
  if (sessionId === '' || path === '') return undefined
  return { sessionId, path }
}

/**
 * 把工作区相对路径拼到会话工作目录上;已是绝对路径(以 `/` 开头,含
 * `/etc/...`、`C:/...`、`//server/share` 这些官方形式)时原样返回。
 *
 * host 侧会按会话自己的工作区再解析一次(`dsh-api-workspace-files` 的
 * `stat` 语义),所以这里只做「相对 → 绝对」的拼接,不做规范化。
 */
function toAbsolutePath(cwd: string | undefined, path: string): string | undefined {
  if (path.startsWith('/')) return path
  if (cwd === undefined || cwd === '') return undefined
  const base = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd
  return `${base}/${path}`
}

// —— host 侧「用系统默认程序打开」 ——

/** 远端调用失败时官方返回的结果形状(结构判定,不 import 协议包)。 */
interface RemoteFailureLike {
  ok: false
  error: { code: string; message: string }
}

/** 远端调用成功时的结果形状。 */
interface RemoteSuccessLike<T> {
  ok: true
  value: T
}

/** 结构判定:是不是官方的失败结果分支。 */
function isRemoteFailure(value: unknown): value is RemoteFailureLike {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { ok?: unknown; error?: unknown }
  return candidate.ok === false && typeof candidate.error === 'object' && candidate.error !== null
}

/**
 * 直接走宿主 RPC(`post /api/<method>`)调用 session 命名空间的方法。
 *
 * 为什么不用 `ctx.remote.session`:实测在 0.1.5-rc.2 的 Web 组合里 `remote` /
 * `sidebarRightTabs` 这两个服务名**不可注入**(装配时三级降级只有
 * `sidebarRight+sessions` 一级成功),依赖它等于功能永远不生效。
 * 而 `session/openWorkspacePath` 在客户端本来就有本地 RPC 分发,信封格式与
 * 网关客户端一致(见 dsh-client-connection 的 createWebConnectionRpc):
 *
 *   POST /api/session/openWorkspacePath
 *   { type: 'client-request', rpcId, method, payload: { args: { request: { path } } } }
 *   → { type: 'server-response', rpcId, result: { ok: true, value } | { ok: false, error } }
 *
 * 这条通路复用页面已有的会话认证(同源 fetch),不引入新依赖,也不碰 cordis 服务表。
 */
async function callSessionRpc(method: string, args: Record<string, unknown>): Promise<unknown> {
  const rpcId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now())
  const response = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
  })
  if (!response.ok) throw new Error(`transport failure for /api/${method}: HTTP ${response.status}`)
  const envelope: unknown = await response.json()
  if (typeof envelope !== 'object' || envelope === null) throw new Error(`unexpected reply for /api/${method}`)
  return (envelope as { result?: unknown }).result
}

/** 浏览器所在平台与宿主桌面是否一致(平台不一致是 WSL 场景的诊断要点)。 */
function browserPlatform(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Windows/i.test(ua)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos'
  if (/Linux|X11/i.test(ua)) return 'linux'
  return 'unknown'
}

/**
 * 读 host 是否支持原生打开。
 *
 * 返回 false 的两种情形都按「不支持」处理并回退官方右栏:host 明确说不支持
 * (远程浏览器、无桌面),或这条 RPC 通道不可用(未认证、旧宿主)。
 */
async function canOpenNatively(): Promise<boolean> {
  try {
    const result = await callSessionRpc('session/canOpenWorkspacePath', {})
    if (isRemoteFailure(result)) {
      console.warn('[dsh-web-enhance] 原生打开探测:host 拒绝', result.error.code, result.error.message)
      return false
    }
    const value = (result as RemoteSuccessLike<unknown>).value
    if (value !== true) console.warn('[dsh-web-enhance] 原生打开探测:host 回答不支持')
    return value === true
  } catch (error) {
    console.warn('[dsh-web-enhance] 原生打开探测失败', error)
    return false
  }
}

/** 请求 host 用系统默认程序打开一个绝对路径。 */
async function requestNativeOpen(path: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  try {
    // 排查用:Console 打开 Verbose 级别即可看到这条链路
    console.debug('[dsh-web-enhance] 请求 host 原生打开:', path, '浏览器平台=', browserPlatform())
    const result = await callSessionRpc('session/openWorkspacePath', { request: { path } })
    if (isRemoteFailure(result)) {
      console.warn('[dsh-web-enhance] host 原生打开失败', result.error.code, result.error.message)
      return false
    }
    console.debug('[dsh-web-enhance] host 原生打开成功:', path)
    return true
  } catch (error) {
    console.warn('[dsh-web-enhance] 原生打开调用抛错', error)
    return false
  }
}

// —— 拦截 ——

/**
 * 资源类型注册表的最小面:只用 `claim(address)` 问「这个地址会被开成哪种
 * kind」。官方 `ctx.sidebarRightTabs` 结构上满足它(多出来的方法不管),
 * 所以调用点不用任何断言;单列一条是为了不 import 未被官方导出的
 * `SidebarRightTabRegistry` 类名。
 */
export interface SidebarRightTabsLike {
  claim: (address: string, kind?: string) => { kind: string }
}

/** 打开资源时我们关心的选项:显式 kind(其余放置选项原样透传)。 */
export interface OpenResourceOptionsLike {
  kind?: string
}

/**
 * 会话数据面:只用 `list.getSnapshot().byId[sessionId].cwd` 一个字段
 * (官方 `ctx.sessions` 的形状,取工作目录把相对路径拼成绝对路径)。
 */
export interface SessionsFace {
  list?: {
    getSnapshot?: () => { byId?: Record<string, { cwd?: string } | undefined> }
  }
}

/**
 * 文档预览类型的 kind 字面量。
 *
 * **实测值来自官方源码,不是推断**:`ui-sidebar-documentpreview` 里
 * `TEXTPREVIEW_KIND = "text"`,注册形如
 * `{ id: TEXTPREVIEW_ID, kind: TEXTPREVIEW_KIND, patterns: ["dsh-resource://file/**"],
 *    priority: "fallback", canOpen: (a) => parseFileAddress(a)?.scope === "session" }`。
 * 早期版本凭印象写成 `"document"`,导致判定永不成立 —— 表现为「拦截器装上了、
 * 点文件却始终进右栏」,极难察觉。
 */
const DOCUMENT_KIND = 'text'

/** 文件资源的协议键(`dsh-resource://file/…` 的 host 段)。 */
const FILE_PROTOCOL = 'dsh-resource://file/'

/**
 * 判定这次 openResource 是否「用户点了一个文件、要开文档预览」。
 *
 * 需要同时满足三条,任一条不满足都放行给官方(宁可少拦,不可误伤):
 * 1. 打开类型是文档预览——`options.kind` 显式给了就按它,没给就问注册表
 *    `claim()`(官方认领顺序:extension > builtin > fallback,与预览一致);
 * 2. 地址是会话文件地址(带 sessionId,能定位工作目录);
 * 3. 开关开着。
 */
function shouldOpenNatively(
  sidebarRightTabs: SidebarRightTabsLike | undefined,
  address: string,
  options: OpenResourceOptionsLike | undefined,
): FileAddress | undefined {
  if (!loadNativeOpenEnabled()) return undefined
  if (!address.startsWith(FILE_PROTOCOL)) return undefined
  const file = parseSessionFileAddress(address)
  if (file === undefined) return undefined
  const kind = options?.kind ?? sidebarRightTabs?.claim(address)?.kind
  // kind 未知(降级装配时拿不到资源类型注册表)时按「文档预览」处理并放行拦截:
  // 官方对 `dsh-resource://file/**` 只注册了文档预览一个类型,所以这个默认是
  // 安全的;已知 kind 则必须严格等于文档预览,避免误伤别的资源类型。
  if (kind !== undefined && kind !== DOCUMENT_KIND) return undefined
  return file
}

/** 包装后暴露给外部的副作用清理句柄。 */
export interface NativeOpenHandle {
  /** 还原被包装的 `openResource`(插件卸载时调用)。 */
  dispose: () => void
}

/**
 * 就地包装 `ctx.sidebarRight.openResource`:点文件走系统默认程序,其余原样放行。
 *
 * 为什么是「就地包装」而不是重新 provide 一个 `sidebarRight` 服务:官方
 * `ui-sidebar-right` 用 `ctx.reflect.provide("sidebarRight", controller)` 提供该
 * 服务,而 `ui-chat` 在 apply 阶段就把控制器引用抓在闭包里了 —— 再 provide
 * 一次要么冲突、要么只影响后加载的插件,拦不住已经抓住旧引用的消费方。
 * 就地替换实例上的方法是对同一个对象动刀,两边看到的是同一份。
 *
 * 返回 undefined 表示结构不符(没有 openResource、不是函数),此时不包装、
 * 只记一条告警:插件的其余功能继续工作,不因为官方改形而白屏。
 */
export function installNativeFileOpen(
  sidebarRight: ISidebarRight | undefined,
  sidebarRightTabs: SidebarRightTabsLike | undefined,
  sessions: SessionsFace | undefined,
  signal: AbortSignal,
): NativeOpenHandle | undefined {
  if (sidebarRight === undefined || typeof sidebarRight.openResource !== 'function') {
    console.warn('[dsh-web-enhance] ctx.sidebarRight 结构不符,原生打开文件功能已跳过')
    return undefined
  }
  const original = sidebarRight.openResource.bind(sidebarRight)
  const wrapper = (address: string, options?: OpenResourceOptionsLike): void => {
    const file = shouldOpenNatively(sidebarRightTabs, address, options)
    if (file === undefined) {
      original(address, options)
      return
    }
    // 同步返回、异步打开:官方调用点多在 onClick 里,不关心 openResource 的
    // 返回时机;失败时下面会回退到官方右栏,保证点击永远有结果。
    const cwd = sessions?.list?.getSnapshot?.().byId?.[file.sessionId]?.cwd
    const absolutePath = toAbsolutePath(cwd, file.path)
    console.debug('[dsh-web-enhance] 点文件被接管', { address, sessionId: file.sessionId, cwd, absolutePath })
    void (async () => {
      if (absolutePath !== undefined && (await canOpenNatively())) {
        if (await requestNativeOpen(absolutePath, signal)) return
      }
      // 回退:host 不支持原生打开、或路径无法拼成绝对路径 —— 交回官方右栏,
      // 用户至少还能在预览里看到文件,不会出现「点了没反应」。
      console.warn('[dsh-web-enhance] 已回退到官方右栏(原因见上方 warn)')
      if (!signal.aborted) original(address, options)
    })()
  }
  // 接口把 openResource 声明成只读方法,而本功能的全部手段就是就地覆盖实例
  // 上的这一个方法(理由见函数头注释),因此这里用 Reflect.set 写入 —— 这是
  // 有意为之的运行时改写,不是类型疏漏。
  Reflect.set(sidebarRight, 'openResource', wrapper)
  return {
    dispose: () => {
      // 只有「当前挂着的仍是本插件这层包装」时才还原,避免把别的插件后装的
      // 包装拆掉;还原的是绑定了 this 的原方法(见下)。
      if (sidebarRight.openResource === wrapper) Reflect.set(sidebarRight, 'openResource', original)
    },
  }
}

// —— 设置行 ——

/** 设置行文案(插件自带,与官方行同处「通用」分区)。 */
const COPY = {
  zh: {
    title: '文件用系统程序打开',
    description: '点击会话里的文件路径时,交给本机默认程序(VS Code、文本编辑器等)打开,不再自动弹出右侧栏。桌面不可用时自动回退到官方预览。',
  },
  en: {
    title: 'Open files in the system app',
    description: 'Open a file path from the conversation in your desktop default app (VS Code, text editor, …) instead of popping the right sidebar. Falls back to the official preview when no desktop is available.',
  },
} as const

/** 当前语言下的文案键。 */
type CopyKey = keyof typeof COPY.zh

/** 插件自有 locale 命名空间(未合并进官方 LocaleNamespaceMap,用非类型化形态注册)。 */
const NS = 'web-enhance-native-open'

/**
 * 当前生效的取词函数。
 *
 * 关键设计:**默认就是内置中文**,不等 locale 服务 —— 设置行在 `apply()` 里
 * 无条件注册,若文案要等官方 locale 服务就绪,一旦那个回调没跑,整行就会消失
 * (用户唯一能看见的入口不该被无关时序绑架)。locale 可用时再换成官方取词函数。
 */
let nativeOpenText: (key: CopyKey) => string = (key) => COPY.zh[key]

/** 文案变化订阅者(设置行组件订阅它,换词后重渲染,组件不重挂载)。 */
const textListeners = new Set<() => void>()

/**
 * 注册文案并返回取词函数;locale 服务缺失时退回内置中文(插件自有文案,
 * 不依赖官方 ui-chat / ui-sidebar 的命名空间)。
 *
 * 用官方 locale 的「未合并命名空间的非类型化形态」:`register(ns, locale, dict)`
 * 逐语言注册 + `bind(ns)` 取词。这样插件不必把自己的命名空间合并进官方的
 * `LocaleNamespaceMap`(那需要 import 官方类型声明,徒增版本耦合)。
 * 注册失败(命名空间被占、locale 标签非法等)一律退回内置中文。
 */
export function registerNativeOpenCopy(
  locale:
    | {
        register: (ns: string, locale: string, dict: Record<string, string>) => unknown
        bind: (ns: string) => (key: string) => string
      }
    | undefined,
): (key: CopyKey) => string {
  const fallback = (key: CopyKey): string => COPY.zh[key]
  if (locale === undefined || typeof locale.register !== 'function' || typeof locale.bind !== 'function') return fallback
  try {
    locale.register(NS, 'zh', { ...COPY.zh })
    locale.register(NS, 'en', { ...COPY.en })
    const t = locale.bind(NS)
    return (key) => t(key)
  } catch {
    return fallback
  }
}

/** 换掉当前取词函数并通知已挂载的设置行(语言切换、locale 晚到时调用)。 */
export function setNativeOpenText(next: (key: CopyKey) => string): void {
  nativeOpenText = next
  for (const listener of textListeners) listener()
}

/** 开关行组件的 props:目前没有来自组合的字段(文案与状态都自持)。 */
export type NativeOpenRowProps = Record<string, never>

/**
 * 「通用」分区里的开关行:文件用系统程序打开。
 *
 * 状态自持(localStorage),不走官方 settings 文档:这是纯浏览器侧偏好,
 * 与功能二的思维链开关同款做法,免去 host 半区的读写与重启。
 * 文案自持(内置中文 + 可选官方 locale),不要求组合注入 `t`。
 *
 * 样式沿用官方功能行的排版(标题 + 说明两行,右侧控件),类名由
 * index.tsx 注入的 CSS 提供,不复制官方模块类。
 */
export function NativeOpenRow() {
  const [enabled, setEnabled] = useState(loadNativeOpenEnabled)
  // 文案变化(语言切换 / locale 晚到)时重渲染,组件实例与开关状态都不受影响
  const [, setTextRevision] = useState(0)
  useEffect(() => {
    const rerender = () => setTextRevision((revision) => revision + 1)
    const unsubscribeText = (() => {
      textListeners.add(rerender)
      return () => {
        textListeners.delete(rerender)
      }
    })()
    const unsubscribeSwitch = subscribeNativeOpenEnabled(() => setEnabled(loadNativeOpenEnabled()))
    return () => {
      unsubscribeText()
      unsubscribeSwitch()
    }
  }, [])
  const title = nativeOpenText('title')
  return (
    <div className="dsh-webe-setting-row">
      <div className="dsh-webe-setting-text">
        <div className="dsh-webe-setting-title">{title}</div>
        <div className="dsh-webe-setting-desc">{nativeOpenText('description')}</div>
      </div>
      <Switch
        checked={enabled}
        label={title}
        onChange={(next) => {
          // 先写持久值再更新本地状态:拦截逻辑读的是同一个来源,保证下一次
          // 点击文件时立刻按新值行事。
          saveNativeOpenEnabled(next)
          setEnabled(next)
        }}
      />
    </div>
  )
}
