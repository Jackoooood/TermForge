# TermForge 安全边界

本文对应 P1-05 实际实现，说明 Electron 安全配置、IPC 边界、真实 SSH 连接、交互式 PTY、多标签会话隔离、两窗格会话分屏、定向连接取消、有界自动重连、真实 SFTP 远程文件管理、真实文件上传/下载与传输队列、SSH 端口转发、持久化设置（v4）、壁纸皮肤、脱敏诊断日志、凭据处理与主机密钥策略。**这不是渗透测试报告，也没有经过第三方安全审计；端口转发未在真实 SSH 服务端验收。**

## 1. 安全目标

1. 渲染进程不能获得 Node.js、文件系统、子进程、`ssh2` 或任意 IPC 能力。
2. 应用不能加载远程内容、打开新窗口或嵌入 webview。
3. 连接配置只能通过固定、校验过的 IPC 通道读写，且不含密码、私钥内容或口令。
4. 凭据只允许以操作系统保护后的密文落盘；安全存储不可用时失败关闭，不降级为明文。
5. 未知或发生变化的主机密钥绝不会被自动信任；首次连接必须由用户显式确认。
6. 所有来自渲染进程的 ID 都在主进程重新校验并确认归属/存在性；渲染进程不能创建或访问 `ssh2.Client`。
7. SSH 状态以主进程为唯一权威；渲染进程只展示脱敏快照。
8. 渲染进程不能获得 `ssh2.Client`、Shell Channel 或任意主进程对象；终端只通过不透明 `sessionId`、受限文本与尺寸交互。
9. 终端输入/输出、命令内容与敏感输出不写入日志，也不进入 React/Zustand 全局状态；渲染进程不做本地回显。
10. 多标签会话相互隔离：每个标签以稳定 `clientId` 关联独立 SSH Client 与 PTY；关闭或重连一个标签不影响其他标签。
11. 真实 SFTP 由主进程在既有 SSH 会话上持有：渲染进程只能使用不透明 `sessionId`、校验后的 POSIX 路径与名称调用固定操作，不能获得 `SFTPWrapper`、文件内容或任意文件读写能力。
12. 目录删除是非递归且受限的：根目录、受保护的系统顶层目录、浅层目录、符号链接、非目录与非空目录都会被拒绝。
13. 文件传输由主进程执行：本地路径来自主进程原生对话框或渲染端双栏面板/拖拽（`enqueueUploadPaths`/`enqueueDownloadPaths`），后者由主进程逐条重新校验（绝对路径、无设备前缀、存在性、类型、目录展开深度与任务上限）；本地 `fs` 流、SFTP Read/Write 流、临时文件与提交操作不跨 IPC；渲染进程只接收带 `revision` 的任务快照，不能指定文件大小、任务状态或文件内容。
14. 传输提交使用目标同目录临时文件与 rename；覆盖前先备份目标并在失败时尝试恢复；取消/失败/退出只清理本任务创建的临时文件，不删除用户原有文件。
15. 传输层不提供断点续传、暂停/恢复、自动重启执行与自动重试；目录递归上传在入队前展开为逐文件任务（符号链接不跟随、深度与任务数上限），远程目录递归下载未实现；重启只把未完成任务显示为 `interrupted`，必须由用户核对后重新发起。SSH 自动重连是独立的、默认关闭的有界重试，只重建 SSH/PTY，不恢复传输、端口转发或旧 Shell 状态。
16. 设置只包含非敏感偏好，经 strict schema 校验并原子持久化；不提供任意路径、凭据或秘密读取。
17. 诊断日志只写结构化、脱敏的固定事件；终端输入/输出、命令、文件内容、凭据与任务路径不进入日志。日志导出只能由用户主动选择目标路径。
18. 关闭流程是有序、幂等且逐步有界的，单步卡住不会阻止后续清理；不把无法确认的清理描述为已完成。
19. 壁纸图片只由主进程从原生对话框读取、校验并重编码；渲染进程只接收有界 JPEG data URL 与文件名，不能指定路径、读取任意文件或让图片字节绕过解码。
20. 本地文件系统只读列举（`local-fs:roots`/`local-fs:list`）只返回名称、类型、大小、mtime 与隐藏/截断标记，不读取文件内容；路径在主进程按绝对路径、设备前缀与可读性校验，条目数量有上限，失败归一为固定错误码。
21. 跳板链路（ProxyJump 等价能力）由主进程用 `ssh2` `forwardOut` 建立，Socket/Channel 与中间主机凭据永不进入渲染进程；每一跳都独立执行主机密钥校验与凭据解析（按各自连接记录），跳板凭据只写入该跳板自己的加密凭据记录；任何一跳失败即终止链路并清理临时 Client。
22. 端口转发只通过主进程窄门面使用已连接的最终目标会话：渲染进程不能获得 `ssh2.Client`、Socket、Channel、监听器或流量；运行时状态以主进程为准，启动成功后才显示 `running`。
23. 本地/远程监听默认 `127.0.0.1`，非回环监听必须显式确认暴露风险，且不存在默认 `0.0.0.0`；远程服务器拒绝绑定时不得自动放宽；SOCKS5 监听强制为本机回环，首版只支持 no-auth CONNECT。
24. 端口转发不读取、不解析、不存储、不记录隧道内的应用层数据；任何 Socket payload 都不会发送给渲染进程或写入日志。
25. `ssh:cancel-connect` 只按校验过的 `clientId` 定向取消该标签正在进行的连接；取消不关闭标签、不影响其他标签或分屏窗格，也不返回凭据、Client 或底层错误。
26. 自动重连默认关闭，最多 5 次、退避 1/2/4/8/15 秒；只按固定 `SshFailure.code` 白名单触发，不匹配错误文本；每次重试重新执行主机密钥校验与完整认证，绝不自动信任、绕过检查或重放旧输入。
27. 分屏仅提供两个窗格，方向、比例与窗格绑定只存在于渲染运行态；分屏操作不调用 SSH 连接/断开，不改变会话生命周期，也不在窗格之间共享 Client、PTY 或终端输出。

## 2. 明确不在范围内

- 远程目录递归下载、跨主机传输、暂停/恢复、断点续传、自动重启执行、自动重试/自动同步、远程编辑与文件比较。
- 传输带宽限制、完整传输历史与操作审计（仅保留未完成任务的展示快照）。
- keyboard-interactive、Pageant 与第三方 Agent 适配。
- 凭据管理/审计 UI、多用户隔离与第三方安全审计；主机密钥仅提供列表与删除，不提供导入/导出或轮换审计。
- 无限或按错误文本触发的自动重连；自动重连不覆盖认证失败、主机密钥变化、用户取消、主动断开与应用退出，且不重放断线前的输入或快速命令。端口转发规则不会在重启或重连后自动恢复或静默重新绑定。
- SOCKS5 的 UDP ASSOCIATE、BIND、SOCKS4、用户名/密码认证与外部认证；Unix 域套接字转发、HTTP/HTTPS 代理与通用代理网关；隧道流量检查、解密、审计或带宽控制。
- 打包、签名、自动更新、发布链路与第三方安全审计。
- 真实 SSH/SFTP 服务端、网络环境的集成测试与手工验收。

## 3. Electron 窗口配置

`src/main/windows/mainWindow.ts`：

```ts
webPreferences: {
  preload: join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  sandbox: true,
  webviewTag: false,
  spellcheck: false,
  devTools: isDev,
}
```

- `contextIsolation: true`：preload 与页面上下文隔离。
- `sandbox: true`：渲染进程运行在 Chromium 沙箱中。
- `nodeIntegration: false` 与 `nodeIntegrationInWorker: false`：页面/Worker 无 Node 能力。
- `webviewTag: false`：禁用 `<webview>`。
- `devTools` 只在未打包（开发）时开启；菜单中的开发者工具也只在开发模式出现。
- 未设置 `webSecurity: false`、`allowRunningInsecureContent` 等降低安全性的选项。

### 加载来源

- 开发模式（`!app.isPackaged`）才读取 `ELECTRON_RENDERER_URL` 并加载 Vite dev server。
- **打包后的应用忽略该环境变量**，只加载本地 `out/renderer/index.html`。
- 创建窗口后拒绝所有新窗口（`setWindowOpenHandler` → `deny`）。
- `will-navigate`：生产模式阻止全部导航；开发模式只允许与 dev server 同源。
- `will-redirect` 始终阻止；`will-attach-webview` 始终阻止。
- 权限请求与权限检查一律返回 `false`。
- 单实例锁避免多开时出现未受管理的窗口。

## 4. IPC 边界

### 固定通道

