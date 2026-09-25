/**
 * dsh-web-enhance 0.2.0 的离线探针(不属于 npm 包,纯本地验证用)。
 *
 * 两件事:
 * 1) 状态机单元验证:`src/client/notify-monitor.ts` 用假时钟回放忙闲序列,
 *    断言提醒时机/类型/失败音/开关——这些是「不响」「乱响」类问题的根因所在;
 * 2) bundle 装配验证:用 mock 的 window.__ModuleLoader__ + 平台模块表执行
 *    `lib/client.js` 的 factory,断言 apply() 注册了哪些 slot、jobs 服务缺失时
 *    是否只降级不抛(不能连累其它功能)。
 *
 * 注:逐轮导航(上下箭头)已随 dsh 0.1.7 内置回合导航轨一起删除,当时的 DOM
 * 结构回放探针(probe/jump-probe.mjs)一并移除;删除时的根因与修复思路记录在
 * README 的开发者注意事项里。
 *
 * 运行:`node probe/notify-probe.mjs`(在 dsh-web-enhance 目录下;需要先 npm run build)
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

// —— 加载 TS 源(状态机是纯 TS,用 esbuild 现场转译,保证与产物同源) ——
const { transform } = await import('esbuild')
const monitorSource = readFileSync(new URL('../src/client/notify-monitor.ts', import.meta.url), 'utf8')
const { code: monitorJs } = await transform(monitorSource, { loader: 'ts', format: 'esm', target: 'es2022' })
const monitorModule = await import(`data:text/javascript;base64,${Buffer.from(monitorJs).toString('base64')}`)
const { createMonitor } = monitorModule

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

/** 假时钟:手动推进,避免真等 2 秒。 */
function createClock() {
  let now = 0
  let nextId = 1
  const timers = new Map()
  return {
    setTimer: (fn, ms) => {
      const id = nextId++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: (id) => {
      timers.delete(id)
    },
    advance: (ms) => {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id)
          timer.fn()
        }
      }
    },
    pending: () => timers.size,
  }
}

/** 造一个会话事实(running / jobs / pendingChoiceKey)。 */
const session = (running, jobs = [], pendingChoiceKey = undefined) => ({
  running,
  jobs: jobs.map(([id, status]) => ({ id, status })),
  pendingChoiceKey,
})

console.log('状态机(notify-monitor.ts):')

check('首帧就闲的历史会话不补报', () => {
  const clock = createClock()
  const events = []
  const monitor = createMonitor({ quietMs: 2000, notify: (k, f) => events.push([k, f]), ...clock })
  monitor.update(new Map([['s1', session(false)]]))
  clock.advance(5000)
  assert.deepEqual(events, [])
})

check('忙 → 空闲 2 秒后提醒 done(不 failed)', () => {
  const clock = createClock()
  const events = []
  const monitor = createMonitor({ quietMs: 2000, notify: (k, f) => events.push([k, f]), ...clock })
  monitor.update(new Map([['s1', session(true)]]))
  monitor.update(new Map([['s1', session(false)]]))
  clock.advance(1999)
  assert.deepEqual(events, [], '安静窗口未满不该响')
  clock.advance(1)
  assert.deepEqual(events, [['done', false]])
})

check('安静窗口内又转忙 → 撤销提醒(唤醒的新回合抢先)', () => {
  const clock = createClock()
  const events = []
  const monitor = createMonitor({ quietMs: 2000, notify: (k, f) => events.push([k, f]), ...clock })
  monitor.update(new Map([['s1', session(true)]]))
  monitor.update(new Map([['s1', session(false)]]))
  clock.advance(1000)
  monitor.update(new Map([['s1', session(true)]])) // agent 被任务唤醒继续干
  clock.advance(10000)
  assert.deepEqual(events, [])
})

check('agent 让出回合但后台任务在跑 → 不算闲,不提醒', () => {
  const clock = createClock()
  const events = []
  const monitor = createMonitor({ quietMs: 2000, notify: (k, f) => events.push([k, f]), ...clock })
  monitor.update(new Map([['s1', session(true, [['j1', 'running']])]]))
  monitor.update(new Map([['s1', session(false, [['j1', 'running']])]])) // running=false,任务还在跑
  clock.advance(10000)
  assert.deepEqual(events, [], '这正是旧版误报的场景')
  monitor.update(new Map([['s1', session(false, [['j1', 'completed']])]]))
  clock.advance(2000)
  assert.deepEqual(events, [['done', false]])
})

