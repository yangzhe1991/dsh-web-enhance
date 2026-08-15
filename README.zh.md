# dsh-web-enhance

[English](README.md) | [中文](README.zh.md)

DSH(DeepSeek Harness)浏览器插件:给 Web UI 增加一些顺手的小功能。

## 功能

- ⬆️⬇️ **逐轮导航** —— 对话右下角悬浮按钮组,位于官方「滚到底部」圆钮正上方:
  - **上箭头** —— 回到当前正在看的这一轮的**开头**:该轮「最终结果」的第一句(思考、工具调用、过程中蹦出来的过渡句全部跳过)。视口已经停在该轮开头时,跳到**上一轮**的开头。
  - **下箭头** —— 跳到当前轮的**结尾**(该轮最后一行内容的底部)。视口已经停在该轮结尾时,跳到**下一轮**的结尾。
  - 会话里出现过含正文的轮之后按钮才会显示。

## 安装(30 秒)

```sh
dsh plugin --profile web add link:/path/to/dsh-web-enhance
```

重启 Web GUI(Ctrl+C 停掉 `dsh web` 进程再重新运行)并刷新浏览器标签即可(`dsh plugin` 会执行 `pnpm add` 并自动把 bundle 追加到 `dsh.profile.bundles`;用 `link:` 规格保留活符号链接,改完代码重新 build + 重启即生效)。

## 实现原理

插件通过标准 `useSession` 钩子订阅会话快照,读取轮模型(`chat.timeline.turnOrder` + `chat.locations.getTurn(turn)`,来自 `dsh-client-runtime`)。一轮的「最终结果」= 该轮内最后一个「含非空正文、且 blocks 以 text 结尾」的节点(过渡句 blocks 形如 `[思考, 文字, 工具…]` —— agent 还在干活;最终结果形如 `[思考, 文字]` 或 `[文字]`);整轮没有收尾总结时,回退到该轮最后一个含正文的节点。

滚动复用内置 UI 的同一套 DOM 原语:行定位用官方 `data-chat-anchor-key` 标记(`[data-chat-flow]` 列表内),滚动容器是 `[data-conversation-scroll]`,开头锚点越过思考折叠条(`DisclosureRow`,带 `aria-expanded`)落在正文起点。「已停在开头/结尾」按与锚点的滚动距离(< 60px)判定,而不是看视口边缘恰好是哪一行 —— 最终结果很长时宽阈值会把停在行中段误判成「已在开头」。

## 开发

```sh
npm install
npm run build        # 产出 lib/index.js(宿主半)+ lib/client.js(浏览器半)
npx tsc --noEmit     # 类型检查
```

## 卸载

```sh
dsh plugin --profile web remove dsh-web-enhance
```

## 许可证

MIT
