/**
 * dsh-web-enhance 插件,node 半(宿主侧)。
 *
 * 本插件没有宿主侧行为:五个功能(轮导航、思维链默认展开、会话价格统计、
 * 文件用系统程序打开、跑完提醒)全部在浏览器半实现,通过 package.json 的
 * `dsh.client` 声明和 `exports["./client"]` 被发现并注入 Web UI。空 apply
 * 只为了让插件行出现在宿主 Loader 的配置树中,从而被 dsh.client 扫描到。
 */
export function apply(): void {}
