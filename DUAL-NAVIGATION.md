# 移动端双入口：经典会话 / DS Bots

适配版本：`dsh-mobile-adapt 0.5.0`。仅窄屏（< 1024px）启用，桌面 UI 不改。实现位于 `lib/client.js`，复用原有侧栏抽屉、遮罩、会话自动收起、焦点管理和 Android 返回键机制。

## 用户操作

- 左上角（可拖动）的 **会话**：切换到经典 Agent 模式，打开 DSH 的工作区与历史会话列表。
- **Bots**：切换到 DS Bot 模式，打开 Chief、Bot、群聊列表。
- 已经打开某个列表时，再点同一入口 = 收起；点另一个入口 = 切换列表且保持抽屉展开。
- 点击会话行 / Bot 行之后抽屉自动收起；点列表外的遮罩也可收起。
- 按住任意按钮拖动整组，松手自动贴左/右；位置保存在浏览器 `localStorage['dsh-mobile-adapt:dual-dock']` 中。跨设备位置独立。
- 展开抽屉且按钮停在左侧时，浮动组会暂时移到抽屉右侧，不遮盖前面的工作区/会话行。
- 如果 DS Bot 前端插件未启用或加载失败，则回退到此前的**单一侧栏按钮**（`data-dsh-ma-opener`）。不会丢失原生会话入口。
- 桌面端 ≥1024px，双入口彻底隐藏，继续使用 DSH 原生侧栏及 DS Bot 菜单。

## 实现要点

一套原生 DSH 侧栏容器，**两个入口、两种呈现模式**，不是复制/迁移会话，也不是再建数据库。双入口控制器在 `installController(ctx)` 内管理 DOM。

1. 两按钮分别有 `data-dsh-ma-target="agent"` 和 `data-dsh-ma-target="bot"`，统一位于 `[data-dsh-ma-dual-dock]`。实际可用性由已加载的 DS Bot 客户端 DOM 标识探测；不会从本地磁盘臆断插件状态。
2. `agent` 模式走 DS Bot 原生 `AccountLauncher` 的「切换经典 Agent 模式」菜单；`bot` 模式走它的 `button.bt-return`。均调用其已有 React 事件回调，不修改或手工伪造 `ds-bot:surface` 状态。模式切换完成后才通过 `ctx.layout.toggleSidebar()` 开抽屉。
3. 保留原生 `onRowClick` 的 click 冒泡阶段收起机制，加入 Bot 行 `data-bot-id` / `data-room-id` / `data-agent-id`；跳过 Bot 菜单/群组辅助控件，避免在 pointerup 时提早吞掉手机合成 click。
4. 监听切换期间可能发生的 Chief 当前会话更新，短时保护新打开的抽屉，防止会话订阅误关。
5. 全部浮动 DOM、事件与属性随 HMR fiber disposer 回收；CSS 仅在窄屏生效。没有新网络权限、凭据 API 或 Agent 能力扩张。

DOM 选择器来自当前固定的 DS Bot `0.1.4`，后续升级 DS Bot 时应回归核对 `button.bt-account`、`button.bt-return` 和 `[data-bot-id]`。

## 验收记录（2026-10-15）

已在 linux-zt 生产 DSH `3080` 使用**独立 Chromium 用户配置**（没有修改用户的浏览器本地设置）运行验证：

| 场景 | 已验证 |
|---|---|
| 390×844 手机尺寸：两个按钮显示、单一共享抽屉 | 通过 |
| Bots → 会话 → Bots，两个列表正确切换 | 通过 |
| 再次点活动入口可打开/收起 | 通过 |
| 点击 Chief 行 / 旧 DSH 会话行自动收起 | 通过 |
| DSH-Home 工作区展开并看到原会话 | 通过 |
| 拖动后左/右自动吸附，位置写入 localStorage | 通过 |
| 刷新页面保持浮动位置 | 通过 |
| 320px 宽手机：按钮留在可见区域、会话区全宽 | 通过 |
| 1440px 宽桌面：双按钮隐藏 | 通过 |

测试输出保存在 `~/.cache/dsh-mobile-dual-20261015/`，修复前文件/原 Profile 备份在 `~/.dsh/backups/dsh-mobile-dual-20261015/`。

## 运维、回滚与注意事项

- DSH 服务：`systemctl --user status dsh-web.service`。前端插件源码改动由现有 HMR 检测；必要时可受控重启 `dsh-web.service`。
- 回退客户端：停止进一步编辑后，将 `~/.dsh/backups/dsh-mobile-dual-20261015/client.before.js` 复制回 `~/Desktop/apps/DSH-Home/plugins/dsh-mobile-adapt/lib/client.js`。旧版说明及 `package.json` 也已分别备份。
- **不会删除任何历史会话**。进入 Bots 模式时，原会话只是被 DS Bot 自己的侧栏替换；点「会话」即可再次访问。当前中心区域可能仍显示上一次打开的 Chief，点左侧原会话行即可切回原对话。
- 当屏幕非常窄或底部出现软件键盘时，浮动按钮会夹在可用视口范围内；若遮挡内容，可拖动调整。
