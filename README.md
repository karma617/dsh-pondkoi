# dsh-pondkoi · 后院鱼塘

把 DeepSeek Harness 桌面版内置的「后院鱼塘」提取为独立 DSH 插件。锦鲤随真实主会话对话成长、投喂、玩水、繁育，庭院按本地时段与节气呈现。

- 目标宿主：**DeepSeek Harness `0.2.0-rc.2`**
- 安装位置：`~/.dsh/profiles/web`（与其它第三方插件一致）

## 它做了什么

- **成长**：每次成功发送一条主会话消息，池中每条锦鲤 +1 级。
- **投喂 / 玩水**：点击中央可游动水域投下五粒饲料，或切换「玩水」轻点水面产生正弦折射波。饲料与玩水共用 140 ms 冷却，最多 6 个活动折射波。
- **繁育**：500 级异性锦鲤自动配对产卵，再经历 5 次对话孵出小鱼；鱼与卵合计上限 16，每条鱼一生只繁育一次。
- **档案与改名**：点击锦鲤查看性别、花色、代际、成熟进度，并保存 1–16 字的名字。
- **性格与亲密度**：性格由鱼自身标识稳定决定；亲密度随对话、投喂与陪玩提升，影响游速与阶段称号。
- **庭院事件**：按对话序号约 42% 概率出现花瓣、蜻蜓、青蛙、流萤或跃水锦鲤，同一时间只保留一个。
- **节气与时段**：季节由本地日期决定（3–5 春 / 6–8 夏 / 9–11 秋 / 12–2 冬）；时段可选自动或手动清晨／日间／傍晚／夜间。
- **禅模式**：隐藏文字与面板，只留画面；单击鼠标右键退出。
- **执行列表**：左侧透明面板仅显示正在执行的会话短标识，不显示消息正文。

投喂不升等级；没有饥饿、死亡、离线惩罚或付费内容。

## 安装

在 DSH 中把本包加入 web profile：

```powershell
dsh plugin --profile web add <path-or-tarball>
```

或在本目录执行 `npm pack` 后安装生成的 tarball。安装后重启 DSH，右下角会出现「池」悬浮球。

## 架构

插件是标准的 dsh 双面插件（dual-face package）：

| 文件 | 角色 |
| --- | --- |
| `index.js` | 宿主面（Node）。默认导出 `apply`，声明 `inject: ['webServer']`，注册 HTTP 路由。 |
| `client.js` | 客户端面（浏览器）。在页面内挂载锦鲤池塘与悬浮球，并观察会话以驱动成长。 |
| `src/store.js` | 存档与成长账本。原子写入、串行化去重。 |
| `src/routes.js` | 路由常量、输入边界、响应工具。 |
| `src/weather.js` | Open-Meteo 实时天气（IP 定位，可失败降级）。 |
| `cordis.patch.yml` | bundle patch，向 patch 栈插入本插件。 |
| `assets/` | 庭院美术、折射内核与渲染脚本。 |

