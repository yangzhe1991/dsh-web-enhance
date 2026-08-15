/**
 * dsh-web-enhance 构建脚本(esbuild,无其他工具链依赖)。
 *
 * 产出两个半区(与官方 client 插件包一致):
 * - lib/index.js      node 半:宿主 Loader 直接 import 的 ESM 入口。
 * - lib/client.js     浏览器半:window.__ModuleLoader__.load({id, factory})
 *                     格式的 CJS bundle,externals 通过 loader 注入的
 *                     require 从平台模块表解析。
 * - lib/types/*.d.ts  手写类型声明,供 exports.types 指向。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'

const PLUGIN_ID = 'dsh-web-enhance'

// 浏览器半的 externals:必须是平台模块表(CLIENT_EXTERNALS)中的成员,
// 否则 require 会在运行时抛错。详见 dsh 仓库 packages/client/tsdown.client.ts。
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  // 文档化豁免:snapshot-store 引擎在 runtime/client 里,属模块表成员。
  '@deepseek-ai/dsh-client-runtime/client',
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
  "import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';",
  '/** 需要的 client 服务:sessions、slots。 */',
  'export declare const inject: string[];',
  '/** Client 插件 body。 */',
  'export declare function apply(ctx: ClientContext): void;',
  '',
].join('\n'))

console.log('[dsh-web-enhance] build done: lib/index.js, lib/client.js, lib/types/*.d.ts')
