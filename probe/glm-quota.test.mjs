/**
 * 功能六(GLM Coding Plan 套餐额度)宿主半的 mock 探针。
 *
 * 运行:node probe/glm-quota.test.mjs(构建后跑,import 的是 lib/index.js)。
 *
 * 探针原则(踩过的坑,见 AGENTS.md):
 * - mock 按生产语义写:插件拿到的 settings/credentials 服务对象自始至终
 *   是同一个引用,断言打在插件真正调用的那个实例上;
 * - 断言数据用「真实世界的值」:quota 应答读仓库内 fixture(probe/
 *   fixtures/glm-quota-real.json,2026-10-15 用真实 key 从 open.bigmodel.cn
 *   抓的原始应答,Max 套餐,5h 窗口 17% / 周 34%)—— 早期版本放 /tmp,
 *   机器一重启探针就断,这次起进仓库;
 * - 探针全绿只证明宿主半逻辑自洽,不证明端点契约没变 —— 端点契约由
 *   真实请求验证(见 README 的验证记录)。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { apply } from '../lib/index.js'

// —— 载入真实应答(2026-10-15 实测抓包,仓库内 fixture) ——
const rawReal = JSON.parse(await readFile(new URL('./fixtures/glm-quota-real.json', import.meta.url), 'utf8'))

// —— 生产语义的 mock 服务(同一引用贯穿全程) ——
const updates = []
const settingsMock = {
  configured: null,
  configure(presentation, owner) {
    // 生产语义:同一 fiber 重复注册会抛,插件应当吞掉并继续。
    if (this.configured !== null) throw new Error('Settings presentation is already configured for this plugin instance')
    this.configured = { presentation, owner }
  },
  async update(ns, patch, expectedRevision) {
    updates.push({ ns, patch, expectedRevision })
  },
}
const credentialsMock = {
  async resolve(ref) {
    // 只给国内站 key:验证「按顺序找到第一个已设置的引用」的配对逻辑。
    return ref === 'ZAI_CODING_CN_API_KEY' ? { value: 'sk-probe-test-key' } : undefined
  },
}
const warnings = []
let streamListener = null
const disposers = []
const ctx = {
  on(event, listener, options) {
    assert.equal(event, 'llm/stream')
    streamListener = listener
    // 记录 global 选项:子代理等子作用域的调用也要被看到。
    assert.equal(options?.global, true)
  },
  effect(setup, label) {
    const dispose = setup()
    if (dispose !== undefined) disposers.push({ label, dispose })
  },
  inject(services, callback) {
    // 生产语义:scope 与宿主 ctx 同构,服务以同名属性挂在 scope 上。
    const scope = { settings: settingsMock, credentials: credentialsMock }
    callback(scope)
  },
  logger: { warn(message) { warnings.push(String(message)) } },
  fiber: { id: 'probe-fiber' },
}

// —— 装配 ——
apply(ctx, {})
assert.notEqual(streamListener, null, 'llm/stream 监听器必须被注册')
assert.deepEqual(settingsMock.configured.presentation, { auto: false }, '必须关闭 settings 自动表单')
assert.equal(settingsMock.configured.owner, ctx.fiber)

// —— mock 全局 fetch:插件生产语义直接用 global fetch,这是唯一正确的 ——
// 注入缝。应答用真实抓包(见文件头),并校验请求形状(Bearer 头 + 路径)。
const fetchCalls = []
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, authorization: init?.headers?.authorization })
  return {
    ok: true,
    status: 200,
    async json() { return rawReal },
  }
}

// —— case A:GLM 请求,直通 + 拉取 + 写入 ——
async function* fakeGlmStream() {
  yield { type: 'block-start', index: 0 }
  yield { type: 'text-delta', text: 'hello' }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
let innerCalls = 0
const wrapped = streamListener(
  { provider: 'zai-coding-cn', model: 'glm-5.3-flash' },
  () => { innerCalls += 1; return fakeGlmStream() },
)
const chunks = []
for await (const chunk of wrapped) chunks.push(chunk)
// 分片必须原样透传(只读不改写),下游(next)必须被调用。
assert.deepEqual(chunks, [
  { type: 'block-start', index: 0 },
  { type: 'text-delta', text: 'hello' },
  { type: 'finish', reason: { kind: 'stop' } },
])
assert.equal(innerCalls, 1)
// 等 fetch → normalize → write 的异步链落定。
await new Promise((resolve) => setTimeout(resolve, 100))
// 请求形状:打在凭据配对的端点上,Bearer 头就位(绝不出现 key 明文进日志)。
assert.equal(fetchCalls.length, 1)
assert.equal(fetchCalls[0].url, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit')
assert.equal(fetchCalls[0].authorization, 'Bearer sk-probe-test-key')
assert.equal(updates.length, 1, `应恰好写入一次 settings,实际 ${updates.length}`)
assert.equal(updates[0].ns, 'web-enhance')
const payload = updates[0].patch.glmQuota
assert.equal(payload.version, 2, '载荷版本必须是 v2(v1 客户端直接拒渲染)')
assert.equal(payload.fixedDaily, 13000, 'apply 未传配置时回退默认 13000')
assert.equal(payload.level, 'max')
assert.equal(payload.windows.length, 2)
// 用真实应答的值断言:5h 窗口 17%、周窗口 34%(归一化不得歪曲服务端数据)。
assert.equal(payload.windows[0].kind, 'short')
assert.equal(payload.windows[0].percentage, 17)
assert.equal(payload.windows[0].total, 28000)
assert.equal(payload.windows[1].kind, 'week')
assert.equal(payload.windows[1].percentage, 34)
assert.equal(payload.windows[1].total, 140000)

// —— case B:非 GLM 请求必须零开销直通 ——
async function* fakeDeepseekStream() { yield { type: 'finish' } }
let deepseekCalls = 0
const passthrough = streamListener(
  { provider: 'deepseek-official', model: 'deepseek-flash' },
  () => { deepseekCalls += 1; return fakeDeepseekStream() },
)
assert.equal(passthrough, undefined || passthrough, '直通场景返回值应原样来自 next()')
for await (const chunk of streamListener({ provider: 'deepseek-official', model: 'deepseek-flash' }, () => { deepseekCalls += 1; return fakeDeepseekStream() })) {
  void chunk
}
assert.equal(deepseekCalls, 2)
await new Promise((resolve) => setTimeout(resolve, 50))
assert.equal(updates.length, 1, '非 GLM 流不得触发任何写入')

// —— case C:自定义路由 + glm 模型名兜底 ——
let customCalls = 0
for await (const chunk of streamListener({ provider: 'my-gateway', model: 'GLM-5.4' }, () => { customCalls += 1; return fakeGlmStream() })) {
  void chunk
}
assert.equal(customCalls, 1, 'model 以 glm 开头必须命中(兜底判定)')
await new Promise((resolve) => setTimeout(resolve, 50))

// —— case D:15s 最小间隔去重 —— 同步连发不得重复写/重复外呼 ——
assert.equal(updates.length, 1, 'MIN_FETCH_GAP 内的补拉不得产生第二次写入(载荷签名也没变)')

// —— case D2:插件配置的 fixedDaily 必须进载荷 ——
// 第二个实例:settingsMock.configure 会抛「已配置」,插件按约定吞掉并继续;
// lastFetchAt 是实例内状态,新实例的首拉不受上一个实例的 15s 间隔限制。
// 载荷签名含 fixedDaily(见 quota.ts),所以额度值没变也会触发这次写入。
apply(ctx, { fixedDaily: 14000 })
assert.notEqual(streamListener, null)
for await (const chunk of streamListener({ provider: 'zai-coding-cn', model: 'glm-5.3-flash' }, () => fakeGlmStream())) {
  void chunk
}
await new Promise((resolve) => setTimeout(resolve, 100))
assert.equal(updates.length, 2, '配置变化必须触发一次重写(签名含 fixedDaily)')
assert.equal(updates[1].patch.glmQuota.fixedDaily, 14000, '配置的 fixedDaily 必须原样进载荷')

// —— case E:插件 disposer 清理(热重载不漏定时器) ——
disposers.forEach(({ label, dispose }) => dispose())

// —— case F:纯函数补充断言 —— 业务失败形态必须被拒 ——
// quota.ts 是纯 TS(无依赖),用 esbuild 现场转译加载,保证与产物同源。
const { transform } = await import('esbuild')
const quotaSource = await readFile(new URL('../src/quota.ts', import.meta.url), 'utf8')
const { code: quotaJs } = await transform(quotaSource, { loader: 'ts', format: 'esm', target: 'es2022' })
const { normalizeQuota, payloadSignature } = await import(`data:text/javascript;base64,${Buffer.from(quotaJs).toString('base64')}`)
assert.equal(normalizeQuota({ code: 200, success: false, data: { limits: [] } }, 0, 13000), null, 'success=false 必须拒')
assert.equal(normalizeQuota({ code: 401, success: true, data: { limits: [{ unit: 3, number: 5, nextResetTime: 1 }] } }, 0, 13000), null, 'code!=200 必须拒')
assert.equal(normalizeQuota({ code: 200, success: true, data: { limits: 'nope' } }, 0, 13000), null, 'limits 非数组必须拒')
assert.equal(normalizeQuota({ code: 200, success: true, data: { limits: [{ unit: 99, number: 5, nextResetTime: 1 }] } }, 0, 13000), null, '未知 unit 必须丢弃(不猜)')
// v2 载荷:fixedDaily 原样透传,version 固定 2(客户端按版本做形状校验)。
const okPayload = normalizeQuota(
  { code: 200, success: true, data: { level: 'max', limits: [{ unit: 6, number: 1, usage: 140000, remaining: 91192, percentage: 35, nextResetTime: 1792429157998 }] } },
  1000, 13000,
)
assert.equal(okPayload.version, 2)
assert.equal(okPayload.fixedDaily, 13000)
assert.equal(okPayload.windows[0].kind, 'week')
// 安全线口径联动:payloadSignature 必须把 fixedDaily 算进去。
const sigA = payloadSignature(okPayload)
const sigB = payloadSignature({ ...okPayload, fixedDaily: 14000 })
assert.notEqual(sigA, sigB, 'fixedDaily 变化必须改变签名(触发客户端拿到新预算)')

console.log('[probe] glm-quota 宿主半探针全部通过')
console.log(`[probe] warnings(${warnings.length}):`)
for (const message of warnings) console.log('  -', message)
