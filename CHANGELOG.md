# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.5.3] - 2026-10-18

### Fixed
- 窄屏抽屉打开时，宿主 portal 菜单（视图选项 / 工作区 / 归档）被抽屉压住：
  插件层叠从 1290/1300/1350 压回 100/110/120，留在宿主模态（1000）与 portal
  菜单（1100）之下。判据是 `elementFromPoint` 命中，不是"元素存在"。
- 「添加工作区」面板被抽屉当 fixed 包含块：抽屉内出现 dialog/menu 时让出包含块
  （改用 left 定位而非 transform），并显式打开继承的 visibility / pointer-events。
  面板恢复视口大小、可见且可点击。

### Added
- `tools/probes/mobile-menus.js` 层叠回归探针（8 条断言）。

## [0.5.2] - 2026-10-15

### Fixed
- 右侧栏关闭后仍保留有宽度的 DOM；浮动入口可见性只由与视口相交的可见会话面板决定。

## [0.5.1] - 2026-10-14

### Fixed
- 手机全屏右侧栏展开时隐藏双浮动入口，避免覆盖浏览器输入/操作区域。
