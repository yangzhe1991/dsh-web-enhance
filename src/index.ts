/**
 * dsh-web-enhance 插件,node 半(宿主侧)。
 *
 * 本插件没有宿主侧行为:浏览器半通过 package.json 的 `dsh.client` 声明
 * 和 `exports["./client"]` 被发现并注入 Web UI。空 apply 只为了让插件行
 * 出现在宿主 Loader 的配置树中,从而被 dsh.client 扫描到。
 */
export function apply(): void {}