`src/shared/constants/ipc.ts` 定义 63 个 invoke 通道：

```ts
app: get - info
security: get - status
connections: list
connections: create
connections: update
connections: remove
connections: set - favorite
ssh: connect
ssh: cancel - connect
ssh: disconnect
ssh: get - status
ssh: respond - host - key
ssh: set - credential
terminal: open
terminal: write
terminal: resize
terminal: close
terminal: get - status
sftp: open
sftp: list
sftp: stat
sftp: mkdir
sftp: rename
sftp: delete -file
sftp: remove - directory
sftp: close
local - fs: roots
local - fs: list
transfer: enqueue - upload
transfer: enqueue - upload - paths
transfer: enqueue - download
transfer: enqueue - download - paths
transfer: cancel
transfer: retry
transfer: resolve - conflict
transfer: list
transfer: clear - history
port - forwards: list
port - forwards: create
port - forwards: update
port - forwards: remove
port - forwards: start
port - forwards: stop
port - forwards: connection - impact
quick - commands: list
quick - commands: create
quick - commands: update
quick - commands: remove
quick - commands: set - favorite
quick - commands: execute
command - history: list
command - history: remove
command - history: clear
settings: get
settings: update
host - keys: list
host - keys: remove
logs: get - info
logs: export
logs: open - folder
wallpaper: get
wallpaper: choose
wallpaper: remove
```

以及 7 个主进程 → 渲染进程推送事件：

```ts
ssh: session - status
ssh: host - key - request
terminal: output
terminal: status
terminal: exit
transfer: update
port - forwards: snapshot - updated
```

- 没有通用 `send/invoke` 转发，没有原始 `ipcRenderer`；没有由渲染进程提交文件大小、任务状态或文件内容通道。本地文件系统只提供只读列举（`local-fs:roots`/`local-fs:list`），不读取文件内容。SFTP 通道只接受不透明 `sessionId` 与受限路径/名称，`SFTPWrapper` 始终留在主进程；传输只接受会话 ID、远程路径、任务 ID、冲突策略，以及上传/下载批量入队所需的本地路径（由主进程逐条重新校验），文件内容、流与句柄从不跨 IPC。
- `ssh:cancel-connect` 是窄控制通道，只接受一个 `clientId`，不接受会话 ID、凭据、传输对象或任意取消条件；主进程只取消该 `clientId` 正在进行的连接尝试，取消不可关闭标签、不可波及其他标签/窗格，响应只含 `cancelled` 与脱敏会话快照。
- `ssh2` 只在主进程导入；渲染进程不能创建、持有或销毁 Client、Shell Channel 或 `SFTPWrapper`。
- 终端输出事件只含 `{ sessionId, data }`（已解码 UTF-8 文本）；状态/退出事件只含尺寸、固定失败信息与退出码/信号，不含环境变量、凭据、Client 或 Channel。
- SFTP 没有推送事件；结果只作为对应 invoke 的响应返回，避免后台目录数据绕过请求上下文进入渲染进程。
- 传输推送事件只含完整 `TransferTask` 快照（路径、状态、字节数、错误与冲突信息），不含文件内容、流、本地句柄、SFTP 对象或凭据；渲染进程不能用事件参数发起新操作。
- 端口转发推送事件只含带 `revision` 的规则/运行时快照（规则字段、状态、绑定端点、活动连接数、固定失败信息、`cleanupPending`），不含 Socket、Channel、监听器、流量、凭据或内部 Client；快照由主进程发布，渲染进程无法伪造。
- 所有 invoke handler 使用 `ipcMain.handle`，在 `whenReady` 后、窗口创建前注册。

### 发送方校验

`assertTrustedSender` 要求：

1. 存在且未销毁的主窗口；
2. `event.sender === window.webContents`；
3. `event.senderFrame === window.webContents.mainFrame`（拒绝 iframe/子 frame）。

任一条件不满足即抛错。窗口关闭后请求被拒绝。事件推送只发送到当前主窗口的 `webContents`，窗口已销毁时丢弃；渲染端无法伪造状态事件。

### 输入校验与存在性

