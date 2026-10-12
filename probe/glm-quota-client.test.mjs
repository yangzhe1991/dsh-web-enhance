/**
 * 功能六(GLM Coding Plan 套餐额度)浏览器半的离线探针。
 *
 * 两件事(与 notify-probe.mjs 同一套路):
 * 1) 纯展示函数验证:quota-format.ts(载荷校验/徽章/时长格式化)与
 *    cost.ts 的 GLM 门控(isGlmRoute/latestRouteInfo)用 esbuild 现场转译
 *    后加载,断言用真实值(2026-10-13 实测:Max 套餐,5h 13% / 周 2%);
 * 2) bundle 装配验证:mock 的 window.__ModuleLoader__ + 平台模块表执行
 *    lib/client.js 的 factory,断言模块级 inject 已声明 remote(quota 徽章
 *    的数据源)、apply() 装配不炸、dock slot 仍注册。
 *
 * 运行:node probe/glm-quota-client.test.mjs(需先 npm run build)。
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const { transform } = await import('esbuild')

/** 现场转译一份 TS 源并加载(esbuild 擦除 type-only import,零依赖模块可直接跑)。 */
async function loadSource(path) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' })
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}

const fmt = await loadSource('../src/client/quota-format.ts')
const cost = await loadSource('../src/client/cost.ts')

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${error.message}`)
    process.exitCode = 1
  }
}

// —— 宿主半会写入的真实载荷形状(值取自 2026-10-13 实测应答) ——
const REAL_PAYLOAD = {
  version: 1,
  fetchedAt: 1791851000000,
  level: 'max',
  windows: [
    { kind: 'short', windowMs: 18000000, startMs: 1791839100000, resetMs: 1791842912116, current: 3726, total: 28000, remaining: 24273, percentage: 13 },
    { kind: 'week', windowMs: 604800000, startMs: 1791819957998, resetMs: 1792429157998, current: 3726, total: 140000, remaining: 136273, percentage: 2 },
  ],
}
// describe 条目的真实形状(2026-10-13 原始 RPC 实测):value 按 settings
// schema 字段名投影,载荷在 glmQuota 字段下面 —— 不是载荷本身。
// (历史教训:第一版探针把 value 直接喂成载荷,函数也读错层级,两边
// 自洽地「假绿」,真实宿主上全 null。形状一律用实测的。)
const describeShape = (payload) => [{ ns: 'web-enhance', value: { glmQuota: payload } }]

check('extractPayload:真实形状完整解析', () => {
  const payload = fmt.extractPayload(describeShape(REAL_PAYLOAD))
  assert.equal(payload.level, 'max')
  assert.equal(payload.windows.length, 2)
  assert.equal(payload.windows[0].kind, 'short')
  assert.equal(payload.windows[0].percentage, 13)
})

check('extractPayload:ns 不对 / 形状坏了 → null(徽章隐藏,不渲染残缺数据)', () => {
  assert.equal(fmt.extractPayload([{ ns: 'other-entry', value: { glmQuota: REAL_PAYLOAD } }]), null)
  assert.equal(fmt.extractPayload([{ ns: 'web-enhance', value: { glmQuota: { version: 2 } } }]), null)
  assert.equal(fmt.extractPayload([{ ns: 'web-enhance', value: {} }]), null, 'value 里没有 glmQuota 字段 → null')
  assert.equal(fmt.extractPayload([{ ns: 'web-enhance', value: null }]), null)
  assert.equal(fmt.extractPayload(undefined), null)
})

check('namespacesOf:describe 实际返回是 {writable,hasDocument,namespaces} 包装(2026-10-13 实测形状)', () => {
  const realDescribeValue = {
    writable: true,
    hasDocument: true,
    namespaces: [{ ns: 'llm-pi-ai', value: {} }, { ns: 'web-enhance', value: { glmQuota: REAL_PAYLOAD } }],
  }
  const payload = fmt.extractPayload(fmt.namespacesOf(realDescribeValue))
  assert.equal(payload.level, 'max', '经包装解析后应取到 web-enhance 条目')
  assert.equal(fmt.extractPayload(fmt.namespacesOf({ writable: true })), null, '没有 namespaces 字段 → undefined → null')
  // 兼容直接数组形态(防宿主漂移)
  assert.equal(fmt.extractPayload(fmt.namespacesOf(describeShape(REAL_PAYLOAD))).level, 'max')
})

check('extractPayload:单条窗口缺字段只丢该条,不整包丢弃', () => {
  const broken = {
    ...REAL_PAYLOAD,
    windows: [
      { kind: 'short', windowMs: 18000000, startMs: 1, resetMs: 2, percentage: 13 },
      { kind: 'week', windowMs: 604800000 }, // 缺 startMs/resetMs/percentage → 丢
    ],
  }
  const payload = fmt.extractPayload(describeShape(broken))
  assert.equal(payload.windows.length, 1)
  assert.equal(payload.windows[0].kind, 'short')
})

check('formatQuotaBadge:徽章文案(窗口标签从时长推导,不硬编码 5h)', () => {
  assert.equal(fmt.formatQuotaBadge(REAL_PAYLOAD.windows), '5h 13% · 周 2%')
  // 官方哪天把短窗口调成 4h,标签自动跟随(而不是写死「5h」)。
  const fourHours = [{ ...REAL_PAYLOAD.windows[0], windowMs: 14400000 }]
  assert.equal(fmt.formatQuotaBadge(fourHours), '4h 13%')
})

check('formatDuration:中文时长(向下取整,负值按 0)', () => {
  assert.equal(fmt.formatDuration(42 * 60_000), '42分')
  assert.equal(fmt.formatDuration(3 * 3600_000 + 42 * 60_000), '3小时42分')
  assert.equal(fmt.formatDuration(3 * 3600_000), '3小时')
  assert.equal(fmt.formatDuration(2 * 86400_000 + 3 * 3600_000), '2天3小时')
  assert.equal(fmt.formatDuration(-5), '0分')
})

check('windowElapsedPercent:周窗口时间进度(钳 0-100,取整)', () => {
  const week = REAL_PAYLOAD.windows[1] // 7 天窗口
  // 已过 10%:start + 0.1*windowMs
  const at10 = week.startMs + 0.1 * week.windowMs
  assert.equal(fmt.windowElapsedPercent(week, at10), 10)
  // 窗口起点前(时钟偏差)→ 0;重置点后 → 100
  assert.equal(fmt.windowElapsedPercent(week, week.startMs - 999), 0)
  assert.equal(fmt.windowElapsedPercent(week, week.resetMs + 999), 100)
})

// —— cost.ts 的 GLM 门控 ——
check('isGlmRoute:已知路由命中;自定义路由靠 glm 模型名兜底', () => {
  assert.equal(cost.isGlmRoute('zai-coding-cn', 'glm-5.3-flash'), true)
  assert.equal(cost.isGlmRoute('zai', 'glm-5.3'), true)
  assert.equal(cost.isGlmRoute('zhipu', 'glm-4.7'), true)
  assert.equal(cost.isGlmRoute('my-gateway', 'GLM-5.4'), true, '模型名兜底不区分大小写')
  assert.equal(cost.isGlmRoute('deepseek-official', 'deepseek-flash'), false)
  assert.equal(cost.isGlmRoute(undefined, undefined), false)
})

check('latestRouteInfo:GLM 会话门控(独立于 deepseek 累计器,summarizeCost 此时为 null)', () => {
  const requests = [
    { startSeq: 1, startedAt: 100, requestConfig: { provider: 'zai-coding-cn', model: 'glm-5.3-flash' }, usage: { inputTokens: 10, outputTokens: 5 } },
    { startSeq: 2, startedAt: 200, providerMetadata: { provider: 'zai-coding-cn', model: 'glm-5.3-flash' } }, // 流式中:无 usage
  ]
  const info = cost.latestRouteInfo({ requests })
  assert.equal(info.provider, 'zai-coding-cn')
  assert.equal(info.model, 'glm-5.3-flash')
  assert.equal(info.inFlight, true, '最近请求无 usage = 流式进行中')
})

check('latestRouteInfo:已完成的请求不算 inFlight', () => {
  const requests = [
    { startSeq: 1, startedAt: 100, providerMetadata: { provider: 'zai-coding-cn', model: 'glm-5.3-flash' }, usage: { inputTokens: 10, outputTokens: 5 } },
  ]
  const info = cost.latestRouteInfo({ requests })
  assert.equal(info.inFlight, false)
})

check('latestRouteInfo:字段形态兼容(旧 provenance 也能读到路由)', () => {
  const requests = [
    { startSeq: 1, startedAt: 100, provenance: { provider: 'zai-coding-cn', model: 'glm-5.3' }, usage: { inputTokens: 1, outputTokens: 1 } },
  ]
  assert.equal(cost.latestRouteInfo({ requests }).provider, 'zai-coding-cn')
})

// —— bundle 装配验证 ——
const clientBundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
{
  const registrations = []
  const injections = []
  const documentMock = {
    documentElement: { dataset: {} },
    title: 'DSH',
    hidden: false,
    head: { appendChild: () => {} },
    createElement: () => ({ dataset: {}, textContent: '', appendChild: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    body: {},
  }
  globalThis.document = documentMock
  globalThis.localStorage = {
    store: new Map(),
    getItem(key) { return this.store.has(key) ? this.store.get(key) : null },
    setItem(key, value) { this.store.set(key, String(value)) },
  }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }

  let factory = null
  const windowMock = {
    __ModuleLoader__: {
      load: ({ id, factory: f }) => {
        assert.equal(id, '@yangzhe1991/dsh-web-enhance')
        factory = f
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const requireReal = (specifier) => {
    if (specifier === 'react') return { useEffect: () => {}, useMemo: () => {}, useRef: () => {}, useState: () => {}, useSyncExternalStore: () => {} }
    if (specifier === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
    if (specifier === 'react-dom') return { createPortal: (node) => node }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { Switch: () => null, Tooltip: ({ children }) => children }
    throw new Error(`probe: unexpected require("${specifier}")`)
  }

  new Function('window', 'document', 'localStorage', 'MutationObserver', 'AudioContext', clientBundle)(
    windowMock, documentMock, globalThis.localStorage, globalThis.MutationObserver, undefined,
  )
  assert.ok(factory !== null, 'bundle 应该调用 __ModuleLoader__.load')
  const exports = factory(requireReal)

  check('模块级 inject 已声明 remote(quota 徽章的数据源服务)', () => {
    assert.ok(exports.inject.includes('remote'), `inject = ${JSON.stringify(exports.inject)}`)
  })

  check('apply() 装配不炸,dock slot 仍注册(remote 缺失时降级而非抛错)', () => {
    const ctx = {
      slots: {
        inject: (name, cb) => { injections.push(name); cb() },
        register: (def) => { registrations.push({ ...def }); return () => {} },
      },
      inject: (deps, cb) => {
        injections.push(`ctx.inject:${deps.join('+')}`)
        if (deps.includes('locale') || deps.includes('remote')) return // 探针不模拟这些服务
        cb(ctx)
      },
      effect: (setup) => setup(), // notify 等功能用;探针立即执行、不清理
      sidebarRight: undefined,
      sidebarRightTabs: undefined,
      sessions: undefined,
    }
    exports.apply(ctx)
    assert.ok(injections.includes('conversation.composer.dock'), '价格/额度行必须注册')
    assert.ok(registrations.some((r) => r.id === 'web-enhance-session-cost'), 'dock 条目 id 保持不变')
  })
}

console.log(`\n[probe] glm-quota 客户端探针:${passed} 项全部通过`)