宿主提供四个接口，客户端只通过它们通信：

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/plugins/dsh-pondkoi/state` | GET | 当前存档（不含去重键）。 |
| `/plugins/dsh-pondkoi/dialogue` | POST | 记录一次成功对话。 |
| `/plugins/dsh-pondkoi/rename` | POST | 改名。 |
| `/plugins/dsh-pondkoi/weather` | GET | 实时天气，失败返回 `null`。 |
| `/plugins/dsh-pondkoi/assets/*` | GET | 静态美术资源。 |

存档位置：`$DSH_HOME/dsh-pondkoi.json`（默认 `~/.dsh/dsh-pondkoi.json`）。等级、名字、代际、鱼卵与消息去重键都在这里；去重键永不下发给客户端。

## 与桌面内置版的差异

桌面版把池塘做成 Electron 的 `WebContentsView` + 沙箱 preload，成长观察靠在主世界里改写聊天模块的 `prompt` 方法。DSH 插件没有这些特权，因此：

- **画面**：改为在 DSH 页面内挂载覆盖层，而不是独立原生视图。切换池塘不会导航或销毁聊天页，工作区、会话与草稿都保留。
- **通信**：preload 的 `window.koiPond` 桥保留同名同形状，但由同源 HTTP 实现。渲染脚本 `assets/koi-pond.js` 除资源路径外未作改动。
- **资源路径**：原版用相对路径（`file://` 下有效）。在页面内相对路径会解析到应用根目录导致 404，因此统一改为 `/plugins/dsh-pondkoi/assets/` 绝对前缀。
- **成长观察**：不再改写 `prompt`。客户端订阅公开的会话列表，按主会话用户消息数递增上报，并以消息序号作为去重键。**语义略有差异**：桌面版统计「`prompt` 返回 `ok: true`」，本版统计「主会话新增用户消息」。发送失败、助手回复、工具事件与历史加载都不计入；子智能体会话不计入。

## 安全边界

- 所有路由拒绝跨域请求，并要求 `content-type: application/json`。
- 会话与请求标识在 HTTP 边界做字符校验：拒绝路径分隔符、C0 控制字符与 DEL、空白包围与超长值。
- 请求体上限 16 KiB。
- 资源路由只服务 `assets/` 目录内的**实际存在文件**，读取前先做成员校验，目录穿越一律 404。
- 资源按扩展名给出类型，未知扩展名不作为可执行内容返回。
- 存档损坏时保留原文件并抛错，不静默重置；写入先落临时文件再替换，成功后才提交内存状态。

## 测试

```powershell
npm install
npm test
```

58 个测试，覆盖：

- 存档：初始住户、去重（含重放与跨会话）、等级、配对产卵、孵化、一生一次繁育、容量上限、损坏存档保留、重载恢复、并发串行化。
- 边界：`isBoundedId` 字符规则、资源类型映射、路由常量无尾斜杠、导出完整性。
- 资源：渲染脚本引用的每个素材都真实存在，且没有残留相对路径。
- 契约：渲染脚本与 `client.js` 之间的桥接口形状、桥安装时机先于脚本执行、`close()` 可链式 `.catch()`。
- 激活：通过真实 cordis `Fiber` 走 `resolveConfig`，验证 `Config` 为 Standard Schema、默认值、越界值被拒、路由在激活时注册且在 fiber 卸载时注销。
- 集成：在真实 `@deepseek-ai/dsh-host-webserver` 上跑真实 HTTP，验证状态、成长、改名、天气、资源字节（含 WebP 魔数）、目录穿越拒绝、跨域拒绝、超大体拒绝、方法拒绝。

## 配置

在 `cordis.patch.yml` 中可覆盖：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `saveFile` | `dsh-pondkoi.json` | `$DSH_HOME` 下的存档文件名，只允许普通文件名。 |
| `capacity` | `16` | 鱼与未孵化卵合计上限，范围 1–16。 |
| `liveWeather` | `true` | 是否响应 Open-Meteo 实时天气。 |

`Config` 必须是 Standard Schema（`@deepseek-ai/schemastery` 的 `z.object`）。cordis 在 `resolveConfig` 中执行 `runtime.Config['~standard'].validate(config)`，若 `Config` 是普通对象，`~standard` 为 undefined，插件会在 `apply` 之前就激活失败并报 `Cannot read properties of undefined (reading 'validate')`。

## 已知限制

- **未在真实 DSH 完整 loader 链路中装载验证。** 本机只安装了 `0.2.0-rc.1`。宿主面已通过真实 cordis `Fiber` 激活路径与真实 `dsh-host-webserver` 验证，但**客户端面**（`dsh.client.inject` 注入、`window.__ModuleLoader__.load` 执行）未在真实运行时跑通。首次安装后请确认悬浮球出现。
- 客户端成长观察依赖 `@deepseek-ai/dsh-api-session-controller` 的会话列表快照结构；若该结构在后续版本变化，成长会停止（投喂仍可用），需重新核对。
- 实时天气需要出网；失败时静默降级为本地季节／时段表现。

## 许可

MIT。美术素材沿用桌面版，随原项目授权。