- 连接参数用 `connectionInputSchema` 在主进程再次校验；连接 ID、会话 ID、主机密钥请求 ID、凭据输入、终端尺寸与终端写入数据分别使用 strict schema。
- 会话/请求 ID 还必须在主进程内存表中存在；`connect(connectionId, clientId)` 必须能在连接仓库中找到该连接，且 `clientId` 符合 `sshtab-<UUID>` 格式；主进程只按 `clientId` 去重并返回对应会话，不能借其他标签的 ID 复用其 transport；Shell 操作还要求 SSH 会话当前为 `connected`。
- `ssh:cancel-connect` 只接受 `sshClientIdSchema`（`sshtab-<UUID 风格>`）；主进程只结束该 `clientId` 对应的进行中尝试，并先以 `disconnected(cancelled)` 收敛状态再销毁 transport，迟到成功结果按 epoch 丢弃。取消是幂等的：没有进行中尝试时返回 `cancelled: false`，不会断开已连接会话，也不会关闭标签。
- `sshSessionIdSchema` 限制为 `ssh-<UUID 风格>`，`sshClientIdSchema` 限制为 `sshtab-<UUID 风格>`，`hostKeyRequestIdSchema` 限制为 `hk-...`；渲染进程不能借 ID 访问任意对象。
- 连接输入含未知字段（如 `password`、`privateKey`、`passphrase`）会被 strict schema 拒绝。
- 终端尺寸为 strict `{ cols, rows }`：整数、列 1–2,000、行 1–1,000；零、负数、小数、NaN 与超限值均被拒绝。
- 终端写入必须为字符串，单次 1–65,536 字符；渲染端再按 32 KiB 分片并串行发送，防止大段粘贴乱序或无限请求。
- SFTP 参数使用 strict schema：`sessionId` 必须匹配 SFTP 会话 ID 规则；路径 1–4,096 字符且必须以 `/` 开头，拒绝 NUL 与控制字符；新建名称 1–255 字符，拒绝 `/`、`.`、`..`、纯空白、NUL 与控制字符。未知字段被拒绝，渲染进程不能传入 Client、Channel 或任意对象引用。
- 每次 SFTP 调用都通过 `SshService.getSftpClient(sessionId)` 重新校验会话存在、由本应用创建且当前为 `connected`；**不会仅因渲染进程传入一个 `sessionId` 就访问 Channel**。SFTP 通道由主进程按会话持有并在 SSH 断开、关闭标签或应用退出时释放。
- 目录删除在主进程重复校验：拒绝 `/`、受保护的系统顶层目录、深度小于 2 的顶层目录、符号链接、非目录与非空目录；代码中没有递归删除分支。
- 变更类 SFTP 操作在请求已发出后遇到传输中断或超时会返回 `outcome-unknown`，不宣称成功或失败；超时后迟到回调被忽略，调用方必须刷新目录核实后再决定是否重试。
- 传输参数使用 strict schema：`transferId` 必须匹配 `transfer-<UUID 风格>` 且存在于主进程任务表；上传目录与下载来源必须是绝对 POSIX 路径；冲突策略只能是 `overwrite/rename/skip`，`rename` 必须带非空 `newName`，其他策略禁止携带 `newName`。未知字段被拒绝。
- 本地路径参数（`local-fs:list` 的 `path`、`enqueue-upload-paths` 的 `localPaths`、`enqueue-download-paths` 的 `localDirectory`）使用 `localPathSchema`：1–4,096 字符、必须为绝对路径、拒绝 NUL 与控制字符、拒绝 `\\.\`/`\\?\` 设备前缀；批量列表 1–50 条。
- **传输不接受渲染进程提供的文件大小、任务状态、文件内容、流或句柄**。渲染端可提交批量入队的本地路径，但主进程对每条路径重新 `lstat` 校验存在性与类型、重新展开目录（符号链接不跟随；超出深度上限 64 的目录计入跳过；任务数上限默认 500 超出后截断）；上传面板按钮仍走主进程 `dialog.showOpenDialog`。本地文件元数据由主进程 `lstat`/`stat` 获取，远程元数据来自 SFTP `stat`。
- 传输任务与 `sessionId` 的真实关联由主进程维护：重试、取消与冲突处理只能作用于已存在的任务；重试与冲突处理在继续执行前会重新确认会话仍可访问 SFTP，渲染进程不能把任务迁移到其他会话。
- 传输开始、重试与提交前会重新校验源、目标目录与冲突；目标已存在且未选择覆盖时进入冲突状态，不能静默覆盖。覆盖只允许普通文件，目录与符号链接会被拒绝。
- 上传只写目标同目录的 `.termforge-part-<UUID>` 临时文件（`wx`、`0600`），提交时主进程再次校验临时名前缀、同父目录、目标非根；下载临时文件同样位于本地目标目录并使用 `wx`、`0600`。提交使用同目录 rename；覆盖时先把目标改名为 `.termforge-backup-<UUID>`，失败时尝试恢复，恢复失败返回 `outcome-unknown`。
- 清理只删除本任务记录且仍为 `.termforge-part-*` 的临时文件；不会删除用户原有目标，也不会按通配符清理其他 `.termforge-*` 文件。取消、失败、超时或应用退出后清理有界；无法确认时会明确提示可能残留，不声称已清理。
- 传输批量上限、全局并发默认 2（可设 1–4）、每会话默认 1（可设 1–2，且不超过全局），进度推送限流；未知总大小不生成伪造百分比。取消/重试不会绕过来源与目标校验，也不存在自动重试循环。
- 端口转发参数使用 strict discriminated union：规则 ID 必须匹配 `pf-<UUID 风格>`；名称 1–64 字符且不含控制字符；监听地址必须是规范化的 IPv4/IPv6 字面量，拒绝主机名；端口为 1–65,535 的整数；`dynamic` 规则的 `bindAddress` 必须是 `127.0.0.1`。创建/更新不能通过输入改变规则类型或 `connectionId`，最多 100 条规则。
- 启动转发只接受 `{ ruleId, sessionId, confirmExposure? }`：主进程确认规则存在、连接配置仍存在、会话存在且为 `connected`、会话 `connectionId` 与规则一致；非回环的本地/远程规则在缺少 `confirmExposure: true` 时拒绝启动。服务端拒绝远程绑定时返回固定失败，不会自动改用其他地址或端口。
- `connections:remove` 的可选参数只允许 `{ cascadePortForwards?: boolean }`；主进程重新计算该连接下的规则数与运行中数量，渲染端传入的计数不被信任。有规则且未显式确认时拒绝删除；确认后先停止并删除规则，任何停止/清理失败都会中止连接删除。
- 快速命令使用 strict schema：草稿只含名称、分类、说明、正文与参数表，限制长度、单行/控制字符、参数数量与“参数列表必须与 `{{identifier}}` 按顺序一致”；执行输入只含 `requestId`、命令 ID 或已确认的历史正文、参数值、`tabId`、`sessionId` 与 `recordHistory`。未知字段一律拒绝。
- **快速命令不新增超出 `terminal:write` 的执行能力**：它最终只调用 `SshService.writeShell(sessionId, body + "\r")`，写入用户显式选择的已连接 Shell，等价于把文本键入该终端；不创建 SSH Client、不打开 exec 通道、不启动本地 shell，也不执行 `eval`/`new Function`。历史重发正文仍受长度/控制字符限制，并由用户预览确认。
- 发送目标在主进程重新校验：`getStatus(sessionId)` 必须存在、`sessionId` 与请求一致、`clientId === tabId`、SSH 为 `connected`，且 `getShellStatus(sessionId).status === 'open'`。目标失效返回固定错误，不自动换标签、不自动重发；渲染端发送前会冲刷该标签的终端写入队列，主进程按请求 ID 去重并限制同一标签同时只有一个发送在途，避免重复执行。
- 内置快速命令只包含只读诊断，且不可编辑；自定义命令可改变服务器状态，但应用不会自动执行，必须在发送确认框中显式选择目标并确认。
- 命令历史默认关闭。只有设置在发送时读取为开启且本次勾选记录，才把最终命令正文与目标元数据写入独立的 `command-history.json`；不记录终端输入输出、退出码、参数表、凭据或命令输出，正文不写入诊断日志。该文件**不额外加密**，依赖操作系统账户与磁盘权限；设置页与抽屉均明确披露，并提供关闭与清空入口。
- 命令模板只做字面单次替换，参数值不会再次解析为模板；应用不承诺通用 shell 转义，参数值仍可能被远端 Shell 解释，用户必须自行确认命令与参数语义。
- 设置更新只接受 strict `AppPreferences`：主题为 16 套风格或 `system`、DBX 明暗三选一、界面/终端字体族白名单 ID、界面字号 12–15、终端字号 10–20、回滚行数/并发数仅允许预设整数、布尔严格（含命令历史开关与 `autoReconnectEnabled`）、日志级别四选一、壁纸开关严格布尔、壁纸浓度三选一；未知字段与任何凭据/路径字段被拒绝。拒绝时主进程不写入任何数据，也不应用到运行时。设置文件由 v1–v5 读取时在内存迁移到 v6，新字段缺失按固定默认值处理，不因旧文件默认开启自动重连。
- 设置只持久化非敏感偏好；没有“读取连接配置/凭据”的设置通道，也不接受自由文本 CSS 或文件路径。
- 壁纸通道不接受任何参数。`wallpaper:choose` 只通过主进程 `dialog.showOpenDialog` 选择本地图片，扩展名限 `.png/.jpg/.jpeg`，`stat` 确认为普通文件且 1 字节–20 MiB；`nativeImage` 解码失败、零尺寸或重编码为空时拒绝。最长边超过 2,560px 时等比缩放，再以 JPEG 质量 85 重编码，原子写入 `<userData>/wallpapers/`。返回值只含 `dataUrl`、原始文件名 basename 与更新时间；源路径、原始字节与文件句柄不跨 IPC。`wallpaper:remove` 只删除固定的两个壁纸文件。
- 主机密钥移除只接受 `{ host, port }` 并经 `hostKeyEndpointSchema` 校验（主机格式、端口 1–65,535）；主进程按规范化端点删除信任记录，未知端点返回 `removed: false`。该操作不会中断现有 SSH 会话，但下次连接该端点必须重新确认。
- 删除连接时，主进程在 profile 删除成功后尽力删除该连接对应的 password/private-key/passphrase 三个凭据引用；清理失败不回滚已删除的连接，也不返回秘密。主机密钥信任记录不会随连接删除。
- 日志导出不接受渲染进程路径：由主进程原生保存对话框选择目标，只读取固定日志目录中匹配 `termforge*.log` 的文件，最多 20 MiB，写入前再次文本脱敏；`logs:open-folder` 只打开固定日志目录，`logs:get-info` 只返回文件名、大小、修改时间、级别与失败计数。
- 统一返回 `OperationResult`，错误码限制在允许列表；原始 `ssh2` 错误、`fs` 错误、Zod issue、堆栈和内部路径不会出现在错误响应或日志中。传输错误消息为固定中文描述，不包含内部路径或原始错误码；成功任务快照按设计包含用于展示的源/目标路径。

### 推送事件

- 快照只包含主机、端口、用户名、认证方式、状态、时间戳、主机密钥公钥信息与固定错误码/消息；不包含密码、私钥内容、口令或 Client 引用。
- 终端快照只包含 Shell 状态、尺寸、固定失败码/消息与退出码/信号；终端输出单独走 `terminal:output`，只含会话 ID 与文本。
- 渲染端所有 `on*` 返回幂等取消订阅函数；应用根卸载时移除监听。

## 5. Preload 暴露面

```ts
const bridge = Object.freeze({
  getAppInfo,
  getSecurityStatus,
  connections: Object.freeze({ list, create, update, remove, setFavorite }),
  ssh: Object.freeze({
    connect,
    cancelConnect,
    disconnect,
    getStatus,
    respondToHostKey,
    saveCredential,
    onSessionStatus,
    onHostKeyRequest,
  }),
  terminal: Object.freeze({
    open,
    write,
    resize,
    close,
    getStatus,
    onOutput,
    onStatus,
    onExit,
  }),
  sftp: Object.freeze({
    open,
    list,
    stat,
    mkdir,
    rename,
    deleteFile,
    removeDirectory,
    close,
  }),
  localFs: Object.freeze({ roots, list }),
  transfer: Object.freeze({
    enqueueUpload,
    enqueueUploadPaths,
    enqueueDownload,
    enqueueDownloadPaths,
    cancel,
    retry,
    resolveConflict,
    list,
    clearHistory,
    onUpdate,
  }),
  portForwards: Object.freeze({
    list,
    create,
    update,
    remove,
    start,
    stop,
    getConnectionRemovalImpact,
    onSnapshot,
  }),
  quickCommands: Object.freeze({
    list,
    create,
    update,
    remove,
    setFavorite,
    execute,
  }),
  commandHistory: Object.freeze({ list, remove, clear }),
  settings: Object.freeze({ get, update }),
  hostKeys: Object.freeze({ list, remove }),
  logs: Object.freeze({ getInfo, exportLogs, openFolder }),
  wallpaper: Object.freeze({ get, choose, remove }),
})
```

- 只暴露冻结对象与固定方法；每个方法只调用一个固定通道，没有动态通道名参数。
- 没有原始 `ipcRenderer`、`send`、`invoke`、`require` 或 Node API。
- **没有读取凭据的方法**：渲染进程可以提交凭据到主进程，但不能从主进程取回密码/私钥。
- `terminal` 方法只接受 `sessionId`、字符串与 `{ cols, rows }`；无法传入对象引用来操作主进程资源，也无法获得 `ssh2.Client`/Channel。
- `sftp` 方法只接受 `sessionId`、绝对路径与名称；没有读取文件内容、上传、下载、递归删除或任意通道/对象参数，也无法获得 `SFTPWrapper`。
- `transfer` 方法只接受 `sessionId`、远程路径、任务 ID、冲突策略，以及批量入队所需的本地路径列表（`enqueueUploadPaths`/`enqueueDownloadPaths`，由主进程逐条重新校验并重新展开）；无法传入流、Buffer、大小或句柄，也无法获得 SFTP 通道。
- `portForwards` 方法只接受规则 ID、连接 ID、会话 ID、地址/端口、名称与暴露确认标志；没有 Socket/Channel、监听器、流量、凭据或任意对象参数，也无法获得 `ssh2.Client` 或 `SshForwardingSession`。`onSnapshot` 只接收主进程推送的只读快照。
- `quickCommands` 方法只接受命令草稿、命令/历史 ID、一次性请求 ID、参数值、`tabId`/`sessionId` 与记录开关；`execute` 最终只写入用户显式选择的已打开 Shell，不能创建 SSH Client、exec 通道或本地 shell，也不能读取终端输出。`commandHistory` 只返回历史正文与目标元数据，支持按 ID 删除与清空，不能读取日志、文件或终端输出。
- `localFs` 只有 2 个只读方法：`roots`（无参数）与 `list`（单个绝对路径）；返回名称、类型、大小、mtime 与隐藏标记，不读取文件内容、不写盘、不返回文件句柄，也不能借此访问远程主机。
- `ssh.cancelConnect` 只接受一个标签 `clientId`，不能指定任意会话或关闭标签；它只终止该标签正在进行的连接尝试。`settings` 方法只接受完整偏好对象或空参数；`hostKeys` 只接受主机端点；`logs` 不接受参数，导出路径由主进程对话框产生；`wallpaper` 不接受参数，图片源由主进程对话框产生。四者都不能读取凭据、终端输出、文件内容或任意路径。
- `ssh:connect`/`ssh:disconnect`/`terminal:*`/`sftp:*`/`transfer:*`/`local-fs:*`/`port-forwards:*`/`quick-commands:*`/`command-history:*` 构成渲染进程的操作面；若渲染进程被 XSS 完全控制，攻击者可以发起连接、断开会话、写凭据、向已打开 PTY 写入文本，对当前 SSH 账号可访问的远程目录执行列举、创建、重命名与受限删除，启动上传/下载（本地路径由渲染端提交、主进程逐条校验存在性与类型，符号链接不被跟随），只读枚举本地目录（名称、类型、大小、mtime），创建/启动/停止端口转发并删除连接下的规则（非回环监听仍需显式暴露确认与级联确认），创建/编辑/删除快速命令并最多收藏/复制内置命令，向显式选择的已打开 Shell 写入任意文本（等价于终端键盘输入），以及读取、删除或清空命令历史正文。攻击者仍无法直接获得已保存的秘密内容，无法读取文件内容、日志内容、终端输出或转发流量，无法创建 exec 通道，也无法获得 Client/Channel/SFTPWrapper/Socket/监听器。

## 6. Content Security Policy

CSP 由 `electron.vite.config.ts` 的 `termforge:csp` 插件注入 `index.html` 的 meta 标签。

### 生产

```text
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
font-src 'self' data:;
connect-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none'
```

- 生产环境禁止渲染进程发起任何网络连接（`connect-src 'none'`）。**SSH 与 SFTP 连接均由主进程建立，不经过渲染进程网络栈。**
- 不允许内联脚本、远程脚本、远程图片/字体、object 或表单提交。
- `style-src 'unsafe-inline'` 是已知放宽：React 会写入内联 `style` 属性。它只影响样式注入，不授予脚本执行能力。

### 开发

开发 CSP 额外允许 Vite/React Refresh 的 inline script 与指向 localhost/127.0.0.1 的 HTTP/WS `connect-src`。这些放宽只出现在未打包开发模式。

### 已知限制

- CSP 通过 `<meta http-equiv>` 注入，而不是 HTTP 响应头；`frame-ancestors` 在 meta 中不受支持，已在生成策略中移除。
- CSP 不是完整防御，主进程的导航/窗口/权限限制仍是必要边界。

## 7. 凭据处理

### 数据模型

- `ConnectionProfile` / `ConnectionInput` 没有密码、私钥内容或口令字段；strict schema 会拒绝意外传入的敏感字段。
- `credentialRef` 是非机密指针：私钥文件路径、`file://` URL、`~` 路径或凭据库引用。它不包含秘密内容。
- 凭据库条目只保存引用与 safeStorage 密文（Base64），不保存明文。

