# dsh-mobile-adapt

移动端适配插件，v0.5.3。窄屏（`< 1024px`）下把 dsh web 调成手机上能用的样子。

| # | 需求 | 实现位置 |
|---|------|----------|
| 1 | 左侧栏折叠后**完全不占宽**；没有 DS Bot 时保留一个「打开侧边栏」按钮，有 DS Bot 时提供两个浮动入口 | `lib/client.js` 的 `CSS`（`grid-template-columns` 压成 `0` + 侧边栏列改绝对定位抽屉）+ `otherOpenerVisible()` |
| 2 | 点抽屉里的**会话卡片自动收起**抽屉，**并且真的切过去** | `onRowClick`（click 阶段收起，不早于行的 `onClick`）+ `onPointerUp`（只处理当前已选中行）+ `ctx.sessions.list.subscribe`（会话真的换了） |
| 3 | **切换对话后不自动聚焦输入框** | `armSuppression` / `shadowComposerFocus` / `onFocusIn` |
| 4 | **iOS 聚焦时不自动放大** | `CSS` 里可编辑面的 `font-size: max(16px, 1em)` |
| 5 | **Android/桌面端保持紧凑字号** | 非 iOS 下输入框使用 `font-size: inherit` |
| 6 | **有对话且未聚焦时**：底部整片 30% 透明（卡片 + token/步数条 + 任务/目标栏）+ **收起工具行**，对话区向下延伸 42px | `CSS` 3.6 段：`${COMPOSER_CARD_SEL} > ${TOOL_ROW_SEL}` 归零；渐隐目标是 JS 标记的 `[data-dsh-ma-bottom]`（composer seat），闸门是 `[data-dsh-ma-has-thread]:not([data-dsh-ma-composer-focused])` |
| 7 | **无焦点时顶部栏透明梯度**（上深下浅，底端 98% 透明） | `CSS` 3.8 段 + `markTopBar()` / `syncBarColors()`（颜色取自最近的不透明祖先，跟随明暗主题） |
| 8 | **模型名显示宽度上限**（116px，超出省略号，title/aria 保留全名） | `CSS` 3.7 段 `MODEL_CHIP_SEL` |
| 9 | **空对话页（hero）不参与 6/7/10/11** | `[data-dsh-ma-has-thread]` 由 `sync()` 现算：卡片祖先带 `_hero` 就没有对话 |
| 10 | **顶栏浮层化**，正文从它底下穿过 → 梯度才看得见 | `CSS` 3.9 段 `position: absolute` + `markTopBar()`/`markScroller()` |
| 11 | **打字时顶栏淡出 + 正文顶上 + 底部 token/步数统计条收起** | `CSS` 3.9 段 `[data-dsh-ma-composer-focused]` → `opacity: 0` / `padding-top: 0` / `[data-dsh-ma-dock]` 归零 |
| 12 | **侧栏按钮可拖动，松手自动贴左/右，位置持久化** | `onOpenerPointerDown/Move/Up` + `applyOpenerPos()` + `localStorage['dsh-mobile-adapt:opener']` |
| 13 | **系统返回（手机返回键/返回手势）**：右侧文件/侧边栏（窄屏是全屏 pane）打开 → 关掉回对话页；抽屉开着 → 关抽屉；对话页 → 唤出侧边对话列表 | `onPopState()` + `armBackEntry()`（`history.pushState`）+ `selectPanel(null)` / 面板自带的「收起右侧边栏」按钮 |
| 14 | **双浮动入口：会话 / Bots**，共用原生覆盖抽屉；模式切换、切换列表、拖拽贴边、位置持久化、单入口回退 | `[data-dsh-ma-dual-dock]`、`syncDualDock()`、`openDualDrawer()`，细节见 [DUAL-NAVIGATION.md](./DUAL-NAVIGATION.md) |

服务端半（`lib/index.js`）故意是空的：这些需求都是纯 DOM/CSS 行为，不需要宿主能力。
它存在的唯一理由是让这一行进插件树，从而让宿主发现 `lib/client.js`。

## 两条踩过的坑（v0.0.3 → v0.1.0 的全部改动都是修它们）

### 坑一：压扁卡片会把可编辑面 flex 成 0px，落点命中工具行 → 「点了唤不醒键盘」

v0.0.3 用 `height: 44px` 直接压 `[data-composer-card]`。实测（390×844）：