check('忙周期内有任务 failed → 该次提醒带 failed 标记(下行音)', () => {
  const clock = createClock()
  const events = []
  const monitor = createMonitor({ quietMs: 2000, notify: (k, f) => events.push([k, f]), ...clock })
  monitor.update(new Map([['s1', session(true, [['j1', 'running']])]]))
  monitor.update(new Map([['s1', session(false, [['j1', 'failed']])]]))
  clock.advance(2000)
  assert.deepEqual(events, [['done', true]])
})

check('首帧就存在的历史 failed 任务不算本次失败', () => {
  const clock = createClock()
  const events = []
  const monitor = createMonitor({ quietMs: 2000, notify: (k, f) => events.push([k, f]), ...clock })
  monitor.update(new Map([['s1', session(true, [['j1', 'failed']])]]))
  monitor.update(new Map([['s1', session(false, [['j1', 'failed']])]]))
  clock.advance(2000)
  assert.deepEqual(events, [['done', false]])
})

check('新的「等待用户选择」立即提醒 choice,同 key 不重复', () => {
  const clock = createClock()
  const events = []
  const monitor = createMonitor({ quietMs: 2000, notify: (k, f) => events.push([k, f]), ...clock })
  monitor.update(new Map([['s1', session(true)]]))
  monitor.update(new Map([['s1', session(true, [], 'ask-1')]]))
  assert.deepEqual(events, [['choice', false]], '弹框出现即响,不等安静窗口')
  clock.advance(500)
  monitor.update(new Map([['s1', session(true, [], 'ask-1')]]))
  assert.equal(events.length, 1, '同一个弹框持续存在不重复响')
  monitor.update(new Map([['s1', session(true, [], 'ask-2')]]))
  assert.equal(events.length, 2, '答完再弹新框要再响')
  // 弹框期间算「忙」:答完后 agent 继续跑再收尾,只该响一次 done
  monitor.update(new Map([['s1', session(false)]]))
  clock.advance(2000)
  assert.deepEqual(events[2], ['done', false])
})

check('开关关闭:完全不提醒,但忙闲基线保留', () => {
  const clock = createClock()
  const events = []
  let enabled = false
  const monitor = createMonitor({ quietMs: 2000, notify: (k, f) => events.push([k, f]), isEnabled: () => enabled, ...clock })
  monitor.update(new Map([['s1', session(true)]]))
  monitor.update(new Map([['s1', session(false)]]))
  clock.advance(5000)
  assert.deepEqual(events, [], '关闭期间不响')
  enabled = true
  monitor.update(new Map([['s1', session(true)]]))
  monitor.update(new Map([['s1', session(false)]]))
  clock.advance(2000)
  assert.deepEqual(events, [['done', false]], '重新打开后照常工作')
})

check('安静窗口期内被关掉 → 不响(定时器到点复查开关)', () => {
  const clock = createClock()
  const events = []
  let enabled = true
  const monitor = createMonitor({ quietMs: 2000, notify: (k, f) => events.push([k, f]), isEnabled: () => enabled, ...clock })
  monitor.update(new Map([['s1', session(true)]]))
  monitor.update(new Map([['s1', session(false)]]))
  enabled = false
  monitor.update(new Map([['s1', session(false)]])) // 下一帧读到开关已关
  clock.advance(5000)
  assert.deepEqual(events, [])
})

check('会话从快照消失 → 状态与在途定时器一起丢弃,不产生幽灵提醒', () => {
  const clock = createClock()
  const events = []
  const monitor = createMonitor({ quietMs: 2000, notify: (k, f) => events.push([k, f]), ...clock })
  monitor.update(new Map([['s1', session(true)]]))
  monitor.update(new Map([['s1', session(false)]]))
  monitor.update(new Map()) // 会话关闭
  clock.advance(5000)
  assert.deepEqual(events, [])
  assert.equal(clock.pending(), 0, '在途定时器已清')
})