### 凭据来源

| 认证方式     | 主进程行为                                                               |
| ------------ | ------------------------------------------------------------------------ |
| `password`   | 从 safeStorage 凭据库读取；缺失时返回 `credential-required`，UI 提示输入 |
| `privateKey` | `credentialRef` 为私钥路径时由主进程读取文件；否则从凭据库读取私钥内容   |
| 加密私钥     | 检测加密格式后从凭据库读取 `passphrase`；缺失时提示输入口令              |
| `sshAgent`   | 仅使用系统 OpenSSH Agent；未检测到 Agent 时明确失败，不猜测第三方 Agent  |

- 私钥文件路径由用户配置，主进程只读取普通文件，限制 1–65,536 字节；支持绝对路径、`file://` 与 `~`。
- 文件路径会解析为绝对路径；不会执行 shell、不会展开任意环境变量。
- `saveCredential` 只允许与连接认证方式匹配的类型；SSH Agent 连接拒绝保存密码/私钥。私钥内容要求 PEM 头并去除首尾空白。
- 凭据库在每次读写前检查 safeStorage 可用性；不可用、损坏或解密失败时返回安全错误，**没有明文回退分支**。
- Electron 异步 `safeStorage`：Windows DPAPI、macOS Keychain、Linux 密钥环；Linux `basic_text`/`unknown` 视为不可用。

### 渲染进程与日志

- 密码/私钥口令输入使用非受控输入框，提交后立即清空 DOM 值；React state 与 Zustand 只保存凭据类型与错误元数据。
- 秘密通过单次 `ssh:set-credential` invoke 进入主进程，随后写入凭证库；IPC 单项上限 65,536 字符。
- 密码、私钥内容与口令不会写入 `connections.json`、`known-hosts.json`、日志、Toast 或错误消息。
- 主进程会把秘密短暂保存在内存中并传给 `ssh2`；没有显式内存清零或防止核心转储的保证。

## 8. 主机密钥策略

### 记录

`<userData>/known-hosts.json`：

```json
{
  "version": 1,
  "records": [
    {
      "host": "10.20.4.11",
      "port": 22,
      "algorithm": "ssh-ed25519",
      "fingerprint": "SHA256:...",
      "trustedAt": "2026-10-22T08:00:00.000Z",
      "updatedAt": "2026-10-22T08:00:00.000Z"
    }
  ]
}
```

- 只保存 host/port、算法、OpenSSH SHA-256 指纹与信任时间；不保存公钥之外的秘密。
- 同一 `host:port` 只保留一条记录；主机名匹配大小写不敏感。
- 文件损坏或版本不支持时停止加载，不覆盖现有信任决定。

### 校验流程

1. `ssh2` `hostVerifier` 提供原始公钥 blob；主进程解析算法并计算 `SHA256:` Base64 指纹。
2. `verify` 只返回 `trusted` / `unknown` / `changed`，**绝不写盘或自动信任**。
3. `trusted`（算法与指纹完全一致）才允许继续握手。
4. `changed` 立即拒绝，会话进入 `error(host-key-changed)`；已信任记录不被覆盖。
5. `unknown` 进入 `awaiting-host-key`，推送确认请求：
   - 用户接受：先显式 `trust` 写盘，成功后才 `verify(true)`；
   - 用户拒绝、关闭弹窗、Esc、点击遮罩：`verify(false)`，连接失败；
   - 30 秒无响应：`verify(false)`，`host-key-timeout`；
   - 信任存储异常：`verify(false)`，`host-key-storage-failed`，连接取消；
   - 会话关闭、窗口关闭、IPC 异常：`verify(false)`，不会自动信任。