```
cardRect     [16, 770, 351, 44]     ← 我们强制的 44px
editableRect [16, 774, 347, 32]     ← 可编辑面自己的盒子还是 32px
children:  _scroll [16, 774, 347, 0]   ← 但它的滚动容器被 flex 压成 0px
           _row    [16, 786, 351, 42]  ← 42px 工具行溢出，盖在可见带上
elementFromPoint(40, 790) → uV2eYG_row   ← 命中工具行，不是可编辑面
```

宿主输入卡片是 `flex-direction: column`、`gap: 12px` 的列布局，硬压卡片高度会让内部
`_scroll` 塌成 0px、`_row` 溢出到可见区，**用户点的其实是工具行**。

**现在改成收起工具行本身**，卡片高度由内容自然回流，可编辑面永远在可见带内：

```css
[data-composer-card] > [class*="_row"] { min-height: 0; box-sizing: border-box;
                                        padding-top: 0; padding-bottom: 0;
                                        max-height: 0; opacity: 0; overflow: hidden; }
```

四处声明缺一不可（都是实测值）：`min-height: 0` 挡 flex item 的 `min-height: auto`；
`box-sizing: border-box` 让 `max-height` 约束到边框盒；`padding-*: 0` 干掉行自带的
`padding: 2px 8px 6px`（实测只从 42px 收到 8px 就是漏了这条）。聚焦分支不写 padding，
宿主自己的内边距在展开时原样回来。

另外 `onCardTap()` 在 pointerup 时对「卡片内的一次点按」显式 `editable.focus()`——
`focus()` 不看命中测试，只看元素本身，是这条链路上最后一道保险。

### 坑七：淡卡片 ≠ 淡底部（统计条在卡片外面）

第一版把 `opacity: .3` 写在 `[data-composer-card]` 上，实测卡片 0.3 而紧挨着它的
token/步数条 `uV2eYG_dock`（26px）是 **1.0** —— 它们俩的共同父级
`wSkVaW_composerSeat` 才是「底部这一片」。现在渐隐目标是 JS 标记的
`[data-dsh-ma-bottom]` = composer seat；目标栏用宿主稳定钩子 `[data-goal-bar]`
（`@deepseek-ai/dsh-client-ui-goal`），**只有在 seat 之外**时才单独再标记一个——
在里面的话父子 opacity 相乘会变成 0.09。

> 判据要跟着实现改：渐隐从卡片挪到父级之后，卡片自己的 `computed opacity` 恒为 1
> （由父级合成），探针断言也得改成看渐隐目标，否则会误报「没生效」。

### 坑八：窄屏的右侧面板是「全屏 pane」，右列宽度永远是 0

点「打开右侧边栏」后，`[data-dsh-ma-rightbar]` 的宽度**始终是 0**；宿主把面板铺成全屏的
`[data-dockkit-pane]`（390×844，x 从 390 挪到 0）。第一版只看右列宽度，于是判据永远不成立，
系统返回全都落到「开抽屉」分支。更麻烦的是**退出也不能靠 `ctx.layout.closeRightbar()`**：
`dsh-client-ui-sidebar-right` 里是 `syncPresentation({shown}) → shown ? openRightbar :
closeRightbar`，显示与否由它自己的 controller 决定，直接 `closeRightbar()` 只释放 track，
下一帧又被推回来。正确做法是点面板自带的 `aria-label="收起右侧边栏"` 按钮
（实测返回后面板回到 x=390 视口外，随后一次返回唤出侧边列表）。

### 坑五：popstate 里再调一次 `history.back()` = 替用户多退一次

需求 13 的第一版在「关掉抽屉」分支里调了 `releaseBackEntry()`，而那个函数的语义是
**主动撤掉我们压的那条条目**（内部 `history.back()`）。但用户按下返回的那一刻，我们压的
条目**已经被这次 popstate 消费掉了**，再退一次就是替用户多退一步——实测按一次返回，
应用整个消失（`[data-dsh-ma-frame]` 查不到了）。

分清两种情况：

- **被消费**（用户按返回）：只把 `backArmed` 落下，绝不再 `history.back()`；
- **主动撤**（离开窄屏、热重载 disposer）：才调 `releaseBackEntry()`。

### 坑六：引导链会吃掉早压的 history 条目

本机是走 `/dsh-login` → 303 → `/?token=…` 进来的。如果在引导页就压条目，那条会被跳转
一起冲掉，症状很隐蔽：DOM 上 `data-dsh-ma-back=armed`，而 `history.length` 没涨，
第一次按返回就直接退出应用；而且压得早/压得晚结果不同（竞态）。

