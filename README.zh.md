# dsh-web-enhance

[English](README.md) | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/@yangzhe1991/dsh-web-enhance)](https://www.npmjs.com/package/@yangzhe1991/dsh-web-enhance)
[![npm downloads](https://img.shields.io/npm/dm/@yangzhe1991/dsh-web-enhance)](https://www.npmjs.com/package/@yangzhe1991/dsh-web-enhance)
[![license](https://img.shields.io/github/license/yangzhe1991/dsh-web-enhance)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-1e90ff)](https://github.com/topics/dsh-plugin)

**dsh-web-enhance** 是 [DSH(DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) Web UI 的浏览器插件,给界面增加一些顺手的小功能。目前提供:

- **逐轮对话导航**:对话右下角悬浮按钮组,一键回到当前正在看的这一轮的开头(已停轮首则跳上一轮开头)、跳到当前轮的结尾(已停轮尾则跳下一轮结尾)—— 始终落在真正的回复正文上,思考、工具调用、过渡句都会被跳过。
- **思维链默认展开**:悬浮按钮组里的灯泡按钮(默认开启),自动展开对话里每一条「Think」思考折叠条,流式输出时直接看思维链全文,而不是一行摘要。
- **会话价格统计**:会话走 DeepSeek 官方 API 时,在底部输入/输出 token 统计行同一行的最左侧显示当前会话的估算价格(人民币),按官网「模型 & 价格」页的价格逐请求按真实时间分峰谷计价。

![dsh-web-enhance 实际效果:对话右下角的悬浮按钮组(⬆ ⬇ 💡,灯泡高亮表示思维链默认展开已开启),思维链已全部展开](https://raw.githubusercontent.com/yangzhe1991/dsh-web-enhance/main/screenshot.png)

## 功能

- 💡 **思维链默认展开** —— 悬浮按钮组里、导航按钮下方的第三个按钮(灯泡图标):

  ```
      ⬆   ← 回到当前轮的开头
      ⬇   ← 跳到当前轮的结尾
      💡  ← 思维链默认展开开关(开启时高亮)
  ```

  - **开启时**(默认),每条「Think」思考折叠条都会被自动点开 —— 包括 agent 还在流式输出时新挂载的行 —— 不用逐条点击就能看到完整思考内容。
  - 关闭后恢复官方默认的收起样式,只显示一行摘要。
  - 开关状态跨刷新持久化(localStorage)。手动收起某一条折叠条不会被强制展开回去。

- ⬆️⬇️ **逐轮导航** —— 对话右下角悬浮按钮组,位于官方「滚到底部」圆钮正上方:

  ```
      ⬆   ← 回到当前轮的开头
      ⬇   ← 跳到当前轮的结尾
  ```

  - **上箭头** —— 回到当前正在看的这一轮的**开头**:该轮「最终结果」的第一句(思考、工具调用、过程中蹦出来的过渡句全部跳过)。视口已经停在该轮开头时,跳到**上一轮**的开头。
  - **下箭头** —— 跳到当前轮的**结尾**(该轮最后一行内容的底部)。视口已经停在该轮结尾时,跳到**下一轮**的结尾。
  - 会话里出现过含正文的轮之后按钮才会显示。

- 💰 **会话价格统计** —— 与官方 stats 行(轮数 / token 输入输出那行)**同一行、排在最左侧**,如 `≈ ¥0.83 · 2 轮 12 步 | …`:

  - 只有会话的请求走 **DeepSeek 官方 API**(provider 路由 `deepseek-official`)时才显示;切换到其它 API 后自动消失。
  - 价格 = token × 官网单价(人民币,`deepseek-v4-flash` / `deepseek-v4-pro` 两档),逐请求按**真实时间**分峰谷计价(峰时 = 北京时间 9:00–12:00、14:00–18:00,价格为闲时的 2 倍),输入区分缓存命中(折扣价)与未命中。
  - **边发生边累计**:每观测到一条请求就立刻按它的真实时间计价并持久化(localStorage,按会话,last-wins 不重复计)—— 历史分页把旧请求挤出浏览器窗口也不影响。会话从创建起就用本插件的话,总价**全程精确**,与会话多长无关。
  - 只有**从未被加载过的历史**(装插件之前、别的设备)才没有逐请求数据,差额按当前模型闲时价估算,以 `≈` 前缀标示(悬停可看明细:模型、token 数、峰/闲请求次数);点「加载更早」补上这部分历史后即转为精确。
  - 价格表随官网调整时在插件代码里同步更新(`src/client/cost.ts`)。

## 安装(30 秒)

```sh
dsh plugin --profile web add @yangzhe1991/dsh-web-enhance
```

重启 Web GUI(Ctrl+C 停掉 `dsh web` 进程再重新运行)并刷新浏览器标签即可(`dsh plugin` 会执行 `pnpm add` 并自动把 bundle 追加到 `dsh.profile.bundles`)。

本地开发时改为从路径安装,`link:` 规格保留活符号链接,改完代码重新 build + 重启即生效:

```sh
dsh plugin --profile web add link:/path/to/@yangzhe1991/dsh-web-enhance
```

## 实现原理

插件通过标准 `useSession` 钩子订阅会话快照,读取轮模型(`chat.timeline.turnOrder` + `chat.locations.getTurn(turn)`,来自 `dsh-client-runtime`)。一轮的「最终结果」= 该轮内最后一个「含非空正文、且 blocks 以 text 结尾」的节点(过渡句 blocks 形如 `[思考, 文字, 工具…]` —— agent 还在干活;最终结果形如 `[思考, 文字]` 或 `[文字]`);整轮没有收尾总结时,回退到该轮最后一个含正文的节点。

滚动复用内置 UI 的同一套 DOM 原语:行定位用官方 `data-chat-anchor-key` 标记(`[data-chat-flow]` 列表内),滚动容器是 `[data-conversation-scroll]`,开头锚点越过思考折叠条(`DisclosureRow`,带 `aria-expanded`)落在正文起点。「已停在开头/结尾」按与锚点的滚动距离(< 60px)判定,而不是看视口边缘恰好是哪一行 —— 最终结果很长时宽阈值会把停在行中段误判成「已在开头」。

思维链默认展开作用于官方思考行(根节点 `data-variant="think"`,行内是 `[data-disclosure-row][aria-expanded="false"]` 的折叠条)。因为思维链全文只在展开态挂载,插件直接点击每条折叠行,翻转官方组件内部的 React 展开状态。`document.body` 上挂一个 `MutationObserver`,盯着「新增」的子树(流式输出、新轮次)随挂随点开;开关打开时先全量扫一遍已渲染的行。只扫新增子树、不监听属性变化,所以用户手动收起的行不会被强行展开。

会话价格统计注册到 `conversation.composer.dock`(官方 stats 行同一个 slot,与它排在同一行、作为行内第一个元素)。数据两个来源:`trajectory` 视图(逐请求携带 provider/model/usage/时间戳/startSeq,精确计价的基础)与 `tokenUsage` 投影(整个会话的全量 token)。每条观测到 usage 的请求按 startSeq 持久化累计(localStorage,last-wins,重试替换不重复计),投影超出累计器合计的差额(从未观测过的历史)按闲时价估算并标「≈」;最近一次请求不是 `deepseek-official` 时价格行不渲染。

## 开发

```sh
npm install
npm run build        # 产出 lib/index.js(宿主半)+ lib/client.js(浏览器半)
npx tsc --noEmit     # 类型检查
```

## 卸载

```sh
dsh plugin --profile web remove @yangzhe1991/dsh-web-enhance
```

## 许可证

MIT