6. 不支持或无法解析的算法直接拒绝。

**不存在自动接受所有 Host Key 的代码路径，也不存在因窗口关闭、IPC 超时或存储异常而自动信任的分支。** 指纹由实际握手密钥计算，不是 UI 模拟值。

### 已知限制

- 首次信任是 TOFU（Trust On First Use）；用户必须通过带外渠道核对指纹，否则无法发现首次即被中间人的情况。
- 设置页提供只读主机密钥列表与显式删除；删除必须经过确认弹窗，只影响信任记录，不会断开当前活动会话，但该端点下次连接会重新进入确认流程。
- 只校验主机密钥，不提供证书/CA 信任模型。删除记录不是安全事件的补救措施；若怀疑密钥被替换，还必须排查服务器与网络。

## 9. 渲染进程数据边界

- 渲染进程没有 `require`、`process`、`fs`、`child_process`、SSH 库或数据库访问。
- 连接元数据只能通过 `window.termforge.connections` 的 5 个固定方法读写。
- SSH 只通过 6 个固定方法 + 2 个事件使用；状态快照不含秘密。渲染端标签到会话的映射基于主进程返回的 `clientId`，不信任本地点击结果。取消连接只提交 `clientId`，不能借此操作其他标签或已连接会话。
- 终端只通过 5 个固定方法 + 3 个事件使用；终端输出/输入不进入 Zustand，重放缓冲位于模块级内存且有 256 KiB/标签上限。
- xterm.js 只负责渲染与键盘事件；不包含本地 shell、命令执行、`eval`、`new Function` 或动态脚本执行。
- 渲染端不做本地回显；输入直接发给主进程 PTY。
- SFTP 浏览只通过 8 个固定方法使用；没有浏览推送事件。页面只展示主进程返回的目录元数据（名称、类型、大小、mtime、权限），浏览方法不读取文件内容，也不访问本地文件系统。
- 本地文件浏览只通过 `localFs` 的 2 个固定只读方法（`roots`/`list`）使用；返回条目名称、类型、大小、mtime 与隐藏/截断标记，单个目录最多 5,000 条，不读取文件内容、不返回句柄、不写盘。
- 文件内容只在主进程中流动：渲染进程只能提交 `transferId`、`sessionId`、远程路径与批量入队所需的本地路径列表（主进程对每条路径重新校验存在性与类型、符号链接不跟随）；这些参数不构成任意文件读写入口。渲染进程永远拿不到文件句柄、`ReadStream`/`WriteStream`、SFTP 数据流或文件字节。
- 传输只通过 9 个固定方法 + 1 个 `transfer:update` 事件使用；任务快照包含用于界面展示的源/目标路径与文件名，但不含文件句柄、流对象、远程临时名或原始错误；任务状态由主进程写入快照，渲染进程无法伪造。
- 任务快照中的本地绝对路径对渲染进程可见（用于展示任务来源/目标），但不赋予任何读取能力；若渲染进程被 XSS 攻陷，该路径信息本身可能泄露用户名与目录结构，CSP 与依赖审计仍然关键。
- `transferStore` 只是主进程任务的只读投影：按 `revision` 单调合并、忽略过期快照，不自行推断或写入任务状态；清空历史只影响已进入终态的记录。
- 上传完成后，渲染端仅按 `sessionId` 与目标父目录匹配，在 200 ms 防抖后重新调用受控的 `sftp:list`，不信任任务快照中的目录内容。
- `sftpStore` 按标签保存浏览状态；目录切换与会话切换使用请求 ID 和 `sessionId` 守卫忽略迟到响应，关闭标签或 SSH 断开后清理，避免旧响应覆盖新路径。
- 没有 `localStorage`、`sessionStorage`、IndexedDB 或渲染进程文件写入；设置只能经固定 IPC 交给主进程持久化，完整传输历史与进度只存在主进程内存（仅未完成任务快照写入主进程传输日志）。
- 设置只包含主题、终端显示、传输并发、日志级别、壁纸开关/浓度与 `autoReconnectEnabled`，不包含秘密、主机地址、凭据引用或任意路径；日志由主进程写入并只在用户主动导出时落到用户选择的位置。
- 壁纸图片由主进程重编码后以 JPEG data URL 返回，渲染进程只保存该字符串与文件名；不接触源路径、原始文件或图片解码器。`img-src 'self' data:` 允许该 data URL，生产 CSP 的 `connect-src 'none'` 不受影响。若渲染进程被 XSS 攻陷，攻击者可读取当前壁纸图片与文件名，并可调用 `choose`/`remove` 触发原生对话框或删除壁纸，但无法让主进程读取任意路径或返回任意文件。
- 没有 `dangerouslySetInnerHTML` 或 `innerHTML` 注入。
- 唯一剪贴板操作是用户点击「复制地址」后写入 `host:port`，不读取剪贴板。
- 端口转发只通过 7 个固定方法 + 1 个 `port-forwards:snapshot-updated` 事件使用；渲染端只保存规则/运行时快照与本地请求状态，无法获得监听器、Socket、Channel、流量或 `ssh2.Client`。非回环监听确认与有规则时的连接级联确认都在主进程再次校验，渲染端不能仅凭点击把规则标记为运行中或绕过清理。
- 多标签之间不共享 SSH Client、PTY 或 SFTP 通道；同一连接配置的多个标签也各自独立认证，主进程最多同时保留 32 个活动会话。端口转发规则通过显式选择的 `sessionId` 绑定到一个会话，不会因其他标签重连而迁移。
- 关闭标签与重连会解绑旧终端并忽略旧 `sessionId` 的迟到事件；SFTP 页面与传输任务随会话关闭或断开而失效；关闭请求幂等且有界等待，不会因重复关闭破坏其他会话。
- 应用退出时先阻止新连接与新传输，再按固定顺序执行传输、SFTP、SSH 与日志清理；每个步骤独立 4 秒上限，单步失败/超时不会阻断后续步骤，`before-quit` 只执行一次并在清理完成后才真正退出。临时文件清理自身仍有 10 秒上限，传输收敛等待 3 秒、日志冲刷 1.5 秒。
- 设置、端口转发规则与未完成传输快照跨重启保留；SSH 会话镜像、Shell 生命周期、SFTP 浏览状态、端口转发运行时/监听器、传输投影、分屏布局、自动重连计时器与重试计数仅存在内存中。重启后端口转发规则保持 `stopped`，未完成传输只显示为 `interrupted`，两者都不会自动执行；分屏布局重置为单窗格，自动重连不恢复。
- 分屏仅改变两个窗格的可见性与绑定关系，不新增 IPC 通道、不调用 SSH 连接/断开，也不复制终端输出；每个窗格绑定的仍是标签原有的唯一 SSH 会话与唯一终端实例。关闭/重连一个窗格对应的会话不会写入另一个窗格的终端、状态或错误。
- 自动重连由渲染进程按主进程推送的固定 `SshFailure.code` 调度，主进程不持久化计时器或重试任务；重试前会重新执行主机密钥与认证流程。认证失败、主机密钥变化、用户主动断开、用户取消、设置关闭、标签关闭与应用退出都会清除计时器并结束序列，不重放终端输入、快速命令或未确认数据。

### 分屏、连接取消与自动重连（P1-05）

- **固定错误码白名单**：自动重试只对 `network-error`、`connection-timeout`、`dns-failed`、`connection-refused`、`remote-closed` 生效；判断依据是主进程快照中的 `SshFailure.code`，不匹配错误消息文本。`auth-failed`、`host-key-changed`、`host-key-timeout`、`credential-required`、`cancelled`、`user-closed` 等其余代码一律不重试。
- **有界且可取消**：最多自动尝试 5 次，间隔固定为 1、2、4、8、15 秒；用户取消、主动断开、关闭标签、关闭窗口、退出应用或关闭设置开关会立即清除计时器并结束序列。达到上限后进入 `exhausted` 终态，必须由用户手动重连。
- **不降低安全强度**：每次重试都重新创建 SSH Client 并重新执行主机密钥校验与认证/跳板流程；不自动信任未知或变化的主机密钥，不忽略认证失败，不缓存或重放密码、口令、私钥、终端输入或快速命令。
- **状态不伪造**：`reconnecting` 只表示本标签正在重新尝试，不代表旧 Shell、前台进程或服务器上下文已恢复；新会话建立后创建新的 PTY，旧 `sessionId` 的迟到事件按 epoch 丢弃。无法恢复绑定时显示断开/错误状态或空窗格，并要求用户重新选择。
- **取消隔离**：`cancelConnect(clientId)` 只作用于该标签正在进行的连接尝试；不关闭标签、不影响另一窗格或其它标签，不取消已建立的会话。取消后迟到的连接成功结果由主进程收敛并清理 transport，渲染端不会把它写回已取消标签。
- **分屏无 SSH 副作用**：分屏开关、方向切换、比例调整、窗格聚焦与窗格解绑只修改渲染运行态和可见性，不调用 `ssh:connect`/`ssh:disconnect`，不创建第二份 SSH Client、PTY 或终端实例；每个标签始终最多一个 SSH 会话与一个终端实例。
- **不持久化运行态**：分屏布局、窗格绑定、焦点、自动重连计时器与尝试次数都不写入磁盘；重启后重置。设置文件只在用户开启时保存布尔 `autoReconnectEnabled`，不保存任何重试任务或会话标识。