现在三道闸门一起用：应用已挂载（`frame !== null`）+ `readyState === 'complete'` +
挂载后 1.5s 宽限期，且不在 `/dsh-login` 路径上。`data-dsh-ma-back` 属性就是给探针看
这三条走到哪个分支的（`armed` / `booting` / `settling` / `wide` / `push-failed`）。

> 排查时的一个教训：全新 profile 的 `history.length` 基线是 **2**（about:blank + 首次
> 导航），不是 3。我一度把「3」当成基线，差点把「已经压好了」误判成「没压上」。

### 坑三：把渐变画在「没有内容经过」的地方 = 视觉零变化

v0.1.0 给顶栏加了 `linear-gradient(页面底色 → 同色 2%)`，探针里 `backgroundImage` 确实
读到了，用户反馈却是「顶部好像没有应用透明」。原因是结构：实测头部是 390×78 的**独立
布局带**，正文滚动容器 `wSkVaW_scrollBody` 在它**下面**（78..844），内容永远不经过头部；
而渐变两端又都是页面底色 —— 白底上画白→白2%，等于什么都没画。

改成把头部从文档流里拿出来（`position: absolute`，它的外层是 `display: contents` 的空壳，
所以头部本身就是会话根的直接流子节点），正文顶到 0，内容才会从头部底下穿过。实测：

```
scroller [0, 0, 388, 844]  ← 原来 [0, 78, 388, 766]
overlapsHeader = true
```

未聚焦时给滚动容器 `padding-top: <实测顶栏高度>`（78px，**实测值不是写死**：头部会随
标题/芯片出现而在 40px `headerBlank` 与 78px 之间变），首条消息不会被压在栏下；聚焦时
这个留白归零，文字直接顶到屏幕最上沿。

### 坑四：塌陷统计条和塌陷工具行一样，四处声明缺一不可

底部 token/步数统计条（实测 `uV2eYG_dock` 351×26，文本「8 轮 147 步·175 tok/s /
28.3M tok·缓存命中 89%」）是 composer 卡片的兄弟节点。塌陷它需要
`min-height: 0` + `box-sizing: border-box` + `padding-top/bottom: 0` + `max-height: 0`，
与工具行同一套（见坑一）。聚焦 26px + 顶栏 78px = 打字时多出 **104px** 给对话文字。

### 坑二：焦点属性用事件推断会永久停在「已聚焦」

v0.0.3 用一对 `focusin`/`focusout` 监听维护 `data-dsh-ma-composer-focused`。但捕获阶段
的 `onFocusIn`（需求 3 的抑制）会先 `blur()`，**同一个 focusin 事件**随后又被冒泡阶段
的监听器把属性设回 `'1'`；而那次 blur 触发的 `focusout` 已经先跑完了，于是属性再也
不会清掉。实测进会话后：`focusedAttr=1` 而 `document.activeElement === BODY`。

后果：折叠/透明化在「进会话」这条最常用的路径上直接失效。

**现在 `sync()` 每帧从 `document.activeElement.closest('[data-composer-input]')` 现算**，
任何路径（程序化聚焦、被 blur、元素被换掉）都会自愈。`focusin`/`focusout` 只负责调
`schedule()`，不参与判定。

### 1. 折叠后完全不占宽

宿主 `dsh-client-ui-layout` 的算法是 `computeColumns()`：

```js
const s = sidebar === 0 ? 56 : clampWidth(sidebar, 264, 420);   // 折叠 = 56px rail
```

也就是**折叠后仍然留一条 56px 的轨道**。在 390px 宽的手机上那是 14% 的屏幕，
而且这条 rail 的内容（图标按钮）在这么窄的宽度里基本没法用。所以：

- `grid-template-columns: 0px minmax(0, 1fr) 0px !important`——轨道压到 0。
  必须 `!important`：宿主的 `grid-template-columns` 是 React 写的**内联样式**。
- 侧边栏列改成 `position: absolute` 的抽屉：展开时**盖在**中间列上（中间列始终
  满宽 390px），折叠时 `translateX(-100%)` 整体移出屏幕。
