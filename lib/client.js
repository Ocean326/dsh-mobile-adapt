/**
 * dsh-mobile-adapt — 客户端半（v0.5.0）。
 *
 * 核心实现：窄屏覆盖式抽屉、会话行导航自动收起、切换会话不抢焦点、
 * iOS 聚焦不放大、顶部/底部浮层渐隐、系统返回、拖动停靠与横竖屏。
 * 启用 DS Bot 时追加「会话 / Bots」两个浮动入口，共用同一原生侧栏容器；
 * 不安装 DS Bot 时仍保留原来的单按钮。
 *
 * ── 为什么用「纯 DOM + CSS」而不是 slots ──────────────────────────────────
 * 上述需求主要作用在**宿主自己的结构**上（AppFrame 的 grid、SidebarRoot 的列、
 * 输入卡片），无需向宿主插槽注册新的会话 UI。所以这里不注册任何
 * slot：注入一张样式表 + 一个 DOM 控制器，控制器只做三件事——标记宿主节点、
 * 读状态、写 <html> 上的 data 属性，其余交给 CSS。
 *
 * 这样做的直接好处是**宿主重渲染不会碰到我们的东西**：按钮与遮罩挂在 <body>，
 * React 永远不管它们；我们只往宿主的两个节点上写两个 data 属性，React 也不管
 * 它没声明过的属性。
 *
 * ── 与第三方适配插件共存 ──────────────────────────────────────────────────
 * 同一台机器上可能已经有别的移动端适配插件（本机是 dsh-web-mobile v3.0.0）。
 * 它们和本插件要的是**同一个结果**（抽屉式侧边栏），所以 CSS 不冲突——但
 * 「打开侧边栏」按钮会变成两个。因此本插件只在**没有别的可见入口**时才渲染
 * 自己的按钮（见 `otherOpenerVisible`）。于是「只留一个打开侧边栏按钮」这条
 * 该单入口回退策略仅在 DS Bot 未启用时使用；启用 DS Bot 时以双浮动入口为准。
 *
 * ── 热重载 ────────────────────────────────────────────────────────────────
 * `dsh-client-hmr` 轮询本文件的 mtime+size，变了就重算 rev 经 SSE 推给浏览器，
 * 浏览器把本模块整个换掉：旧 fiber dispose → 下面每个 `ctx.effect` 的 disposer
 * 跑完（样式表、按钮、遮罩、全部监听、全部定时器）→ 新模块 apply。所以**任何
 * 副作用都必须登记成可回收的**，否则重载一次就漏一份。
 */

