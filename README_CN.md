# Codex Chrome MCP

[English](README.md) | **中文**

把 Codex 的 **Chrome("Control Chrome with Codex")插件**封装成 MCP server,让任何 MCP 客户端(Cursor、Claude Code 等)都能驱动你**真实的、已登录的 Chrome**——导航、DOM 快照、点击、输入、截图、运行 Playwright,以及原生 Chrome DevTools Protocol 调试。

## 工作原理

与 Computer Use(自包含 `.exe`)不同,Chrome 插件是一个 Node bundle(`browser-client.mjs`),它通过 Codex 私有的命名管道和 Codex Chrome 扩展与 Chrome 通信:

```
MCP client (Cursor, ...)
  ↓ MCP (stdio)
codex-chrome-mcp  ──imports──▶ <Codex 插件缓存>/chrome/<ver>/scripts/browser-client.mjs
  ↓ named pipe  \\.\pipe\codex-browser-use\<uuid>
extension-host.exe  ↔  Codex Chrome 扩展 (hehggadaopoacecdllhhajmbjkdcmajg)
  ↓
你的 Chrome 标签页
```

本 server 提供 Codex `node_repl` 通常注入的宿主环境 shim(特权管道桥、每轮元数据、安全模式、审批回调、fetch),然后复用**官方**的 browser-client,因此 API 始终与你本机安装的插件版本一致。

## 环境要求

- Windows 10/11
- Node.js 18+
- **已安装 "Chrome" 插件的 ChatGPT 桌面版(原 Codex Desktop)**("Control Chrome with ChatGPT";兼容标识仍沿用 Codex 时代的命名——`~/.codex`、`codex-browser-use` 等)。插件的 `browser-client.mjs` 需存在于 `~/.codex/plugins/cache/openai-bundled/chrome/…`,或使用 `vendor/` 下自备的客户端(原生 CDP 必需,见下文)。
- 一条活跃的 `codex-browser-use` 管道——由扩展/宿主创建。实践中:保持 ChatGPT 桌面版运行、Chrome 打开且其扩展已启用。

## 安装

见 [INSTALL.md](INSTALL.md)(英文)。简而言之:`npm install && npm run build`,然后把 `node <repo>/bin/codex-chrome-mcp.js` 注册为 stdio MCP server。

## 工具

| 工具 | 说明 |
|------|------|
| `browser_documentation` | 返回 `browser`/`tab` 的完整实时 API 参考(写 `browser_exec` 前先读)。 |
| `browser_exec` | 对该 API 运行任意异步 JS(作用域内有 `agent`、`browser`、`tabs`、`user`、`tab`)。全功率逃生舱。 |
| `list_user_tabs` | 列出用户真实打开的 Chrome 标签页。 |
| `list_tabs` | 列出本会话控制的标签页。 |
| `new_tab` | 创建受控标签页(可选带导航)。 |
| `claim_tab` | 接管一个用户已打开的标签页。 |
| `goto` | 将活动标签页导航到 URL。若导航失败落在 `chrome-error://` 页,会自动恢复到之前的页面。 |
| `snapshot` | url + 标题 + 带 node id 的 DOM(`get_visible_dom`);在 `chrome-error://` 页会给出警告。 |
| `screenshot` | 截取活动标签页。 |
| `click` | 按 node_id、selector、文本或 x/y 点击。 |
| `type_text` | 输入文本(可选填充某个 selector)。 |
| `press_key` | 按键/组合键。 |
| `scroll` | 按增量滚动 / 滚动容器内部(`node_id`)/ 在 `x`+`y` 处滚轮 / `scrollIntoView` 某 `selector`。返回前后位置、`pageHeight`、`nearBottom`。 |
| `eval_js` | 通过 Playwright 的加固只读沙箱在页面内求值(无 fetch/XHR/DOM 写入);在 `chrome-error://` 页会给出警告。 |
| `fetch_url` | ⚠️ 与本桥接目标的 `extension` 后端已知不兼容:26.727 API 文档将 `tabs.content` 标记为 `unsupportedByDefaultIn: extension`,调用会报 `browser.tabs.content is not a function`。请改用 `browser_exec` 内的 Node `fetch`(公开 URL)或 `goto` + `eval_js`(需登录态的页面)。 |
| `get_console_logs` | 读取标签页的 console 日志。 |
| `cdp_send` | 向标签页或已附加的子 target 发送一条原生 Chrome DevTools Protocol 命令(开发者模式,见下文 Raw CDP 章节)。 |
| `cdp_events` | 以游标分页读取缓冲的 CDP 事件(`{ cursor, events, hasMore, truncated }`,见下文 Raw CDP 章节)。 |
| `name_session` | 命名浏览器会话。 |
| `finalize` | 清理会话标签页(可选保留部分)。 |

## Raw CDP(开发者模式)