- **三条轨道必须显式指派**（`grid-column: 1/2/3`）。侧边栏列脱离 grid 流之后，
  宿主剩下的两个列会被自动排列塞进第 1、2 条轨道：中间列落进第 1 条（`0px`）、
  右侧栏占了第 2 条（`1fr`），**整个会话区变成 0 宽**、输入框只剩 22px。这个 bug
  在第一次验收里就被探针的 `centerCol.w` 抓到了，所以验收里专门留了一条
  `1-composer-has-room`。
- 抽屉宽度 `min(280px, 88vw)`——280 是宿主窄屏展开时给的偏好值。
- 抽屉模式下拖动把手没有意义，隐藏。

「只留一个打开侧边栏按钮」由 `data-dsh-ma-solo` 控制：只有在**没有别的可见入口**
时才渲染自己的按钮（见下面「与 dsh-web-mobile 共存」）。

### 2. 点会话卡片自动收起

三条路径，各管一段，**互不重叠**：

- **`onRowClick`（click 冒泡阶段）**：点会话行后收起。之所以在 `click` 而不是
  `pointerup`：浏览器合成的 `click` 在 `pointerup` **之后**才派发，同一次触摸的
  touchend → click 之间至少隔一个任务。在 `pointerup` 里先收起，本插件的 CSS 会当帧
  把抽屉设成 `pointer-events: none`（`pointer-events` 没有 transition-delay，只有
  transform/visibility 有），那次 click 的落点就被改到抽屉外面，会话行自己的
  `onClick: () => onOpen(node.id)` 根本不跑——表现就是**「抽屉收起了、会话没切过去」**。
  放在 click 里收，说明这次触摸已经走完浏览器的命中测试，行的 `onClick` 也已经在
  同一个派发里跑过了。四道闸门：长按抬手（> `LONG_PRESS_MS` 450ms）、目标在
  `[class*="_rowActions"]` 里、屏幕上有 `[role="menu"]`、抽屉没开/不在窄屏，任一命中都不收。
- **`onPointerUp`**：只处理**当前已选中**的行——点它不会导航，立刻收起是安全的。
  用 12px 位移阈值把「点」和「滑」分开（抽屉里的会话列表可以滚动，滚动结束时
  `pointerup` 也落在某一行上）；阈值取 12 是为了和 `dsh-web-mobile` 的
  `TAP_NAV_SLOP_PX` 对齐，同一个手势不能有两套判定。
- **`ctx.sessions.list.subscribe`**：当前会话 id 真的变了才收起。它覆盖点「新会话」、
  搜索跳转这类**不是会话行**的入口（它们没有 `_sessionRow` 祖先，前两条都看不见）。

⚠ 别指望 store 订阅能兜「`click` 被吞掉」：click 被吞就没有导航，`current` 不变，
订阅根本不会触发。本文件早先的版本把这条写反了（当时的说法是「它能覆盖 WebKit 把 tap
的 click 吞掉的情况」）。能兜住 click 被吞的，是**不要在那个时刻收起抽屉**。

> 本机 a2 宿主（`ISessions` 没有 `open`）上，`dsh-web-mobile` 恰恰是**故意**不在未选中行
> 的 `pointerup` 里收起的（它把导航押在「行自己的 click 会派发」上，见其
> `onDrawerPointerUp` / `armNav`）。所以这里的 pointerup 分支多收一次，就会把别人赖以
> 工作的那次 click 打掉。根因、时序证据与 A/B 对照见
> [`audit/mobile-tap-nav-analysis.md`](../../audit/mobile-tap-nav-analysis.md)。

### 3. 切换会话不抢焦点

宿主 `dsh-client-ui-conversation` 里有一段：

```js
useEffect(() => {
  if (locked || editor === null) return;
  editor.getRootElement()?.focus({ preventScroll: true });
  editor.focus(() => revealSelection());
}, [locked, sessionId, editor]);
```

`sessionId` 一变就抢焦点。手机上表现是：**切一个对话，键盘就弹起来**，挡住半个屏幕。

挡法有两层，因为编辑面元素可能在换会话时被整个替换：

1. `shadowComposerFocus()`：给 `[data-composer-input]` 装一个 own 的 no-op `focus`
   方法，从根上让那次程序化聚焦不发生（比「聚焦后再 blur」干净——blur 会让 caret
   闪一下，而且 Lexical 内部仍以为自己是聚焦的）。
2. `onFocusIn`（捕获阶段）：新元素没有影子，就在这次聚焦上立刻 `blur()`。

**不会挡住用户自己点输入框**：原生 tap 走浏览器自己的聚焦，不经过 `element.focus()`；
而且 `pointerdown` 落在输入卡片里时立刻撤影子、清窗口（`onPointerDown`）。