## 10. SSH 端口转发边界（P1-03）

### 监听暴露

- 本地与远程转发默认监听 `127.0.0.1`；输入非回环 IP 字面量时，启动弹窗要求用户勾选暴露风险确认，服务在缺少 `confirmExposure: true` 时再次拒绝。不存在默认 `0.0.0.0` 或自动扩宽绑定的分支。
- 远程转发的监听地址由 SSH 服务器执行；主进程使用服务器返回的实际端口，不把拒绝重试为其他地址。`dynamic` 规则在 schema 与运行时都固定为 `127.0.0.1`，不提供“局域网 SOCKS”选项。
- 允许用户显式确认非回环本地/远程监听是产品能力，不等于安全建议；UI 与文档明确提示这会向其他主机暴露端口，防火墙与服务器配置仍由用户负责。

### 流量与协议

- 主进程只做字节转发与背压：本地转发使用 `net.Server`/`forwardOut`，远程转发使用 `forwardIn`/`tcp connection`/本地 `net.Socket`，动态转发使用回环 `net.Server` + RFC 1928 握手 + `forwardOut`。不解析、不记录、不持久化隧道内容，也不把 payload 发送给渲染进程。
- SOCKS5 首版只支持 no-auth CONNECT：IPv4、域名与 IPv6 目标；BIND、UDP ASSOCIATE、SOCKS4 与未知命令返回协议错误，不做静默降级。握手有 10 秒超时与 1,024 字节上限，解析器容忍分片与合并包。
- 每规则最多 64 个连接、全局最多 256 个；超出时拒绝新连接而不是无限排队。停止会关闭监听器/远程绑定并销毁活动连接，5 秒内无法收敛时保留 `cleanupPending` 并阻止删除。
- 窄门面只暴露 `forwardOut`/`forwardIn`/`unforwardIn`/`onTcpConnection`/`onClosed` 与 `closed`，不暴露 `ssh2.Client`、认证配置或跳板链内部对象；跳板链仍由 `SshService` 按 P1-02 规则建立与清理。

### 生命周期与删除

- 规则状态以主进程为准：只有监听器/远程绑定真实建立后才显示 `running`；启动失败、运行中失败、停止失败与清理未完成都以固定失败码和 `cleanupPending` 表达，不把未确认的清理描述为成功。
- SSH 会话结束会停止相关规则；**不会**在重连后静默把规则迁移到新 `sessionId`，也不会自动重启。应用重启后规则保持 `stopped`，用户必须重新选择已连接会话并显式启动。
- 删除连接前必须加载该连接的规则影响；有规则时要求显式级联确认。确认后主进程先停止并删除全部规则，任何停止/清理失败都会阻止连接删除。删除顺序为“规则 → 连接”，若连接删除在规则删除后失败，规则已被移除，需重新创建；这是已知的残余风险。

### 日志与验收

- 端口转发日志（若未来增加）只允许记录固定事件与规则 ID/类型/状态，不记录目标流量、Socket 数据、凭据、完整目标清单或应用层内容。当前不提供转发流量日志。
- 自动化测试只覆盖 fake 门面、本机回环 Socket 与手写 SOCKS5 客户端；**没有在真实 SSH 服务端执行端口转发验收**，也没有 Electron 实窗暴露确认/级联删除手工验收。不得把 mock 测试描述为真实服务器兼容性证明。

## 11. 快速命令与命令历史边界（P1-04）

### 执行面

- 快速命令不创建新的执行通路：发送复用 `terminal:write` 对应的 `SshService.writeShell`，写入目标会话的既有 Shell Channel；不新建 SSH Client、不打开 exec 通道、不启动本地 shell。插入与发送都只作用于用户显式选择的已连接标签。
- 目标校验在渲染端与主进程双重执行：`tabId`/`sessionId` 必须绑定、SSH 必须 `connected`、Shell 必须 `open`。目标关闭、断开或被替换时拒绝操作，不自动切换标签、不自动重发；发送前先冲刷该标签已排队的终端输入，主进程再按请求 ID 去重并限制每标签一个在途发送。
- 模板只做 `{{identifier}}` 字面单次替换，不使用 `eval`/`new Function`/本地 shell；参数值不会再次解析为模板。应用**不承诺通用 shell 转义**，参数中的 `;`、`$()`、引号等仍可能被远端 Shell 解释，用户必须在预览中确认语义。
- 内置命令固定为只读诊断，应用不提供“重启/停止/删除”类内置模板；自定义命令可改变服务器状态，但必须预览、显式选择目标并确认，且不会在应用启动、连接、重连或标签切换时自动执行。
- 历史重发（`kind: 'history'`）使用用户确认过的最终正文，仍受长度/控制字符 schema 与目标校验约束；它等价于再次向终端键入文本，不获得额外权限。
- 快速命令的渲染端入口不读取终端输出，也不接触 Shell Channel；主进程只返回命令/历史元数据与固定错误消息。

### 命令历史隐私

- 命令历史默认关闭（新安装 `commandHistoryEnabled: false`），必须在设置中显式开启；关闭后仍可查看、复制、删除与清空已有记录，但任何发送都不会新增记录。
- 只有设置开启且本次发送勾选「记录本次发送」时，主进程才把最终正文、发送时间与目标元数据追加到独立的 `command-history.json`；不记录终端输入输出、退出码、参数表、命令输出、工作目录或凭据。
- 历史和诊断日志分离：命令正文与参数值不写入 `logs/termforge*.log`；但历史文件本身**不额外加密**，依赖操作系统账户与磁盘权限，拥有同一用户账户访问权的进程可以读取。设置页与抽屉均明确披露，并提供关闭与清空入口。
- 最多 200 条，最新在前；单条删除与清空按 ID/文件操作，不需要终端或 SSH 会话。清空遇到损坏文件时会写入空历史以恢复可用状态。
- 历史写入失败不回滚已写入终端的命令，主进程返回 `historyRecorded: false` 与固定警告；界面不会把“命令已发送”误报为“历史已保存”。
- 若渲染进程被 XSS 攻陷，攻击者可以读取、删除或清空历史正文（其中可能包含内网主机名、服务名或参数），但无法读取终端输出、日志或凭据。这是历史功能的已知隐私代价。

### 验证与限制

- 自动化测试只使用 fake `SshService` 窄方法、临时目录与 mock bridge，不能证明真实 SSH 兼容性。
- P1-04 受控验收使用源码模式 Electron + 本地真实 `ssh2` 夹具服务器（密码认证、PTY/Shell）+ CDP，18/18 项通过并生成 10 张截图；它验证了真实 Shell 写入、目标失效不自动切换、历史开关与持久化，但**不是 Windows OpenSSH Server 验收，也不是 NSIS 打包安装包验收**，未覆盖真实生产网络、权限异常、磁盘满或系统休眠。
- P1-05 自动化覆盖分屏模型、窗格绑定、取消连接隔离、自动重连固定错误码、上限/退避与清理；受控验收使用源码模式 Electron + 本地真实 `ssh2` 夹具服务器 + CDP，19/19 项通过并生成 10 张截图，覆盖两窗格切换、方向/比例、取消连接、意外断线与有界自动重连。**真实 OpenSSH Server、真实网络抖动、长时间断网与 NSIS 打包安装包仍未执行验收**，不能把夹具结果等同于这些环境。

## 12. 日志与错误

