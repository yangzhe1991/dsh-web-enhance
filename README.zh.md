# dsh-web-enhance

[English](README.md) | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/@yangzhe1991/dsh-web-enhance)](https://www.npmjs.com/package/@yangzhe1991/dsh-web-enhance)
[![npm downloads](https://img.shields.io/npm/dm/@yangzhe1991/dsh-web-enhance)](https://www.npmjs.com/package/@yangzhe1991/dsh-web-enhance)
[![license](https://img.shields.io/github/license/yangzhe1991/dsh-web-enhance)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-1e90ff)](https://github.com/topics/dsh-plugin)

**dsh-web-enhance** 是 [DSH(DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) Web UI 的浏览器插件,给界面增加一些顺手的小功能。目前提供:

- **思维链默认展开**:对话右下角悬浮的灯泡按钮(默认开启),自动展开对话里每一条「Think」思考折叠条,流式输出时直接看思维链全文,而不是一行摘要。
- **会话价格统计**:会话走 DeepSeek 官方 API 时,在底部输入/输出 token 统计行同一行的最左侧显示当前会话的估算价格(人民币),按官网「模型 & 价格」页的价格逐请求按真实时间分峰谷计价。
- **文件用系统程序打开**:点对话里出现的文件路径,交给本机默认程序(VS Code、文本编辑器等)打开,不再自动弹出右侧栏。可在设置 → 通用里关掉。
- **跑完提醒**:会话真正干完活时响一声提示音(有弹框等你选择时也会响),页面不在前台时同时把标签页标题改成提醒。默认开启,可在设置 → 通用里关掉。*(从已停维护的 [dsh-task-notify](https://github.com/yangzhe1991/dsh-task-notify) 插件并入。)*

![dsh-web-enhance 实际效果:对话右下角的悬浮灯泡按钮(高亮 = 思维链默认展开已开启)、思维链已全部展开,以及 stats 行上的会话价格统计](https://raw.githubusercontent.com/yangzhe1991/dsh-web-enhance/main/screenshot.png)

> **从 dsh-task-notify 迁移过来?** 那个插件已停维护 —— 它的「跑完提醒」现在是本插件的内置功能(判定口径不变,另外多了「设置 → 通用」里的开关)。切换命令:
>
> ```sh
> dsh plugin --profile web remove @yangzhe1991/dsh-task-notify
> dsh plugin --profile web add @yangzhe1991/dsh-web-enhance
> ```
>
> 然后重启 Web GUI、刷新标签页即可。本插件其它功能一起到手。

## 兼容性

- **dsh ≥ 0.1.7-rc.2** —— 自 **0.2.0**(并入「跑完提醒」的版本)起需要。提醒器读的是当前三套 Client 契约:会话列表快照(`useSessions` 的 `ids` / `byId.origin`)、每会话 UI 状态(`useSessionStatus` 的 agent `running` + `pendingInteraction`)、以及 `jobs` 客户端服务按会话订阅的任务列表(`watchRows` → `state.rows`)。在 **dsh ≤ 0.1.6** 上「跑完提醒」自动缺席(插件其余功能不受影响)—— 那些版本把任务列表放在会话列表快照里、把弹框放在 `useSessionPendingInteraction`,两者都在 0.1.7 被移除。
- **dsh ≥ 0.1.2-alpha.4** —— 其余功能自 **0.1.5** 起支持。重构后的前端以会话标准的 `useChat` hook 提供聊天快照、以 `useTrajectory` 提供轨迹,两条均已适配;旧版 dsh 保留 legacy 路径。自 **0.1.9** 起在 **dsh 0.1.3-alpha.2** 上验证通过;自 **0.1.10** 起在 **dsh 0.1.5-rc.2** 上验证通过(该版本新增「文件用系统程序打开」,已在本机实测);自 **0.1.11** 起在 **dsh 0.1.7-rc.2** 上验证通过 —— dsh 0.1.7 把 trajectory 快照里逐请求的 `provenance` 字段换成了 `requestConfig`/`providerMetadata`,曾让价格行无声消失;**0.1.11** 三种字段形态都读,自 0.1.2-alpha.4 起的宿主都能正常计价。**0.2.0**(跑完提醒)在 **dsh 0.1.7-rc.2** 上验证通过。
  - **0.2.0** 的额外说明:dsh 0.1.7 还改了 `dsh-client-ui-primitives` 的图标导出名(`IconChevronUpOutline14` → `IconChevronUpOutlineMedium`)。**0.2.0** 用的是新名字;旧版本在 0.1.7+ 上会渲染成空白页。
- **dsh 0.1.0-rc.x** —— 仍通过旧版快照路径支持。

## 功能

- 💡 **思维链默认展开** —— 右下角悬浮的灯泡按钮(开启时高亮),位于官方「滚到底部」圆钮正上方:

  - **开启时**(默认),每条「Think」思考折叠条都会被自动点开 —— 包括 agent 还在流式输出时新挂载的行 —— 不用逐条点击就能看到完整思考内容。
  - 关闭后恢复官方默认的收起样式,只显示一行摘要。
  - 开关状态跨刷新持久化(localStorage)。手动收起某一条折叠条不会被强制展开回去。

- 💰 **会话价格统计** —— 与官方 stats 行(轮数 / token 输入输出那行)**同一行、排在最左侧**,如 `≈ ¥0.83 · 2 轮 12 步 | …`:

  - 只有会话的请求走 **DeepSeek 官方 API**(provider 路由 `deepseek-official`)时才显示;切换到其它 API 后自动消失。
  - 价格 = token × 官网单价(人民币,官网在售的 `deepseek-flash`、`deepseek-v4-pro` 均已收录;旧模型名 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 官方仍可调用、由 V4.1-Flash 服务并按 Flash 价计费,故同价),逐请求按**真实时间**分峰谷计价(峰时 = 北京时间**周一至周五** 9:00–12:00、14:00–18:00,价格为闲时的 2 倍,周末全天闲时),输入区分缓存命中(折扣价)与未命中。
  - 价格表**未收录**的模型(官网刚上线、插件价格表还没同步)不会漏算:按已知 DeepSeek 模型里**最便宜的价格**兜底计价,悬停明细里如实标注「价格表未收录,按最低价估算」。
  - **边发生边累计**:每观测到一条请求就立刻按它的真实时间计价并持久化(localStorage,按会话,last-wins 不重复计)—— 历史分页把旧请求挤出浏览器窗口也不影响。会话从创建起就用本插件的话,总价**全程精确**,与会话多长无关。
  - 只有**从未被加载过的历史**(装插件之前、别的设备)才没有逐请求数据,差额按当前模型闲时价估算(当前模型未收录时同样走兜底价);与未收录模型的兜底价一起,都会让总价带上 `≈` 前缀(悬停可看明细:模型、token 数、峰/闲请求次数、未收录模型)。点「加载更早」补上历史后,差额部分即转为精确。
  - 价格表随官网调整时在插件代码里同步更新(`src/client/cost.ts`)。

- 📂 **文件用系统程序打开**(默认开启)—— 点文件不再弹右侧栏:

  - **背景**:dsh 0.1.5 起,聊天正文与工具行里的文件路径都被官方固定路由到右侧栏的文档预览 tab(源码里就是 `ctx.sidebarRight.openResource(...)` 一行,没有任何开关能关掉),于是「看一眼文件」等于「右侧栏被顶出来、会话区被挤窄」。
  - **本插件的行为**:拦截这次打开,把**绝对路径**交给宿主原生的 `session.openWorkspacePath`,由**系统默认程序**打开该文件(和你在访达/资源管理器里双击同一个文件等价)。会话区不动,右侧栏不弹。
  - **只拦「点文件」这一种**:右栏里的文件树、引导页、标签页菜单等自己的导航一律照旧 —— 你想用官方预览时,从文件树里打开文件仍然进右栏;附件图片等非文件资源也不受影响。
  - **打不开就退回官方**:纯远程浏览器(宿主没有桌面)、或宿主拒绝打开时,点击自动回退到官方右侧栏预览,不会出现「点了没反应」。
  - **开关**:设置 → 通用 → 「文件用系统程序打开」,状态即时生效并跨刷新保留。

- 🔔 **跑完提醒**(默认开启)—— 真的干完活时响一声,页面不在前台时同时改标签页标题:

  - **什么算「真的干完」**:一个会话在「agent 正在跑」**或**「有 `running`/`stopping` 的后台任务」**或**「有弹框在等你选」时算**忙**。从忙转闲、并持续安静约 2 秒后,响一声 —— 且只响一声。
    - 这 2 秒安静窗口是必须的:后台任务 settled 与「宿主唤醒 agent」是客户端两条独立的流,不等一个窗口的话,先到达的那一帧(任务已结束)看起来就像「全干完了」。
    - 任务列表按会话按需订阅:对 agent 正在跑的会话订阅,并且**只要该会话仍算「忙」就一直保持订阅** —— 包括 agent 已经让出回合、正等后台任务的那段空白。
    - agent 说完一轮去等后台任务、后台任务结束又把 agent 唤醒继续干,这两件事都**不算**干完,都不会响。(旧版插件的误报主要就来自这里。)
  - **弹框立即响**:工具授权确认、`ask_user_question` 提问、计划确认,出现即响。与「跑完了」用同一个音,标签页标题上区分两者。
  - **音色**:正常收尾是上行双音(do → mi);该次忙活里有后台任务 `failed` 或 `killed` 时改成下行双音(mi → do)。
  - **标签页标题提醒**:页面不是当前标签时(`document.hidden`),标题变成 `🔔 N 个会话跑完了 — <原标题>`;有弹框等你选时变成 `🔔 需要你选择 — <原标题>`。切回前台自动还原。
  - **不误报**:切换会话、加载历史、刷新页面都不会为历史回合或早已结束的任务补响。后台 **subagent** 子会话不会被单独播报 —— 它的结束会唤醒父会话,那还是同一件活。
  - **首次使用注意**:浏览器在用户与页面交互前禁止发声。**在页面任意处点一下或按一次键**,之后就能正常响(标题提醒不受此限制)。
  - **开关**:设置 → 通用 → 「跑完提醒」—— 一个开关同时管提示音与标签页标题,即时生效并跨刷新保留。

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

思维链默认展开作用于官方思考行(根节点 `data-variant="think"`,行内是 `[data-disclosure-row][aria-expanded="false"]` 的折叠条)。因为思维链全文只在展开态挂载,插件直接点击每条折叠行,翻转官方组件内部的 React 展开状态。`document.body` 上挂一个 `MutationObserver`,盯着「新增」的子树(流式输出、新轮次)随挂随点开;开关打开时先全量扫一遍已渲染的行。只扫新增子树、不监听属性变化,所以用户手动收起的行不会被强行展开。

会话价格统计注册到 `conversation.composer.dock`(官方 stats 行同一个 slot,与它排在同一行、作为行内第一个元素)。数据两个来源:`trajectory` 视图(逐请求携带 provider/model/usage/时间戳/startSeq,精确计价的基础)与 `tokenUsage` 投影(整个会话的全量 token)。逐请求的 provider/model 字段随 dsh 版本变过(0.1.5 及以前是 `provenance`,0.1.7 起是 `requestConfig`/`providerMetadata`),三种形态的读取都收敛在 `cost.ts` 的 `requestRoute` 里 —— 宿主再次改名字时表现为"价格行静默消失",所以组件同时把判定过程写到 `document.documentElement.dataset.dshWebeCost`(窗口请求数、其中官方 provider 条数、最近路由、总价、是否渲染),一行读取即可定位。每条观测到 usage 的请求按 startSeq 持久化累计(localStorage,last-wins,重试替换不重复计),投影超出累计器合计的差额(从未观测过的历史)按闲时价估算并标「≈」;最近一次请求不是 `deepseek-official` 时价格行不渲染。

跑完提醒注册到 `shell.overlay`(root 作用域的条目,渲染 `null`)。判定逻辑是 `notify-monitor.ts` 里的纯状态机 —— 不依赖 React / DOM、定时器可注入,所以整套时序能在本地用假时钟离线回放(`node probe/notify-probe.mjs` 覆盖了有意思的那几条:忙转闲、agent 让出回合但任务还在跑、忙周期内有任务失败、弹框出现、开关关闭与再打开)。React 那侧只做「把官方快照投影成每会话事实」:`useSessions`(`ids` / `byId.origin`,跳过 subagent 子会话)、`useSessionStatus`(`running`、`pendingInteraction.key`),任务列表来自 `jobs` 客户端服务(按会话 `watchRows`,只在会话 running 或仍算「忙」时订阅)。该服务缺失时提醒静默缺席、插件其余功能照常 —— 插件**刻意不把 `jobs` 写进 `inject` 列表**,并把装配状态写到 `document.documentElement.dataset.dshWebeNotify`(`tier`、`error`、`enabled`、会话/任务订阅数、每会话阶段),「怎么不响」一行控制台即可定位,不用靠猜。

## 开发

```sh
npm install
npm run build        # 产出 lib/index.js(宿主半)+ lib/client.js(浏览器半)
npx tsc --noEmit     # 类型检查
node probe/notify-probe.mjs   # 离线探针:提醒状态机 + bundle 装配(需先 build)
```

几条只对本机开发有意义的注意事项:

- **图标导出名是版本敏感的。** dsh 0.1.7 把 `dsh-client-ui-primitives` 的图标从尺寸后缀(`IconChevronUpOutline14`)改成语义后缀(`IconChevronUpOutlineMedium`)。导入了运行中宿主并不导出的名字,拿到的是 `undefined`,React 会把它变成 `Element type is invalid` —— 整页白屏,而外观上和「插件没加载」一模一样。存疑时直接查宿主实发的 bundle:页面的 `assets/index-*.js` 里就有模块表,`grep -o 'IconChevron[A-Za-z]*'` 即可。
- **聊天 DOM 不是稳定契约。** 本插件曾经自带一对逐轮导航箭头,**已在 0.2.0 删除** —— dsh 0.1.7 官方加了回合导航轨(TurnNavigator),同时把聊天 DOM 改成两种会静默打穿「凭印象写」的查询的样子:`[data-chat-flow]` 不再唯一(折叠的分步过程组内部也挂了 `data-step-process-content[data-chat-flow]`),折叠行改用 `hidden` 属性隐藏、几何全 0。以后若还要遍历对话流:对话列从**可见**锚点行的父节点反推,行选择器用官方同款 `:not([hidden]):not([hidden] *):not(:empty)`,并且先在 `probe/` 里离线回放再上机(这个目录就是为此存在的)。

- **`tsconfig.json` 的 `paths` 必须指向宿主实际加载的那一版官方包**(dsh CLI 的 `node_modules`),因为官方包之间有跨包的声明合并:同一个包被解析成第二份副本时,合并会静默失效(`GlobalStandardProps` 上会「没有 `useSessions`」)。本仓库自己的 `node_modules` 里还留着旧的 peer 依赖副本,所以 `paths` 是**故意**压过它们的。

## 卸载

```sh
dsh plugin --profile web remove @yangzhe1991/dsh-web-enhance
```

## 许可证

MIT