抑制窗口 1.5s，并且有个兜底定时器保证影子一定会被撤掉——只靠 rAF 同步的话，
窗口结束后若页面再无 mutation，影子会一直留着，输入框就再也聚焦不了。

页面刚打开时也走同一个机制（宿主 mount 时也会抢一次焦点，手机上表现为
「一进应用键盘就弹起来」）。

### 4. 输入不自动放大

iOS Safari 会在聚焦 `font-size < 16px` 的表单控件 / `contenteditable` 时把整页放大，
而且往往捏合缩不回来。宿主的输入卡片是：

```css
.uV2eYG_card  { font-size: var(--dsh-content-font-size, 14px); }
.uV2eYG_input { font-size: inherit; }
```

默认 14px，用户把「字号大小」调小更是必踩。所以给**可编辑面**加 16px 下限：

```css
font-size: max(16px, 1em) !important;
```

`1em` 取父级（卡片）字号，所以用户把字号调大时不会被压回去，只补下限。只改编辑面、
不改卡片本身，输入区的行高与留白保持宿主原样。

## 与 dsh-web-mobile 共存

> **2026-10-05 更新**：`dsh-web-mobile` 已从本机 `dsh.profile.bundles` 移除（外部改动，
> 非本插件所为），当前 `dsh --profile web --dump-config` 里已查不到它的 loader 行。
> 下文是它**曾经并存时**的实测记录，留作参考；现在 `mobile-composer.js`(19/19) 与
> `mobile-nav.js`(11/11) 都是在它缺席的情况下全绿的，本插件不依赖它。

本机 profile 里曾同时装着第三方插件 `dsh-web-mobile@3.0.0`。实测（390×844）它在
需求 1、2、4 上已经生效，需求 3 是真正的缺口。两个插件要的是**同一个结果**，
所以 CSS 不冲突（谁后注入谁赢，两边结果一致）——但「打开侧边栏」按钮会变成两个。

因此本插件只在**没有别的可见入口**时才渲染自己的按钮，判据必须比「标签里有侧边栏」
严得多：

```js
const OPENER_LABEL = /侧边栏|sidebar/i;
// 只认两类：明确声明自己是移动端导航控件的（data-mobile-nav），
//          以及宿主自己的 rail 按钮且真的可见。
```

**为什么不能只按标签认**：`dsh-better-sidebar` 在会话页右上角渲染了一个
`aria-label="展开侧边栏"` 的按钮（`nArs4W_toggleButton`），但它开的是它**自己的
右侧面板**（`togglePanel(store)`），跟宿主侧边栏列毫无关系。只按标签认就会把它算成
入口 → 我们把自己的按钮藏起来 → **宿主侧边栏一个入口都没有**（宿主自己的 rail 按钮
在折叠时是 `display:none`）。这个假阳性是实测抓出来的，不是假想。

同理也不能只认 `data-mobile-nav`：`dsh-web-mobile` 的 FAB（`data-mobile-nav="fab"`，
标签「打开目录」）也带这个属性，但它开的是目录。

判定时还要排除三类假阳性：在我们自己的抽屉里（折叠时它被平移出屏幕，但仍会返回
36×36 的矩形）、完全在视口外、不可见/透明/尺寸为 0。

于是「只留一个打开侧边栏按钮」这条不变式在任何组合下都成立：别的适配器在，就显示
它的；它不在，就显示我们的。**当前本机显示的是本插件的按钮**——因为
`dsh-web-mobile` 的 `MobileNavToggle` 只在会话页的 `conversation.session.header.actions`
里渲染，新会话（hero）页根本没有，而本插件的按钮两种页面都在。

不想共存就直接在 profile 的 patch 层关掉对方（一行，随时可撤）：

```yaml
- id: dsh-web-mobile
  disabled: true
```

## 安装与更新（热重载）

```bash
# 1) 源码在 workspace，profile 里只是软链；workspace 是唯一真源。
#    这一步把 dsh-mobile-adapt 写进 profile 的 dependencies（link:）。
tools/link-plugin.sh dsh-mobile-adapt web

# 2) 装进 bundle 栈——这就是它的挂载点，由本包自带的 cordis.patch.yml 提供：
#        - insert:
#            - id: mobile-adapt
#              name: dsh-mobile-adapt
dsh plugin --profile web add link:/home/ocean/Desktop/apps/DSH-Home/plugins/dsh-mobile-adapt
```