window.__ModuleLoader__.load({
  id: 'dsh-mobile-adapt',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /** 插件命名空间：样式表 id、类名前缀、effect 标签都用它。 */
    const NS = 'dsh-mobile-adapt';
    /** 版本号写进 <html data-dsh-ma>，探针据此确认跑的是哪一版。 */
    const VERSION = '0.5.3';

    /**
     * 窄屏断点。必须与宿主 `dsh-client-ui-layout` 的 `SIDEBAR_AUTO_COLLAPSE`
     * （1024，deepsuite LG）逐字一致：宿主在 `< 1024` 时把侧边栏切到
     * `narrowExpanded` 分支，我们若用别的阈值就会和它的状态机错位。
     */
    const NARROW_QUERY = '(max-width: 1023.98px)';

    /**
     * 检测 iOS：只在 iOS 上强制 16px 下限防止聚焦放大。
     * Android / 桌面端不需要这个下限，保持宿主原本字号（紧凑更好用）。
     * 通过 UA 判断，避免 CSS 媒体查询对平板/桌面误判。
     */
    const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

    /** 抽屉宽度：宿主窄屏展开时给的 sidebar 偏好就是 280（layout store 初值）。 */
    const DRAWER_WIDTH = 'min(280px, 88vw)';

    /**
     * 会话行 / 行内动作按钮的类名片段（宿主 ui-workspace 的 CSS Modules 哈希名
     * `YDXeBa_sessionRow` / `YDXeBa_rowActions` 里的稳定片段）。
     * 这是**宿主没有提供 data 属性**的地方，只能按类名片段认；宿主升级时对账这两条。
     */
    const SESSION_ROW_SEL = '[class*="_sessionRow"]';
    const ROW_ACTIONS_SEL = '[class*="_rowActions"]';

    /**
     * 抽屉内部出现的宿主浮层（「添加工作区」面板、行内菜单）。它们本该是整屏/视口级
     * 浮层，但宿主把它们挂在侧栏列里面，于是抽屉的 transform 会把它们变成「抽屉内部」
     * 的浮层（见 CSS 里的「包含块」注释）。sync() 用这条选择器决定要不要让出包含块。
     */
    const OVERLAY_SEL = '[role="dialog"],[role="menu"],[aria-modal="true"]';

    /** 宿主的输入区契约（这两个 data 属性是宿主自己写的，稳定）。 */
    const COMPOSER_CARD_SEL = '[data-composer-card]';
    const COMPOSER_INPUT_SEL = '[data-composer-input]';

    /**
     * 输入卡片里的「工具行」（模型 chip / 权限 / 添加文件 / 语音 / 发送），实测宿主
     * CSS Modules 名是 `uV2eYG_row`，高 42px，是卡片里唯一可以被安全收起的一块。
     *
     * ⚠ v0.0.3 的教训：曾经用 `height: 44px` 直接压卡片，结果宿主内部的
     * `uV2eYG_scroll`（可编辑面的滚动容器）被 flex 压成 **0px**，42px 的工具行溢出到
     * 可见带上方——落点命中工具行而不是可编辑面，于是「点输入框唤不醒键盘」。
     * 现在改成收起工具行本身（`max-height: 0`），卡片高度由内容自然回流，
     * 可编辑面永远留在可见带里。宿主升级时对账 `_row` 这个片段。
     */
    const TOOL_ROW_SEL = '[class*="_row"]';

    /**
     * 「还没有对话」的初始页（hero）：输入卡片的祖先带 `_hero`。这一页没有内容可看，
     * 折叠 + 透明化只会显得空，所以需求 6/7/8 一律不在这里生效（实测卡片父类名
     * `uV2eYG_root uV2eYG_hero`）。
     */
    const HERO_SEL = '[class*="_hero"]';

    /**
     * 模型 chip：工具行尾部的模型选择按钮。结构钩子而不是文案钩子——
     * 实测 `_trailing` 的子树是 `… > div._standardControls > … > div._root >
     * button._trigger`，中间隔了两层没有类名碎片的 div，所以必须是**后代**选择器；
     * 工具行里另外两个 button 是 `_button_cfgyt_4 … _ghost_…`（语音）与
     * `uV2eYG_primary`（发送），排掉 `_primary` / `_ghost` 后剩下的就是模型 chip。
     */
    const MODEL_CHIP_SEL =
      '[class*="_trailing"] button:not([class*="_primary"]):not([class*="_ghost"])';

    /**
     * 会话切换后抑制「程序化聚焦」的时间窗。宿主在
     * `useEffect(..., [locked, sessionId, editor])` 里调
     * `editor.getRootElement()?.focus({preventScroll:true})`——sessionId 一变就抢焦点。
     * 这个 effect 在会话渲染提交后跑，给 1.5s 足够宽。
     */
    const SUPPRESS_FOCUS_MS = 1500;

    /** 用户自己碰过输入区之后，这段时间内的聚焦都算「用户意图」，一律放行。 */
    const USER_INTENT_MS = 600;

    /**
     * 判定「点」而不是「滑」的位移阈值（px）：抽屉里滚动列表不应被当成点会话行。
     *
     * 取 12 而不是 10，是为了和 `dsh-web-mobile` 的 `TAP_NAV_SLOP_PX = 12` 对齐：
     * 同一个手势不能出现「它算点、我们算滑」两套判定，否则一次轻微抖动的点击会
     * 只关一半（它不关、我们也不关，抽屉停在原地）。
     */
    const TAP_SLOP_PX = 12;

    /**
     * 长按阈值（ms）。超过它的按压是「长按」，不是「点」。
     *
     * 本机 `dsh-web-mobile` 用 500ms 长按打开会话行尾的 `⋯` 菜单，并在抬手时吞掉
     * 那次合成 click。我们必须认这个约定：长按抬手既不能当成导航去收起抽屉，
     * 否则 150ms 后会话列表卸载、刚打开的菜单跟着锚点一起消失。
     */
    const LONG_PRESS_MS = 450;

    /** 「另一个打开侧边栏按钮」的扫描间隔（ms）。流式输出时 DOM 每秒变几十次。 */
    const OPENER_SCAN_MS = 400;

    /** 侧栏按钮的边长（px），与 CSS 里的 width/height 一致，拖动时用来算边界。 */
    const OPENER_SIZE = 36;

    /** 侧栏按钮停靠时距屏幕边缘的距离（px），与 CSS 里的 10px 一致。 */
    const OPENER_EDGE_GAP = 10;

    /** 判定「拖动」而不是「点按」的位移阈值（px）。小于它就当点按，走 open()。 */
    const DRAG_SLOP_PX = 6;

    /** 挂载后多久才允许压 history 条目（ms）：给 /dsh-login → 303 的引导链留窗口。 */
    const BACK_SETTLE_MS = 1500;

    /** 侧栏按钮停靠位置的持久化偏好：{ side: 'left'|'right', y: number }。 */
    const OPENER_KEY = `${NS}:opener`;

    /**
     * 宿主把「当前选中的侧栏面板行」标成 `aria-current="page"`：会话页是 null，
     * 面板页是 "page"，两个状态干净可分。判据与第三方 dsh-web-mobile 的
     * panel-exit.ts 一致（那边是对同一代宿主的实测）。
     */
    const PANEL_ROW_ACTIVE_SEL = '[class*="panelRow"][aria-current="page"]';

    /**
     * 「打开侧边栏」入口的标签特征。只认侧边栏本身，**不**把「打开目录 / 文件」
     * 这类按钮算进来——它们不是侧边栏入口，认错会导致我们把自己的按钮也藏掉、
     * 屏幕上反而一个入口都没有。
     */
    const OPENER_LABEL = /侧边栏|sidebar/i;

    /** 挂在被我们影子掉 focus 的元素上的标记。 */
    const SHADOW_FLAG = 'data-dsh-ma-focus-shadow';

    /**
     * 窄屏下默认关掉的「浮动卡片」——`dsh-whale-widget` 的根节点。
     *
     * 它自己的样式是 `position: fixed; right: 0; bottom: 0; z-index: 9999`，
     * 尺寸 `clamp(122px, min(250px, min(100vw,100vh) * .28), 625px)`：手机上算出来
     * 就是下限 122px，正好钉在输入卡片的发送键上（390px 屏占掉 31% 宽度）。
     * 它没有「不显示」的配置项（只认 `config.provider`），所以由本插件在窄屏兜底。
     * 桌面端完全不受影响——下面那条规则只写在 `@media (max-width: 1023.98px)` 里。
     */
    const FLOAT_CARD_SEL = '.dshwv-root';

    /** 根节点上的开关：有 `on` 才显示浮动卡片，缺省即关闭。 */
    const FLOAT_CARD_ATTR = 'data-dsh-ma-float-card';

    /** 上面那个开关的持久化偏好。写 `'on'` 再刷新一次即可打开。 */
    const FLOAT_CARD_KEY = `${NS}:float-card`;

    /** 「焦点在可编辑面上」——由 `sync()` 从 `document.activeElement` 现算，不靠事件推断。 */
    const FOCUSED_ATTR = 'data-dsh-ma-composer-focused';
    /** 「当前不是空对话页」——折叠/透明化/顶部梯度都只在它成立时生效。 */
    const THREAD_ATTR = 'data-dsh-ma-has-thread';
    /** 由 JS 标记的会话顶部栏（不依赖宿主 CSS Modules 哈希）。 */
    const TOPBAR_ATTR = 'data-dsh-ma-topbar';
    /** 由 JS 标记的正文滚动容器（顶部栏改成浮层后，靠它让开顶部）。 */
    const SCROLLER_ATTR = 'data-dsh-ma-scroller';
    /** 由 JS 标记的底部 token/步数统计条（composer 卡片的兄弟节点）。 */
    const DOCK_ATTR = 'data-dsh-ma-dock';

    /** 顶部梯度最下端的透明度上限：0.02 = 98% 透明（用户要求「最高 98%」）。 */
    const BAR_FADE_ALPHA = 0.02;

    /**
     * 顶部梯度**最上端**的不透明度。0.82 = 顶端已有 18% 透明——第一版写的是 1.0（完全不透明），
     * 用户反馈「还可以再降低一些」，于是把顶端也拉起来一点，往下继续淡到 98% 透明。
     */
    const BAR_TOP_ALPHA = 0.82;

    /**
     * 底部渐隐的目标元素（由 JS 标记）。优先是宿主的 composer seat——实测
     * `wSkVaW_composerSeat` [0,758,383,86] 里同时装着输入卡片 (56px) 与 token/步数条
     * (26px)；只淡卡片的话，下面那条统计条仍是全不透明（用户报的「最下方透明度没调整」）。
     * 找不到 seat 时退回卡片本身。
     */
    const BOTTOM_ATTR = 'data-dsh-ma-bottom';

    const PANEL_LEFT_ICON =
      '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      '<rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2.4" stroke="currentColor" stroke-width="1.3"/>' +
      '<path d="M6.1 2.6v10.8" stroke="currentColor" stroke-width="1.3"/>' +
      '</svg>';

    const CSS = `
/* ══ 1. 窄屏：侧边栏 = 覆盖式抽屉；折叠时完全不占宽 ══════════════════════
   宿主自己的算法是 computeColumns(viewport, sidebar=0, ...) → 折叠成 56px 的
   rail（dsh-client-ui-layout/lib/client.js）。56px 在 390px 手机上吃掉 14% 宽度，
   所以这里把 grid 的第一条轨道直接压成 0，再把侧边栏列改成绝对定位的抽屉：
   展开时它**盖在**中间列上（中间列始终满宽），折叠时整体平移到屏幕外。
   轨道与定位都用 !important：宿主的 grid-template-columns 是 React 写的**内联
   样式**，不加 !important 的普通声明压不过它。 */
/* ══ 层叠（z-index）契约：本插件必须留在宿主浮层**之下** ═══════════════
   宿主 0.2.1-alpha.2 的层级表（全量 client bundle 扫描 + 390×844 实测）：
     页面内容 / 滚动 / 把手        ≤ 40
     dockkit 浮动层                 60
     模态遮罩 / 对话框              1000–1001
     浮层菜单（Menu portal）        1100   ← 归档 / 视图选项 / 工作区菜单都在这一层
     toast / bubble                 1100
     session inspector              1200–1251
   本插件是「内容级覆盖层」，所以抽屉 110、遮罩 100、入口 120，全部 < 1000。

   ⚠ v0.5.2 及以前用的是 1290/1300/1350，追求「永远在最上面」，结果把宿主
   portal 到 <body> 的菜单（1100）压到了抽屉底下：点「视图选项 / 归档 /
   工作区设置」时菜单确实渲染了，但被抽屉整块盖住，屏幕上像「没反应」。
   390×844 复现实测：菜单 rect=(36,282,200,324)，elementFromPoint(136,312)
   命中的却是抽屉里的会话行（YDXeBa_title）。
   规则：本插件任何层都不得 ≥ 1000；需要盖住菜单的是宿主自己，不是我们。 */
@media (max-width: 1023.98px) {
  html[data-dsh-ma] {
    --dsh-ma-drawer-w: ${DRAWER_WIDTH};
  }
  html[data-dsh-ma] [data-dsh-ma-frame] {
    grid-template-columns: 0px minmax(0, 1fr) 0px !important;
  }
  /* 轨道必须**显式指派**。侧边栏列改成绝对定位后就脱离了 grid 流，宿主的三个列
     只剩两个参与自动排列，于是中间列被塞进第 1 条轨道（0px）、右侧栏占了第 2 条
     （1fr）——整个会话区变成 0 宽。这里把三条轨道钉死：1=侧边栏 2=中间 3=右侧栏。 */
  html[data-dsh-ma] [data-dsh-ma-center] {
    grid-column: 2 !important;
  }
  html[data-dsh-ma] [data-dsh-ma-rightbar] {
    grid-column: 3 !important;
  }
  html[data-dsh-ma] [data-dsh-ma-drawer] {
    position: absolute !important;
    top: 0;
    bottom: 0;
    left: 0;
    width: var(--dsh-ma-drawer-w) !important;
    max-width: 88vw;
    /* 110 < 宿主模态 1000 / portal 菜单 1100，见上方「层叠契约」。 */
    z-index: 110 !important;
    transform: translateX(-100%);
    visibility: hidden;
    pointer-events: none;
    transition-property: transform, visibility;
    transition-duration: var(--ds-transition-duration-slow, .22s), 0s;
    transition-timing-function: var(--ds-ease-in-out, cubic-bezier(.4, 0, .2, 1)), linear;
    transition-delay: 0s, var(--ds-transition-duration-slow, .22s);
  }
  /* 展开：滑进来、可交互。visibility 的延迟在展开方向必须是 0，否则会先隐形再出现。 */
  html[data-dsh-ma][data-dsh-ma-open] [data-dsh-ma-drawer] {
    transform: translateX(0);
    visibility: visible;
    pointer-events: auto;
    transition-delay: 0s, 0s;
  }
  /* ══ 抽屉里有宿主浮层时，必须让出「包含块」════════════════════════════
     宿主的「添加工作区」面板是 position: fixed; inset: 0; z-index: 1000，但它
     渲染在侧栏列**内部**（宿主把它挂在 sectionHeader 下）。CSS 规则：fixed 后代
     的包含块是最近的带 transform/filter/will-change/contain 的祖先——也就是我们的
     抽屉。于是这个面板被压成抽屉大小（280×844 而不是整屏），并且被祖先
     bhn1Oq_sectionHeader 的 overflow: hidden 裁掉；抽屉收起时整体平移出屏幕，
     面板跟着一起消失（实测 dialog rect x=-281）。桌面没这个问题：桌面没有 transform，
     fixed 回到视口，overflow 也裁不到它。

     所以：抽屉里出现浮层时，本帧**不用 transform**，改用 left 定位，让 fixed 回到
     视口。同时 visibility / pointer-events 是继承属性，收起态的抽屉会把它们
     传给面板（实测 pe=none、vis=hidden → 面板隐形且点不到），必须显式打开。
     属性 data-dsh-ma-overlay 由 sync() 在抽屉内出现 dialog/menu 时写下。 */
  html[data-dsh-ma][data-dsh-ma-overlay] [data-dsh-ma-drawer] {
    transform: none !important;
    visibility: visible !important;
    pointer-events: auto !important;
  }
  /* 抽屉没展开时，浮层态靠 left 把它留在屏幕外（transform 已经让位）。 */
  html[data-dsh-ma][data-dsh-ma-overlay]:not([data-dsh-ma-open]) [data-dsh-ma-drawer] {
    left: calc(-1 * var(--dsh-ma-drawer-w)) !important;
  }
  /* 抽屉模式下宽度不再由拖动决定，把手没有意义。 */
  html[data-dsh-ma] [data-dsh-ma-frame] > [class*="_handle"] {
    display: none !important;
  }
}

/* ══ 遮罩 ═══════════════════════════════════════════════════════════════ */
.dshma_scrim {
  position: fixed;
  inset: 0;
  z-index: 100; /* 抽屉是 110，必须压在它下面；仍高于宿主内容层（≤60） */
  background: rgba(0, 0, 0, .34);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--ds-transition-duration-slow, .22s) var(--ds-ease-in-out, ease);
  -webkit-tap-highlight-color: transparent;
}
html[data-dsh-ma][data-dsh-ma-open] .dshma_scrim {
  opacity: 1;
  pointer-events: auto;
}

/* ══ 2. 「打开侧边栏」按钮 ═══════════════════════════════════════════════
   默认不显示。只有同时满足「窄屏 + 已折叠 + 没有别的可见入口」
   （html 上的 data-dsh-ma-solo）才出现，于是任何组合下屏幕上只有一个入口。 */
.dshma_opener {
  position: fixed;
  /* 默认停靠位置由 JS 接管（top/left/right 都写进内联样式）。这里的初值只保证
     「JS 还没跑」的第一帧也在合理位置。 */
  top: calc(env(safe-area-inset-top, 0px) + 10px);
  left: calc(env(safe-area-inset-left, 0px) + 10px);
  z-index: 120; /* 高于遮罩 100 才点得到；< 宿主浮层 1000，见「层叠契约」 */
  display: none;
  box-sizing: border-box;
  width: 36px;
  height: 36px;
  /* 拖动必须自己接管手势：否则触屏上的纵向滑动会被浏览器拿去滚页面。 */
  touch-action: none;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 0;
  border: .5px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, .16));
  border-radius: 50%;
  background: var(--dsw-alias-button-elevated-fill, var(--dsw-specific-input-major, rgba(28, 32, 40, .92)));
  color: var(--dsw-alias-label-primary, #e6e8eb);
  box-shadow: var(--dsw-elevation-soft, 0 4px 14px rgba(0, 0, 0, .32));
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  /* 停靠位置变化用 left/top 过渡（拖动过程中由下面的 dragging 规则关掉过渡，
     否则按钮会「追不上手指」）。 */
  transition:
    transform .12s var(--ds-ease-in-out, ease),
    left .18s var(--ds-ease-in-out, ease),
    right .18s var(--ds-ease-in-out, ease),
    top .18s var(--ds-ease-in-out, ease);
}
html[data-dsh-ma-solo] .dshma_opener {
  display: inline-flex;
}
.dshma_opener:active {
  transform: scale(.94);
}
/* 拖动中：跟手，不要过渡、不要缩放，视觉上「拿起来」了。 */
.dshma_opener[data-dragging] {
  transition: none;
  transform: scale(1.08);
  box-shadow: var(--dsw-elevation-overlay, 0 10px 28px rgba(0, 0, 0, .42));
}
/* 拖动时按钮是唯一能接到手势的元素，挡在下面的会话行不该被点到。 */
.dshma_opener[data-dragging] {
  cursor: grabbing;
}


/* ══ Dual mobile sidebars: classic sessions and long-lived DS Bots ══
   The two launchers share one dock and one existing sidebar drawer.
   Outside the narrow breakpoint we leave the desktop layout untouched. */
.dshma_dual-dock {
  position: fixed;
  z-index: 120; /* 与单入口一致：高于遮罩，低于宿主浮层（见「层叠契约」） */
  top: calc(env(safe-area-inset-top, 0px) + 72px);
  left: calc(env(safe-area-inset-left, 0px) + 10px);
  display: none;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  width: 68px;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  transition: left .18s ease, right .18s ease, top .18s ease, opacity .16s ease;
}
.dshma_dual-dock[data-dragging] { transition: none; }
.dshma_dual-button {
  position: relative;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  width: 68px;
  min-height: 36px;
  padding: 0 7px;
  border: 1px solid var(--dsw-alias-border-l3, rgba(135, 145, 160, .35));
  border-radius: 18px;
  background: var(--dsw-alias-button-elevated-fill, var(--dsw-specific-input-major, rgba(28, 32, 40, .94)));
  color: var(--dsw-alias-label-primary, #e6e8eb);
  box-shadow: var(--dsw-elevation-soft, 0 4px 14px rgba(0,0,0,.22));
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0;
  cursor: pointer;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
.dshma_dual-button > svg { flex: none; width: 16px; height: 16px; }
.dshma_dual-button > span { white-space: nowrap; }
.dshma_dual-button[aria-pressed='true'] {
  color: var(--dsw-alias-label-primary, #f1f5fa);
  border-color: var(--dsw-alias-border-brand, rgba(90, 138, 246, .9));
  box-shadow: inset 0 0 0 1px rgba(91, 141, 248, .25), 0 3px 12px rgba(0,0,0,.2);
}
.dshma_dual-button[aria-pressed='true']::before {
  content: '';
  position: absolute;
  width: 3px;
  height: 14px;
  top: 11px;
  left: 0;
  border-radius: 0 3px 3px 0;
  background: var(--dsw-alias-brand-primary, #6691f7);
}
.dshma_dual-button:active { transform: scale(.96); }
.dshma_dual-button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #6691f7);
  outline-offset: 2px;
}
.dshma_dual-dock[data-dragging] .dshma_dual-button { cursor: grabbing; }
@media (max-width: 1023.98px) {
  html[data-dsh-ma][data-dsh-ma-dual] .dshma_dual-dock { display: flex; }
  /* Avoid covering the native full-screen right sidebar or Agent Browser. */
  html[data-dsh-ma][data-dsh-ma-right-open] .dshma_dual-dock,
  html[data-dsh-ma][data-dsh-ma-right-open] .dshma_opener { display: none !important; }
  html[data-dsh-ma][data-dsh-ma-dual] .dshma_opener { display: none !important; }
  html[data-dsh-ma][data-dsh-ma-dual][data-dsh-ma-composer-focused]:not([data-dsh-ma-open]) .dshma_dual-dock {
    opacity: .62;
  }
  html[data-dsh-ma][data-dsh-ma-dual][data-dsh-ma-composer-focused] .dshma_dual-dock:hover,
  html[data-dsh-ma][data-dsh-ma-dual][data-dsh-ma-composer-focused] .dshma_dual-dock:focus-within {
    opacity: 1;
  }
}
@media (min-width: 1024px) {
  .dshma_dual-dock { display: none !important; }
}
/* ══ 3.5 浮动卡片默认关闭 ════════════════════════════════════════════════
   ${FLOAT_CARD_SEL} 是 dsh-whale-widget 的根节点：position:fixed + right:0 +
   bottom:0 + z-index:9999，手机上是 122px 见方，正好压在输入卡片的发送键上。
   它自己没有「不显示」的开关，所以窄屏默认关掉；想打开就
   localStorage.setItem('${FLOAT_CARD_KEY}', 'on') 再刷新一次。
   只写在窄屏媒体查询里——桌面端那个挂件照常显示。 */
@media (max-width: 1023.98px) {
  html[data-dsh-ma]:not([${FLOAT_CARD_ATTR}='on']) ${FLOAT_CARD_SEL} {
    display: none !important;
  }
}

/* ══ 3. 输入不自动放大（仅 iOS）══════════════════════════════════════════════════
   iOS Safari 会在聚焦 font-size < 16px 的表单控件 / contenteditable 时把整页
   放大，且捏合往往缩不回来。宿主的输入卡片是
   font-size: var(--dsh-content-font-size, 14px)，编辑面是 font-size: inherit
   ——用户把「字号大小」调小就会踩到。这里**仅在 iOS**给可编辑面加 16px 下限：
   max(16px, 1em) 里的 1em 取父级（卡片）字号，所以用户调大字号时不被压回去，
   只补下限。只改编辑面、不改卡片本身，输入区的行高与留白保持宿主原样。
   Android / 桌面端不加下限，保持紧凑字号。 */
@media (max-width: 1023.98px) {
  html[data-dsh-ma] ${COMPOSER_INPUT_SEL} {
    font-size: max(16px, 1em) !important;
  }
  html[data-dsh-ma] input:not([type='checkbox']):not([type='radio']):not([type='range']):not([type='color']):not([type='file']),
  html[data-dsh-ma] textarea,
  html[data-dsh-ma] [contenteditable='true'] {
    font-size: max(16px, 1em);
  }
}

/* ══ 3.5 Android/桌面紧凑字号 ═══════════════════════════════════════════════
   非 iOS（Android / 桌面端）窄屏下保持宿主原本字号（紧凑更好用）。iOS 那条 16px
   下限在上面的块里，两条互不重叠。 */
@media (max-width: 1023.98px) {
  html[data-dsh-ma]:not([data-dsh-ma-ios]) ${COMPOSER_INPUT_SEL} {
    font-size: inherit !important;
  }
  html[data-dsh-ma]:not([data-dsh-ma-ios]) input:not([type='checkbox']):not([type='radio']):not([type='range']):not([type='color']):not([type='file']),
  html[data-dsh-ma]:not([data-dsh-ma-ios]) textarea,
  html[data-dsh-ma]:not([data-dsh-ma-ios]) [contenteditable='true'] {
    font-size: inherit;
  }
}

/* ══ 3.6 非聚焦时：输入卡片半透明 + 收起工具行 ════════════════════════════
   三道闸门，缺一不可：
     · 窄屏（本块整体在媒体查询里）
     · **不是空对话页**（'[data-dsh-ma-has-thread]'）：初始页没内容可看，压扁只是显空
     · 焦点确实不在可编辑面上（'[data-dsh-ma-composer-focused]' 由 sync() 现算）

   收起的是**工具行**（模型 chip / 权限 / 语音 / 发送，实测 42px），不是卡片高度。
   卡片高度由内容自然回流，所以可编辑面永远留在可见带内——v0.0.3 用
   'height: 44px' 压卡片时，宿主内部的 '_scroll' 被 flex 压成 0px，工具行溢出盖住
   可见带，落点命中工具行而不是可编辑面，表现就是「点了唤不醒键盘」。 */
@media (max-width: 1023.98px) {
  /* 底部整片渐隐：目标是 JS 标记的 composer seat（卡片 + token/步数条 + 任务/目标栏），
     不是单指卡片——只淡卡片时下面那条统计条仍是不透明的（实测 cardOp=0.3 / dockOp=1）。
     单个目标、单个 opacity，避免父子各淡一次叠成 0.09。 */
  html[data-dsh-ma][${THREAD_ATTR}]:not([${FOCUSED_ATTR}]) [${BOTTOM_ATTR}] {
    opacity: .3;
    transition: opacity .18s var(--ds-ease-in-out, ease);
  }
  html[data-dsh-ma][${THREAD_ATTR}]:not([${FOCUSED_ATTR}]) ${COMPOSER_CARD_SEL} > ${TOOL_ROW_SEL} {
    /* 三处都要写，缺一个就收不干净（都是实测值，不是预防性代码）：
       · min-height: 0 —— 工具行是 flex item，默认 min-height:auto 会解析成内容高度，
         把 max-height:0 顶回去（实测只从 42px 收到 8px）；
       · box-sizing: border-box —— 默认 content-box 下 max-height 只限制**内容**盒；
       · padding-top/bottom: 0 —— 实测行自带 'padding: 2px 8px 6px'，上下合计 8px。
         两种 box-sizing 语义下这 8px 都会撑出可见高度（实测收尾停在 8px 而不是 0），
         直接归零才彻底。聚焦分支不写这一条，所以宿主自己的 padding 在展开时原样
         回来，不需要我们记住它的原值。 */
    min-height: 0;
    box-sizing: border-box;
    padding-top: 0;
    padding-bottom: 0;
    max-height: 0;
    opacity: 0;
    overflow: hidden;
    pointer-events: none;
    transition:
      max-height .18s var(--ds-ease-in-out, ease),
      opacity .14s var(--ds-ease-in-out, ease);
  }
  /* 聚焦时把工具行放回来：max-height 给足 60px（实测行高 42px），从 0 过渡回来。 */
  html[data-dsh-ma][${THREAD_ATTR}][${FOCUSED_ATTR}] ${COMPOSER_CARD_SEL} > ${TOOL_ROW_SEL} {
    min-height: 0;
    box-sizing: border-box;
    max-height: 60px;
    opacity: 1;
    pointer-events: auto;
    transition:
      max-height .18s var(--ds-ease-in-out, ease),
      opacity .14s var(--ds-ease-in-out, ease);
  }
}

/* ══ 3.7 模型名显示宽度上限 ═══════════════════════════════════════════════
   实测 390px 宽下模型 chip 占 151px（'Strata Coder (lenovo, 153K)'），把右侧挤到
   贴着发送键。收到 116px：名字多出来的部分走宿主已有的
   'text-overflow: ellipsis'（'…_triggerLabel' 本来就是 nowrap+ellipsis），
   'title'/'aria-label' 里仍是完整名字，信息不丢。 */
@media (max-width: 1023.98px) {
  html[data-dsh-ma] ${MODEL_CHIP_SEL} {
    max-width: 116px !important;
  }
  html[data-dsh-ma] ${MODEL_CHIP_SEL} > span {
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
  }
}

/* ══ 3.9 顶部栏浮层化 + 打字时收起顶部与统计条 ════════════════════════════
   为什么必须浮层化：实测头部是 390×78 的**独立布局带**，正文滚动容器
   (wSkVaW_scrollBody) 在它**下面**（78..844），内容根本不会滚到头部底下。
   于是「白色 → 白色 2%」的渐变画在一个空背景上 = 视觉零变化（用户实测「顶部好像
   没有应用透明」）。把头部从文档流里拿出来（position: absolute）之后，正文顶到 0，
   内容才会从头部**底下穿过**，渐变才看得见，同时白赚 78px。

   打字（聚焦）时进一步把顶部内容淡出、让正文 padding-top 归零、并收起底部
   token/步数统计条，再多出 78 + 26 = 104px 给对话文字。

   ⚠ 只在「有对话」时生效（[data-dsh-ma-has-thread]）：空对话页的头部是
   headerBlank（实测 390×40、无内容），浮层化没有意义，还会给 hero 页平白加内边距。 */
@media (max-width: 1023.98px) {
  html[data-dsh-ma][${THREAD_ATTR}] [${TOPBAR_ATTR}] {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 6;
    transition: opacity .18s var(--ds-ease-in-out, ease);
  }
  /* 聚焦：顶部内容整体淡出并让开点击，正文顶上来的 78px 直接归零 */
  html[data-dsh-ma][${THREAD_ATTR}][${FOCUSED_ATTR}] [${TOPBAR_ATTR}] {
    opacity: 0;
    pointer-events: none;
  }
  html[data-dsh-ma][${THREAD_ATTR}] [${SCROLLER_ATTR}] {
    padding-top: var(--dsh-ma-header-pad, 0px);
    transition: padding-top .18s var(--ds-ease-in-out, ease);
  }
  html[data-dsh-ma][${THREAD_ATTR}][${FOCUSED_ATTR}] [${SCROLLER_ATTR}] {
    padding-top: 0;
  }
  /* 底部 token/步数统计条（实测 351×26，文本「8 轮 147 步·175 tok/s / 28.3M tok…」）。
     与工具行同一套收法：min-height + border-box + padding 归零，缺一条就收不干净。 */
  html[data-dsh-ma][${THREAD_ATTR}][${FOCUSED_ATTR}] [${DOCK_ATTR}] {
    min-height: 0;
    box-sizing: border-box;
    padding-top: 0;
    padding-bottom: 0;
    max-height: 0;
    opacity: 0;
    overflow: hidden;
    transition:
      max-height .18s var(--ds-ease-in-out, ease),
      opacity .14s var(--ds-ease-in-out, ease);
  }
  html[data-dsh-ma][${THREAD_ATTR}]:not([${FOCUSED_ATTR}]) [${DOCK_ATTR}] {
    max-height: 60px;
    opacity: 1;
    transition:
      max-height .18s var(--ds-ease-in-out, ease),
      opacity .14s var(--ds-ease-in-out, ease);
  }
}

/* ══ 3.8 无焦点时顶部栏透明梯度 ═══════════════════════════════════════════
   会话头部（JS 用 '[${TOPBAR_ATTR}]' 标记，不认类名哈希）铺一条从上到下的渐变：
   顶端 = 页面底色（不透明），底端 = 同色 ${BAR_FADE_ALPHA * 100}% 透明（= 98% 透明）。
   两个颜色由 JS 从头部最近的「不透明祖先」取，所以跟随明暗主题自动切换。

   实测（390×844，会话态）：头部是 390×78 的独立布局带，正文滚动容器
   'wSkVaW_scrollBody' 在它**下面**（78..844），内容不会滚到头部底下——所以这里
   不需要 sticky / z-index，纯背景即可。渐变本身不可插值，所以这是**离散切换**
   （聚焦/失焦那一帧换掉），输入卡片那边的收起/展开才是带过渡的。 */
@media (max-width: 1023.98px) {
  html[data-dsh-ma][${THREAD_ATTR}]:not([${FOCUSED_ATTR}]) [${TOPBAR_ATTR}] {
    background-image: linear-gradient(
      to bottom,
      var(--dsh-ma-bar-top, rgba(255, 255, 255, 0.82)) 0%,
      var(--dsh-ma-bar-bot, rgba(255, 255, 255, 0.02)) 100%
    ) !important;
  }
}
`;

    // ── 样式表 ────────────────────────────────────────────────────────────

    /**
     * 注入本插件的样式表，并保证**任何时刻至多只有一张**。
     *
     * 先删掉所有同名旧表再建新的，而不是「有就复用」：客户端热重载会重新执行
     * 本模块并再跑一次 `apply`，而旧 fiber 的 disposer 与新 `apply` 的先后顺序
     * 不是我们能假设的（实测一轮热重载后 `<style>` 变成了两张）。「先清后建」在
     * 任何顺序下都收敛到一张，反复热重载也不会累积。
     * @returns 移除样式表的 disposer。
     */
    function ensureStyles() {
      for (const stale of document.querySelectorAll(`style[data-plugin="${NS}"]`)) stale.remove();
      const tag = document.createElement('style');
      tag.id = `${NS}-styles`;
      tag.dataset.plugin = NS;
      tag.dataset.pluginCss = `${NS}/mobile.css`;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        if (tag.isConnected) tag.remove();
      };
    }

    // ── 宿主状态读取 ──────────────────────────────────────────────────────

    /**
     * 当前会话 id。宿主 0.1.6-alpha.2 前后改过这个形状：rc.2 是
     * `list.current`，a2 把选择搬进每个会话的 `retainedBy.mainView` 计数。
     * 两个都认，认不出来就返回 undefined（当作「没变」，绝不抛）。
     * @param ctx - 客户端插件上下文。
     * @returns 当前会话 id，或 undefined。
     */
    function currentSessionId(ctx) {
      try {
        const snapshot = ctx.sessions.list.getSnapshot();
        if (typeof snapshot.current === 'string') return snapshot.current;
        const byId = snapshot.byId || {};
        for (const key of Object.keys(byId)) {
          const summary = byId[key];
          if (summary === undefined || summary === null) continue;
          const mainView = summary.retainedBy && summary.retainedBy.mainView;
          if (typeof mainView === 'number' && mainView > 0 && typeof summary.id === 'string') return summary.id;
        }
      } catch (error) {
        /* 宿主代数差异：拿不到当前会话就退化成「只在点会话行时收起抽屉」。 */
      }
      return undefined;
    }

    // ── DOM 控制器 ────────────────────────────────────────────────────────

    /**
     * 安装移动端控制器：标记宿主结构、维护 `<html>` 上的状态属性、按状态渲染
     * 入口按钮与遮罩、并挂上四条需求需要的监听。
     * @param ctx - 客户端插件上下文（用到 ctx.layout.toggleSidebar / ctx.sessions）。
     * @returns 拆除全部副作用的 disposer（热重载必须完全可回收）。
     */
    function installController(ctx) {
      const root = document.documentElement;
      const mq = window.matchMedia(NARROW_QUERY);

      /** 宿主的 AppFrame 根节点（grid 容器）。 */
      let frame = null;
      /** 宿主的侧边栏列（AppFrame 的第一个元素子节点）。 */
      let drawer = null;
      /** 宿主的中间列。侧边栏脱离 grid 流后必须显式钉在轨道 2，否则会话区会被压成 0 宽。 */
      let center = null;
      /** 宿主的右侧栏列，显式钉在轨道 3。 */
      let rightbar = null;

      /** rAF 句柄：把一串 mutation 合成一帧处理。 */
      let raf = 0;
      /** 上一次「别的入口」扫描的时刻（performance.now()）。 */
      let lastOpenerScan = 0;
      /** 上一次扫描的结论：没有别的可见入口。 */
      let solo = false;
      /** 抑制自动聚焦的截止时刻（performance.now()）。 */
      let suppressUntil = 0;
      /** 用户最后一次碰输入区的时刻。 */
      let userIntentAt = 0;
      /** 解除 focus 影子的定时器。 */
      let shadowTimer = 0;
      /** 被影子掉 focus 的元素与它原本的 focus 方法。 */
      let shadowed = null;
      let shadowedOriginal = null;
      /** 一次点击的起点（判定「点」还是「滑」）。 */
      let downAt = null;
      /** 这次按压的起始时刻（判定「点」还是「长按」）。 */
      let pressAt = 0;
      /** 上一次看到的当前会话 id。 */
      let lastSession = currentSessionId(ctx);
      /** 侧栏按钮停靠在哪一侧。 */
      let openerSide = 'left';
      /** 侧栏按钮的垂直停靠位置（视口坐标 px）。 */
      let openerY = OPENER_EDGE_GAP;
      /** 拖动会话：按下时的坐标与指针相对按钮左上角的偏移。 */
      let drag = null;
      /** 刚拖完的那一次 click 要吞掉，否则拖完会顺手把抽屉打开。 */
      let swallowOpenerClick = false;
      /** 本次挂载的时刻，用来给引导链留宽限期。 */
      let installedAt = performance.now();
      /** 我们是否已经往 history 里压了一条可被系统返回消费的条目。 */
      let backArmed = false;
      /** 是我们自己调用 history.back() 引发的 popstate 回声，需要吞掉。 */
      let backEcho = false;
      let backEchoTimer = 0;
      /** 安全区探针元素：JS 读 env(safe-area-inset-*) 的标准做法。 */
      const safeProbe = document.createElement('div');
      /** 被我们标记成「会话顶部栏」的元素。 */
      let topbar = null;
      /** 被我们标记成「正文滚动容器」的元素。 */
      let scroller = null;
      /** 被我们标记成「底部 token/步数统计条」的元素。 */
      let dock = null;
      /** 目标栏（data-goal-bar）在 composer seat 之外时，单独标记的那一个。 */
      let extraBottom = null;
      /** 上一次给顶部梯度取色的时刻（明暗主题切换时要重取，所以按轮询节奏节流）。 */
      let lastBarColorAt = 0;

      // ── 结构标记 ────────────────────────────────────────────────────────

      /**
       * 找到并标记宿主结构。
       *
       * 用 `[class*="_frame"]` + 「内部有 `[class*="_sidebarCol"]`」来认：AppFrame
       * 的根节点唯一满足这一条。标记成自己的 data 属性之后，CSS 就不再依赖任何
       * 哈希类名——宿主换哈希、别的插件改类名，都不影响我们。
       */
      function markStructure() {
        if (frame !== null && frame.isConnected && drawer !== null && drawer.isConnected) return;
        frame = null;
        drawer = null;
        center = null;
        rightbar = null;
        for (const candidate of document.querySelectorAll('[class*="_frame"]')) {
          const column = candidate.querySelector('[class*="_sidebarCol"]');
          if (column === null) continue;
          frame = candidate;
          drawer = column;
          center = candidate.querySelector('[class*="_centerCol"]');
          rightbar = candidate.querySelector('[class*="_rightbarCol"]');
          break;
        }
        if (frame !== null) frame.setAttribute('data-dsh-ma-frame', '');
        if (drawer !== null) drawer.setAttribute('data-dsh-ma-drawer', '');
        if (center !== null) center.setAttribute('data-dsh-ma-center', '');
        if (rightbar !== null) rightbar.setAttribute('data-dsh-ma-rightbar', '');
      }

      /**
       * 标记会话顶部栏。
       *
       * 用几何而不是类名认：实测宿主头部是 `header.wSkVaW_header`，390×78、贴顶、
       * 横跨整个中间列，而它的两个子块（`_headerActions` 100×28、`_headerUtilities`
       * 217×32）都更窄。取「贴顶 + 宽度 ≥ 中间列 80% + 高度在 20..240」的唯一那个。
       * 标记成 data 属性之后，CSS 不再依赖任何 CSS Modules 哈希。
       */
      function markTopBar() {
        if (topbar !== null && topbar.isConnected && scroller !== null && scroller.isConnected) return;
        topbar = null;
        scroller = null;
        dock = null;
        const host = center;
        if (host === null) {
          for (const stale of document.querySelectorAll(`[${TOPBAR_ATTR}],[${SCROLLER_ATTR}],[${DOCK_ATTR}]`)) {
            stale.removeAttribute(TOPBAR_ATTR);
            stale.removeAttribute(SCROLLER_ATTR);
            stale.removeAttribute(DOCK_ATTR);
          }
          return;
        }
        const hostBox = host.getBoundingClientRect();
        for (const el of document.querySelectorAll('header,[class*="_header"],[class*="_topbar"]')) {
          const box = el.getBoundingClientRect();
          if (box.top > 8) continue;
          if (box.height < 20 || box.height > 240) continue;
          if (box.width < hostBox.width * 0.8) continue;
          if (box.left > hostBox.left + 2) continue;
          topbar = el;
          break;
        }
        // 正文滚动容器：头部外层是 display:contents（实测），所以头部的父元素就是
        // 会话根；根下「高度 > 100 的兄弟」是 body，body 里 overflow-y:auto 且够高的
        // 那个才是真正在滚的容器。
        if (topbar !== null) {
          // 头部的直接父元素是 display:contents 的空壳（实测 rect 0×0），所以要往上
          // 找到**第一个真有高度**的祖先——那才是会话根（wSkVaW_root，position:relative）。
          let root_ = topbar.parentElement;
          while (root_ !== null && root_ !== document.body && root_.getBoundingClientRect().height < 100) {
            root_ = root_.parentElement;
          }
          for (const sibling of root_ !== null ? root_.children : []) {
            if (sibling === topbar || sibling.contains(topbar)) continue;
            if (sibling.getBoundingClientRect().height < 100) continue;
            for (const el of sibling.querySelectorAll('*')) {
              const cs = getComputedStyle(el);
              if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') continue;
              if (el.clientHeight < 200) continue;
              scroller = el;
              break;
            }
            if (scroller !== null) break;
          }
        }

        // 底部统计条：composer 卡片所在容器的直接子节点里带 `_dock` 片段的那个
        // （实测 uV2eYG_dock，文本「8 轮 147 步·175 tok/s / 28.3M tok·缓存命中 89%」）。
        const card = document.querySelector(COMPOSER_CARD_SEL);
        if (card !== null && card.parentElement !== null) {
          for (const el of card.parentElement.children) {
            if (el === card || !/[\s]?_dock/.test(String(el.className))) continue;
            dock = el;
            break;
          }
        }

        for (const el of document.querySelectorAll(`[${TOPBAR_ATTR}],[${SCROLLER_ATTR}],[${DOCK_ATTR}]`)) {
          if (el !== topbar) el.removeAttribute(TOPBAR_ATTR);
          if (el !== scroller) el.removeAttribute(SCROLLER_ATTR);
          if (el !== dock) el.removeAttribute(DOCK_ATTR);
        }
        if (topbar !== null) topbar.setAttribute(TOPBAR_ATTR, '');
        if (scroller !== null) scroller.setAttribute(SCROLLER_ATTR, '');
        if (dock !== null) dock.setAttribute(DOCK_ATTR, '');
      }

      /**
       * 标记「底部渐隐」的目标元素。
       *
       * 实测（390×844 会话态）：`wSkVaW_composerSeat` = [0,758,383,86]，里面装着输入卡片
       * (56px) 与 token/步数条 `uV2eYG_dock` (26px)；第一版只淡卡片，结果卡片 0.3 而统计条
       * 仍是 1.0——就是用户报的「最下方的透明度没有正常调整」。
       *
       * 目标栏用宿主稳定钩子 `[data-goal-bar]`（来自 `@deepseek-ai/dsh-client-ui-goal`，
       * 不是 CSS Modules 哈希）。它在 seat **之外**时才单独再标记一个；在里面的话 seat 已经
       * 带上了，不能再淡一次（父子 opacity 相乘会变成 0.09）。
       */
      function markBottomTarget() {
        const card = document.querySelector(COMPOSER_CARD_SEL);
        const seat = card === null ? null : card.closest('[class*="_composerSeat"]');
        const target = seat === null ? card : seat;
        extraBottom = null;
        for (const el of document.querySelectorAll('[data-goal-bar]')) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 8 || rect.height < 4) continue;
          if (target !== null && target.contains(el)) continue;   // 已被 seat 覆盖
          extraBottom = el;
          break;
        }
        for (const el of document.querySelectorAll(`[${BOTTOM_ATTR}]`)) {
          if (el !== target && el !== extraBottom) el.removeAttribute(BOTTOM_ATTR);
        }
        if (target !== null) target.setAttribute(BOTTOM_ATTR, '');
        if (extraBottom !== null) extraBottom.setAttribute(BOTTOM_ATTR, '');
      }

      /**
       * 把「正文要让开顶部多少」写成 CSS 变量。
       *
       * 顶部栏改成 absolute 之后不再占文档流，正文顶到 0，于是要靠滚动容器的
       * padding-top 把首条消息顶下来，否则它一开始就被压在栏下面。聚焦（打字）时
       * 这个留白归零，文字直接顶到屏幕最上沿。
       *
       * 高度是**实测**的而不是写死的：头部高度会随标题/芯片的出现而变（实测
       * headerBlank 40px vs 有内容 78px）。
       * @param focused - 焦点是否在可编辑面上。
       */
      function syncHeaderPad(focused) {
        const height = topbar === null ? 0 : Math.round(topbar.getBoundingClientRect().height);
        const pad = focused || height === 0 ? '0px' : `${height}px`;
        if (root.style.getPropertyValue('--dsh-ma-header-pad') !== pad) {
          root.style.setProperty('--dsh-ma-header-pad', pad);
        }
      }

      /**
       * 从元素往上找第一个「真正不透明」的背景色，给顶部梯度取色。
       *
       * 为什么不写死白色：明暗主题下页面底色不同，写死会在暗色下变成一条白带。
       * 取不到就返回 null，CSS 回落到自己的 `rgb(255,255,255)` 兜底值。
       * @param el - 起点元素。
       * @returns { r, g, b } 或 null。
       */
      function opaqueColorOf(el) {
        let node = el;
        while (node !== null && node !== document.documentElement) {
          const parsed = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.%]+))?\s*\)$/.exec(
            getComputedStyle(node).backgroundColor || '',
          );
          if (parsed !== null) {
            const alpha = parsed[4] === undefined ? 1 : parsed[4].endsWith('%') ? parseFloat(parsed[4]) / 100 : parseFloat(parsed[4]);
            if (alpha > 0.5) return { r: parsed[1], g: parsed[2], b: parsed[3] };
          }
          node = node.parentElement;
        }
        return null;
      }

      /** 把顶部梯度的两个颜色写成 CSS 变量（跟随明暗主题自动变）。 */
      function syncBarColors(now) {
        if (now - lastBarColorAt < 1500) return;
        lastBarColorAt = now;
        const target = topbar !== null ? topbar : frame;
        const color = target === null ? null : opaqueColorOf(target);
        if (color === null) return;
        root.style.setProperty('--dsh-ma-bar-top', `rgba(${color.r}, ${color.g}, ${color.b}, ${BAR_TOP_ALPHA})`);
        root.style.setProperty('--dsh-ma-bar-bot', `rgba(${color.r}, ${color.g}, ${color.b}, ${BAR_FADE_ALPHA})`);
      }

      // ── 状态 ────────────────────────────────────────────────────────────

      const isNarrow = () => mq.matches;
      const isCollapsed = () => (frame === null ? true : frame.hasAttribute('data-sidebar-collapsed'));

      /** 只在值真的变了才写 DOM，避免每帧都产生一次无谓的属性写入。 */
      function setRootAttr(name, value) {
        if (value === null) {
          if (root.hasAttribute(name)) root.removeAttribute(name);
          return;
        }
        if (root.getAttribute(name) !== value) root.setAttribute(name, value);
      }

      /**
       * 屏幕上是否已经存在**另一个可见的、真的能开宿主侧边栏**的入口。
       *
       * 判据必须比「标签里有侧边栏」严得多。本机实测：dsh-better-sidebar 在会话页
       * 右上角渲染了一个 `aria-label="展开侧边栏"` 的按钮（`nArs4W_toggleButton`），
       * 但它开的是它自己的右侧面板（`togglePanel(store)`），跟宿主侧边栏列毫无关系。
       * 只按标签认就会把它算成入口 → 我们把自己的按钮藏起来 → **宿主侧边栏一个入口
       * 都没有**（宿主自己的 rail 按钮在折叠时是 display:none）。
       *
       * 所以只认两类：
       *   1. 明确声明自己是移动端导航控件的（`data-mobile-nav`，dsh-web-mobile 的约定）；
       *   2. 宿主自己的 rail 按钮，且**真的可见**（折叠时它是 display:none，不算）。
       * 排除在我们自己的抽屉里的元素：折叠时它被平移出屏幕，但仍会返回 36×36 的
       * 矩形，宿主自己的 rail 按钮就是这样。
       * @returns 存在另一个可见入口时为 true。
       */
      function otherOpenerVisible() {
        const candidates = [
          ...document.querySelectorAll('[data-mobile-nav]'),
          ...document.querySelectorAll('button[aria-label="打开侧边栏"]'),
        ];
        for (const el of candidates) {
          if (el === opener || opener.contains(el)) continue;
          if (drawer !== null && drawer.contains(el)) continue;
          const label =
            `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.dataset ? el.dataset.mobileNav || '' : ''}`;
          if (!OPENER_LABEL.test(label)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 8 || rect.height < 8) continue;
          if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) continue;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.1) continue;
          return true;
        }
        return false;
      }

      /**
       * 把当前状态投影到 `<html>` 上。CSS 只认这些属性，所以这里是唯一的
       * 「状态 → 表现」转换点。
       * @param now - 本帧的 performance.now()。
       */
      function sync(now) {
        markStructure();
        markTopBar();
        const narrow = isNarrow();
        const collapsed = isCollapsed();
        // The native rightbar remains mounted and retains width while offscreen.
        // Only a visible in-viewport session dock should hide the floating dock.
        const rightOpen = narrow && [...document.querySelectorAll('[data-sidebar-right-session]')].some((side) => {
          const rect = side.getBoundingClientRect();
          const style = getComputedStyle(side);
          return rect.width > 8 && rect.height > 8 &&
            rect.right > 8 && rect.left < window.innerWidth - 8 &&
            style.display !== 'none' && style.visibility !== 'hidden' &&
            Number(style.opacity) >= 0.1 &&
            side.closest('[hidden],[aria-hidden="true"]') === null;
        });
        setRootAttr('data-dsh-ma-right-open', rightOpen ? '1' : null);

        setRootAttr('data-dsh-ma', VERSION);
        setRootAttr('data-dsh-ma-ios', IS_IOS ? '1' : null);
        setRootAttr('data-dsh-ma-open', narrow && !collapsed ? '1' : null);
        setRootAttr('data-dsh-ma-collapsed', narrow && collapsed ? '1' : null);
        // 抽屉里有宿主浮层（添加工作区面板 / 行内菜单）时让出包含块，见 CSS。
        const drawerOverlay = drawer !== null && drawer.querySelector(OVERLAY_SEL) !== null;
        setRootAttr('data-dsh-ma-overlay', drawerOverlay ? '1' : null);
        syncDualDock(narrow, collapsed);

        // ── 焦点状态：现算，不靠事件推断 ──────────────────────────────────
        // v0.0.3 的 bug：焦点属性是用一对 focusin/focusout 监听写的，而捕获阶段的
        // onFocusIn（抑制用）会先 blur()，同一个 focusin 事件随后又被冒泡阶段的
        // 监听器把属性设回 '1'——于是属性永久停在「已聚焦」，而
        // document.activeElement 其实是 BODY（实测 focusedAttr=1 / activeTag=BODY）。
        // 后果是进会话后输入卡片再也不折叠。现在直接问 DOM「焦点到底在谁身上」，
        // 任何路径（程序化聚焦、被 blur、元素被换掉）都会自愈。
        const active = document.activeElement;
        const composerFocused =
          active !== null &&
          typeof active.closest === 'function' &&
          active.closest(COMPOSER_INPUT_SEL) !== null;
        setRootAttr(FOCUSED_ATTR, composerFocused ? '1' : null);

        // ── 有没有对话 ────────────────────────────────────────────────────
        // 空对话页（hero）不参与折叠/透明化/顶部梯度：没有内容可看，压扁只是显空。
        const card = document.querySelector(COMPOSER_CARD_SEL);
        const hasThread = card !== null && card.closest(HERO_SEL) === null;
        setRootAttr(THREAD_ATTR, hasThread ? '1' : null);

        markBottomTarget();
        syncHeaderPad(composerFocused);
        syncBarColors(now);
        syncBackEntry();

        // 只在「窄屏 + 已折叠」时才需要知道有没有别的入口；其余状态下按钮反正不显示。
        if (narrow && collapsed) {
          if (now - lastOpenerScan > OPENER_SCAN_MS) {
            lastOpenerScan = now;
            solo = !otherOpenerVisible();
          }
        } else {
          solo = false;
        }
        setRootAttr('data-dsh-ma-solo', narrow && collapsed && solo ? '1' : null);

        // 抑制窗口内的 focus 影子：跟着时间走，保证一定会被撤掉。
        if (now < suppressUntil) shadowComposerFocus(true);
        else shadowComposerFocus(false);
      }

      /** 把一串 mutation 合成一帧：流式输出时 DOM 每秒变几十次，不能每次都全量同步。 */
      function schedule() {
        if (raf !== 0) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          sync(performance.now());
        });
      }

      // ── 打开 / 收起 ─────────────────────────────────────────────────────

      /**
       * 展开抽屉。走宿主的 layout store（ctx.layout.toggleSidebar）而不是自己改
       * DOM——窄屏下它翻的是 `narrowExpanded`，宿主随后自己重渲染，两边状态一致。
       * 收起动画结束前再同步一次，避免属性落后于宿主。
       */
      function open() {
        if (!isNarrow() || !isCollapsed()) return;
        ctx.layout.toggleSidebar();
        schedule();
        window.setTimeout(schedule, 80);
      }

      /** 收起抽屉。已经是收起的就什么都不做（点会话行 + store 订阅会各调一次）。 */
      function close() {
        if (!isNarrow() || isCollapsed()) return;
        ctx.layout.toggleSidebar();
        schedule();
        window.setTimeout(schedule, 80);
      }

      // ── 需求 3：切换会话不抢焦点 ────────────────────────────────────────

      /**
       * 给输入框装/撤一个 own 的 no-op `focus`，把宿主那次程序化聚焦吞掉。
       *
       * 为什么不是「聚焦后再 blur」：blur 会让 caret 闪一下，而且宿主 Lexical
       * 内部仍以为自己是聚焦的。影子法从根上不让这次 focus 发生。
       * 为什么不会挡住用户自己点输入框：原生 tap 走的是浏览器自己的聚焦，
       * 不经过 `element.focus()`；而且用户 pointerdown 到输入区时我们立刻撤影子
       * （见 onPointerDown）。
       * @param on - true 装影子，false 撤影子。
       */
      function shadowComposerFocus(on) {
        if (on) {
          if (shadowed !== null && shadowed.isConnected) return;
          shadowComposerFocus(false);
          const el = document.querySelector(COMPOSER_INPUT_SEL);
          if (el === null) return;
          shadowed = el;
          shadowedOriginal = el.focus;
          el.setAttribute(SHADOW_FLAG, '');
          Object.defineProperty(el, 'focus', {
            configurable: true,
            writable: true,
            value: function dshmaSwallowedFocus() {
              /* 需求 3：切换会话后的那次程序化聚焦，故意不执行。 */
            },
          });
          return;
        }
        if (shadowed === null) return;
        const el = shadowed;
        shadowed = null;
        if (el.hasAttribute(SHADOW_FLAG)) el.removeAttribute(SHADOW_FLAG);
        try {
          delete el.focus;
        } catch (error) {
          el.focus = shadowedOriginal;
        }
        shadowedOriginal = null;
      }

      /**
       * 武装抑制窗口：从现在起 SUPPRESS_FOCUS_MS 内，输入框不接受程序化聚焦。
       * 立刻装影子（同步），并挂一个兜底定时器——只靠 rAF 同步的话，窗口结束后
       * 若页面再无 mutation，影子会一直留着，输入框就再也聚焦不了。
       */
      function armSuppression() {
        suppressUntil = performance.now() + SUPPRESS_FOCUS_MS;
        shadowComposerFocus(true);
        window.clearTimeout(shadowTimer);
        shadowTimer = window.setTimeout(() => {
          shadowTimer = 0;
          shadowComposerFocus(false);
          schedule();
        }, SUPPRESS_FOCUS_MS + 60);
      }

      // ── 侧栏按钮：可拖动 + 自动贴边 ─────────────────────────────────────

      /** 安全区内边距（px）。CSS 的 env() 只有 CSS 读得到，JS 用探针元素问一次。 */
      function safeInsets() {
        const cs = getComputedStyle(safeProbe);
        return {
          top: parseFloat(cs.paddingTop) || 0,
          right: parseFloat(cs.paddingRight) || 0,
          bottom: parseFloat(cs.paddingBottom) || 0,
          left: parseFloat(cs.paddingLeft) || 0,
        };
      }

      /** 把停靠位置写进按钮内联样式（left/right 二选一，top 永远写）。 */
      function applyOpenerPos() {
        const insets = safeInsets();
        const minY = insets.top + OPENER_EDGE_GAP;
        const maxY = Math.max(minY, window.innerHeight - insets.bottom - OPENER_EDGE_GAP - OPENER_SIZE);
        openerY = Math.min(Math.max(openerY, minY), maxY);
        opener.style.top = `${Math.round(openerY)}px`;
        if (openerSide === 'right') {
          opener.style.right = `${insets.right + OPENER_EDGE_GAP}px`;
          opener.style.left = 'auto';
        } else {
          opener.style.left = `${insets.left + OPENER_EDGE_GAP}px`;
          opener.style.right = 'auto';
        }
        opener.setAttribute('data-side', openerSide);
      }

      /** 读一次持久化的停靠偏好；读不到就用左上角默认值。 */
      function loadOpenerPos() {
        try {
          const raw = window.localStorage.getItem(OPENER_KEY);
          if (raw === null) return;
          const saved = JSON.parse(raw);
          if (saved === null || typeof saved !== 'object') return;
          if (saved.side === 'left' || saved.side === 'right') openerSide = saved.side;
          if (typeof saved.y === 'number' && Number.isFinite(saved.y)) openerY = saved.y;
        } catch (error) {
          /* 隐私模式 / storage 被禁：用默认值，不影响其它功能。 */
        }
      }

      function saveOpenerPos() {
        try {
          window.localStorage.setItem(OPENER_KEY, JSON.stringify({ side: openerSide, y: Math.round(openerY) }));
        } catch (error) {
          /* 存不下就算了，这一轮仍然能用，只是下次打开回到默认位置。 */
        }
      }

      /**
       * 拖动开始：记下指针相对按钮左上角的偏移，之后按钮跟着手指走而不是跳到指尖。
       *
       * `setPointerCapture` 让 pointermove/pointerup 始终落在按钮上——手指滑出按钮
       * 范围（这是拖动时的常态）也不会丢事件。
       * @param event - pointerdown 事件。
       */
      function onOpenerPointerDown(event) {
        if (drag !== null) return;
        const rect = opener.getBoundingClientRect();
        drag = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          offsetX: event.clientX - rect.left,
          offsetY: event.clientY - rect.top,
          moved: false,
        };
        if (typeof opener.setPointerCapture === 'function') {
          try {
            opener.setPointerCapture(event.pointerId);
          } catch (error) {
            /* 老 WebView 没有 capture：下面的 window 级监听兜底。 */
          }
        }
      }

      /**
       * 拖动中：跟手移动。位移超过 `DRAG_SLOP_PX` 才算拖动——在那之前它仍然是一次
       * 普通点按（交给 click → open()），这样「点一下打开」的手感不会被拖动逻辑吃掉。
       * @param event - pointermove 事件。
       */
      function onOpenerPointerMove(event) {
        if (drag === null || event.pointerId !== drag.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.abs(dx) < DRAG_SLOP_PX && Math.abs(dy) < DRAG_SLOP_PX) return;
        drag.moved = true;
        opener.setAttribute('data-dragging', '');
        const insets = safeInsets();
        const maxLeft = Math.max(insets.left, window.innerWidth - OPENER_SIZE - insets.right);
        const maxTop = Math.max(insets.top, window.innerHeight - OPENER_SIZE - insets.bottom);
        opener.style.left = `${Math.round(Math.min(Math.max(event.clientX - drag.offsetX, insets.left), maxLeft))}px`;
        opener.style.right = 'auto';
        opener.style.top = `${Math.round(Math.min(Math.max(event.clientY - drag.offsetY, insets.top), maxTop))}px`;
        event.preventDefault();
      }

      /**
       * 拖动结束：按按钮**中心**离屏幕中线的远近视左右吸附，然后记住位置。
       *
       * 用中心而不是指尖：手指会挡住按钮，按指尖判侧会让人「明明放在右边却贴到了左边」。
       * 没超过位移阈值就不是拖动，交给 click 处理。
       * @param event - pointerup / pointercancel 事件。
       */
      function onOpenerPointerUp(event) {
        if (drag === null || (event.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
        const moved = drag.moved;
        drag = null;
        opener.removeAttribute('data-dragging');
        if (typeof opener.releasePointerCapture === 'function') {
          try {
            opener.releasePointerCapture(event.pointerId);
          } catch (error) {
            /* 没有 capture 过：忽略。 */
          }
        }
        if (!moved) return;
        const rect = opener.getBoundingClientRect();
        openerSide = rect.left + rect.width / 2 < window.innerWidth / 2 ? 'left' : 'right';
        openerY = rect.top;
        applyOpenerPos();
        saveOpenerPos();
        // 拖完浏览器仍会补一次 click，必须吞掉，否则会顺手把抽屉打开。
        swallowOpenerClick = true;
        window.setTimeout(() => {
          swallowOpenerClick = false;
        }, 0);
      }

      // ── 系统返回（手机返回键 / 返回手势）─────────────────────────────────
      //
      // 语义按手机习惯排优先级：先关面板/右栏，再关抽屉，会话页上返回则**唤出侧边
      // 对话列表**（用户需求）。为此需要在窄屏时始终压一条 history 条目，否则第一次
      // 返回会直接把页面退出去。
      //
      // ⚠ 与其他插件共享 history：本插件只在自己 armed 且命中已知状态时才消费；
      // 其余 popstate 一律不处理（参考 dsh-web-mobile 的 panel-exit.ts 同款约定）。

      /** 面板是否占着主区（宿主把选中的面板行标成 aria-current="page"）。 */
      function panelOwnsMain() {
        try {
          return document.querySelector(PANEL_ROW_ACTIVE_SEL) !== null;
        } catch (error) {
          return false;
        }
      }

      /**
       * 右侧栏/文件面板是否真的开着。
       *
       * ⚠ 窄屏下它**不是**「右侧那一列变宽」：实测点「打开右侧边栏」后
       * `[data-dsh-ma-rightbar]` 的宽度始终是 0，而宿主把面板铺成**全屏**的
       * `[data-dockkit-pane]`（390×844，x 从 390 挪到 0）。第一版只看右列宽度，
       * 于是这个判据永远不成立 —— 系统返回全都落到「开抽屉」分支，用户看到的就是
       * 「打开右侧文件后返回不回会话、再返回才动」。
       *
       * 现在两条判据都认：右列有宽度，或者 dockkit pane 真的**与视口相交**（pane 元素
       * 一直在 DOM 里，关闭态停在 x=390 的视口外，所以必须看位置而不是「是否存在」）。
       */
      function rightbarOccupied() {
        const bar = document.querySelector('[data-dsh-ma-rightbar]');
        if (bar !== null && bar.getBoundingClientRect().width > 8) return true;
        for (const sel of ['[data-dockkit-pane]', '[data-dockkit-host]']) {
          for (const el of document.querySelectorAll(sel)) {
            const rect = el.getBoundingClientRect();
            if (rect.width < 8 || rect.height < 8) continue;
            if (rect.right <= 8 || rect.left >= window.innerWidth - 8) continue;  // 视口外
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.1) continue;
            return true;
          }
        }
        return false;
      }

      /**
       * 找右侧面板自带的「收起」按钮。
       *
       * 为什么必须走宿主自己的按钮而不是 `ctx.layout.closeRightbar()`：
       * `dsh-client-ui-sidebar-right` 里是 `syncPresentation({shown}) → shown ? openRightbar :
       * closeRightbar`——**是否显示由它自己的 controller 决定**。窄屏下全屏面板正是这个
       * controller 推出来的，所以直接调 `closeRightbar()` 只释放了 track，controller 下一帧
       * 又把面板推回来（实测：返回后 pane 仍在 [0,0,390,844]）。面板里那个
       * `aria-label="收起右侧边栏"` 按钮走的才是真正隐藏它的路径。
       *
       * @returns 找到的按钮，找不到返回 null。
       */
      function findRightbarCloser() {
        const panes = [...document.querySelectorAll('[data-dockkit-pane],[data-dockkit-host]')];
        const scope = panes.length === 0 ? [document] : panes;
        for (const root of scope) {
          for (const el of root.querySelectorAll('button,[role="button"]')) {
            const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`;
            if (!/收起.*右侧|关闭.*右侧|close.*right|collapse.*right/i.test(label)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 8 || rect.height < 8) continue;
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.1) continue;
            return el;
          }
        }
        return null;
      }

      /** 退出面板/右栏：优先 selectPanel(null)，否则走宿主自己的收起按钮。 */
      function exitPanelOrRightbar() {
        if (panelOwnsMain() && typeof ctx.layout.selectPanel === 'function') {
          try {
            ctx.layout.selectPanel(null);
            return true;
          } catch (error) {
            /* 宿主在 selectPanel 之前会校验面板注册表；抛错就退回关右栏。 */
          }
        }
        if (rightbarOccupied()) {
          const closer = findRightbarCloser();
          if (closer !== null) {
            closer.click();
            return true;
          }
          if (typeof ctx.layout.closeRightbar === 'function') {
            try {
              ctx.layout.closeRightbar();
              return true;
            } catch (error) {
              /* 关不掉就算了：返回这次不消费，交给浏览器。 */
            }
          }
        }
        return false;
      }

      function clearBackEcho() {
        backEcho = false;
        window.clearTimeout(backEchoTimer);
        backEchoTimer = 0;
      }

      /** 我们自己退掉那条 history：设回声标记，免得把自己的 popstate 当成用户返回。 */
      function releaseBackEntry() {
        if (!backArmed) return;
        backArmed = false;
        setRootAttr('data-dsh-ma-back', 'released');
        backEcho = true;
        window.clearTimeout(backEchoTimer);
        backEchoTimer = window.setTimeout(clearBackEcho, 1200);
        try {
          window.history.back();
        } catch (error) {
          clearBackEcho();
        }
      }

      function armBackEntry() {
        if (backArmed) return;
        try {
          // 第二个参数为空串：压一条可被消费、但不改动 URL 的条目。
          window.history.pushState({ dshMobileBack: true }, '');
          backArmed = true;
          setRootAttr('data-dsh-ma-back', 'armed');
        } catch (error) {
          // 沙箱 iframe 会拒绝 pushState：那就放弃这条返回路径，别把返回键弄坏。
          backArmed = false;
          setRootAttr('data-dsh-ma-back', 'push-failed');
        }
      }

      /**
       * 系统返回的落点。抽屉开着就关抽屉（并解除武装，让下一次返回能退出应用）；
       * 否则在会话页唤出侧边对话列表。
       */
      function onPopState() {
        if (backEcho) {
          clearBackEcho();
          return;
        }
        if (!backArmed) return;
        if (!isNarrow()) return;
        // ⚠ 本次 popstate 已经**消费掉我们压的那一条**了，所以这里只是把标志位落下，
        // 绝不能再调 releaseBackEntry()（它内部会 history.back()，等于替用户多退一次，
        // 实测会直接把应用退掉——页面整个消失）。要主动撤条目只在「我们自己想撤」时用：
        // 离开窄屏、以及热重载的 disposer。
        backArmed = false;
        if (exitPanelOrRightbar()) {
          armBackEntry();
          schedule();
          return;
        }
        if (!isCollapsed()) {
          // 关掉抽屉，并且**不再武装**：下一步返回应该退出应用，而不是把抽屉再唤出来。
          close();
          schedule();
          return;
        }
        // 会话页上返回 → 唤出侧边对话列表，并继续武装（抽屉开着时返回要能关它）。
        open();
        armBackEntry();
        schedule();
      }

      /**
       * 窄屏时保持一条可消费的 history 条目；离开窄屏（桌面/平板）就撤掉。
       *
       * ⚠ 必须等 `frame` 真的存在（应用已挂载）才压。本机是走
       * `/dsh-login` → 303 → `/?token=…` 这条引导链进来的，在引导页上压的条目会被
       * 随后的跳转一起冲掉——实测症状是「DOM 上 `data-dsh-ma-back=armed`，但
       * `history.length` 没涨」，于是系统返回直接退出应用。引导页上没有 `_frame`，
       * 所以拿 `frame !== null` 当「应用已就绪」的判据。
       */
      function syncBackEntry() {
        if (!isNarrow() || frame === null || !appSettled(performance.now())) {
          releaseBackEntry();
          setRootAttr('data-dsh-ma-back', !isNarrow() ? 'wide' : frame === null ? 'booting' : 'settling');
          return;
        }
        armBackEntry();
      }

      /**
       * 应用是否已经「稳定下来」，可以安全地压 history 条目了。
       *
       * 本机是走 `/dsh-login` → 303 → `/?token=…` 这条引导链进来的。如果在引导页上
       * 就压条目，那条会被随后的跳转一起冲掉——症状是 DOM 上 `data-dsh-ma-back=armed`
       * 而 `history.length` 没涨，于是系统返回直接退出应用（竞态：压得早/晚结果不同）。
       *
       * 三道闸门一起用：
       *   · `readyState === 'complete'`：文档加载完；
       *   · 距本模块挂载超过 `BACK_SETTLE_MS`：303 通常在几百毫秒内完成；
       *   · 不在 `/dsh-login` 引导路由上：这个前缀由 dsh-web-login 占着，它一定会跳转。
       * @param now - 本帧的 performance.now()。
       */
      function appSettled(now) {
        return (
          document.readyState === 'complete' &&
          now - installedAt > BACK_SETTLE_MS &&
          !location.pathname.startsWith('/dsh-login')
        );
      }

      // ── 元素：入口按钮 + 遮罩 ───────────────────────────────────────────

      const opener = document.createElement('button');
      opener.type = 'button';
      opener.className = 'dshma_opener';
      opener.setAttribute('data-dsh-ma-opener', '');
      opener.setAttribute('aria-label', '打开侧边栏');
      opener.title = '打开侧边栏';
      opener.innerHTML = PANEL_LEFT_ICON;
      opener.addEventListener('pointerdown', onOpenerPointerDown);
      opener.addEventListener('pointermove', onOpenerPointerMove);
      opener.addEventListener('pointerup', onOpenerPointerUp);
      opener.addEventListener('pointercancel', onOpenerPointerUp);
      opener.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        // 拖动结束浏览器仍会补一次 click；这一次要吞掉，否则会顺手把抽屉打开。
        if (swallowOpenerClick) return;
        open();
      });

      const scrim = document.createElement('div');
      scrim.className = 'dshma_scrim';
      scrim.setAttribute('data-dsh-ma-scrim', '');
      scrim.addEventListener('click', () => {
        close();
      });

      // 上一次热重载留下的元素先清掉：`apply` 可能在没有先跑 disposer 的情况下
      // 再执行一次，不清就会累积出第二个按钮/遮罩。
      for (const stale of document.querySelectorAll('[data-dsh-ma-opener],[data-dsh-ma-scrim]')) stale.remove();

      document.body.appendChild(scrim);
      document.body.appendChild(opener);

      // 安全区探针 + 停靠位置：先读持久化偏好，再摆好。
      safeProbe.setAttribute('data-dsh-ma-safe-probe', '');
      safeProbe.style.cssText =
        'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
        'padding-top:env(safe-area-inset-top,0px);padding-right:env(safe-area-inset-right,0px);' +
        'padding-bottom:env(safe-area-inset-bottom,0px);padding-left:env(safe-area-inset-left,0px);';
      document.body.appendChild(safeProbe);
      loadOpenerPos();
      applyOpenerPos();

      // ── 2 mobile floating launchers, sharing the existing drawer state ──
      // No DS Bot internals or private session files are modified. Surface
      // changes go through DS Bot's own menu/button React handlers.
      let dualSwitchProtectUntil = 0;
      let dualDockDisposed = false;
      let dualSwitchSerial = 0;
      let dualDrag = null;
      let dualIgnoreClickUntil = 0;
      let dualSide = openerSide;
      let dualY = 72;
      const DUAL_POS_KEY = NS + ':dual-dock';
      const dualDock = document.createElement('div');
      dualDock.className = 'dshma_dual-dock';
      dualDock.setAttribute('data-dsh-ma-dual-dock', '');
      dualDock.setAttribute('role', 'group');
      dualDock.setAttribute('aria-label', '移动端会话与 Bots 导航');
      const dualButtons = {};
      const makeDualButton = (mode, label, icon) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dshma_dual-button';
        btn.dataset.dshMaTarget = mode;
        btn.setAttribute('aria-label', mode === 'agent' ? '打开会话列表' : '打开 DS Bots 列表');
        btn.setAttribute('aria-pressed', 'false');
        btn.title = label;
        btn.innerHTML = icon + '<span>' + label + '</span>';
        btn.addEventListener('pointerdown', onDualPointerDown);
        btn.addEventListener('pointermove', onDualPointerMove);
        btn.addEventListener('pointerup', onDualPointerUp);
        btn.addEventListener('pointercancel', onDualPointerUp);
        btn.addEventListener('click', onDualClick);
        dualDock.appendChild(btn);
        dualButtons[mode] = btn;
      };
      const sessionsIcon = '<svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linejoin="round"><rect x="2" y="3" width="16" height="14" rx="3"/><path d="M7 3v14M10 7h5M10 11h4"/></svg>';
      const botsIcon = '<svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round"><rect x="3" y="5" width="14" height="11" rx="3"/><path d="M10 2v3M7 10h.1M13 10h.1M7 13h6M1.5 9v3M18.5 9v3"/></svg>';
      makeDualButton('agent', '会话', sessionsIcon);
      makeDualButton('bot', 'Bots', botsIcon);
      for (const stale of document.querySelectorAll('[data-dsh-ma-dual-dock]')) stale.remove();
      document.body.appendChild(dualDock);
      try {
        // Keep the original single-button docking preference untouched.
        const saved = JSON.parse(localStorage.getItem(DUAL_POS_KEY) || 'null');
        if (saved && (saved.side === 'left' || saved.side === 'right')) dualSide = saved.side;
        if (saved && typeof saved.y === 'number' && Number.isFinite(saved.y)) dualY = saved.y;
      } catch (error) {
        // Storage may be disabled in private browsing mode.
      }
      function alignDualDock() {
        const insets = safeInsets();
        const minY = insets.top + OPENER_EDGE_GAP;
        const maxY = Math.max(minY, window.innerHeight - insets.bottom - OPENER_EDGE_GAP - 80);
        dualY = Math.min(Math.max(dualY, minY), maxY);
        let left = dualSide === 'right'
          ? window.innerWidth - insets.right - OPENER_EDGE_GAP - 68
          : insets.left + OPENER_EDGE_GAP;
        // When sessions are shown, move the dock outside the drawer's text
        // column so the two buttons never obscure its first rows.
        if (!isCollapsed() && dualSide === 'left' && drawer !== null) {
          left = Math.max(left, drawer.getBoundingClientRect().width + 6);
        }
        left = Math.max(insets.left, Math.min(left, window.innerWidth - insets.right - 68));
        if (dualDock.style.left !== Math.round(left) + 'px') dualDock.style.left = Math.round(left) + 'px';
        if (dualDock.style.top !== Math.round(dualY) + 'px') dualDock.style.top = Math.round(dualY) + 'px';
        if (dualDock.getAttribute('data-side') !== dualSide) dualDock.setAttribute('data-side', dualSide);
      }
      function botMode() {
        try { return localStorage.getItem('ds-bot:surface') === 'agent' ? 'agent' : 'bot'; }
        catch (error) { return document.querySelector('button.bt-return') ? 'agent' : 'bot'; }
      }
      function hasBotUi() {
        return document.querySelector('.bt-side,button.bt-return,button.bt-account') !== null;
      }
      function syncDualDock(narrow, collapsed) {
        const enabled = narrow && hasBotUi();
        setRootAttr('data-dsh-ma-dual', enabled ? '1' : null);
        if (!enabled) return;
        const active = botMode();
        for (const [mode, btn] of Object.entries(dualButtons)) {
          const next = String(mode === active);
          if (btn.getAttribute('aria-pressed') !== next) btn.setAttribute('aria-pressed', next);
          const expanded = mode === active && !collapsed ? 'true' : 'false';
          if (btn.getAttribute('aria-expanded') !== expanded) btn.setAttribute('aria-expanded', expanded);
        }
        alignDualDock();
      }
      function saveDualPosition() {
        try { localStorage.setItem(DUAL_POS_KEY, JSON.stringify({ side: dualSide, y: Math.round(dualY) })); }
        catch (error) { /* Navigation still works without persistent storage. */ }
      }
      function onDualPointerDown(event) {
        if (dualDrag !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
        const box = dualDock.getBoundingClientRect();
        dualDrag = { id: event.pointerId, button: event.currentTarget, x: event.clientX, y: event.clientY,
          dx: event.clientX - box.left, dy: event.clientY - box.top, moved: false };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch (error) {}
      }
      function onDualPointerMove(event) {
        if (dualDrag === null || event.pointerId !== dualDrag.id) return;
        const diffX = event.clientX - dualDrag.x;
        const diffY = event.clientY - dualDrag.y;
        if (!dualDrag.moved && Math.abs(diffX) < DRAG_SLOP_PX && Math.abs(diffY) < DRAG_SLOP_PX) return;
        dualDrag.moved = true;
        dualDock.setAttribute('data-dragging', '');
        const safe = safeInsets();
        const x = Math.max(safe.left, Math.min(event.clientX - dualDrag.dx, window.innerWidth - safe.right - 68));
        const y = Math.max(safe.top, Math.min(event.clientY - dualDrag.dy, window.innerHeight - safe.bottom - 80));
        dualDock.style.left = Math.round(x) + 'px';
        dualDock.style.top = Math.round(y) + 'px';
        event.preventDefault();
      }
      function onDualPointerUp(event) {
        if (dualDrag === null || (event.pointerId !== undefined && event.pointerId !== dualDrag.id)) return;
        const dragged = dualDrag.moved;
        const capturer = dualDrag.button;
        dualDrag = null;
        dualDock.removeAttribute('data-dragging');
        try { capturer.releasePointerCapture(event.pointerId); } catch (error) {}
        if (!dragged) return;
        const rect = dualDock.getBoundingClientRect();
        dualSide = rect.left + rect.width / 2 < window.innerWidth / 2 ? 'left' : 'right';
        dualY = rect.top;
        alignDualDock();
        saveDualPosition();
        dualIgnoreClickUntil = performance.now() + 500;
      }
      function onDualClick(event) {
        event.preventDefault();
        event.stopPropagation();
        if (performance.now() < dualIgnoreClickUntil || !isNarrow()) return;
        const mode = event.currentTarget.dataset.dshMaTarget;
        void openDualDrawer(mode);
      }
      const pause = ms => new Promise(resolve => window.setTimeout(resolve, ms));
      async function openDualDrawer(mode) {
        if (mode !== 'agent' && mode !== 'bot') return;
        const serial = ++dualSwitchSerial;
        const was = botMode();
        const switching = was !== mode;
        if (switching && mode === 'agent') {
          const account = document.querySelector('button.bt-account');
          if (account === null) return console.warn('[dsh-mobile-adapt] DS Bot account button unavailable');
          account.click();
          let item = null;
          for (let attempt = 0; attempt < 12; attempt++) {
            if (dualDockDisposed || serial !== dualSwitchSerial) return;
            item = [...document.querySelectorAll('button[role=menuitem]')].find(button =>
              /切换经典 Agent 模式|Switch to classic Agent mode/i.test(button.textContent || ''));
            if (item !== undefined) break;
            await pause(45);
          }
          if (!item) return console.warn('[dsh-mobile-adapt] DS Bot mode menu unavailable');
          item.click();
        } else if (switching && mode === 'bot') {
          const back = document.querySelector('button.bt-return');
          if (back === null) return console.warn('[dsh-mobile-adapt] DS Bot return button unavailable');
          back.click();
        }
        if (switching) {
          let ready = false;
          for (let i = 0; i < 16; i++) {
            if (dualDockDisposed || serial !== dualSwitchSerial) return;
            if (botMode() === mode) { ready = true; break; }
            await pause(65);
          }
          if (!ready) return console.warn('[dsh-mobile-adapt] DS Bot did not confirm requested surface:', mode);
        }
        if (dualDockDisposed || serial !== dualSwitchSerial) return;
        dualSwitchProtectUntil = performance.now() + 1200;
        // Same button = toggle drawer; other button = switch list, keep/open drawer.
        if (isCollapsed()) open();
        else if (!switching) close();
        schedule();
        window.setTimeout(schedule, 100);
      }
      alignDualDock();

      // ── 需求 2：点会话行 / 会话变了 → 收起抽屉 ──────────────────────────

      /**
       * 记录按下点，并识别「用户自己要输入」。
       *
       * 三件事共用一次 pointerdown：
       *   - downAt 给 pointerup 做位移比较，把抽屉里的滚动/滑动和「点会话行」分开；
       *   - pressAt 给 click 做时长比较，把「长按（开 ⋯ 菜单）」和「点」分开；
       *   - 目标落在输入卡片里就说明是用户主动要输入，立刻撤掉 focus 影子、清掉
       *     抑制窗口——否则用户点了输入框却打不开键盘。
       * @param event - pointerdown 事件。
       */
      function onPointerDown(event) {
        const target = event.target;
        downAt = { x: event.clientX, y: event.clientY };
        pressAt = performance.now();
        if (!(target instanceof Element)) return;
        const inCard = target.closest(COMPOSER_CARD_SEL) !== null;
        // 「用户在下面那一片」= 输入卡片 **或** 会话区。两者都算明确的用户意图：
        // 立刻撤掉 focus 影子、清空抑制窗口，否则这一下聚焦仍会被需求 3 的机制吞掉
        // ——实测「点了输入区却没反应」就出在影子还挂着的时候。
        const inThread = center !== null && center.contains(target) && !inCard;
        if (inCard || inThread) {
          userIntentAt = performance.now();
          suppressUntil = 0;
          shadowComposerFocus(false);
        }
      }

      /**
       * 在输入卡片里「点一下」（非拖动、非长按、没点中按钮）就**显式**聚焦可编辑面。
       *
       * 为什么显式 `focus()` 而不只是撤掉抑制：可编辑面是 contenteditable，落点可能
       * 命中它内部的 `<p>`，也可能被宿主的装饰层盖住——实测折叠态下工具行就盖在可见
       * 带上（`elementFromPoint` 命中 `uV2eYG_row`）。浏览器自己的聚焦在这种落点下
       * 不一定发生，而 `focus()` 不看命中测试，只看元素本身。
       *
       * 四道闸门：不在输入卡片内 / 位移超过 `TAP_SLOP_PX`（那是滑动）/ 长按 /
       * 命中了 `button`/`[role="button"]`/`[role="menu"]`（那是点按钮，不是聚焦）。
       * @param event - pointerup 事件。
       * @param down - 对应的 pointerdown 起点（已被 onPointerUp 取走）。
       */
      function onCardTap(event, down) {
        if (down === null) return;
        if (Math.abs(event.clientX - down.x) > TAP_SLOP_PX) return;
        if (Math.abs(event.clientY - down.y) > TAP_SLOP_PX) return;
        if (performance.now() - pressAt > LONG_PRESS_MS) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const card = target.closest(COMPOSER_CARD_SEL);
        if (card === null) return;
        if (target.closest('button,[role="button"],[role="menu"],[role="option"]') !== null) return;
        if (document.querySelector('[role="menu"],[role="dialog"]') !== null) return;
        const editable = document.querySelector(COMPOSER_INPUT_SEL);
        if (editable === null) return;
        userIntentAt = performance.now();
        suppressUntil = 0;
        shadowComposerFocus(false);
        try {
          editable.focus({ preventScroll: true });
        } catch (error) {
          /* 元素被换掉/不可聚焦：下一帧 sync() 会纠正状态，不在这里抛。 */
        }
        schedule();
      }

      /**
       * 需求 2 的第一条路径：抽屉里点到**当前已选中**的会话行就收起。
       *
       * ⚠ 这里只处理「已选中」的行，未选中的行**绝不能**在 pointerup 里收起。
       *
       * 浏览器合成的 `click` 是在 `pointerup` **之后**才派发的（同一次触摸的
       * touchend → click 之间隔着至少一个任务）。如果在 pointerup 里先收起抽屉，
       * 本插件的 CSS 会当帧把抽屉设成 `pointer-events: none`（`pointer-events`
       * 没有 transition-delay，只有 transform/visibility 有），于是那次 click 的
       * 落点被改到抽屉外面，会话行自己的 `onClick: () => onOpen(node.id)` 根本
       * 不跑——表现就是「抽屉收起了、会话没切过去」。
       *
       * 本机 a2 宿主（`ISessions` 没有 `open`）上，`dsh-web-mobile` 恰恰是**故意**
       * 不在未选中行的 pointerup 里收起的（它把导航押在「行自己的 click 会派发」上，
       * 见其 `onDrawerPointerUp` / `armNav`）。所以这里多收一次，就是把别人赖以
       * 工作的那次 click 打掉。实测：干净点击 4/6 失败；只把抽屉钉成
       * `pointer-events:auto`（其余不动）后立刻 2/2 成功。
       *
       * 未选中行交给 `onRowClick`（click 之后才收）+ 下面的 store 订阅。
       *
       * 位移阈值把「点」和「滑」分开——抽屉里的会话列表是可以滚动的，滚动结束时
       * pointerup 也落在某一行上，不加阈值会变成「滚一下就收起」。
       * 点在行尾的 `⋯` 菜单（`_rowActions`）上不算导航，不收起。
       * @param event - pointerup 事件。
       */
      function onPointerUp(event) {
        const down = downAt;
        downAt = null;
        if (down === null) return;
        // 唤醒输入框优先判断：它与抽屉无关（侧边栏折叠时才是常态），所以放在窄屏/折叠
        // 两道闸门之前。
        onCardTap(event, down);
        if (!isNarrow() || isCollapsed()) return;
        if (Math.abs(event.clientX - down.x) > TAP_SLOP_PX) return;
        if (Math.abs(event.clientY - down.y) > TAP_SLOP_PX) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (drawer === null || !drawer.contains(target)) return;
        const row = target.closest(SESSION_ROW_SEL);
        if (row === null) return;
        if (target.closest(ROW_ACTIONS_SEL) !== null) return;
        // 未选中行会导航：收起必须等它的 click 派发完（onRowClick），这里不碰。
        if (row.getAttribute('aria-selected') !== 'true') return;
        close();
      }

      /**
       * 需求 2 的第二条路径：click 阶段收起抽屉。
       *
       * 放在 click 而不是 pointerup，是因为**只有 click 才证明这次触摸走完了浏览器
       * 的命中测试**：click 的 target 就是浏览器最终认定的落点。在这里收起，行的
       * `onClick` 已经/正在被派发（宿主 React 的委托监听挂在根容器上，行节点在收起
       * 后仍有 150ms 存活期——`SidebarRoot` 的 `settled` 才卸载列表），导航不受影响。
       * 用冒泡阶段：宿主行自己的 onClick 先跑，我们再收，顺序上最保守。
       *
       * 四道闸门，任何一条命中都不收：
       *   1. 长按抬手（`now - pressAt > LONG_PRESS_MS`）——那是 `dsh-web-mobile` 刚
       *      打开的 `⋯` 菜单，收了会把菜单一起带走。`detail === 0` 是键盘触发的
       *      click（没有对应的 pointerdown），不该被这条挡掉；
       *   2. 目标在 `_rowActions` 里——点的是行内动作按钮，不是导航；
       *   3. 屏幕上有 `[role="menu"]`——同上，菜单开着就不许收；
       *   4. 抽屉没开 / 不在窄屏——没得收。
       * @param event - click 事件。
       */
      function onRowClick(event) {
        if (!isNarrow() || isCollapsed()) return;
        if (event.detail !== 0 && performance.now() - pressAt > LONG_PRESS_MS) return;
        if (document.querySelector('[role="menu"]') !== null) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (drawer === null || !drawer.contains(target)) return;
        const sessionRow = target.closest(SESSION_ROW_SEL);
        const botRow = target.closest('[data-bot-id],[data-room-id],[data-agent-id]');
        if (sessionRow === null && botRow === null) return;
        if (target.closest(ROW_ACTIONS_SEL) !== null) return;
        // Ignore Bot settings/more buttons, pins, and group expanders.
        if (botRow !== null && target.closest('[aria-haspopup=menu],.bt-row-menu,.bt-row-more,.bt-agent-sub') !== null) return;
        // React's own row onClick has already fired at this phase. Do not hide
        // the drawer on pointerup: that would eat the synthesized touch click.
        close();
      }

      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('pointerup', onPointerUp, true);
      document.addEventListener('click', onRowClick, false);

      // ── 需求 3：把程序化聚焦挡在门外 ────────────────────────────────────

      /**
       * 兜底：影子只装在「装的那一刻存在的那个元素」上，而宿主换会话时可能把
       * 编辑面整个换掉，新元素没有影子。focusin 在捕获阶段就能看到这次聚焦，
       * 立刻 blur 掉。两条路一起用，才是「无论元素换不换都挡得住」。
       * @param event - focusin 事件。
       */
      function onFocusIn(event) {
        if (!isNarrow()) return;
        if (performance.now() > suppressUntil) return;
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (!target.matches(COMPOSER_INPUT_SEL)) return;
        if (performance.now() - userIntentAt < USER_INTENT_MS) return;
        target.blur();
      }

      document.addEventListener('focusin', onFocusIn, true);

      // 焦点一变就重算一次状态（属性本身在 sync() 里从 activeElement 现算）。
      // 不加这两个的话要等下一次 DOM mutation 或 2s 轮询才更新，输入卡片收起/展开
      // 会明显滞后于手指。
      const onFocusChange = () => schedule();
      document.addEventListener('focusin', onFocusChange, false);
      document.addEventListener('focusout', onFocusChange, false);

      // 系统返回键 / 返回手势（Android 硬件键、浏览器返回手势都走 popstate）
      window.addEventListener('popstate', onPopState);

      // 视口变了（旋屏、地址栏收起、窗口缩放）就把停靠位置重新夹回可视范围，
      // 否则旋转后按钮可能停在屏幕外、再也点不到。
      const onViewportResize = () => {
        applyOpenerPos();
        alignDualDock();
        schedule();
      };
      window.addEventListener('resize', onViewportResize);
      window.addEventListener('orientationchange', onViewportResize);

      // ── 需求 2 的第三条路径：会话真的换了就收起 ────────────────────────

      /**
       * 订阅会话列表。这是「导航确实发生了」最诚实的信号：它同时覆盖点会话行、
       * 点「新会话」、搜索跳转等所有路径。
       *
       * ⚠ 它**兜不住**「tap 的 click 被吞掉」——click 被吞就没有导航，`current`
       * 不变，订阅根本不会触发。（本文件早先的注释把这条写反了。）能兜住 click
       * 被吞的是「不要在那个时刻收起抽屉」：见 onPointerUp 里只处理已选中行的说明。
       *
       * 三条路径各管一段，不重叠：
       *   - 点**当前已选中**的行不会改 current，store 订阅收不到 → onPointerUp 兜；
       *   - 点**未选中**的行会导航，但收起不能早于它的 click → onRowClick 兜；
       *   - 「新会话 / 搜索跳转」这类不是会话行的入口 → 由本订阅兜（它们没有
       *     `_sessionRow` 祖先，前两条都看不见）。
       */
      const unsubscribe = ctx.sessions.list.subscribe(() => {
        const id = currentSessionId(ctx);
        if (id === lastSession) return;
        lastSession = id;
        if (!isNarrow()) return;
        // 同步武装抑制窗口：宿主的聚焦 effect 和这次通知之间没有可靠的先后关系，
        // 先挡住再说。
        armSuppression();
        // 改 layout store 会触发 React 更新，别在别人的订阅回调里同步改状态。
        window.setTimeout(() => {
          if (performance.now() >= dualSwitchProtectUntil) close();
        }, 0);
      });

      // ── 浮动卡片：窄屏默认关闭，只有显式开过才显示 ──────────────────────
      //
      // 偏好存在 localStorage 里，缺省（读不到 / 被禁用 / 不是 'on'）就是关闭。
      // 这里只把结论写到 <html> 上，具体隐藏交给上面那段 CSS——CSS 负责「窄屏才
      // 生效」，JS 负责「用户开过没有」，两边职责不重叠。
      let floatCardOn = false;
      try {
        floatCardOn = window.localStorage.getItem(FLOAT_CARD_KEY) === 'on';
      } catch (error) {
        // 隐私模式 / storage 被禁用：保持默认（关闭），不影响其它功能。
      }
      setRootAttr(FLOAT_CARD_ATTR, floatCardOn ? 'on' : null);

      // ── 观察者 ──────────────────────────────────────────────────────────

      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true });

      const onMediaChange = () => schedule();
      mq.addEventListener('change', onMediaChange);

      // 兜底轮询：空闲时没有 mutation，「别的入口」的结论与结构标记都需要一次
      // 机会刷新（例如另一个适配器在自己的一次重渲染里换了按钮）。
      const poll = window.setInterval(schedule, 2000);

      // 首次同步：包括页面刚打开时的自动聚焦（宿主在 mount 时也会抢一次焦点，
      // 手机上表现为「一进应用键盘就弹起来」）。
      armSuppression();
      sync(performance.now());

      // ── 拆除 ────────────────────────────────────────────────────────────

      return () => {
        observer.disconnect();
        mq.removeEventListener('change', onMediaChange);
        window.clearInterval(poll);
        window.clearTimeout(shadowTimer);
        if (raf !== 0) cancelAnimationFrame(raf);
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('pointerup', onPointerUp, true);
        document.removeEventListener('click', onRowClick, false);
        document.removeEventListener('focusin', onFocusIn, true);
        document.removeEventListener('focusin', onFocusChange, false);
        document.removeEventListener('focusout', onFocusChange, false);
        window.removeEventListener('popstate', onPopState);
        window.removeEventListener('resize', onViewportResize);
        window.removeEventListener('orientationchange', onViewportResize);
        window.clearTimeout(backEchoTimer);
        opener.removeEventListener('pointerdown', onOpenerPointerDown);
        opener.removeEventListener('pointermove', onOpenerPointerMove);
        opener.removeEventListener('pointerup', onOpenerPointerUp);
        opener.removeEventListener('pointercancel', onOpenerPointerUp);
        releaseBackEntry();
        safeProbe.remove();
        unsubscribe();
        shadowComposerFocus(false);
        scrim.remove();
        opener.remove();
        dualDockDisposed = true;
        dualSwitchSerial += 1;
        dualDock.remove();
        setRootAttr('data-dsh-ma-dual', null);
        setRootAttr('data-dsh-ma', null);
        setRootAttr('data-dsh-ma-right-open', null);
        setRootAttr('data-dsh-ma-ios', null);
        setRootAttr('data-dsh-ma-open', null);
        setRootAttr('data-dsh-ma-collapsed', null);
        setRootAttr('data-dsh-ma-solo', null);
        setRootAttr(FOCUSED_ATTR, null);
        setRootAttr(THREAD_ATTR, null);
        setRootAttr('data-dsh-ma-back', null);
        setRootAttr(FLOAT_CARD_ATTR, null);
        root.style.removeProperty('--dsh-ma-bar-top');
        root.style.removeProperty('--dsh-ma-bar-bot');
        root.style.removeProperty('--dsh-ma-header-pad');
        for (const stale of document.querySelectorAll(`[${TOPBAR_ATTR}],[${SCROLLER_ATTR}],[${DOCK_ATTR}],[${BOTTOM_ATTR}]`)) {
          stale.removeAttribute(TOPBAR_ATTR);
          stale.removeAttribute(SCROLLER_ATTR);
          stale.removeAttribute(DOCK_ATTR);
          stale.removeAttribute(BOTTOM_ATTR);
        }
        if (frame !== null) frame.removeAttribute('data-dsh-ma-frame');
        if (drawer !== null) drawer.removeAttribute('data-dsh-ma-drawer');
        if (center !== null) center.removeAttribute('data-dsh-ma-center');
        if (rightbar !== null) rightbar.removeAttribute('data-dsh-ma-rightbar');
      };
    }

    // ── 插件入口 ──────────────────────────────────────────────────────────

    /**
     * 依赖的客户端服务。两个都是宿主 UI 层自己提供的（`dsh-client-ui-layout`
     * 的 `layout`、会话列表的 `sessions`），本机已实装验证。
     *
     * ⚠ 这两个是**必需**注入：cordis 会等它们就绪才激活本行。宿主若哪天删掉
     * 其中任何一个，本行会停在 `pending`，而客户端的启动闸门
     * （`assertEntriesActive`）会把**整个** web UI 判为启动失败——本机
     * 2026-09-22 就因为 `dsh-remote-ssh` 等一个不存在的 `betterSidebar` 而整页白屏。
     * 所以下面所有对 ctx.sessions / ctx.layout 的用法都包在 try/catch 或形状判断里。
     */
    const inject = ['layout', 'sessions'];

    /**
     * 挂载客户端半。
     * @param ctx - 客户端插件上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ensureStyles(), `${NS}: stylesheet`);
      ctx.effect(() => installController(ctx), `${NS}: mobile drawer controller`);
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