- 主进程使用 `Logger` 输出结构化 JSONL 到 `<userData>/logs/termforge.log`；日志目录以 `0700` 创建、文件以 `0600` 写入，单文件默认 2 MiB、保留 5 个文件并按大小轮转，单行上限 16 KiB。
- 日志事件只包含时间、级别、固定模块/事件名和非敏感元数据；**不主动记录**连接输入、密码、私钥、口令、终端输入、命令内容、终端输出、文件内容或凭据。快速命令正文、参数值、命令历史与发送目标不写入诊断日志；历史只写入独立的 `command-history.json`。当前写入的事件限于启动/退出结果、退出步骤失败、日志导出字节数、传输并发上限更新与启动恢复的任务数量；传输任务路径、文件名与 SFTP 目录不写入日志。
- `redact.ts` 作为第二道防线：对敏感键名（password/token/secret/privateKey/apiKey/credential/cookie/authorization/terminalInput/terminalOutput 等）、PEM 私钥、`password=...`/`api_key: ...`、`Authorization` 头与 URI 内嵌凭据做脱敏；限制字符串 2,048 字符、数组 100 项、对象深度 6，并处理 Error/cause/循环引用。该机制不能替代调用方不传秘密的约束。
- 日志写入失败只累计 `writeFailures`，绝不把异常抛回 SSH/SFTP/传输/设置流程；日志级别可由用户设置为 `error/warn/info/debug`。
- 日志导出只允许用户主动触发：主进程打开原生保存对话框，读取固定目录的白名单日志，最多 20 MiB，并在写入前对文本再次脱敏；没有读取任意日志内容或任意路径的 IPC。
- `ssh2` 原始错误不进入日志，也不跨 IPC；统一映射为固定 `SshFailureCode` 与安全消息。
- 终端通道错误只记录/推送固定的 `shell-error` 类消息；不记录终端数据内容。
- SFTP 错误只映射为固定错误码与安全消息，不包含服务器路径、目录条目或原始 `ssh2` 错误。
- 传输错误只映射为允许列表中的 `TransferErrorCode` 与固定中文消息；错误消息与日志不包含本地绝对路径、远程目录、文件名、临时名或原始 fs/SFTP 错误。任务快照本身包含用于展示的路径与文件名，但不含临时名。
- IPC 错误通过 `toOperationError` 归一；内部错误只返回固定消息。
- 凭据补录失败只返回“无法读取系统凭据存储”等固定描述，不包含实现细节。
- 认证失败、主机密钥变化与网络错误会在 UI 中展示可操作的固定消息。
- 设置文件只包含非敏感偏好；其警告/错误文案是固定描述，不包含文件内容或绝对路径。恢复警告会明确提示哪些字段被回退，避免把未保存状态描述为已保存。
- 壁纸服务不记录源路径或文件名到日志；只返回固定错误消息。图片解码与重编码在主进程完成，错误不包含原始路径或底层图像错误。
- 端口转发错误只映射为固定 `PortForwardFailureCode` 与安全消息；不记录或返回 Socket 数据、应用层 payload、凭据、原始 `ssh2` 错误或内部监听器对象。转发规则的目标主机/端口只作为规则快照展示，不写入诊断日志。

## 13. 供应链与依赖

- 依赖版本固定，`package-lock.json` 已提交。
- 当前运行时依赖包含 `ssh2@1.17.0`、`@xterm/xterm@6.0.0` 与 `@xterm/addon-fit@0.11.0`；`@types/ssh2` 仅用于类型。xterm 只在渲染进程渲染文本，不获得 Node/SSH 能力。
- 终端输出按文本写入 xterm，不使用 `innerHTML`；xterm 的 ANSI/控制序列处理属于其渲染职责。
- Electron、React、Zustand、Zod、Lucide 与构建/测试工具来自 npm 公共生态；上生产前仍应执行依赖审计、漏洞扫描与升级策略。
- Electron 二进制安装失败时的镜像配置仅是排障手段，不改变运行时安全配置。

## 14. 开发与验证注意事项

- 不得为调试而关闭 `contextIsolation`、`sandbox`、CSP 或导航限制。
- 开发工具只在开发模式启用，不应通过命令行开关在打包应用中打开。
- 测试中的 IPC/SSH/SFTP/端口转发 fake 只用于验证边界与状态机，不能替代真实环境的安全测试；传输测试使用真实本地临时目录与流，但远端仍是 fake `SFTPWrapper`；端口转发测试使用 fake 门面与本机回环 Socket，不等于真实服务器集成测试。
- 安全相关改动至少运行 `npm run typecheck`、`npm run lint`、`npm test`、`npm run build`，并在 Electron 实窗中验证导航、权限、bridge、真实 SSH 握手、PTY 交互、两窗格分屏与焦点隔离、连接取消、意外断线与有界自动重连、SFTP 目录/文件操作、真实上传/下载与冲突处理、端口转发本地/远程/SOCKS5 监听与暴露确认、级联删除、快速命令显式目标发送/插入、历史默认关闭与清空，以及断线/退出清理。
- P1-05 门禁结果（2026-10-24）：`typecheck` 通过、`lint` 通过、57 个测试文件 / 530 个测试通过、`build` 通过且仅保留 2 条 zod Rollup 注解警告；受控验收 19/19 通过。测试与夹具通过不等于真实 OpenSSH/真实网络验收。

## 15. 残余风险与后续要求