**挂载点只有一个，而且必须在 `dsh.profile.bundles` 里**，profile 的
`cordis.patch.yml` 里**不要**再 insert 一次。原因见下节。

改功能不需要重启、也不需要刷新页面：只有 `lib/client.js` 会被改，而它由
`dsh-client-hmr` 每 500ms 轮询 mtime+size，变了就重算 rev 经 `/plugins/events`
（SSE）推给浏览器热替换模块。实测：改 `lib/client.js` 后 **2 秒**页面里的
`document.documentElement.dataset.dshMa` 就变了，`<style>`/按钮/遮罩数量都保持 1。

```bash
# 本机已有的热重载探针
tools/hmr-reload-test.mjs <entry>              # 服务端半：apply → dispose → 重新 import → 再 apply
node tools/ui-probe.mjs --script tools/probes/mobile-flows.js      # 客户端半：全量验收（含「真的切过去了」）
node tools/ui-probe.mjs --script tools/probes/mobile-tap-nav.js    # 点行导航：A/B 对照 + 漂移 + 长按
node tools/ui-probe.mjs --script tools/probes/mobile-tap-timing.js # 逐毫秒时序（window vs document 捕获）
```

> 需求 2 的验收必须断言**导航真的发生了**，不能只断言 `collapsed === true`。
> 「收起了」和「切过去了」是两件事，2026-09 那个「点会话切不过去」的 bug 表现恰恰是
> **收起了但没切过去**，而当时只测 `collapsed` 的验收全绿——见
> [`audit/mobile-tap-nav-analysis.md`](../../audit/mobile-tap-nav-analysis.md)。

服务端半（`lib/index.js`）没有任何副作用，所以它几乎不需要改；真改了要热重载，
需要 profile 的 `hmr` 行处于可用状态（本机 2026-09-22 曾因为在线改 `hmr` 行把热重载
静默打死，要重启一次才能重新武装）。

## 挂载点只能有一个（踩过的坑）

`dsh.profile.bundles` 与 profile 的 `cordis.patch.yml` 会被**合并成同一个 config
数组**，而 loader 的重复 id 检查跑在 `disabled` 求值**之前**：

```js
// cordis-plugin-loader/lib/index.js:87
for (const options of config) {
  const id = this.tree.ensureId(options);
  if (seen.has(id)) throw new TypeError(`duplicate loader entry id: ${id}`);
}
```

所以：

- 两层各 `insert` 一次同一个 id → 启动直接失败
  （`dsh: plugin tree failed to load: duplicate loader entry id: …`），
  `dsh web` 退出、systemd 无限重启、GUI 白屏。本 profile 已经因此挂过三次。
- **`disabled: !!js` 救不了同 id 的重复**：检查在前、求值在后。它只能用来防止
  「同一个包被两个**不同** id 挂载」（`dsh-better-sidebar` 的 aggregate 守卫就是
  这个用法）。

而 patch 层在**每次启动**都会应用，`patchReload` 又是 `live`——看起来「只挂 patch 层」
能同时满足「现在就是活的」和「重启之后还是活的」，不需要 bridge/retire 那套临时手段。
**但它站不住，本机实测翻车了**：

> `dsh plugin --profile web <任何子命令>`——**连 `--help` 都算**——会把 profile 的
> **每一个 `dependencies` 重新写回 `dsh.profile.bundles`**。这两个包既在 dependencies
> 里、又被 patch 层 insert 过，命令跑完就变成两层各 insert 一次同一个 id，下一次启动
> 直接撞 `duplicate loader entry id`。

所以挂载点的正确归属是 **bundle 层**（也就是 `dsh plugin add` 天然会给你的那个位置）：
它由 `dsh plugin` 维护、跟着 dependencies 走、不会被下一次命令悄悄改坏。patch 层只用来
做**临时**的事（bridge 到下次重启前、或者改一行 config）。

判断当前组合对不对，最快的办法是铺平看一眼（**注意：`--dump-config` 只铺平、不建树，
所以它不会报 duplicate，得自己数**）：

```bash
dsh --profile web --dump-config | grep -c '^- id: mobile-adapt$'   # 必须是 1
dsh --profile web --dump-config | grep -c '^- id: better-sidebar$' # 必须是 1
```

出现 2 就是「下一次启动会白屏」。`tools/migrate-mount-ownership.sh` 就是按这个判据
做迁移 + 安全重启 + 失败回滚的。