check('activeSessions / phases 给订阅集合用:quiet 仍算活跃', () => {
  const clock = createClock()
  const monitor = createMonitor({ quietMs: 2000, notify: () => {}, ...clock })
  monitor.update(new Map([['s1', session(true)], ['s2', session(false)]]))
  assert.deepEqual([...monitor.activeSessions()].sort(), ['s1'])
  monitor.update(new Map([['s1', session(false)], ['s2', session(false)]]))
  assert.deepEqual([...monitor.activeSessions()].sort(), ['s1'], '等安静窗口期间仍要盯着任务列表')
  clock.advance(2000)
  assert.deepEqual([...monitor.activeSessions()], [])
  assert.deepEqual([...monitor.phases()], [['s1', 'idle'], ['s2', 'idle']])
})

// —— bundle 装配验证 ——
console.log('\nbundle 装配(lib/client.js):')

const clientBundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/**
 * 造一个 mock 浏览器环境并执行 bundle。
 * @param options.withJobsService - 是否让 ctx.inject(['jobs']) 回调(模拟任务控制器缺失)
 */
function loadBundle({ withJobsService = true } = {}) {
  const registrations = []
  const injections = []
  let sidebarRightCalls = 0

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

  // 平台模块表(与 package.json 的 dsh.client.inject 对应):bundle 只允许 require 这些。
  const requireReal = (specifier) => {
    if (specifier === 'react') {
      return { useEffect: () => {}, useMemo: () => {}, useRef: () => {}, useState: () => {}, useSyncExternalStore: () => {} }
    }
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
  assert.ok(typeof exports.apply === 'function', 'bundle 应该导出 apply')

  const slots = {
    inject: (name, cb) => {
      injections.push(name)
      cb()
    },
    register: (def) => {
      registrations.push({ ...def })
      return () => {}
    },
  }
  const ctx = {
    slots,
    inject: (deps, cb) => {
      injections.push(`ctx.inject:${deps.join('+')}`)
      if (deps.includes('jobs') && !withJobsService) return
      if (deps.includes('locale')) return // 探针不模拟 locale 服务
      cb({
        // 功能四的拦截装配需要这两个服务(走 tier 0)
        sidebarRight: { openResource: () => { sidebarRightCalls += 1 } },
        sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
        jobs: { state: { subscribe: () => () => {}, getSnapshot: () => ({ rows: {} }) }, watchRows: () => () => {} },
        slots,
        effect: () => {},
      })
    },
    effect: () => {},
    on: () => {},
  }
  exports.apply(ctx)
  return { registrations, injections, exports, sidebarRightCalls }
}

check('apply() 注册四个入口 + 两个 root 级条目(提醒监视器 / 思维链按钮)', () => {
  const { registrations, injections } = loadBundle()
  const names = registrations.map((r) => `${r.name}#${r.id}`).sort()
  console.log('    注册:', names.join(', '))
  assert.deepEqual(names, [
    'conversation.composer.dock#web-enhance-session-cost',
    'settings.general.item#web-enhance-native-open',
    'settings.general.item#web-enhance-notify',
    'shell.overlay#web-enhance-notify',
    'shell.overlay#web-enhance-think-toggle',
  ])
  assert.ok(injections.includes('ctx.inject:jobs'), 'jobs 走延迟注入')
})

check('jobs 服务缺失时:其余功能照常注册,只是没有 shell.overlay 监视器', () => {
  const { registrations } = loadBundle({ withJobsService: false })
  const names = registrations.map((r) => `${r.name}#${r.id}`).sort()
  assert.deepEqual(names, [
    'conversation.composer.dock#web-enhance-session-cost',
    'settings.general.item#web-enhance-native-open',
    'settings.general.item#web-enhance-notify',
    'shell.overlay#web-enhance-think-toggle',
  ])
})

check('装配打点写到 dataset(排查出口存在且版本戳统一)', () => {
  loadBundle()
  assert.match(globalThis.document.documentElement.dataset.dshWebeVersion, /^0\.2\.0 \(build /)
  assert.match(globalThis.document.documentElement.dataset.dshWebeNotifyVersion, /^0\.2\.0 \(build /)
  const notifyDiag = JSON.parse(globalThis.document.documentElement.dataset.dshWebeNotify)
  assert.equal(notifyDiag.tier, 0, 'jobs 到位 → tier 0')
  assert.equal(notifyDiag.enabled, true, '默认开启')
})

console.log(`\n通过 ${passed} 项检查${process.exitCode ? '(有失败)' : ''}`)
// 装配里留了自我修复用的 setTimeout(探针不关心),直接退出避免挂住事件循环。
process.exit(process.exitCode ?? 0)