`cdp_send` / `cdp_events` 暴露标签页的 `cdp` capability——面向开发调试的原生 Chrome DevTools Protocol(网络拦截、设备模拟、性能剖析、断点)。上游自身的指引同样适用:常规自动化请优先使用高层工具。

前置条件——三条必须全部满足,否则工具报 `Capability is not available: cdp`:

1. **26.727+ 的 browser-client**:只有 26.727+ 会注入 `cdp` tab capability(插件缓存目前发的是 `26.715.31925`,不含该能力)。本仓库在 `vendor/chrome-26.727.51351/` 自备了可用客户端(见 [vendor/README.md](vendor/README.md) 自行填充);把 `CODEX_CHROME_CLIENT` 指到其 `scripts/browser-client.mjs`,且 `scripts/` 与 `docs/` 必须放在一起(否则 `browser_documentation` 失效)。
2. `~/.codex/browser/config.toml` 中 **`full_cdp_access_enabled = true`**——客户端的 full-CDP 门控通过 shim 的 `nodeRepl.config` 面读取该配置(`src/runtime.ts`)。
3. 标签页处于 **http(s) 源**:先导航;原生 CDP 的作用域限定为标签页当前的 web origin。

行为:

- 首次 `cdp_send` 会在扩展侧自动附加调试器;Chrome 会显示"已开始调试"横幅。事件域(`Page`、`Network` 等)在发送对应 `.enable` 命令前不会产生事件。
- 观察某个动作产生的事件:先用 `cdp_events` 取一个游标,执行动作,再用 `after_sequence` 从该游标读取;`hasMore` 为 true 时继续分页(`truncated` 表示更早的事件已被淘汰;分页期间保持同样的过滤条件)。
- 子 target(iframe、worker):从 `Target.attachedToTarget` 事件中发现选择器,然后传 `session_id` 或 `target_id`。

上游强制的护栏(部分原生命令会被拒绝并附带指引):

- 不允许拦截顶层 `Document`——请改为拦截子资源或页面发起的请求。
- `Fetch.enable` 的 pattern 必须显式指定非 `Document` 的 `resourceType`(`XHR`、`Fetch`、`Script` 等);不加限定的 pattern 隐含包含 `Document`,会被拒绝。
- 没有 `Fetch.disable`——用 `Fetch.enable({ patterns: [] })` 清除拦截。
- 断点:暂停会阻塞触发它的那条 `Runtime.evaluate`。请以"发射后不管"的方式触发(`awaitPromise: false`,或包在 `setTimeout(fn, 0)` 里),然后轮询 `Debugger.paused`、用 `Debugger.evaluateOnCallFrame` 检查现场、最后 `Debugger.resume`。

验证工具(仓库根目录):`node verify-cdp.mjs` 端到端运行构建产物(capability 注入、自动附加、`Runtime.evaluate`、事件分页);`node verify-stdio.mjs` 以 stdio 方式拉起 `bin/codex-chrome-mcp.js`,与 MCP 客户端的启动方式完全一致。2026-08-04 已基于自备的 26.727 客户端完成端到端验证。

## 配置(环境变量)

| 变量 | 默认值 | 用途 |
|------|--------|------|
| `CODEX_CHROME_CLIENT` | 自动探测 | `browser-client.mjs` 的绝对路径。自动探测(缓存 `latest` → native-host 清单 → 最新缓存目录)目前会解析到 `26.715.31925`,它没有 `cdp` capability——需要原生 CDP 时请 pin `vendor/chrome-26.727.51351/scripts/browser-client.mjs`。 |
| `CODEX_HOME` | `~/.codex` | Codex 主目录。 |
| `CODEX_CHROME_BROWSER` | `extension` | 后端 id:`extension`、`iab`、`cdp` 或具体 id。 |
| `CODEX_CHROME_SECURITY_MODE` | `disabled-for-local-testing` | 设为 `""` 恢复 Codex 的 consent 检查。 |
| `CODEX_CHROME_AUTO_APPROVE` | `true` | 自动批准 elicitation 弹窗。 |
| `CODEX_CHROME_SESSION_NAME` | `🔎 Cursor` | UI 中显示的会话名。 |

## 注意事项

- 非自包含、不可再分发:运行时复用你本机的专有插件,且与已安装的插件版本绑定。
- 需要活跃的 `codex-browser-use` 管道(通常要求 ChatGPT 桌面版 + Chrome 扩展处于活动状态)。
- 可能与应用自身的浏览器会话共享/竞争;行为可能随应用/插件更新而变化。
- 原生 CDP 会把 Chrome 调试器附加到标签页(可见"已开始调试"横幅),作用域限定为标签页当前 web origin,且上游会拒绝部分命令(见上文 Raw CDP 章节)。若通过 CDP 对页面/浏览器状态做了超出常规导航与 UI 交互的修改并保留了该修改,上游指引要求告知用户改了什么。

## 免责声明

运行时使用 OpenAI 专有的捆绑 `browser-client.mjs`;本仓库不对其再分发。与 OpenAI 无隶属关系。使用风险自负。