## 浮动卡片：窄屏默认关闭

`dsh-whale-widget` 的根节点 `.dshwv-root` 是
`position: fixed; right: 0; bottom: 0; z-index: 9999`，尺寸
`clamp(122px, min(250px, min(100vw,100vh) * .28), 625px)`：在 390×844 上算出来是下限
**122px**，正好钉在输入卡片的发送键上（占屏宽 31%）。它自己没有「不显示」的配置项
（只认 `config.provider`），所以在窄屏由本插件兜底关掉。

```css
@media (max-width: 1023.98px) {
  html[data-dsh-ma]:not([data-dsh-ma-float-card='on']) .dshwv-root { display: none !important; }
}
```

职责是分开的：CSS 负责「只在窄屏生效」（桌面端那个挂件照常显示，实测 1280×900 下
仍是 275×275 可见），JS 负责「用户开过没有」——启动时读一次
`localStorage['dsh-mobile-adapt:float-card']`，是 `'on'` 才给 `<html>` 加上
`data-dsh-ma-float-card="on"`。读不到（隐私模式、storage 被禁）就是默认关闭。

想打开：

```js
localStorage.setItem('dsh-mobile-adapt:float-card', 'on'); location.reload();
// 关回去：localStorage.removeItem('dsh-mobile-adapt:float-card'); location.reload();
```

验收探针里的 `5-float-card-off-by-default` 检查「可见面积 = 0」；没装那个挂件时记
inconclusive 而不是失败。

## 验证

```bash
# v0.5.3 回归：抽屉打开时，宿主 portal 菜单（视图选项/工作区…/设置对话框）必须在抽屉之上
node tools/ui-probe.mjs --script tools/probes/mobile-menus.js

# 需求 1-5 + 浮动卡片：390×844 完整交互流
node tools/ui-probe.mjs --script tools/probes/mobile-flows.js

# 需求 6-11（输入区折叠/唤醒/焦点属性一致性/模型名上限/顶部栏浮层与梯度）：16 条断言
node tools/ui-probe.mjs --script tools/probes/mobile-composer.js

# 需求 12-13（侧栏按钮拖动/贴边/持久化、系统返回）：9 条断言
node tools/ui-probe.mjs --script tools/probes/mobile-nav.js

# 桌面必须零影响（1280×800）
node tools/ui-probe.mjs --width 1280 --height 800 --no-mobile --expr \
  "getComputedStyle(document.querySelector('[data-composer-card]')).opacity"

# 只看某一项
node tools/ui-probe.mjs --expr "document.documentElement.dataset.dshMa"
node tools/ui-probe.mjs --expr "getComputedStyle(document.querySelector('[data-dsh-ma-frame]')).gridTemplateColumns"
node tools/ui-probe.mjs --expr "document.activeElement.hasAttribute('data-composer-input')"
```

> `mobile-composer.js` 里「折叠高度」用的是**相对判据**（比聚焦态矮 ≥20px），不写死
> 绝对值：宿主改输入框高度时绝对阈值会假失败。它同时断言
> `elementFromPoint` 命中的是可编辑面而不是工具行——这正是坑一的回归点。

## 已知取舍

- **窄屏判定只看宽度**（`max-width: 1023.98px`），与宿主 `SIDEBAR_AUTO_COLLAPSE`
  逐字一致，不看指针是否粗。桌面浏览器把窗口拖窄也会进抽屉模式——这是宿主的
  既有语义，跟随它比另立标准更不容易错位。
- **会话行靠类名片段认**（`[class*="_sessionRow"]`）：宿主没给 data 属性，只能
  按 CSS Modules 哈希名里的稳定片段认。宿主升级时对账这两条常量。
- **必需注入 `layout` 与 `sessions`**：宿主若删掉其中任何一个，本行会停在 `pending`，
  而客户端启动闸门 `assertEntriesActive` 会把**整个** web UI 判为启动失败
  （本机 2026-09-22 因 `dsh-remote-ssh` 等一个不存在的 `betterSidebar` 整页白屏过）。
  所以所有用法都包在 try/catch 或形状判断里。

## v0.5.1 右侧浏览器兼容

手机全屏右侧栏展开时隐藏双浮动入口，避免覆盖浏览器输入/操作区域；关闭右侧栏后恢复两按钮的保存位置。使用原有 rightbarOccupied() 可视区判据和 data-dsh-ma-right-open 属性，桌面不受影响。

