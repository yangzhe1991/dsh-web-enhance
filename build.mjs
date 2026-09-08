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

const PLUGIN_ID = '@yangzhe1991/dsh-web-enhance'

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
  '/** 需要的 client 服务:sessions、slots。 */',
  'export declare const inject: string[];',
  '/** Client 插件 body。 */',
  'export declare function apply(ctx: ClientContext): void;',
  '',
].join('\n'))

console.log('[@yangzhe1991/dsh-web-enhance] build done: lib/index.js, lib/client.js, lib/types/*.d.ts')
