/**
 * dsh-web-enhance 构建脚本(esbuild,无其他工具链依赖)。
 *
 * 产出两个半区(与官方 client 插件包一致):
 * - lib/index.js      node 半:宿主 Loader 直接 import 的 ESM 入口。
 * - lib/client.js     浏览器半:window.__ModuleLoader__.load({id, factory})
 *                     格式的 CJS bundle,externals 通过 loader 注入的
 *                     require 从平台模块表解析。
 * - lib/types/*.d.ts  手写类型声明,供 exports.types 指向。
 *
 * 另有一个构建期生成模块 `src/client/version.generated.ts`:
 * - PLUGIN_VERSION 直接读 package.json 的 version,避免源码里手抄版本号抄漏;
 * - PLUGIN_BUILD 是本次构建时刻,用来区分「同一版本号、不同次构建」。
 * 排查时读控制台那行日志或 `document.documentElement.dataset.dshWebeVersion` 即可。
 * (早先用 esbuild 的 define 注入这两个裸标识符,**不生效**:ESM 模块里它们是局部
 * 绑定而非全局引用,占位符会原样留在产物里 —— 生成模块没有这个不确定性。)
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'

const PLUGIN_ID = '@yangzhe1991/dsh-web-enhance'

/** 从 package.json 读版本号(单一事实来源)。 */
const { version: PLUGIN_VERSION } = JSON.parse(await readFile('package.json', 'utf8'))
/** 本次构建时刻(ISO):同一版本号下的不同构建靠它区分。 */
const PLUGIN_BUILD = new Date().toISOString()

// —— 版本/构建戳生成模块(每次构建重写,故不进 git) ——
await writeFile('src/client/version.generated.ts', [
  '/**',
  ' * 本文件由 build.mjs 自动生成 —— 不要手改,改构建脚本。',
  ' *',
  ' * 为什么用生成模块而不是 esbuild define:define 只替换「全局标识符」,而',
  ' * `PLUGIN_BUILD` 在 ESM 模块里是局部绑定,写进 define 后占位符会原样留在产物',
  ' * 里(实测:日志真的打印出 `__DSH_WEB_ENHANCE_BUILD__`)。',
  ' */',
  `export const PLUGIN_VERSION = ${JSON.stringify(PLUGIN_VERSION)}`,
  `export const PLUGIN_BUILD = ${JSON.stringify(PLUGIN_BUILD)}`,
  '',
].join('\n'))

// 浏览器半的 externals:必须是平台模块表(PLATFORM_MODULES,见 dsh 仓库
// packages/client/web/src/platform.ts)成员,否则 require 会在运行时抛错。
// 只列实际会出现在产物里的 require:值导入(如 ui-primitives、react)
// 与可能被误用的基线成员;类型导入会被 esbuild 擦除,无需列入。
// 注意:@deepseek-ai/dsh-client-runtime 已随 dsh 0.1.2 停产,不再是模块表成员。
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

// —— node 半 ——
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  sourcemap: true,
})

// —— 浏览器半 ——
await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  external: CLIENT_EXTERNALS,
  sourcemap: true,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  // 与官方产物同构:闭包工厂由 __ModuleLoader__ 调用,require 为注入的模块表 require。
  banner: { js: [
    `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    'var module = { exports: {} }; var exports = module.exports;',
  ].join('\n') },
  footer: { js: 'return module.exports; } });' },
})

// —— 手写类型声明 ——
await mkdir('lib/types/client', { recursive: true })
await writeFile('lib/types/index.d.ts', [
  '/** dsh-web-enhance 插件,node 半:无宿主侧行为。 */',
  'export declare function apply(): void;',
  '',
].join('\n'))
await writeFile('lib/types/client/index.d.ts', [
  '/** dsh-web-enhance 插件,浏览器半。 */',
  "import type { Context as ClientContext } from '@deepseek-ai/cordis';",
  '/** 需要的 client 服务:sessions、slots(jobs 走 ctx.inject 延迟等待,不在此列)。 */',
  'export declare const inject: string[];',
  '/** Client 插件 body。 */',
  'export declare function apply(ctx: ClientContext): void;',
  '',
].join('\n'))

console.log(`[${PLUGIN_ID}] build done (v${PLUGIN_VERSION}, build ${PLUGIN_BUILD}): lib/index.js, lib/client.js, lib/types/*.d.ts`)