## v0.5.2 面板关闭识别

右侧栏即使关闭仍保留具有宽度的 DOM；浮动入口可见性现在只由具有可见样式并与视口相交的右侧会话面板决定。关闭后立即恢复双浮动按钮，不因隐藏的缓存面板而误判。

## v0.5.3 浮层菜单被抽屉压住（归档 / 视图选项 / 工作区菜单）

**症状**：手机上打开左侧抽屉后，点「视图选项」「归档」「工作区」相关按钮，菜单偶尔像没反应；
其实菜单已渲染，但被抽屉整块盖住。

**真因**：宿主把 Workspace / Session / View options 的 `Menu` 用 `portal: true` 渲染到
`<body>`，层级固定为 **1100**；本插件旧版把抽屉写成 **1300**、遮罩 **1290**、
入口 **1350**，于是 portal 菜单被压在抽屉下面。不是「有时不出现」，而是**鼠标/手指命中了抽屉**。

390×844 实测（修复前）：

```
menu  rect=(36,282,200,324)  z=1100  parent=BODY
drawer rect=(0,0,281,844)    z=1300
elementFromPoint(136,312) -> SPAN.YDXeBa_title  (抽屉里的会话行)   ← 不是菜单
```

**修复**：把本插件整体压回宿主浮层之下，并在 CSS 里把层级表写成契约：

| 层 | z-index |
|---|---|
| 页面内容 / dockkit 浮动层 | ≤ 60 |
| **本插件遮罩 / 抽屉 / 浮动入口** | **100 / 110 / 120** |
| 宿主模态遮罩、对话框 | 1000–1001 |
| 宿主 portal 菜单、toast | 1100 |
| session inspector | 1200–1251 |

规则：本插件任何层都不得 ≥ 1000。需要盖住菜单的是宿主自己，不是适配层。

**回归判据**（探针，不靠截图）：打开抽屉 → 点「视图选项」→
`elementFromPoint(菜单中心)` 必须 `closest('[role="menu"]')` 非空；
同时抽屉仍须盖住正文（`elementFromPoint(350,400)` 命中 `.dshma_scrim`）。

## v0.5.3 「添加工作区」面板被抽屉当包含块

**症状**：手机上点「添加工作区」，面板显示不正常——被压成侧栏那么大，或者干脆看不见。

**真因**：这个面板是宿主的 `position: fixed; inset: 0; z-index: 1000`，但宿主把它挂在
侧栏列**内部**（`bhn1Oq_sectionHeader` 下面）。CSS 规则：fixed 后代的包含块是最近的带
`transform` 的祖先——也就是我们的抽屉。于是：

- 面板被压成抽屉大小（280×844，而不是整屏 390×844）；
- 祖先 `sectionHeader` 的 `overflow: hidden` 把它裁掉；
- 抽屉收起时整体平移出屏幕，面板跟着一起消失（实测 `rect x=-281`，命中落到正文）；
- `visibility` / `pointer-events` 是继承属性，收起态抽屉把 `hidden` / `none` 传给面板，
  面板隐形且点不到。

桌面没有这个问题：桌面没有 transform，fixed 回到视口，overflow 也裁不到它。

**修复**：抽屉里出现 dialog/menu 时（`sync()` 写 `data-dsh-ma-overlay`），本帧不用
`transform`，改用 `left` 定位，让 fixed 回到视口，并显式打开 `visibility` /
`pointer-events`。

390×844 实测（修复前 → 修复后）：

```
抽屉收起 + 面板打开： rect x=-281 w=280, pe=none, vis=hidden, hit=正文
                    → rect (0,0,390,844), pe=auto, vis=visible, hit=面板内
抽屉展开 + 面板打开： rect (0,0,280,844)
                    → rect (0,0,390,844)，面板里的按钮真的能点（实测点开文件选择器）
```

**回归判据**：`tools/probes/mobile-menus.js` 第 7、8 条 —— 面板必须是视口大小、
`pointer-events: auto`、`visibility: visible`，且 `elementFromPoint(面板中心)` 命中
面板自身；收起态和展开态各测一次。

A/B（同一探针，同一环境）：0.5.2 挂 6 条，0.5.3 全 8 条通过。

> 顺带说明：`tools/probes/mobile-flows.js` / `mobile-composer.js` 里「点会话行」那一步
> 在本机 0.2.1 上本来就挂（0.5.2 基线跑同样的失败），与本次改动无关。