| 风险/缺口                      | 当前状态 / 后续要求                                                                                                                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 未进行真实 SSH/SFTP 集成验收   | 测试使用 fake Client/Channel/SFTPWrapper 与 fake xterm，传输测试只使用真实本地临时文件 + fake 远端；需在隔离环境用真实 OpenSSH 服务端验证认证、PTY、SFTP 列举/统计/变更、上传/下载、冲突与断线清理、Unicode 与特殊字符、权限、符号链接、非空目录拒绝 |
| SFTP 变更操作存在 TOCTOU/竞态  | mkdir/rename 先 stat 再执行，远端状态可能在间隙变化；主进程按路径加锁、渲染端限制并发，但操作不是服务端原子事务，仍可能返回 `already-exists`/`not-found` 或 `outcome-unknown`                                                                        |
| SFTP 删除的最终权限边界        | 根目录、受保护系统目录、浅层目录、符号链接与非空目录检查是纵深防御，不是操作系统权限边界；SSH 账号可删除的文件仍可能被删除                                                                                                                           |
| 渲染进程 XSS 的 SFTP 能力面    | 即使无 Node 与文件内容通道，攻击者仍可列举、创建、重命名和删除当前 SSH 账号可操作的远程文件；CSP 与依赖审计仍关键                                                                                                                                    |
| SFTP 单通道与超时              | 每个 SSH 会话复用一条 SFTP 通道，读操作 30 秒超时、打开通道 15 秒超时；大目录列举可能超时；传输流与目录浏览共用该通道，可能相互拖慢                                                                                                                  |
| SFTP 路径与字符集              | 允许空格、Unicode 与常见特殊字符，拒绝 NUL/控制字符与相对路径；服务端 locale/编码差异仍可能导致显示异常                                                                                                                                              |
| 传输提交存在 TOCTOU            | 上传/覆盖/重命名在提交前复查源与目标，但检查与 `rename` 之间远端可能变化；不覆盖策略依赖预检而非服务端原子 no-replace，可能失败或出现非预期结果，需用户刷新核实                                                                                      |
| 临时文件与备份残留             | 只清理本任务记录在案的 `.termforge-part-*` / `.termforge-backup-*`；进程被强杀、断电或清理超时可能留下残留，需要用户手工确认删除；不会清理非本任务创建的文件                                                                                         |
| 无断点续传/暂停/恢复执行       | 取消、断线或退出后只能重新上传/下载整个文件；未完成任务快照跨重启保留但只显示为 `interrupted`/`outcome-unknown`，不会自动排队或续传；不得将当前行为描述为可恢复                                                                                      |
| 传输取消与超时的边界           | 运行中取消会中止流并等待 8 秒收敛；远端/本地已写入的部分数据以临时文件形式清理，清理失败会以 `cleanup-failed` 告警但任务可能已结束                                                                                                                   |
| 渲染进程 XSS 的传输能力面      | 攻击者可发起原生选择器或批量入队、cancel/retry 与冲突决策，把当前 SSH 主机上的文件下载到本地任意可写目录，或上传本地任意可读文件（主进程仅校验存在性与类型）；任务快照还暴露所选绝对路径。渲染进程无法直接读取或写入文件内容                         |
| 渲染进程 XSS 的本地列举能力面  | `localFs.list` 可对任意绝对路径做只读列举，暴露本地目录结构、文件名、大小与 mtime 等元数据（含用户名）；不读取文件内容、不写盘，条目中的符号链接只标记类型、不跟随目标。CSP 与依赖审计仍是主要防线                                                   |
| 首次信任是 TOFU                | 用户必须带外核对指纹；未来可增加指纹展示/审计与证书模型                                                                                                                                                                                              |
| 主机密钥信任删除               | 设置页可删除信任记录，但没有审计日志或批量轮换流程；删除后下次连接重新确认，当前活动会话不受影响                                                                                                                                                     |
| 未完成传输日志含展示路径       | `<userData>/transfer-journal.json` 保存任务显示用的源/目标路径，可能泄露用户名与目录结构；不含文件内容或凭据，任务完成/清理后不再写入                                                                                                                |
| 日志脱敏不是内容隔离           | 键名/文本脱敏是第二道防线；若未来调用方违规记录秘密，仍可能因未知格式漏脱敏。代码审查与“只记录固定事件”约束仍是主要边界                                                                                                                              |
| 端口转发未做真实服务端验收     | 本地/远程/SOCKS5 仅使用 fake 门面、本机回环 Socket 与手写 SOCKS5 客户端测试；未验证真实 OpenSSH 的 `forwardOut`/`forwardIn`/`unforwardIn`/`tcp connection` 行为、服务器转发权限、防火墙/端口占用与断线清理。**真实 SSH 验收未执行**                                                |
| 端口转发监听暴露风险           | 非回环本地/远程监听可被网络中的其他主机访问；产品要求显式确认并在 UI 提示，但不提供网络访问控制、身份认证或加密，用户需自行配置防火墙与目标服务。SOCKS5 强制回环且无认证，任何本机进程均可使用该代理                                               |
| 端口转发规则与连接删除顺序     | 连接删除先停止并删除规则、后删除连接配置；若连接仓库删除随后失败，规则已被移除，用户需重新创建。主进程在删除前重新计算影响并要求显式级联确认，但不能把两步操作变成跨仓库原子事务                                                 |
| 端口转发清理失败               | 停止/解绑失败会保留 `error + cleanupPending` 并阻止删除，但进程被强杀或 SSH 服务器失联时，远程监听或本地端口可能短暂残留；重启后应用不假定监听仍存在，用户需自行核实端口占用与服务器端转发状态                                      |
| 命令历史明文存储               | `<userData>/command-history.json` 不额外加密，命令正文、连接名与主机名可被同一用户账户下的进程读取；最多 200 条，提供关闭、单条删除与清空，但不提供加密或导出。产品已明示该边界，敏感命令不应记录                                                         |
| 渲染进程 XSS 的历史能力面      | 攻击者可读取、删除或清空命令历史正文，并可通过快速命令/历史重发向用户显式选择之外的任何已打开 Shell 写入任意文本（等价于终端输入）；无法读取终端输出或日志。CSP、依赖审计与最小 bridge 仍是主要防线                                                       |
| 快速命令目标竞态               | 渲染端校验并冲刷队列后，标签仍可能在主进程写入前断开或更换会话；主进程在写入前立即复核 `tabId`/`sessionId`/Shell `open`，但仍无法保证远端命令执行成功，写入成功只代表文本已写入通道。请求去重仅保留最近 200 个请求 ID，应用重启后不保留                                |
| 模板不是通用 shell 转义        | 应用只做字面替换，不转义 `;`、`$()`、引号、换行（换行本身被拒绝）等 shell 语义；参数值仍可能被远端 Shell 解释。预览与显式确认是唯一语义核对手段，不能把模板视为安全命令构造器                                                 |
| 快速命令验收范围               | 自动化测试使用 fake SSH/Shell；受控验收使用源码模式 Electron + 本地真实 `ssh2` 夹具服务器，18/18 项通过，但不是 Windows OpenSSH Server、真实生产网络或 NSIS 打包安装包验收；未覆盖权限异常、磁盘满、系统休眠与历史文件损坏后的手工恢复流程 |
| 设置写入与退出交接             | 设置采用原子写入和串行队列，但进程被强杀时最后一次写入可能未完成；退出清理每步 4 秒上限，极端卡死时仍可能留下临时文件或未冲洗日志，不能声称一定完成                                                                                                  |
| 壁纸内容与文件名               | 壁纸源图经主进程校验、缩放与 JPEG 重编码，但渲染进程仍能读取当前壁纸 data URL 与原始文件名 basename；若渲染进程被 XSS 攻陷，这些内容可能泄露。壁纸源路径不跨 IPC，也不会进入日志                                                                     |
| 壁纸解码资源占用               | 源文件限制 ≤20 MiB、输出最长边 2,560px；仍可能消耗短暂 CPU/内存进行解码与缩放。仅接受 PNG/JPEG，不支持 SVG、GIF、WebP 或动画格式                                                                                                                     |
| 渲染进程 XSS 的能力面          | 即使无 Node，攻击者可通过 bridge 发起连接、向 PTY 写入文本或写入凭据；CSP 与依赖审计仍关键                                                                                                                                                           |
| 主进程内存中的秘密             | 无内存清零/核心转储防护；属于桌面应用的已知残余风险                                                                                                                                                                                                  |
| 终端 IPC 频率/大小限制         | 写入单次 ≤65,536 字符、渲染端 32 KiB 分片；输出批量 8ms/64 KiB 并有 1M 字符背压水位；尚无跨窗口/多路复用限流                                                                                                                                         |
| 终端输出留在内存               | 每标签重放缓冲最多 256 KiB，关闭标签后清理；不做磁盘记录，避免敏感输出落盘                                                                                                                                                                           |
| 多标签并发会话                 | 每标签独立 Client/PTY/SFTP 通道，最多 32 个活动会话；关闭/重连只影响本标签，但仍共享同一渲染进程与凭据库                                                                                                                                             |
| 终端 ANSI/控制序列             | 由 xterm.js 解析渲染；恶意远端可发送清屏、标题等控制序列，但不会获得本地命令执行能力                                                                                                                                                                 |
| 自动重连为有界重试             | 默认关闭，最多 5 次（1/2/4/8/15 秒），只对固定错误码生效；每次重新握手与认证，不恢复旧 Shell、前台进程、传输或端口转发。达到上限后需用户手动重连；真实网络抖动/长时间断网下的行为未做真实环境验收                                                                         |
| 分屏仅两个窗格                 | 分屏布局只存在于渲染运行态，不提供多窗格、拖拽跨窗格迁移或布局持久化；一个标签仍只有一个 SSH 会话与一个终端实例，分屏不改变连接生命周期。渲染进程被 XSS 控制时仍只能操作既有标签与终端写入面                                                                                          |
| 连接取消的迟到结果             | `ssh:cancel-connect` 会先收敛为 `disconnected(cancelled)` 再销毁 transport，并用 epoch 丢弃迟到成功；但底层 `ssh2` 握手/认证回调的物理完成时刻不受应用控制，极短窗口内仍可能短暂持有已取消的 Client，需依赖有界清理                                                                     |
| 无键盘交互认证                 | keyboard-interactive 明确未实现；仅支持 password/privateKey/Agent，部分服务器可能需要键盘交互方式                                                                                                                                                    |
| 跳板链路信任边界               | 每一跳都独立校验主机密钥与凭据，但不验证「该跳板是否被授权转发到目标」；若跳板被攻陷，它可以记录或篡改流量（TCP 转发本身不提供端到端机密性保护）。跳板 Socket 只存在于主进程内存                                                                     |
| Agent 生态                     | 仅系统 OpenSSH Agent；Pageant 与第三方 Agent 未支持                                                                                                                                                                                                  |
| Windows 文件权限               | 原子写入请求 `0600`，但实际访问控制依赖用户目录 ACL；未做跨用户隔离验证                                                                                                                                                                              |
| 主机密钥文件非机密             | 只含公钥元数据；泄露不直接导致认证失陷，但可能泄露拓扑                                                                                                                                                                                               |
| CSP `style-src` 放宽           | 已知；引入远程数据前应评估样式注入面                                                                                                                                                                                                                 |
| CSP 元标签与 `frame-ancestors` | 当前应用不在网页中加载；若未来提供浏览器载体需改用响应头                                                                                                                                                                                             |
| 备份/迁移                      | 没有显式备份或迁移流程；版本不匹配时停止加载                                                                                                                                                                                                         |
| 打包、签名、自动更新           | 未实现；上生产前必须补齐签名、哈希校验与安全更新链路                                                                                                                                                                                                 |
| 安全审计                       | 未进行第三方审计或渗透测试；不得将本文件视为合规认证                                                                                                                                                                                                 |

发现安全问题时，应记录复现步骤、影响范围与受影响版本，暂停相关功能的发布，并在修复后补充回归测试。
