/**
 * dsh-mobile-adapt — 服务端半（宿主半）。
 *
 * 本插件**全部功能都在浏览器半**（`lib/client.js`）：窄屏抽屉侧边栏、点会话行收起、
 * 切换会话不抢输入焦点、输入不自动放大，以及「会话 / Bots」双浮动入口。
 * 这些都是浏览器内的 DOM/CSS 行为，不需要额外的宿主
 * 能力，所以这一半故意是空的。
 *
 * 那为什么还要有这一半？因为宿主发现客户端插件的路径是**扫描 loader 行**：
 * `dsh-client-modules` 只认那些「已经在插件树里、且 package.json 声明了
 * `dsh.client`」的包。没有这一行，`lib/client.js` 根本不会被编进浏览器模块图。
 * 所以这一半的唯一职责就是让这一行存在，并且**不注册任何东西**——没有路由、
 * 没有监听、没有定时器，于是它天然 HMR 安全（重载时没有任何需要回收的副作用）。
 *
 * 由此带来一个运维上的好处：改功能只需要改 `lib/client.js`。那一半由
 * `dsh-client-hmr` 每 500ms 轮询 bundle 的 mtime+size，重算内容哈希 rev 后经
 * `/plugins/events`（SSE）推给浏览器热替换模块——**不用重启 dsh web，也不用刷新页面**。
 */
export const name = 'dsh-mobile-adapt';

/** 不需要任何宿主服务。 */
export const inject = [];

/**
 * 挂载服务端半：只留一条启动日志，方便在 journal 里确认这一行真的起来了。
 * @param ctx - 宿主插件上下文。
 */
export function apply(ctx) {
  ctx.logger.info(
    '[mobile-adapt] host half mounted (no routes, no listeners) — all behavior lives in the browser half',
  );
}
