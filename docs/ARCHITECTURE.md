# TermForge 架构说明

本文描述 P1-05 实际落地的架构：SSH 连接、交互式 PTY、SFTP 文件管理、文件上传/下载、SSH 端口转发与快速命令均由 Electron 主进程通过 `ssh2` 与 Node 网络/文件流建立和维护，渲染进程通过 xterm.js 展示远程输出并发送键盘输入，只接收脱敏状态快照、目录元数据、传输任务快照、端口转发快照与快速命令元数据。工作区标签与 SSH 会话分离，每个标签拥有独立 SSH transport；手动重连保留标签并更换会话。TASK-008 增加持久化设置中心、脱敏结构化日志与导出、主机密钥删除入口、传输未完成任务日志与真实的有界顺序关闭；P1-01 增加本地/远程双栏文件管理与拖拽，P1-02 增加有序跳板链，P1-03 增加本地/远程 TCP 转发与仅回环的 SOCKS5 CONNECT 动态转发，P1-04 增加快速命令库、字面参数模板、显式目标发送/插入与默认关闭的命令历史。P1-05 增加运行态双窗格分屏（左右/上下、比例与窗格绑定不持久化）、按 `clientId` 定向取消在途连接，以及默认关闭、最多 5 次且仅对固定网络类错误码生效的自动重连；分屏布局不拥有 SSH 会话，自动重连重新执行完整的认证与主机密钥校验，不重放输入。**不包含断点续传、暂停恢复或自动重启执行**；未完成任务只在重启后显示为 `interrupted`，绝不会被当作已完成或自动恢复。端口转发规则跨重启保留但保持 `stopped`，不自动监听、不自动重新绑定。快速命令不会在应用启动、连接建立、重连或标签切换时自动执行，命令历史默认关闭。壁纸皮肤模式把用户导入的本地图片限制在主进程解码、缩放与重编码，渲染进程只拿到 JPEG data URL；纯色主题与终端/正文的不透明可读性保持不变。

## 1. 目标与边界

本阶段目标：

- 在渲染进程点击服务器时发起真实 SSH 连接，支持密码、私钥文件、加密私钥口令与系统 SSH Agent 认证。
- 将主机密钥校验接入 `ssh2` 的 `hostVerifier`，首次连接必须由用户显式确认，已信任密钥发生变化时阻止连接。
- 凭据只从操作系统保护的安全存储或用户显式指定的私钥文件读取，不进入渲染进程状态、普通配置文件或日志。
- 连接状态由主进程权威维护；渲染进程 store 只是快照镜像，并支持取消订阅主进程推送事件。
- 在既有 SSH 会话上打开真实交互式 Shell（PTY），用 xterm.js 显示输出、发送输入并同步窗口尺寸；不建立“每次击键一条 SSH 连接”的模型。
- 工作区标签作为稳定身份（`clientId`），同一配置可在多个标签中并行建立互不共享的 SSH 会话；关闭标签与重连按幂等、有序的清理流程执行。
- 在既有 SSH 会话上打开真实 SFTP 通道，支持目录浏览、导航、元数据展示、新建目录、重命名、删除文件与安全的空目录删除；不递归删除，拒绝根目录和明显危险的系统目录。
- SFTP 状态按标签/SSH 会话隔离；迟到目录响应、旧会话响应与并发同名操作不得覆盖或破坏当前状态。
- 在既有 SFTP 通道上执行真实上传/下载：本地文件经系统对话框或双栏面板/拖拽由主进程校验，文件内容只通过主进程的本地文件流与 SFTP Read/Write 流传输；每个文件是独立任务，支持批量、FIFO 队列、进度/速度、取消、手动重试与覆盖/重命名/跳过冲突处理。
- 传输任务状态以主进程为唯一权威；渲染进程只保存带单调 `revision` 的只读投影，迟到快照不得回退 UI。
- 本地文件系统以主进程 `LocalFsService` 为唯一访问点：`local-fs:roots`/`local-fs:list` 只读返回目录元数据（名称、类型、大小、mtime、隐藏标记与截断标记），不读取文件内容；拖拽/面板入口提交的本地路径由 `TransferService` 逐条重新校验（绝对路径、设备前缀、存在性与类型、目录展开上限）后才创建任务。
- 在既有 SSH 会话上提供本地 TCP 转发、远程 TCP 转发与 SOCKS5 CONNECT 动态转发；规则经 strict schema 持久化，默认监听 `127.0.0.1`，非回环本地/远程监听必须显式确认暴露风险，SOCKS5 只允许回环。运行时状态、监听器、Socket/Channel 与连接计数只在主进程，规则启动成功后才进入 `running`。
- 提供快速命令库与命令历史：内置只读诊断命令与自定义命令共用 `{{identifier}}` 参数模板，发送与插入必须显式选择已连接且 Shell `open` 的终端会话，复用既有终端写入通道；命令历史默认关闭，只记录用户确认发送的快速命令最终正文与目标元数据，并与诊断日志分离。
- 提供严格两窗格分屏：左右或上下排列，比例限制在 20%–80%，焦点与窗格绑定只存在于运行时 `workspaceStore`；每个标签仍只有一个 xterm 实例与一个 PTY，布局操作绝不调用 SSH connect/disconnect，也不关闭或迁移会话。
- 提供按标签定向的连接取消与自动重连：`ssh:cancel-connect` 只终止指定 `clientId` 的在途尝试，不关闭标签、不影响其他窗格；自动重连默认关闭，开启后仅对 `network-error`、`connection-timeout`、`dns-failed`、`connection-refused`、`remote-closed` 以 1/2/4/8/15 秒退避最多尝试 5 次，每次重新执行既有 SSH、凭据、主机密钥与跳板流程，不自动信任新密钥、不重放输入，并在用户取消、主动断开、关闭标签、设置关闭或应用退出时立即停止。

当前边界：

- **SSH 已连接不等于 Shell 已打开**。`connected` 表示传输层与认证完成；PTY 有独立的 `idle/opening/open/closing/closed/exited/error` 生命周期。
- **SFTP 与文件传输只在已连接的 SSH 会话上可用**。二者都是 SSH 的从属 Channel，不单独建立网络连接；未连接、断开或错误状态的会话拒绝操作。
- **不包含暂停/恢复、断点续传或自动重启执行**。上传支持目录递归：拖入的目录在入队前展开为逐文件任务（保留文件夹名与相对结构、符号链接不跟随、目录深度 ≤64、单次展开任务上限默认 500 并报告截断）；下载只接受普通文件，远程目录与符号链接不会加入任务。取消或失败只清理本任务创建的临时文件。未完成任务快照会跨重启保留，但只显示为 `interrupted`/`outcome-unknown`，不会自动执行。
- 快速命令不是通用脚本引擎：只做 `{{identifier}}` 字面单次替换，不提供条件、循环、输出捕获或通用 shell 转义，不在应用启动、连接建立、重连或标签切换时自动执行。发送目标只接受用户显式选择的活动会话，目标失效时拒绝发送，不自动切换或自动重发。命令历史默认关闭；关闭后不新增记录但保留已有记录的查看/删除能力，历史文件不额外加密。
- **分屏固定为两个窗格**，不支持三窗格以上或拖拽拆分；方向、比例、焦点与窗格绑定只存在于运行态，不写入 `settings.json` 或其他持久化文件。分屏不改变 SSH 会话生命周期：关闭窗格绑定不关闭标签或 SSH，关闭标签只释放该标签自己的会话与终端。
- **自动重连默认关闭**，必须由用户在设置 v4 中显式开启；开启后也只对传输层网络类固定错误码重试，认证失败、主机密钥变化/拒绝/超时、凭据缺失、用户取消与主动断开都不会重试。序列最多 5 次、退避 1/2/4/8/15 秒，耗尽后进入终态并需要用户手动重连。`reconnecting` 同时用于手动重连与自动重连的在途阶段，但自动重连进度只存在于渲染进程内存，不持久化。
- 支持有序跳板链路（ProxyJump 等价能力，P1-02）：跳板引用已保存连接（最多 4 跳，不复制凭据或 Socket），每跳独立执行主机密钥验证与认证；不支持 keyboard-interactive、Pageant 或第三方 Agent 猜测。主机密钥设置页支持只读列表与显式删除；凭据值没有可读 UI。
- 端口转发规则在应用启动后一律保持 `stopped`；不恢复上次监听、不假定服务器端监听仍存在，也不在 SSH 重连后静默切换 `sessionId` 或自动重启规则。非回环绑定不会成为默认值，远程服务器拒绝绑定时也不会自动放宽地址/端口。
- 连接配置持久化在 `connections.json`；端口转发规则持久化在 `port-forwards.json`；自定义快速命令与内置收藏持久化在 `quick-commands.json`，命令历史持久化在 `command-history.json`；主机密钥信任记录写入 `known-hosts.json`；加密凭据库 `credentials.enc.json`、设置 `settings.json`、未完成传输快照 `transfer-journal.json` 与诊断日志 `logs/` 仅由主进程读写。

## 2. 进程与构建模型

```text
┌──────────────────────── Electron main (Node) ─────────────────────────┐
│ src/main/index.ts                                                     │
│   ├─ 单实例锁 / 应用生命周期 / 窗口关闭取消会话                        │
│   ├─ src/main/windows/mainWindow.ts   BrowserWindow + 安全策略         │
│   ├─ src/main/ipc/handlers.ts         63 个 invoke 通道 + sender 校验  │
│   ├─ src/main/services/ssh/SshService.ts                              │
│   │    ├─ ssh2 Client 生命周期、认证、状态机                          │
│   │    ├─ hostVerifier → FileHostKeyStore.verify/trust                │
│   │    ├─ VaultCredentialResolver → EncryptedCredentialStore / 私钥文件│
│   │    └─ getSftpClient：仅主进程的会话归属/连接状态校验               │
│   ├─ src/main/services/sftp/SftpService.ts                            │
│   │    ├─ 每 SSH 会话一个可复用 SFTPWrapper                            │
│   │    ├─ list/stat/mkdir/rename/deleteFile/removeDirectory           │
│   │    ├─ 传输端口：Read/Write 流、同目录提交、临时文件清理               │
│   │    └─ POSIX 路径、路径锁、超时、通道丢失与资源清理                 │
│   ├─ src/main/services/transfers/TransferService.ts                   │
│   │    ├─ 任务状态机、可配置 FIFO 队列、进度/速度、取消/重试、冲突处理   │
│   │    ├─ 本地 fs 流 ↔ SFTP 流；同目录临时文件 + rename 提交            │
│   │    ├─ 未完成任务日志（重启后只水合为 interrupted）                   │
│   │    └─ 原生文件/目录对话框、会话终止与有界退出清理                    │
│   ├─ src/main/services/localFs/LocalFsService.ts                       │
│   │    └─ 本地目录只读列举（roots/list、条目上限、固定错误码）         │
│   ├─ src/main/services/portForward/PortForwardService.ts               │
│   │    ├─ 规则状态机、运行态权威、绑定/停止编排与连接级联清理           │
│   │    ├─ local/remote/dynamic 运行时、连接上限与超时                   │
│   │    └─ SshForwardingSession 窄接口（仅 Duplex 与绑定端点）           │
│   ├─ src/main/services/quickCommands/QuickCommandService.ts            │
│   │    ├─ 命令库 CRUD/收藏、内置只读命令投影、模板重校验与字面渲染      │
│   │    ├─ tabId/sessionId 绑定、SSH connected、Shell open 复核          │
│   │    └─ 经 SshService.writeShell 写入；每标签发送锁与请求去重          │
│   ├─ src/main/services/terminal/ShellChannelManager.ts                │
│   │    └─ 每 SSH 会话一个 PTY；UTF-8 流解码、输出批量推送、背压       │
│   ├─ src/main/logging/{logger,logService,redact}.ts  脱敏 JSONL/轮转/导出│
│   ├─ src/main/storage/settingsRepository.ts    settings.json            │
│   ├─ src/main/storage/quickCommandRepository.ts quick-commands.json    │
│   ├─ src/main/storage/commandHistoryRepository.ts command-history.json │
│   ├─ src/main/storage/connectionRepository.ts  connections.json        │
│   ├─ src/main/storage/hostKeyRepository.ts     known-hosts.json        │
│   ├─ src/main/security/credentialStore.ts      credentials.enc.json    │
│   ├─ src/main/services/wallpaper/WallpaperService.ts                    │
│   │    └─ 本地图片对话框、尺寸/格式校验、nativeImage 缩放与 JPEG 重编码  │
│   ├─ src/main/lifecycle/shutdown.ts            有序、逐步有界的退出编排   │
│   └─ src/main/menu.ts                  仅编辑/窗口；DevTools 仅开发模式 │
└────────────────────────────────┬───────────────────────────────────────┘
             ipcRenderer.invoke(固定通道) + webContents.send(7 个事件)
┌────────────────────────────────┴───────────────────────────────────────┐
│ Preload (sandboxed, contextIsolation)                                  │
│   src/preload/index.ts → contextBridge.exposeInMainWorld('termforge')  │
│   冻结 bridge：getAppInfo / getSecurityStatus                          │
│                connections(5) / ssh(6 invoke + 2 subscribe)            │
│                terminal(5 invoke + 3 subscribe) / sftp(8 invoke)       │
│                localFs(2) / transfer(9 invoke + 1 subscribe)           │
│                portForwards(7 invoke + 1 subscribe)                    │
│                quickCommands(6) / commandHistory(3)                    │
│                settings(2) / hostKeys(2) / logs(3) / wallpaper(3)      │
└────────────────────────────────┬───────────────────────────────────────┘
                                 │ window.termforge
┌────────────────────────────────┴───────────────────────────────────────┐
│ Renderer (React, no Node)                                              │
│   App → layout + active module + overlays                              │
│   sessionStore ← useSshBridgeEvents ← onSessionStatus/onHostKeyRequest │
│   terminalRuntime ← useTerminalBridgeEvents ← 3 个 terminal 事件       │
│   terminalRuntime → xterm.js（输出直写、输入队列、尺寸同步）           │
│   terminalStore 只保存 Shell 生命周期快照，不保存终端输出              │
│   localPanelStore（按标签）→ LocalFilePanel（本地浏览/拖拽源与落点）   │
│   sftpStore（按标签）→ RemoteFilePanel（远程浏览/拖拽源与落点）        │
│   transferStore ← useTransferBridgeEvents ← transfer:update            │
│   TransferDrawer 只渲染主进程任务快照；不接触本地路径或文件流            │
│   quickCommandStore → QuickCommandDrawer/Compose/Editor                │
│   发送前显式目标校验 + flushTerminalInput；不接触终端输出或凭据          │
└────────────────────────────────────────────────────────────────────────┘
```

构建由 `electron-vite` 驱动，三个入口：

- `src/main/index.ts` → `out/main/index.js`（CommonJS，依赖外部化）
- `src/preload/index.ts` → `out/preload/index.js`
- `src/renderer/index.html` → `out/renderer/`

`electron.vite.config.ts` 注册 `termforge:csp` 插件，在 HTML 的 `<!-- TERMFORGE_CSP -->` 占位处注入开发或生产 CSP。渲染端别名：`@renderer` → `src/renderer/src`，`@shared` → `src/shared`。

## 3. 主进程启动与关闭

1. `app.setName('TermForge')`，获取单实例锁；第二个实例只唤醒并聚焦已有窗口。
2. `whenReady` 后在 `app.getPath('userData')` 下创建：
   - `Logger`（`logs/termforge.log`，结构化 JSONL、按大小轮转）；
   - `SettingsRepository`（`settings.json`，版本化、strict schema、原子写入）；
   - `ConnectionRepository`（`connections.json`）；
   - `QuickCommandRepository`（`quick-commands.json`）与 `CommandHistoryRepository`（`command-history.json`）；
   - `EncryptedCredentialStore`（`credentials.enc.json`，Electron async `safeStorage`）；
   - `FileHostKeyStore`（`known-hosts.json`）。
3. 先读取设置并把 `logLevel`、`transferMaxConcurrent` 与 `transferMaxPerSession` 应用到运行时；设置文件损坏时按字段恢复默认值并保留警告，不自动覆盖原文件。
4. 构造 `VaultCredentialResolver`、`SshService`、`SftpService`、`LocalFsService`、`TransferService` 与 `WallpaperService`，注入：
   - `createClient: () => new Client()`（`ssh2` 只在主进程导入）；
   - `emitStatus` / `emitHostKeyRequest`，通过主窗口 `webContents.send` 推送事件；
   - `emitTerminalOutput` / `emitTerminalStatus` / `emitTerminalExit`，由 `SshService` 内部的 `ShellChannelManager` 调用；
   - `SftpService.acquireClient: (sessionId) => ssh.getSftpClient(sessionId)`，每次 SFTP 操作重新确认会话存在、已连接且 Client 可用；
   - `TransferService` 依赖 SFTP 传输端口、`emitUpdate`（`transfer:update`）、原生多文件选择与目录选择函数、`transfer-journal.json` 路径与并发上限；`enqueueUploadPaths`/`enqueueDownloadPaths` 接受渲染端提交的本地绝对路径并逐条重新校验（存在性、类型、设备前缀、目录展开深度与任务上限）；文件内容与流只在主进程内流转；
   - `LocalFsService` 只依赖注入的 `home` 与文件系统读取，用于本地面板的只读列举（roots/list），不读取文件内容；
   - `SshService.onSessionTerminated: (sessionId) => { transferService.handleSessionTerminated(sessionId); sftpService.disposeSession(sessionId) }`，SSH 终态或标签关闭时停止该会话的传输、拒绝未决 SFTP 请求并结束通道。Shell 单独退出不会触发该回调；
   - `WallpaperService` 依赖 `<userData>/wallpapers` 与原生图片选择函数；源路径、图片字节与缩放/重编码只在主进程内处理；
   - `PortForwardService` 依赖 `PortForwardRepository`（`port-forwards.json`）、连接仓库、`SshService.acquireForwardingSession` 与 `emitUpdate`（`port-forwards:snapshot-updated`）；规则状态、监听器、Socket/Channel 与连接计数只在主进程维护。
   - `QuickCommandService` 依赖 `QuickCommandRepository`、`CommandHistoryRepository`、`SshService.getStatus/getShellStatus/writeShell` 与设置读取函数 `isCommandHistoryEnabled`；不创建 SSH Client、不打开独立 exec 通道，也不接触终端输出。历史开关在发送时实时读取，关闭设置立即阻止新增记录。
5. 注册 63 个固定 IPC handler，传入主窗口 getter、连接仓库、凭据库、SSH/SFTP 服务、本地列举服务、传输服务、端口转发服务、快速命令服务、设置仓库、主机密钥仓库、日志服务与壁纸服务。
6. 安装应用菜单并创建窗口。
7. 窗口 `closed` 时调用 `transferService.cancelAll()` 与 `sshService.cancelAll()`，停止传输、关闭所有 PTY、终止所有活动 SSH 会话，SSH 清理回调同步释放 SFTP 通道与端口转发门面；`before-quit` 通过 `runBoundedCleanup` 按顺序执行 `transferService.dispose()`、`portForwardService.shutdown()`、`sftpService.dispose()`、`sshService.dispose()` 与 `logger.flush()`，每步独立 4 秒上限，单步失败或超时只记录并继续后续步骤；`shutdownStarted` / `quitAllowed` 保证退出流程幂等且不会重入。
8. 非 macOS 关闭全部窗口即退出；macOS 激活且无窗口时重建窗口。

加载策略：开发模式使用 `ELECTRON_RENDERER_URL`；生产模式只加载 `out/renderer/index.html`。窗口加载失败会记录日志且不使应用崩溃。

主窗口安全配置、导航与权限策略见 [SECURITY.md](SECURITY.md)。

## 4. 渲染端组成

`src/renderer/src/app/App.tsx` 是组合根：

- 布局：`AppBar`、`PrimaryNav`、`ServerSidebar`、`workspace`、`StatusBar`。
- 模块视图：`WorkbenchView`、`ServersView`、`SftpView`、`PortForwardsView`、`SettingsView`，由 `workspaceStore.activeModule` 切换。
- 全局覆盖层：`ConnectionEditorModal`、`DeleteConnectionModal`、`HostKeyConfirmModal`、`CredentialPromptModal`、`CommandPalette`、`TransferDrawer`、`PortForwardEditorModal`、`PortForwardStartModal`、`DeletePortForwardModal`、`QuickCommandDrawer`、`QuickCommandEditorModal`、`QuickCommandComposeModal`、`ToastHost`。
- 启动副作用：加载连接、应用信息、安全存储状态与持久化设置；`useSshBridgeEvents` 订阅主进程 SSH 事件；`useTerminalBridgeEvents` 在应用根订阅终端输出/状态/退出事件；`useTransferBridgeEvents` 订阅 `transfer:update` 并同步任务列表，上传进入终态时按 200ms 防抖刷新匹配的 SFTP 目录；`usePortForwardBridgeEvents` 订阅 `port-forwards:snapshot-updated` 并同步规则快照；`useGlobalShortcuts` 处理 `Ctrl/Cmd+Shift+K` 打开快速命令抽屉，并在输入框/终端交互时避免误触。
- 主题副作用：把 `settingsStore.resolvedTheme` 写入 `<html data-theme>` 与 `colorScheme`；`theme === 'system'` 时监听 `matchMedia('(prefers-color-scheme: dark)')`，只更新解析后的主题，不覆盖用户偏好。
- `settingsStore` 是设置唯一入口：启动时调用 `loadSettings()`，修改时先本地校验并乐观应用，再串行写入主进程；写入失败只回滚仍等于本次提交值的字段并显示 Toast，不静默恢复旧值。终端字体族以白名单 ID 保存，避免把任意 CSS 写入 xterm。

布局尺寸由 CSS 变量定义（`--tf-layout-appbar: 48px`、`--tf-layout-sidebar: 260px`、`--tf-layout-tabs: 40px`、`--tf-layout-statusbar: 26px`），应用壳使用 CSS Grid。顶部 48px 与 Windows 标题栏合并，`AppBar` 兼作拖拽区并通过 `titleBarOverlay` 保留系统窗口按钮；侧栏折叠时侧栏列宽设为零并卸载 `ServerSidebar`。

Tailwind CSS 4 通过 `@tailwindcss/vite` 接入；界面主要使用语义化类名与 CSS 变量组成的自有设计系统。

### 目录结构说明

整体遵循 `main/`、`preload/`、`renderer/src/{app,components,features,stores,styles,test}`、`shared/{types,schemas,constants,fixtures}`、`tests/unit` 与 `docs/` 布局：

- 主进程 SSH 代码集中在 `src/main/services/ssh/`：`SshService`、`credentialResolver`、`privateKey`、`hostKeyBlob`、`sshFailure`。
- 主进程 SFTP 代码位于 `src/main/services/sftp/`：`SftpService` 负责通道、操作、锁、超时与清理，`sftpMetadata.ts` 负责 `ssh2` 属性到共享目录条目的安全映射。
- 主进程传输代码位于 `src/main/services/transfers/`：`TransferService` 负责任务生命周期、文件流、提交与清理，`TransferQueue` 负责 FIFO 与并发上限，`transfer-errors.ts` 负责错误脱敏；共享命名规则位于 `src/shared/transfer/`。
- 主进程端口转发代码位于 `src/main/services/portForward/`：`PortForwardService` 负责规则状态机、启动/停止、会话绑定与级联删除，`localForward`/`remoteForward`/`dynamicForward` 分别实现本地监听、远程监听与 SOCKS5，`socks5Protocol` 为独立 RFC 1928 解析器，`connectionTracker` 统一每规则/全局连接上限，`streamBridge` 负责双向背压与幂等清理；SSH 窄门面位于 `src/main/services/ssh/SshForwardingSession.ts`；共享地址规范化位于 `src/shared/portForward/address.ts`。
- 主进程快速命令代码位于 `src/main/services/quickCommands/QuickCommandService.ts` 与 `src/main/storage/{quickCommandRepository,commandHistoryRepository}.ts`；共享模板解析/字面渲染位于 `src/shared/quickCommands/template.ts`，只读内置命令位于 `builtIns.ts`，限额位于 `src/shared/constants/quickCommands.ts`；渲染端状态位于 `stores/quickCommandStore.ts`，抽屉/编辑器/发送确认位于 `features/quickCommands/`，目标捕获规则位于 `lib/quickCommandTargets.ts`。
- 主进程本地列举代码位于 `src/main/services/localFs/LocalFsService.ts`；共享本地路径纯函数位于 `src/shared/localFs/localPath.ts`；渲染端本地面板位于 `features/sftp/LocalFilePanel.tsx`，按标签状态位于 `stores/localPanelStore.ts`，拖拽载荷与 drop zone 位于 `features/sftp/fileDrag.ts`。
- 主进程 PTY 代码位于 `src/main/services/terminal/ShellChannelManager.ts`，每个 SSH 会话最多一个 Shell 通道。
- 主进程日志代码位于 `src/main/logging/`：`Logger` 负责级别过滤、JSONL 写入与轮转，`redact.ts` 负责键名/文本/深度脱敏，`LogService` 负责信息查询、固定目录打开与用户主动导出。
- 主进程设置代码位于 `src/main/storage/settingsRepository.ts` 与共享 `src/shared/schemas/settings.ts`；关闭编排位于 `src/main/lifecycle/shutdown.ts`。
- 主进程壁纸代码位于 `src/main/services/wallpaper/WallpaperService.ts`，共享投影类型位于 `src/shared/types/wallpaper.ts`；渲染端状态位于 `stores/wallpaperStore.ts`，壁纸入口位于 `features/settings/SettingsView.tsx` 的「外观」分区，壁纸态样式位于 `styles/wallpaper.css`。
- 渲染端 `components/terminal/XtermTerminal.tsx` 持有 xterm.js 实例；`services/terminalRuntime.ts` 位于 React 之外，负责输出缓冲、输入队列、Shell 打开去重与尺寸同步；`stores/terminalStore.ts` 只保存 Shell 生命周期快照。
- SFTP 主进程服务位于 `src/main/services/sftp/`；共享 POSIX 路径规则位于 `src/shared/sftp/remotePath.ts`；渲染端 `features/sftp/SftpView.tsx` 负责会话选择与操作流程，`RemoteFilePanel.tsx` 只展示真实的远程目录数据；跨功能基础控件位于 `components/common/`。

## 5. IPC 边界

### 通道

`src/shared/constants/ipc.ts` 定义 63 个 invoke 通道：

| 通道                              | 方向   | 参数                                           | 返回                                        |
| --------------------------------- | ------ | ---------------------------------------------- | ------------------------------------------- |
| `app:get-info`                    | invoke | —                                              | `AppInfo`                                   |
| `security:get-status`             | invoke | —                                              | `SecurityStatus`                            |
| `connections:list`                | invoke | —                                              | `OperationResult<ConnectionCatalog>`        |
| `connections:create`              | invoke | `ConnectionInput`                              | `OperationResult<ConnectionProfile>`        |
| `connections:update`              | invoke | `id`, `ConnectionInput`                        | `OperationResult<ConnectionProfile>`        |
| `connections:remove`              | invoke | `id`                                           | `OperationResult<ConnectionMutationAck>`    |
| `connections:set-favorite`        | invoke | `id`, `boolean`                                | `OperationResult<ConnectionProfile>`        |
| `ssh:connect`                     | invoke | `connectionId`, `clientId`                     | `OperationResult<SshConnectResult>`         |
| `ssh:cancel-connect`              | invoke | `clientId`                                     | `OperationResult<SshConnectCancelAck>`      |
| `ssh:disconnect`                  | invoke | `sessionId`                                    | `OperationResult<SshSessionSnapshot>`       |
| `ssh:get-status`                  | invoke | `sessionId`                                    | `OperationResult<SshSessionSnapshot>`       |
| `ssh:respond-host-key`            | invoke | `requestId`, `accepted`                        | `OperationResult<SshHostKeyResponseAck>`    |
| `ssh:set-credential`              | invoke | `SshCredentialInput`                           | `OperationResult<SshCredentialAck>`         |
| `terminal:open`                   | invoke | `sessionId`, `{ cols, rows }`                  | `OperationResult<TerminalOpenResult>`       |
| `terminal:write`                  | invoke | `sessionId`, `string`                          | `OperationResult<TerminalAck>`              |
| `terminal:resize`                 | invoke | `sessionId`, `{ cols, rows }`                  | `OperationResult<TerminalAck>`              |
| `terminal:close`                  | invoke | `sessionId`                                    | `OperationResult<TerminalAck>`              |
| `terminal:get-status`             | invoke | `sessionId`                                    | `OperationResult<TerminalShellSnapshot>`    |
| `sftp:open`                       | invoke | `sessionId`                                    | `OperationResult<SftpOpenResult>`           |
| `sftp:list`                       | invoke | `sessionId`, `path`                            | `OperationResult<RemoteDirectoryListing>`   |
| `sftp:stat`                       | invoke | `sessionId`, `path`                            | `OperationResult<RemoteFileEntry>`          |
| `sftp:mkdir`                      | invoke | `sessionId`, `parentPath`, `name`              | `OperationResult<SftpMutationAck>`          |
| `sftp:rename`                     | invoke | `sessionId`, `sourcePath`, `targetPath`        | `OperationResult<SftpMutationAck>`          |
| `sftp:delete-file`                | invoke | `sessionId`, `path`                            | `OperationResult<SftpMutationAck>`          |
| `sftp:remove-directory`           | invoke | `sessionId`, `path`                            | `OperationResult<SftpMutationAck>`          |
| `sftp:close`                      | invoke | `sessionId`                                    | `OperationResult<SftpCloseAck>`             |
| `local-fs:roots`                  | invoke | —                                              | `OperationResult<LocalRootsResult>`         |
| `local-fs:list`                   | invoke | `path`                                         | `OperationResult<LocalDirectoryListing>`    |
| `transfer:enqueue-upload`         | invoke | `sessionId`, `remoteDirectory`                 | `OperationResult<TransferTask[]>`           |
| `transfer:enqueue-upload-paths`   | invoke | `sessionId`, `remoteDirectory`, `localPaths[]` | `OperationResult<TransferUploadEnqueueAck>` |
| `transfer:enqueue-download`       | invoke | `sessionId`, `remotePaths[]`                   | `OperationResult<TransferTask[]>`           |
| `transfer:enqueue-download-paths` | invoke | `sessionId`, `remotePaths[]`, `localDirectory` | `OperationResult<TransferTask[]>`           |
| `transfer:cancel`                 | invoke | `transferId`                                   | `OperationResult<TransferTask>`             |
| `transfer:retry`                  | invoke | `transferId`                                   | `OperationResult<TransferTask>`             |
| `transfer:resolve-conflict`       | invoke | `transferId`, `choice`, `newName?`             | `OperationResult<TransferTask>`             |
| `transfer:list`                   | invoke | —                                              | `OperationResult<TransferTask[]>`           |
| `transfer:clear-history`          | invoke | —                                              | `OperationResult<TransferClearAck>`         |
| `port-forwards:list`              | invoke | —                                              | `OperationResult<PortForwardSnapshot>`      |
| `port-forwards:create`            | invoke | `PortForwardCreateInput`                       | `OperationResult<PortForwardItem>`          |
| `port-forwards:update`            | invoke | `id`, `PortForwardUpdateInput`                 | `OperationResult<PortForwardItem>`          |
| `port-forwards:remove`            | invoke | `id`                                           | `OperationResult<PortForwardRemoveAck>`     |
| `port-forwards:start`             | invoke | `ruleId`, `sessionId`, `confirmExposure?`      | `OperationResult<PortForwardItem>`          |
| `port-forwards:stop`              | invoke | `id`                                           | `OperationResult<PortForwardItem>`          |
| `port-forwards:connection-impact` | invoke | `connectionId`                                 | `OperationResult<ConnectionRemovalImpact>`  |
| `quick-commands:list`             | invoke | —                                              | `OperationResult<QuickCommandSnapshot>`     |
| `quick-commands:create`           | invoke | `QuickCommandDraft`                            | `OperationResult<QuickCommand>`             |
| `quick-commands:update`           | invoke | `id`, `QuickCommandDraft`                      | `OperationResult<QuickCommand>`             |
| `quick-commands:remove`           | invoke | `id`                                           | `OperationResult<{ id: string }>`           |
| `quick-commands:set-favorite`     | invoke | `id`, `boolean`                                | `OperationResult<QuickCommand>`             |
| `quick-commands:execute`          | invoke | `QuickCommandExecuteInput`                     | `OperationResult<QuickCommandExecuteAck>`   |
| `command-history:list`            | invoke | —                                              | `OperationResult<CommandHistorySnapshot>`   |
| `command-history:remove`          | invoke | `id`                                           | `OperationResult<{ id: string }>`           |
| `command-history:clear`           | invoke | —                                              | `OperationResult<CommandHistoryClearAck>`   |
| `settings:get`                    | invoke | —                                              | `OperationResult<SettingsSnapshot>`         |
| `settings:update`                 | invoke | `AppPreferences`                               | `OperationResult<SettingsSnapshot>`         |
| `host-keys:list`                  | invoke | —                                              | `OperationResult<HostKeyRecord[]>`          |
| `host-keys:remove`                | invoke | `host`, `port`                                 | `OperationResult<HostKeyRemovalAck>`        |
| `logs:get-info`                   | invoke | —                                              | `OperationResult<LogInfo>`                  |
| `logs:export`                     | invoke | —                                              | `OperationResult<LogExportAck>`             |
| `logs:open-folder`                | invoke | —                                              | `OperationResult<LogFolderAck>`             |
| `wallpaper:get`                   | invoke | —                                              | `OperationResult<WallpaperState>`           |
| `wallpaper:choose`                | invoke | —                                              | `OperationResult<WallpaperChooseResult>`    |
| `wallpaper:remove`                | invoke | —                                              | `OperationResult<WallpaperState>`           |

七个主进程 → 渲染进程推送事件：

- `ssh:session-status`：`SshStatusEvent { session }`，每次状态/错误/主机密钥变化时推送完整快照。
- `ssh:host-key-request`：`SshHostKeyRequestEvent { challenge }`，首次主机密钥确认请求。
- `terminal:output`：`{ sessionId, data }`，已解码的 UTF-8 终端输出；不含环境变量、凭据或通道对象。
- `terminal:status`：`TerminalShellSnapshot`，Shell 生命周期与尺寸、失败信息。
- `terminal:exit`：`{ sessionId, code, signal, reason }`，远程退出/关闭/本地关闭/SSH 断开/错误。
- `transfer:update`：`TransferUpdateEvent { task }`，主进程每个任务状态/进度变化时推送完整快照；事件不包含文件内容、流、本地句柄或 SFTP 对象。
- `port-forwards:snapshot-updated`：`PortForwardUpdateEvent { snapshot }`，规则/运行时/连接数/失败/清理状态变化时推送带单调 `revision` 的完整快照；不包含 Socket、Channel、监听器、目标连接内容或凭据。

### 校验与错误

- 每个 handler 先调用 `assertTrustedSender`：窗口存在且未销毁、`event.sender === window.webContents`、`event.senderFrame === webContents.mainFrame`。
- 参数在主进程用共享 Zod schema 二次校验：连接 ID、会话 ID、主机密钥请求 ID、凭据输入、终端尺寸、终端写入数据，以及 SFTP 会话 ID、绝对远程路径与条目名称；不信任渲染进程已校验的结论。
- 终端写入为严格的字符串，单项上限 65,536 字符；终端尺寸为 strict `{ cols, rows }`，列 1–2,000、行 1–1,000，拒绝零、负数、小数与 NaN。
- SFTP 会话 ID 格式为 `ssh-<UUID 风格>`，每次操作都通过 `SshService.getSftpClient` 重新确认会话存在且状态为 `connected`；不能仅凭渲染进程传入的 ID 直接操作 SFTP Channel。路径必须是规范的绝对 POSIX 路径，名称拒绝空值、`.`/`..`、斜杠、NUL 与控制字符。
- 连接与会话 ID 还会在 `SshService` 内再次校验，并从连接仓库/会话表确认存在性；未知 ID 返回 `not-found`。
- 传输参数使用 strict schema：`transferId` 必须匹配 `transfer-<UUID 风格>`；上传目录与下载来源必须是规范绝对 POSIX 路径；单次批量 1–50；冲突策略限制为 `overwrite/rename/skip`，`rename` 必须带非空 `newName`，其他策略不得携带 `newName`。传输 ID 必须在主进程任务表中存在，任务所属会话必须仍可访问 SFTP；主进程不接受渲染进程传入的本地路径、文件大小或任务状态。
- 端口转发参数使用 strict discriminated union：规则 ID 必须匹配 `pf-<UUID 风格>`，名称 ≤64 字符且不含控制字符，监听地址必须是 IPv4/IPv6 字面量（不接受主机名），端口 1–65,535；`dynamic` 的监听地址在 schema 固定为 `127.0.0.1`。`port-forwards:start` 只接受 `ruleId`、`sessionId` 与可选 `confirmExposure`，会话必须存在、状态为 `connected` 且 `connectionId` 与规则一致；非回环的 `local`/`remote` 规则缺少 `confirmExposure: true` 时由服务再次拒绝。`connections:remove` 的可选参数只允许 `{ cascadePortForwards?: boolean }`，主进程在删除时重新计算影响并要求显式级联。
- 快速命令使用 strict schema：命令 ID 为 `qc-…`/`builtin-…`，名称 ≤64、分类 ≤32、说明 ≤256、正文 ≤4,096 字符且不含控制字符；`{{identifier}}` 最多 16 个，参数名必须与正文占位符按顺序一致，参数默认值/发送值 ≤512 字符且不能为空或包含控制字符。`quick-commands:execute` 只接受 `requestId`、命令引用或历史正文、`tabId`、`sessionId`、参数表与 `recordHistory`，主进程不以渲染端填写的目标为可信事实，会重新校验会话与 Shell 状态；历史记录 ID 为 `ch-…`，正文允许字面花括号但同样限制长度与控制字符。
- 本地路径只来自主进程原生对话框（上传多文件选择、下载目录选择、日志导出保存位置），本地文件名在下载前按 Windows-first 规则校验（保留名、非法字符、尾随空格/句点等），远程条目名按 POSIX 规则校验。
- 设置更新使用 strict `AppPreferences` schema：主题仅 16 套风格或 `system`，DBX 明暗仅 `system/light/dark`，界面/终端字体族仅白名单 ID，界面字号 12–15、终端字号 10–20、回滚行数/并发数仅允许预设整数，布尔类型严格校验（含 `commandHistoryEnabled`）；未知字段、NaN、超限值一律拒绝，且拒绝时不写入任何数据。设置仅包含非敏感展示/行为偏好，不包含任何凭据或路径。
- 主机密钥移除只接受 `{ host, port }`：主机按连接主机规则校验、端口 1–65,535；主进程按规范化端点查找并删除，返回 `{ removed }`，未知端点返回 `removed: false`，不会触碰 SSH 会话。
- 日志导出不接受渲染进程提供的路径：主进程打开原生保存对话框，固定导出白名单日志文件，单次读取上限 20 MiB；`open-folder` 只打开主进程固定的日志目录。日志查询与导出返回文件名、大小、时间、级别与写入失败计数，不返回任意文件系统内容。
- 壁纸通道不接受路径或图片字节：`wallpaper:choose` 只调用主进程原生图片对话框，扩展名限 `.png/.jpg/.jpeg`，普通文件且非空、≤20 MiB；`nativeImage` 解码后最长边缩放至 2,560px，重编码为 JPEG（质量 85），原子写入固定目录。返回给渲染进程的只有 `{ dataUrl, fileName, updatedAt }`，不包含源路径、文件句柄或原始字节。
- 所有错误归一为 `OperationResult`，只携带允许列表错误码与固定中文消息；原始 `ssh2` 错误、文件路径与堆栈不跨 IPC。SFTP 传输层中断对只读操作映射为 `unavailable`，对可能已发送到服务器的变更操作映射为 `outcome-unknown`，要求用户刷新目录核实，不自动重试。
- `SshService.connect` 的 Promise 在会话到达 `awaiting-host-key`、`connected` 或 `error` 时解析；主机密钥确认本身通过独立请求/响应通道完成，不依赖 `connect` Promise 的挂起。
- 终端 handler 只把 `sessionId` 交给 `SshService`；渲染进程无法传入 Client、Channel、函数或任意对象。

### Preload 暴露面

- `window.termforge` 是冻结对象，嵌套 `connections`、`ssh`、`terminal`、`sftp`、`localFs`、`transfer`、`portForwards`、`quickCommands`、`commandHistory`、`settings`、`hostKeys`、`logs` 与 `wallpaper` 同样冻结；另提供 `getPathForFile(file)`（`webUtils`）解析拖入的 OS 文件路径，无磁盘路径时返回空串。
- `ssh` namespace 暴露 `connect`、`disconnect`、`getStatus`、`respondToHostKey`、`saveCredential`、`onSessionStatus`、`onHostKeyRequest`。
- `terminal` namespace 暴露 `open(sessionId, size)`、`write(sessionId, data)`、`resize(sessionId, size)`、`close(sessionId)`、`getStatus(sessionId)`，以及 `onOutput`/`onStatus`/`onExit`。
- `sftp` namespace 暴露 8 个固定方法：`open(sessionId)`、`list(sessionId, path)`、`stat(sessionId, path)`、`mkdir(sessionId, parentPath, name)`、`rename(sessionId, sourcePath, targetPath)`、`deleteFile(sessionId, path)`、`removeDirectory(sessionId, path)`、`close(sessionId)`。没有通用请求方法，也不接受本地路径或文件内容。
- `localFs` namespace 暴露 `roots()` 与 `list(path)` 两个只读方法：只返回条目元数据（名称、类型、大小、mtime、隐藏标记）、根列表与截断标记，不读取文件内容，也不返回路径 API、句柄或原始 `fs` 能力。
- `transfer` namespace 暴露 9 个固定方法与 1 个订阅：`enqueueUpload(sessionId, remoteDirectory)`、`enqueueUploadPaths(sessionId, remoteDirectory, localPaths)`、`enqueueDownload(sessionId, remotePaths)`、`enqueueDownloadPaths(sessionId, remotePaths, localDirectory)`、`cancel(transferId)`、`retry(transferId)`、`resolveConflict(transferId, choice, newName?)`、`list()`、`clearHistory()`、`onUpdate(listener)`。上传按钮的本地文件由主进程对话框选择；显式路径入口（拖拽/本地面板）提交本地绝对路径，由主进程逐条校验并重新展开，文件内容与句柄始终不跨 IPC。
- `portForwards` namespace 暴露 7 个固定方法与 1 个订阅：`list()`、`create(input)`、`update(id, input)`、`remove(id)`、`start(ruleId, sessionId, options?)`、`stop(id)`、`getConnectionRemovalImpact(connectionId)`、`onSnapshot(listener)`。参数只含规则 ID、连接 ID、会话 ID、地址/端口、名称与暴露确认标志；没有 Socket、Channel、监听器、目标流量、凭据或原始 `ipcRenderer`。
- `quickCommands` namespace 暴露 6 个固定方法：`list()`、`create(draft)`、`update(id, draft)`、`remove(id)`、`setFavorite(id, favorite)`、`execute(input)`；`commandHistory` 暴露 `list()`、`remove(id)`、`clear()`。参数只含命令字段、命令/历史 ID、目标 `tabId`/`sessionId`、参数值与记录开关；没有终端输出读取、任意命令执行、SSH Client/Channel、文件系统或日志写入能力，也没有订阅事件。
- `settings` namespace 暴露 `get()` 与 `update(preferences)`；`hostKeys` 暴露 `list()`、`remove(host, port)`；`logs` 暴露 `getInfo()`、`exportLogs()`、`openFolder()`。没有“读取日志内容”“清空日志”“删除日志文件”或任意路径参数。
- `wallpaper` namespace 暴露 `get()`、`choose()`、`remove()`；没有路径参数、图片字节参数或任意文件读取方法。`choose()` 的源文件只能来自主进程原生对话框。
- 所有 `on*` 返回幂等的取消订阅函数；React effect 或应用根卸载时移除监听。SFTP 不使用推送事件，结果只通过对应 invoke 返回；传输使用 `transfer:update` 推送只读任务快照。
- 没有原始 `ipcRenderer`、动态通道名、通用 `send/invoke` 转发，也没有 `ssh2`、`fs`、凭据读取方法、Client/Channel/SFTPWrapper 对象、文件内容读取方法或终端输出读取方法。

## 6. SSH 会话服务（主进程）

`src/main/services/ssh/SshService.ts` 持有所有 `ssh2.Client`，对渲染进程只暴露不透明会话 ID 与快照。

### 会话标识与并发

- 主进程会话 ID 由主进程生成：`ssh-<UUID>`；渲染进程无法指定。
- 渲染标签使用稳定的 `sshtab-<UUID>` 作为 `clientId`。`connect(connectionId, clientId)` 只按 `clientId` 去重：同一标签重复请求返回 `reused: true`，不同标签即使连接同一配置也会创建独立 Client。
- 最多同时存在 32 个活动会话（`maxActiveSessions`），超限返回 `limit-exceeded`。
- 终态会话可被新连接替换；旧记录在释放时触发其等待中的 Promise，避免悬挂。
- 渲染端校验返回快照的 `clientId` 必须与发起标签一致，拒绝把其他会话绑定到该标签。

### 状态机

```text
connect()
  → connecting                 创建记录，加载连接配置
  → authenticating             凭据解析成功，创建 ssh2 Client 并 connect
      ├─ hostVerifier unknown → awaiting-host-key
      │      ├─ 用户接受 → 写入信任记录 → authenticating → connected
      │      ├─ 用户拒绝 → error(host-key-rejected)
      │      ├─ 30s 超时 → error(host-key-timeout)
      │      └─ 存储失败 → error(host-key-storage-failed)
      ├─ hostVerifier changed → error(host-key-changed)
      ├─ hostVerifier trusted → connected
      └─ 认证/网络失败 → error
  → connected
      ├─ 用户断开 → closing → disconnected
      ├─ 远端关闭 → disconnected(remote-closed)
      └─ 连接错误/中断 → disconnected(network-error 等)

connecting / authenticating / awaiting-host-key
  → 用户取消或关闭标签 → cancelConnect(clientId) → disconnected(cancelled)

error / disconnected
  → 用户手动重连 → reconnecting → connecting → …（新 sessionId）
  → 自动重连（设置开启且错误码可重试）
       ├─ 1/2/4/8/15 秒退避，最多 5 次
       ├─ 每次重新执行完整认证与主机密钥校验
       └─ 第 5 次仍失败 → error + exhausted
```

- `idle` 是共享类型中的初始状态，但 `SshService` 创建会话时直接进入 `connecting`；工作台没有会话时显示空状态。
- `reconnecting` 表示渲染端已发起手动重连，或自动重连的某次尝试正在进行；两种路径都通过既有 `connect()` 创建新的 `sessionId`，不恢复旧 Client、Channel、PTY 或远程进程。
- 自动重连的进度（当前第几次、下次时间、是否耗尽）只存在于渲染端 `sessionStore` 内存，不写入任何配置文件；设置关闭、用户取消、主动断开、关闭标签或应用退出都会清除定时器与进度。
- `closing` 表示主进程正在关闭 Client；3 秒宽限后强制 `destroy` 并进入 `disconnected`。
- `cancelConnect(clientId)` 只作用于该标签当前的在途尝试；已完成连接不会被它断开（返回 `cancelled: false`），重复取消幂等。主进程先把会话终结为 `disconnected(cancelled)`，再销毁已创建的临时 Client，因此迟到的连接成功不会重新出现在工作区，其他标签与分屏窗格不受影响。

### 连接参数

`ssh2` `ConnectConfig` 包含：

- `host` / `port` / `username`（来自连接配置；跳板链中每一跳使用该跳自己的连接配置）；
- `readyTimeout: 90_000`，外层额外 95 秒连接守卫；
- `keepaliveInterval: 30_000`、`keepaliveCountMax: 3`（网络中断检测）；
- `hostVerifier`（异步回调，见下）；
- 按认证方式注入 `password`、`privateKey` + 可选 `passphrase` 或 `agent`；
- 跳板链的第 2 跳起与最终目标额外注入 `sock`（上一跳 `forwardOut` 返回的 Channel），第 1 跳默认直连 TCP。

`connect` Promise 的里程碑由 `Signal` 记录：`awaiting-host-key`、`connected`、`error` 都会触发，UI 不会被首次主机密钥确认永久阻塞，主进程也不会等待已关闭窗口的响应。

### 跳板机（ProxyJump）链路

连接配置 `jumpConnectionIds` 是有序的已保存连接 ID 列表（最近的跳在前，最多 `MAX_JUMP_HOPS = 4`）。链路完全在主进程建立，渲染进程只看到跳板的公开元数据与阶段状态：

1. 解析：`connect()` 从目录中按 ID 取出每跳的连接配置；引用失效（连接已被删除等）直接拒绝并提示重新编辑配置，不会建立半截链路。
2. 拨号：第 1 跳直连 TCP；每跳 `ready` 后调用 `forwardOut('127.0.0.1', 0, 下一跳或目标 host, port)`，返回的 Channel 作为下一跳 Client 的 `sock`。直到最终目标 `ready` 前，会话状态保持非 `connected`。
3. 每跳独立安全边界：每跳的 `hostVerifier` 绑定该跳自身 host/port，主机密钥信任记录按端点隔离——信任某个跳板**不会**信任目标，也不会与目标共享记录；`snapshot.hostKey` 只记录最终目标。每跳的认证完全复用 `CredentialResolver`（含跳板凭据补录：失败归属到具体跳，补录写入该跳自己的 vault 记录）。
4. 失败归属：认证失败、主机密钥变化、跳板断线、`forwardOut` 拨号失败都会在 `SshFailure.hop` 带上是哪一跳；`forwardOut` 失败归属**正在拨往的下一端点**。任何一跳失败都停止后续连接、清理已建立的临时 Client/Channel，且不残留半开连接。
5. 断开/清理：`disconnect` 先关目标、再按从外向内的逆序关各跳；`destroyClients`/`cancelAll`/`dispose` 覆盖目标与全部跳板 Client；记录用 `pendingCloses` 计数，等全链 `close` 后才 finalize。同一连接在多个标签中并发使用时链路互相独立。
6. 状态展示：`SshSessionSnapshot.jumps`/`activeHop` 只含 `{ index, connectionId, name, host, port, username, authMethod }` 等公开信息；渲染层据此显示连接路径与「跳板 N/M」阶段文案。

### 主机密钥验证

1. `ssh2` 在握手阶段把原始公钥 blob 交给 `hostVerifier`。
2. 主进程 `parseHostKeyBlob` 解析算法并计算 OpenSSH `SHA256:` Base64 指纹（无填充）。
3. `FileHostKeyStore.verify` 按 `host:port` 查找记录，返回 `trusted` / `unknown` / `changed`；**verify 从不写盘、从不自动信任**。
4. `trusted`：仅当算法与指纹完全一致时 `verify(true)`。
5. `changed`：立即 `verify(false)`，会话进入 `error(host-key-changed)`，不覆盖已有记录。
6. `unknown`：
   - 会话进入 `awaiting-host-key`，生成 `hk-<UUID>` 请求，推送 `ssh:host-key-request`；
   - 启动 30 秒超时；超时、用户拒绝、窗口关闭、会话取消、存储异常都会以 `verify(false)` 结束；
   - 用户接受时先 `hostKeys.trust(presented)` 持久化信任，成功后才 `verify(true)`；写入失败则拒绝连接并返回 `storage-write-failed`。
7. 解析失败/不支持的算法直接拒绝并进入 `error`。

跳板链中每个端点（每跳与最终目标）都走同一套流程：顺序握手保证同一时刻最多一个待确认挑战；挑战带上 `hop` 信息用于 UI 区分「首次连接跳板 N」与目标确认。

因此不存在「自动接受所有 Host Key」的代码路径，也不存在因确认窗口关闭、IPC 超时或存储异常而自动信任的分支。

### 错误映射

`sshFailure.ts` 把 `ENOTFOUND`、`ECONNREFUSED`、超时、`ECONNRESET`、认证失败、私钥格式、口令错误、主机密钥错误等归一为固定的 `SshFailureCode` 与中文消息。原始错误对象不写入渲染状态、不记录到日志。认证失败会附带 `credentialKind`（password / privateKey / passphrase），用于 UI 打开对应的凭据补录弹窗。

### 自动重连（P1-05）

自动重连完全由渲染端 `sessionStore` 编排，但每一次尝试都复用主进程既有 `connect(connectionId, clientId)`：

- **触发条件**：设置 v4 `autoReconnectEnabled === true`，且被动断开的 `SshFailure.code` 严格属于 `network-error`、`connection-timeout`、`dns-failed`、`connection-refused`、`remote-closed`。判断只使用固定错误码，不匹配错误消息文本。认证失败、主机密钥变化/拒绝/超时/存储失败、`credential-required`、`agent-unavailable`、`cancelled` 与用户主动断开都不会触发。
- **上限与退避**：最多 5 次自动尝试，固定延迟 1、2、4、8、15 秒；第 5 次失败后停止并记录 `exhausted: true`，不继续排队也不自动降级为手动重连。
- **生命周期清理**：用户点击「停止自动重连」/「取消自动重连」、主动断开、关闭标签、设置关闭或应用退出都会清除定时器、递增尝试纪元并清空 `autoReconnect` 进度；关闭标签与显式断开不会被迟到失败重新排入重试。
- **在途取消**：自动尝试进行中时，取消会调用 `ssh:cancel-connect`（按 `clientId`）并忽略该尝试的迟到成功；若主进程稍后返回已连接会话，渲染端会立即对其调用 `ssh:disconnect`，不把标签标记为已连接。
- **安全语义**：每次重试重新读取凭据、重新执行主机密钥确认与跳板链认证，不绕过任何校验、不复用旧信任决定之外的捷径、不自动接受新密钥；不重放断线前正在输入的命令、未确认的快速命令或其他待发送数据；不声称旧 Shell、前台进程或工作目录已恢复。
- **并发隔离**：定时器、尝试纪元、取消集合与发送状态均按标签记录；一个窗格的自动重连不会触碰相邻窗格或其他标签的会话。

### 断开与资源释放

- `disconnect(sessionId)`：取消未决主机密钥确认（视为拒绝）、清除连接守卫、调用 `client.end()`，等待 `close` 或 3 秒宽限后 `destroy`；非活动会话直接返回快照，保持幂等。
- `cancelAll()`：窗口关闭时终止所有活动会话并推送 `cancelled` / `disconnected`。
- `dispose()`：应用退出时终止全部 Client、清理定时器、释放等待中的 Promise，并将实例标记为不可用。
- 所有定时器调用 `unref()`，不阻止进程退出。

### 交互式 Shell / PTY

`ShellChannelManager`（`src/main/services/terminal/ShellChannelManager.ts`）由 `SshService` 持有，负责每个 SSH 会话的 PTY 通道：

- `openShell(sessionId, size)` 先确认 SSH 会话仍为 `connected`，再用 `client.shell({ term: 'xterm-256color', cols, rows }, callback)` 打开 PTY。
- 每会话最多一个 Shell：已 `open` 时复用并返回 `reused: true`；`opening` 时更新期望尺寸；`closing` 返回 `conflict`；`closed/exited/error` 的旧运行时被释放后可创建新 PTY。
- 输入只允许 `open` 状态；`terminal:write` 严格限制为字符串且单次 ≤65,536 字符。渲染端进一步按 32 KiB 分片并串行化，避免大段粘贴乱序。
- 远程数据始终按字节处理，使用 `StringDecoder('utf8')` 流式解码，跨数据包的多字节 UTF-8 字符不会损坏。
- 输出以 8ms 窗口批量推送；积压 ≥64 KiB 时立即 flush。积压 ≥1,000,000 字符时暂停通道，降至 250,000 以下后恢复，形成背压。
- 尺寸同步调用 `channel.setWindow(rows, cols, 0, 0)`；**先 rows 后 cols**，与 ssh2 接口一致。零/负数/小数/NaN/超限尺寸在 Schema、`SshService` 与渲染运行时三层拒绝。
- `exit`、通道 `close`、通道 `error` 都只会 finalize 一次：冲刷解码器尾部、移除监听、关闭通道、推送最终快照与 `terminal:exit`；不会重复推送。
- 打开超时 15 秒；超时后迟到的通道会被立即关闭，避免泄漏。
- SSH `disconnect`、连接错误、远端关闭、取消、窗口关闭与应用退出都会调用 `closeForSession`/`dispose`，同时释放 PTY；被丢弃的会话记录会 `forget` 对应 Shell。
- Shell 状态为 `idle/opening/open/closing/closed/exited/error`；`TerminalExitReason` 为 `remote-exit/remote-close/local-close/ssh-closed/error`。快照只包含尺寸、失败码/固定消息与退出码/信号，不含输入输出。

### SFTP 通道与文件操作（TASK-006）

`SftpService`（`src/main/services/sftp/SftpService.ts`）持有全部 `SFTPWrapper`，渲染进程只能通过不透明 `sessionId`、绝对路径和条目名称调用固定方法。

- **通道归属**：每个 SSH 会话按需通过 `client.sftp(callback)` 打开一个可复用 SFTP 通道；同一会话的并发的 `open` 共享同一个打开 Promise。通道关闭或丢失后，下一次操作重新打开，不创建额外 SSH transport。
- **每次操作重新验证归属**：所有操作先调用 `acquireClient` → `SshService.getSftpClient`，要求会话存在、状态为 `connected` 且 Client 可用；即使渲染进程持有旧的 `sessionId`，也不能在断开后继续访问。
- **主目录**：`sftp:open` 调用 `realpath('.')` 获取绝对主目录并规范化后返回；并发 open 共享同一次解析，避免重复请求。
- **超时**：打开通道 15 秒；每次目录/文件操作 30 秒。超时的只读操作返回 `timeout`；超时的变更操作返回 `outcome-unknown`，不自动重试。晚到的 SFTP 通道会被 `destroy`，晚到的操作回调会被忽略。
- **POSIX 路径**：主进程与渲染进程共用 `src/shared/sftp/remotePath.ts`。路径以 `/` 分隔、折叠重复斜杠与 `.`、解析 `..` 后限制在根目录；反斜杠不被当作分隔符，不调用 Windows `path.join`。名称拒绝空值、`.`/`..`、斜杠、NUL 与控制字符。
- **元数据映射**：`list` 使用 `readdir`，`stat` 使用 `lstat`；类型优先使用 `isDirectory/isFile/isSymbolicLink`，再回退到 mode 位与 `longname` 前缀。符号链接不会被自动跟随。目录与链接的 `sizeBytes` 为 `null`，缺失 mtime/权限时同样返回 `null`，由 UI 显示未知而不是伪造值。目录条目使用自然排序（目录 → 符号链接 → 文件）。
- **mkdir**：先 `lstat` 目标，已存在则返回 `already-exists`，不覆盖；随后调用 `mkdir`。
- **rename**：拒绝根目录和同路径重命名；先确认源存在、目标不存在，再调用 `rename`，意图是不覆盖。SFTP 服务器对 rename 的原子/覆盖语义并不完全一致，`lstat` 预检与 `rename` 之间存在 TOCTOU 窗口，详见安全文档。
- **deleteFile**：先 `lstat`；目录被拒绝（`not-a-file`），符号链接按链接本身 `unlink`，不跟随目标。
- **removeDirectory**：只允许删除空目录。拒绝根目录、受保护的顶层系统目录、深度不足 2 的浅层目录、非目录与符号链接；删除前用 `readdir` 复查，目录仍有条目时返回 `not-empty`。**没有递归删除代码路径**。
- **并发与隔离**：按规范化路径加锁，同一路径的并发变更返回 `conflict`；不同 SSH 会话各自持有独立通道、主目录与锁集合。
- **清理**：`close(sessionId)` 结束 SFTP 通道但保留 SSH；SSH 进入终态（错误/断开）或标签关闭时，`SshService.onSessionTerminated` 调用 `disposeSession`，拒绝未决请求、结束通道并移除状态。Shell 单独退出不会释放 SFTP。`dispose()` 释放全部通道，之后所有请求失败关闭。
- **错误映射**：SFTP 状态码/原生错误被归一为 `not-found`、`permission-denied`、`not-a-directory`、`conflict`、`unsupported`、`unavailable`、`timeout` 或 `outcome-unknown`；原始错误文本、内部 `SFTPWrapper` 与认证信息不会跨 IPC。
- **面向传输的受控端口**（TASK-007）：`probe`、`statRemote`、`openTransferReadStream`、`openTransferWriteStream`、`commitRemoteUpload`、`removeTransferFile` 只供主进程 `TransferService` 使用。写流只允许 `.termforge-part-*` 临时名并以 `wx`/`0600` 打开；提交时再次校验临时名、同父目录、目标非根、目标不是目录/符号链接，覆盖时先把目标改名为同目录备份，失败则恢复；清理只接受 `.termforge-part-*` 且拒绝目录。

## 7. 文件传输（TASK-007 / TASK-008 恢复语义）

`TransferService` 持有全部任务、本地文件句柄与传输流；渲染进程只接收任务快照。默认全局并发 2、每 SSH 会话并发 1，可在设置中调整为全局 1–4、每会话 1–2（且不超过全局），FIFO 调度；常规路径下槽位从任务被取出一直保留到准备、取消与清理结束。8 秒强制收尾路径会先进入终态并释放槽位，临时文件清理继续在后台有界执行。降低并发上限不会终止运行中任务，现有任务自然收敛到新上限。

### 任务模型与状态机

```text
queued → preparing → transferring → (commit) → completed
   │          │             │
   │          │             ├─ 目标已存在且未选定策略 → waitingForConflictResolution
   │          │             │      ├─ overwrite/rename → queued（重新调度）
   │          │             │      └─ skip → skipped
   │          │             └─ 取消 → cancelling → cancelled
   │          └─ 失败 → failed
   └─ 取消/会话断开 → cancelled/failed
```

- 每个文件一个独立任务；单次上传/下载最多 50 个。状态只由主进程迁移。
- `preparing` 读取源元数据、校验目标目录、检查冲突；`transferring` 才开始计数与推送进度。
- 上传任务只接受普通本地文件（`lstat`）；拖入的目录在入队前展开为逐文件任务，符号链接不跟随；下载只接受远程普通文件。
- `totalBytes` 未知时为 `null`，`progress` 也为 `null`；已传输字节仍真实更新。传输中进度最多显示 99%，只有提交成功后完成态才是 100%。
- 进度每 200ms 最多推送一次；速度基于最近 3 秒采样，样本不足或非有限值时为 `null`。
- 无数据活动 60 秒触发超时中止；目标流关闭等待 30 秒；中止后最多等待 8 秒强制收尾，清理超时 10 秒。

### 上传与下载流程

1. 入口有两条。原生对话框（`enqueueUpload`/`enqueueDownload`）：主进程先校验目标目录，再打开原生多文件或目录对话框，对话框关闭后再次校验目录，防止在等待期间变化；同一时间只允许一个原生对话框，重复请求返回 `conflict`。双栏面板/拖拽（`enqueueUploadPaths`/`enqueueDownloadPaths`）：渲染进程提交本地绝对路径列表，主进程先校验远程/本地目标目录，再逐条 `normalizeLocalPath` 去重与 `lstat` 校验；目录按 BFS 展开为逐文件任务并保留文件夹名与相对结构（复制语义），符号链接只计数不跟随，不支持的类型计数跳过，目录深度上限 64、单次展开任务上限默认 500，超出截断并报告。
2. 下载：先校验每个远程文件名可安全落为本地文件，再 `probe` SFTP 通道并校验本地目录；拖拽入口额外拒绝磁盘根目录、设备路径前缀与非同一会话的拖拽载荷。
3. 准备阶段重新读取源（上传 `lstat`、下载 `statRemote`），写入目标同目录的 `.termforge-part-<UUID>` 临时文件（本地 `wx`/`0600`，远程 `wx`/`0600`）。
4. 数据经计数器 `Transform` 管线传输；上传完成后复查本地源文件大小与 mtime 未变、远程临时文件大小匹配；下载完成后复查本地临时文件大小、远程源大小与类型未变。
5. 提交阶段在目标同目录执行 rename，不做跨文件系统复制。覆盖时先把已有普通目标改名为 `.termforge-backup-<UUID>`，再提交临时文件；提交失败尝试恢复备份，恢复失败返回 `outcome-unknown`。成功后备份清理失败只在任务上保留 `cleanup-failed` 警告，不把已完成的传输改写为失败。
6. 取消、失败、超时与会话断开都会销毁流，并且只清理本任务记录的临时文件；不删除用户原有目标，也不删除不是本任务创建的临时文件。应用退出时清理有界，无法等待时任务会结束并附带“临时文件可能未完全清理”的提示。

### 队列、取消与重试

- FIFO `TransferQueue`：全局与每会话并发取设置值（默认 2 / 1，每会话上限被夹到全局上限以内）；队列条目包含任务 ID 与会话 ID，重复入队被拒绝。
- 取消 `queued`/`waitingForConflictResolution` 立即进入终态；`preparing`/`transferring` 进入 `cancelling` 并销毁流，由正常失败路径或 8 秒强制收尾结束；`cancelling` 重复取消幂等；提交开始后拒绝取消，避免半提交。
- 失败/取消可手动重试。重试保留原任务 ID，但 `attempt + 1`、`revision + 1`，重新 `probe` 会话并重新执行准备与冲突检查；不会从断点继续，也不声称恢复部分字节。
- 会话终止：`queued`/等待冲突任务直接 `failed(connection-lost)`；准备/传输/取消中的任务中止并映射为 `connection-lost`；已开始提交的任务不强行中断，由提交流程收尾。
- `clearHistory` 只删除已结束且没有运行时的任务；活动任务、待处理冲突与 `interrupted` 恢复任务不会被清除。
- 主进程任务历史以内存为权威，额外把未完成任务的有界快照（最多 100 条）写入 `<userData>/transfer-journal.json`；正常完成的任务不进入日志。应用重启时仅把快照水合为 `interrupted` + `outcome-unknown`，**不自动续传、不重新入队、不推进字节数，也不声称完成**。`interrupted` 任务没有重试入口；用户必须自行核对目标端后重新发起传输。
- 退出时 `dispose()` 幂等：先取消全部任务并等待最多 3 秒收敛，再以 1.5 秒上限冲洗任务日志；无法收敛的任务保留为未完成快照，重启后如实显示为已中断。没有自动重试或无限重试。

## 8. SSH 端口转发（P1-03）

端口转发复用既有 SSH 会话，不创建额外 transport，也不改变 P1-02 跳板链的建立、认证与清理逻辑。渲染进程只提交规则与目标会话 ID，并镜像主进程快照。

### 窄门面与资源归属

- `SshService.acquireForwardingSession(sessionId)` 在会话为 `connected` 时返回 `SshForwardingSession`：只暴露 `forwardOut(srcAddress, srcPort, destAddress, destPort)`、`forwardIn(bindAddress, bindPort)`、`unforwardIn(bindAddress, bindPort)`、`onTcpConnection(listener)`、`onClosed(listener)` 与 `closed`；不暴露 `ssh2.Client`、配置、凭据或内部会话记录。
- 门面绑定最终目标 Client（跳板链中即最终目标会话的 Client）；跳板链仍在 `SshService` 内建立，端口转发不会绕过跳板、不会复用跳板 Client 作为业务目标。
- 会话进入任何终态时，`SshService` 关闭对应门面并通知 `PortForwardService`；门面关闭后新的 `forwardOut`/`forwardIn`/`unforwardIn` 以 `unavailable` 拒绝，迟到 Channel 被销毁。
- 本地监听器、远程监听、SOCKS5 服务器、Socket/Channel 与连接计数全部留在主进程；渲染进程永远拿不到流量、句柄或原始套接字。

### 规则模型与限制

- 三种规则：`local`（本地监听 → 经 SSH 转发到目标）、`remote`（SSH 服务器监听 → 回到本机连接目标）、`dynamic`（本机回环 SOCKS5 → 经 SSH 转发）。规则只保存名称、`connectionId`、地址与端口，不保存密码、私钥、口令或运行时对象。
- 集中常量：最多 100 条规则、32 条同时运行、每规则最多 64 个连接、全局最多 256 个连接；连接/握手超时 10 秒，停止/解绑超时 5 秒（`src/shared/constants/portForward.ts`）。
- `local`/`remote` 默认监听 `127.0.0.1`，监听地址必须是 IP 字面量（不接受主机名）；`dynamic` 的监听地址在 schema 中固定为 `127.0.0.1`。不存在默认 `0.0.0.0`。
- 非回环监听在启动前必须由用户显式确认暴露风险（`confirmExposure: true`）；该确认在 schema 之后由服务再次检查，不能仅靠渲染端。远程服务器拒绝绑定时只返回失败，不会自动放宽到其他地址/端口。

### 服务状态机与生命周期

```text
stopped → starting → running → stopping → stopped
                 └──────────────→ error
running/starting → error(cleanupPending=true) → error(cleanupPending=false)
```

- `PortForwardService` 是唯一权威：`start` 只有在监听器/远程绑定真实建立后才把规则置为 `running`；渲染端点击按钮不会直接把规则标记为运行中。
- 每次状态变化递增 `revision` 并推送完整快照；单条规则的创建、更新、启动、停止与恢复通过串行队列执行，避免并发启动重复占用槽位或重复清理。
- `start` 依次校验：规则存在、连接配置仍存在、目标会话 `connected` 且 `connectionId` 一致、活动规则上限、门面可用、暴露确认；任一失败返回固定错误，规则不进入 `running`。
- 启动失败把规则置为 `error` 并清除监听资源；运行中意外失败先发布 `error + cleanupPending`，再有界清理，清理成功后才清除 `cleanupPending`。清理失败保留 `error + cleanupPending`，阻止删除规则/连接。
- `stop` 先进入 `stopping`，关闭监听器并等待活动连接/解绑收敛（最多 5 秒）；失败保留 `error + cleanupPending` 并拒绝危险删除。重复停止幂等。
- 规则运行期间只绑定启动时的 `sessionId`。会话断开/门面关闭时规则以 `session-ended` 结束；**不会**在重连时静默切换到新 `sessionId`，也不会自动重新启动。
- 应用重启只加载规则并保持 `stopped`，不恢复监听器，也不假定上次的本地/远程监听仍然存在。

### 本地转发、远程转发与 SOCKS5

- **本地转发**：`net.createServer({ pauseOnConnect: true })` 在配置地址监听；每个入站连接占用一个规则槽与全局槽，经门面 `forwardOut` 打开到目标的 Channel，再用双向流桥接传输。目标连接失败只关闭该连接，不终止监听；停止时先停止接受新连接，再销毁全部连接并关闭服务器。
- **远程转发**：通过门面 `forwardIn(bindAddress, bindPort)` 请求服务器监听，使用服务器返回的实际端口；只接受目标地址/端口匹配本规则的 `tcp connection`，未匹配或超限的连接被拒绝。每条入站连接由主进程 `net.createConnection` 连接 `targetHost:targetPort`，再与 SSH Channel 桥接。停止时调用 `unforwardIn`；解绑失败保留 `cleanupPending`，不会假装已停止。
- **动态转发（SOCKS5）**：只在本机回环监听，使用独立 `socks5Protocol.ts` 实现 RFC 1928 no-auth CONNECT：支持 IPv4、域名与 IPv6 目标；拒绝 BIND、UDP ASSOCIATE、SOCKS4 与其他命令（`0x07`/`0x08`），协议错误返回完整 10 字节回复。解析器容忍任意分片与握手后同包数据，保留 leftover 不丢失客户端首包；握手默认 10 秒超时、最多 1,024 字节。
- 三条运行时共享 `RuleConnectionTracker`：每规则与全局连接上限同时生效，连接关闭/失败/超时释放槽位；`streamBridge` 处理双向背压与幂等销毁，避免半关闭或重复释放。
- 所有运行时只转发字节；**不解析、不读取、不存储、不记录** SSH/SOCKS 隧道的应用层内容。

### 连接删除级联

- `port-forwards:connection-impact` 返回该连接下的规则数与运行中数量；渲染端删除连接前展示计数，有规则时必须勾选明确的级联确认。
- 主进程在 `connections:remove` 时重新计算影响，未提供 `cascadePortForwards: true` 则拒绝删除；确认后先停止并删除该连接的全部规则，任何停止/清理失败都会中止删除并保留连接与规则，避免留下仍在监听的孤儿规则。
- 级联删除不会删除主机密钥信任记录，也不会影响其他连接的规则或会话。删除顺序为先规则、后连接：若连接仓库删除在规则删除之后失败，规则已被移除，这是已知的残余风险（见 `docs/TASKS.md`）。

### 持久化与渲染端

- `port-forwards.json` 使用 `{ version: 1, data: { rules } }` 信封，strict schema、唯一 ID、最多 100 条、原子写入与串行队列；只保存规则，不保存运行时、监听器、连接数、失败信息或凭据。
- `portForwardStore` 按 `revision` 合并主进程快照，旧快照不会回退状态；pending 只表示本地请求进行中，不伪造 `running`。启动弹窗只列出与规则连接匹配且状态为 `connected` 的会话，并要求非回环监听确认暴露风险；活动规则禁止编辑/删除，需先停止并等待清理完成。
- 连接删除的 impact/级联确认由 `connectionStore` 管理；impact 读取失败时禁用确认并允许重试，不在未知情况下删除连接。

## 9. 快速命令与命令历史（P1-04）

快速命令复用既有 SSH 会话与终端写入通道，不创建额外 SSH Client、exec 通道或本地 shell。渲染进程只提交命令定义、参数、显式目标与记录开关，命令库、模板渲染、目标复核与历史写入都由主进程完成。P1-05 的分屏只改变终端可见布局，不改变快速命令的目标校验、写入队列或历史语义；自动重连不会重放快速命令或未发送草稿。

### 组件与职责

- 共享层：`src/shared/quickCommands/template.ts` 负责解析与字面渲染；`builtIns.ts` 定义只读内置命令；`src/shared/constants/quickCommands.ts` 定义限额与存储版本；`src/shared/schemas/quickCommands.ts` 校验草稿、执行输入与持久化信封。
- 主进程：`QuickCommandRepository`（`quick-commands.json`）保存自定义命令与内置收藏；`CommandHistoryRepository`（`command-history.json`）保存历史；`QuickCommandService` 负责投影、CRUD、模板复核、目标校验、写入与历史。
- 渲染进程：`quickCommandStore` 保存抽屉/编辑器/发送确认状态与主进程投影；`QuickCommandDrawer`、`QuickCommandEditorModal`、`QuickCommandComposeModal` 组成界面；`quickCommandTargets.ts` 只负责可发送性判断，`terminalRuntime.ts` 提供输入插入与队列冲刷。
- 主进程只依赖 `SshService.getStatus`、`getShellStatus` 与 `writeShell`，不直接持有 `ssh2.Client`；渲染进程永远拿不到终端输出、Client、Channel 或凭据。

### 命令库

- 内置命令固定为 12 条只读诊断：`uptime`、`df -h`、`free -h`、`uname -a`、`id`、`systemctl status {{service}} --no-pager`、`journalctl -u {{service}} -n 100 --no-pager`、`ss -tulpn`、`ip addr`、`ping -c 4 {{host}}`、`tail -n 100 {{path}}`、`grep -n {{pattern}} {{path}}`。不提供重启、停止、删除或其他改变服务器状态的命令。
- 内置命令定义随应用发布，只读且 `editable: false`；持久化文件只保存内置命令的收藏 ID，并在读取时校验 ID 属于当前内置集合。
- 自定义命令最多 500 条，字段为名称、分类、说明、正文与参数列表；列表返回内置命令在前、自定义命令按 `updatedAt` 倒序。删除自定义命令不会删除历史记录。
- 收藏上限 64 条，只接受存在的内置命令 ID 或自定义命令 ID；未知 ID 返回 `not-found`。

### 模板解析与渲染

- 模板为单行文本，占位符只接受 `{{identifier}}`（字母或下划线开头、最多 32 位），最多 16 个参数。未闭合 `{{`、未配对 `}}` 与非法标识符直接拒绝，避免“预览正文”和实际写入悄悄不一致。
- 正文 ≤4,096 字符且不能包含控制字符；参数值会去除首尾空白，必须非空、≤512 字符且不能包含换行/控制字符；渲染后正文不能为空且不能超过正文上限。
- 替换是字面、单次的正则替换：参数值不会被再次解析为模板；不使用 `eval`、`new Function`、本地 shell 或自动转义。应用只承诺“按字面替换”，不承诺通用 shell 安全转义，用户需自行确认命令语义。
- 保存时 schema 校验参数列表与正文占位符按顺序完全一致；发送时主进程重新解析并渲染，不复用渲染端预览结果。

### 目标选择、插入与发送

- 抽屉打开时只捕获当前活动标签的 `tabId` 与 `sessionId`，作为发送确认的初始候选；用户必须在确认框中显式选择目标，界面不会因后台标签切换或新连接建立而自动改变目标。
- 渲染端在发送前校验 `sessionStore` 中的会话 ID、`terminalStore` 中的 Shell `open` 状态与运行时绑定；目标失效时禁用确认并提示重新选择，**不自动切换、不自动重发**。
- 「插入」调用 `insertTerminalInput(tabId, sessionId, body)`，仅把正文写入该标签的终端输入队列，不追加回车，不自动执行。
- 「发送并执行」先 `flushTerminalInput(tabId)` 冲刷该标签已排队的键盘输入，再复核目标，然后调用 `quick-commands:execute`；主进程写入 `${body}\r`，复用 `terminal:write` 对应的 `SshService.writeShell`。
- 每个发送确认框只生成一个请求 ID，重试复用该 ID；主进程保留最近 200 个已处理请求 ID，重复请求返回 `conflict`，不会写入两次。同一标签已有发送在途时，第二次发送直接被拒绝。
- 主进程 `requireTarget` 重新校验：`getStatus(sessionId)` 存在、`snapshot.sessionId` 与请求一致、`snapshot.clientId === tabId`、状态为 `connected`，并且 `getShellStatus(sessionId).status === 'open'`；任一不满足都返回固定错误且不写入。
- 历史记录重发使用用户确认的历史正文（`kind: 'history'`），仍会重做目标校验与发送锁；不会重新拼接触发历史的原命令。

### 命令历史

- 默认关闭：新安装 `settings.json` 的 `commandHistoryEnabled` 为 `false`。关闭时历史页仍可查看、复制、插入、删除与清空，但发送不会新增记录。
- 开启后，发送确认框的「记录本次发送」默认勾选，可取消；主进程在发送时再次读取设置，若已关闭则不记录并返回 `historyRecorded: false` 与说明。
- 只记录快速命令成功写入后的最终正文、发送时间、`tabId`、`sessionId`、`connectionId`、`connectionName` 与 `host`；不记录终端输出、退出码、键盘输入或凭据。
- 最多 200 条，按最新在前；支持单条删除与清空。清空即使遇到损坏文件也会写入空历史并返回已清除条数，从而恢复可用状态。
- 历史与诊断日志分离：正文和参数值不写入 `logs/`；历史文件**不额外加密**，依赖操作系统账户与磁盘权限，设置页与抽屉页脚均明示这一点。

### 失败语义

- 目标不存在、会话断开、Shell 未打开、目标被替换：`unavailable`/`conflict`，不写入任何内容，不自动换目标。
- 模板/参数不合法：`invalid-input`，不写入。
- 写入失败：错误返回渲染层，界面提示“发送结果未知”时不会假装成功；请求 ID 去重避免用户因重试而重复执行。
- 历史写入失败不回滚已写入终端的命令，只返回 `historyRecorded: false` 与警告，界面如实展示。

## 10. 认证与凭据

`VaultCredentialResolver` 只在主进程运行：

| 认证方式            | 凭据来源                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `password`          | 凭据库中的密码；按 `credentialRef`（若配置）或 `termforge://connection/<id>/password` 查找      |
| `privateKey`        | `credentialRef` 为路径/`file://`/`~` 时读取私钥文件；否则从凭据库读取私钥内容                   |
| `privateKey` + 加密 | 检测 OpenSSH/PEM 加密格式后，从凭据库读取 `passphrase`；缺失则要求输入                          |
| `sshAgent`          | 系统 OpenSSH Agent：Windows `\\.\pipe\openssh-ssh-agent`，POSIX `SSH_AUTH_SOCK`；不支持 Pageant |

- 私钥文件只由主进程读取，限制为普通文件、1–65,536 字节，支持绝对路径、`~` 与 `file://`。
- `saveCredential` 只允许与连接认证方式匹配的类型；SSH Agent 连接拒绝保存密码/私钥。私钥内容会规范换行、去除首尾空白并校验 PEM 头。
- 凭据写入 `EncryptedCredentialStore`，使用 `safeStorage` 加密；不可用时失败关闭，没有明文回退。
- 渲染进程的密码/口令输入使用非受控输入框，提交后立即清空 DOM 值；React state 与 Zustand 只保存凭据类型、连接元数据与错误信息，不保存秘密内容。
- 密码、私钥内容与口令不会写入 `connections.json`、日志、Toast 或错误消息。

## 11. 渲染端状态与交互

### sessionStore

- 只保存**可序列化**的 `SessionInfo` 记录（以稳定标签 ID 为键）：当前主进程会话 ID、连接信息、状态、generation、是否曾有终端、时间戳、主机密钥与失败信息；不保存 Client、Channel、xterm 或凭据。
- `openSession` 同步创建标签与 workspace 顺序，再调用 `bridge.ssh.connect(connectionId, tabId)`。同一连接仅在存在 pending 标签时快速去重；连接完成后再次打开会创建独立会话。
- `workspaceStore` 独立保存 `tabOrder` / `activeTabId`；`sessionStore` 不负责标签顺序。
- `applySshSnapshot` 只接受 `clientId` 对应已存在且未处于渲染端关闭流程的标签；已被替换的旧 `sessionId` 加入 `dismissedSessionIds`，迟到事件不会覆盖新会话。
- `reconnectSession` 是显式手动重连：先标记 `reconnecting`、递增 generation、解绑旧终端、断开旧会话，再以同一 `tabId` 建立新 SSH 会话；旧事件被忽略，失败保留可重试错误。
- `closeSession` 先标记 `closing` 并停止事件处理，清理 xterm/终端运行时，等待未决连接最多 5 秒，再请求主进程断开；显式失败会恢复可重试标签，超时则移除标签并提示未确认清理。关闭 Promise 按标签去重，重复请求幂等。
- `closeSessionsForConnection`、`retainConnections`、`reset` 复用同一关闭/断开路径；`reset` 还会清理 workspace、终端运行时与提示队列。
- 主进程状态是唯一权威：渲染端不在点击按钮时推断 `connected`，状态只由事件或 IPC 返回快照驱动。

### SSH 事件 hook

`useSshBridgeEvents`：

- 订阅 `onSessionStatus`：应用快照；终态清理主机密钥提示；`connected` 清理凭据提示；`error` 且带 `credentialKind` 时打开凭据补录。
- 订阅 `onHostKeyRequest`：把 challenge 加入待确认队列。
- effect 清理函数同时调用两个取消订阅函数。

### sftpStore 与 SFTP 页面

- `sftpStore` 以稳定标签 ID 为键保存 `SftpTabState`：绑定的 `sessionId`、规范化路径、目录条目、`opening/loading/ready/error/disconnected` 状态、单选/多选项、变更操作状态与单调递增的 `requestId`。
- `open(tabId, sessionId)` 先调用 `sftp.open` 获取主目录，再载入该目录；同一标签切换到新 SSH 会话时清空旧路径、条目和选中项。已处于 `opening/loading/ready` 的同一会话重复调用会被 store 去重。
- `load`/`refresh`/`retry` 通过 `requestId + sessionId` 守卫：只有最新请求且会话仍匹配的响应才能写入。旧路径、旧会话或关闭后到达的响应被丢弃；主进程返回的 `sessionId`/`path` 与请求不一致时同样丢弃并显示错误。
- 错误码 `unavailable` 映射为 `disconnected`（可重试打开），其余为 `error`；`invalid-input` 在执行 bridge 前由本地路径校验拦截。
- 变更操作（mkdir/rename/delete）在目录 `ready` 且会话匹配时执行；运行中记录 `running`，已知失败保留固定错误码/消息，`outcome-unknown` 明确提示刷新核实且不自动重试。目录删除按条目类型调用 `removeDirectory`，文件与符号链接调用 `deleteFile`。
- `SftpView` 从工作区标签与 `sessionStore` 推导可用 SSH 会话，提供会话选择器；若当前标签的 SFTP 状态属于其他会话，则不渲染旧数据。SFTP 只在已连接会话上自动打开。
- 新增 `localPanelStore`（按标签）：保存规范化本地路径、父路径、条目、根入口、排序、隐藏文件开关与单选/多选，复用 `requestId` 守卫丢弃旧目录/旧会话响应；关闭标签与全局重置时清理，手动重连刻意保留本地状态。
- 左侧 `LocalFilePanel` 展示真实本地目录（主目录/磁盘根入口、面包屑、路径输入、返回上一级、刷新、排序与隐藏文件开关），条目只有元数据（名称、类型、大小、mtime、隐藏标记），没有文件内容；相对路径与设备前缀在渲染端先拦截，主进程仍再次校验。它同时是上传源（拖出/「上传到远程」）与下载落点（拖入）。
- 右侧 `RemoteFilePanel` 展示真实远程数据，包括打开/加载/空目录/错误/断开状态、面包屑与路径编辑、刷新、新建目录、重命名、删除确认与选中项元数据。支持 Ctrl/Cmd 多选；普通文件可拖出（拖拽载荷带来源 `sessionId`），本地文件/目录可拖入；下载只包含选中的普通文件，目录与符号链接不会进入任务。
- `features/sftp/fileDrag.ts` 定义自定义 MIME 载荷（`application/x-termforge-local-paths` / `application/x-termforge-remote-files`）与 `useDropZone`（dragenter/dragleave 计数防止高亮闪烁）；OS 文件拖入经 `webUtils.getPathForFile` 解析为路径后再交给传输入队。
- `SftpView` 把拖拽落点转为 `enqueueUploadPaths`/`enqueueDownloadPaths` 并提示跳过/截断计数；跨会话拖拽载荷与磁盘根目录下载目标被拒绝并提示。
- 关闭标签、重连、删除连接与全局重置都会清理对应 SFTP 标签状态；主进程通道由 SSH 终态回调释放。上传结束后 `useTransferBridgeEvents` 会刷新仍显示目标目录的标签，避免把临时文件或旧列表当作最终状态。
- `TransferDrawer` 是 `transferStore` 的只读投影：任务快照按 `revision` 合并，旧响应不会回退状态；入队或首次出现冲突时自动打开抽屉。取消、重试、冲突处理与清空历史都只调用固定 IPC 方法；`interrupted` 任务只展示「已中断 / 结果未知」，不提供重试，并明确说明不会自动续传。

### portForwardStore 与端口转发页

- `portForwardStore` 只保存主进程快照 `PortForwardSnapshot`（`revision` + `items`）、请求中的规则 ID 与编辑器/启动/删除目标；不保存监听器、Socket、Channel 或流量。
- `applySnapshot` 丢弃旧 `revision`；`sync` 从主进程重新读取快照；`startRule`/`stopRule` 只合并主进程返回的 `PortForwardItem`，失败写入 `actionError` 并抛出，不在本地推断 `running`。
- `PortForwardsView` 展示规则类型、连接、监听/目标地址、权威状态、绑定端点、活动连接数、`cleanupPending` 与固定失败信息；运行中/停止中的规则禁止编辑和删除，需先停止并等待清理完成。
- `PortForwardEditorModal` 只编辑规则字段（类型在编辑时不可变），默认本地/远程监听 `127.0.0.1`；不包含凭据字段。`PortForwardStartModal` 只列出与规则连接匹配且已连接的会话（活动标签优先），非回环本地/远程规则必须勾选暴露风险确认；没有可用会话时禁止启动并给出说明。
- `DeletePortForwardModal` 要求二次确认；运行中规则不可直接删除。删除连接的影响与级联确认由 `connectionStore` / `DeleteConnectionModal` 处理：加载失败禁用删除、有规则时要求勾选级联确认，确认后先停止并删除规则，再删除连接。

### quickCommandStore 与快速命令界面

- `quickCommandStore` 保存抽屉开关、当前标签页（命令库/历史）、搜索词、命令与历史投影、加载状态、打开抽屉时捕获的目标候选、编辑器与发送确认状态；不保存终端输出、Shell Channel、SSH Client 或凭据。
- `openDrawer(tabId?)` 在打开瞬间记录当前活动标签的 `{ tabId, sessionId }`（仅当该标签可发送），并并行刷新命令库与历史；关闭抽屉或重置时清空候选与弹窗状态。
- `executeQuickCommand` 在调用 IPC 前校验会话 ID、Shell `open` 与运行时绑定，冲刷该标签的终端写入队列后再次校验；成功后仅在 `historyRecorded` 为真时刷新历史，失败保留主进程固定错误。
- `QuickCommandDrawer` 提供命令库/历史两个标签页、搜索、分类筛选、收藏、复制与发送/插入入口；内置命令只显示收藏/复制，自定义命令额外提供编辑与删除。历史页支持搜索、复制、插入、确认后重发、删除与二次确认清空。
- `QuickCommandComposeModal` 显示最终预览、参数输入、显式目标选择与「记录本次发送」复选框；目标失效时显示警告并禁用确认，不自动改选其他标签。`QuickCommandEditorModal` 只编辑自定义命令字段与参数，内置命令不进入编辑器。
- 入口包括终端工具栏「快速命令」、命令面板动作与 `Ctrl/Cmd+Shift+K`；快捷键不与现有终端/输入框操作冲突，抽屉关闭后焦点返回原终端。
- 设置页「会话与传输记录」分区提供命令历史开关、当前状态、清空按钮与明文存储/日志分离说明；关闭开关只阻止新增，不删除已有记录。

### 设置中心

- `SettingsView` 分区展示外观、终端、传输并发、诊断日志、存储与凭据、应用信息、会话与传输记录（含命令历史开关与清空）、快捷键。主题提供深色/浅色/系统三种卡片；系统主题同时展示当前解析结果。
- 终端设置只提供白名单字体（8 种预设）、字号（10–20）、光标样式（block/underline/bar）、闪烁与回滚行数（1,000/5,000/10,000/20,000）；界面字体（3 种预设）与字号（12/13/14/15）同样走白名单与 schema 校验。所有值在主进程再次校验。
- 传输并发提供全局 1–4 与每会话 1–2；降低全局上限到低于当前每会话值时，设置页同时提交两者以避免无效组合。
- 日志区展示级别、目录、文件数量、写入失败次数与各文件大小/时间，提供刷新、导出与打开文件夹；导出路径由主进程原生对话框决定。
- 存储与凭据区展示 safeStorage 保护状态与主机密钥列表；删除信任记录必须经过弹窗确认，明确“不会断开当前会话、下次连接会重新确认”。凭据值从不显示。
- 会话与传输记录区提供命令历史开关/清空，以及自动重连开关（默认关闭）。自动重连说明列出最多 5 次、1/2/4/8/15 秒退避、仅网络类错误会重试，并明确不会自动信任新主机密钥、不会重放输入；关闭开关会立即停止所有待执行重试。
- 设置读取失败时显示 `role="alert"` 横幅与「重新读取」按钮；恢复警告逐条展示。设置写入失败时保留乐观值直到失败回滚，并弹出危险 Toast。日志与主机密钥列表在页面挂载时加载，并提供手动刷新；读取失败以固定错误文案展示。
- 外观区包含壁纸卡片：预览、`启用壁纸模式` 开关、选择/更换/移除按钮与轻/标准/浓三档浓度。未导入图片时开关与浓度不可用；导入成功后自动开启壁纸模式；移除壁纸会关闭壁纸模式。所有状态都经固定 IPC 与主进程同步，不使用浏览器存储。

### 壁纸模式

- `wallpaperStore` 只保存 `dataUrl/fileName/updatedAt/status/busy/error` 与三个动作；启动时 `loadWallpaper()` 读取主进程投影，不会读取文件系统或浏览器存储。
- `App` 在 `wallpaperEnabled && dataUrl` 时给 `.app-shell` 设置 `data-wallpaper="on"` 与 `data-wallpaper-intensity`，并通过内联 CSS 变量 `--tf-wallpaper-image` 引用 data URL；纯色模式不设置壁纸变量，布局与终端保持原样。
- 壁纸入口只保留在 `SettingsView` 的「外观」分区，提供预览、选择/更换、启用/暂停、移除与浓度选择。浓度只影响面板遮罩强度，不改变终端、输入框、正文与弹窗表单的不透明度。
- 壁纸只影响视觉层：SSH/SFTP/终端/传输逻辑、IPC 通道与安全策略均不因壁纸模式改变。

### 提示与弹窗

- `HostKeyConfirmModal`：展示主机、端口、算法与指纹；关闭按钮、Esc、点击遮罩、取消按钮都发送 `accepted: false`，不会信任密钥。
- `CredentialPromptModal`：密码或私钥/口令的非受控输入；保存成功后关闭并重新连接；保存失败保持弹窗并展示错误。
- 主机密钥 challenge 按会话排队；会话进入终态时清理相关提示。

### 工作台

- 标签顺序与活动标签来自 `workspaceStore`；每个标签的 SSH 状态来自 `sessionStore` 的 `clientId` 记录。关闭活动标签后激活右侧邻居，否则左侧；关到空时显示空状态。
- `TerminalPane` 根据 SSH 状态展示：连接中、认证中、等待主机密钥确认、已连接、断开、错误、重连/取消等视图；`aria-live` 通知状态变化。
- SSH `connected` 后渲染 `XtermTerminal`：在既有 SSH 会话上自动打开真实 PTY。所有标签的 Pane 保持挂载，用 CSS 隐藏非活动标签，因此切换不会创建或关闭 PTY。
- **SSH 断开但曾有终端**时继续渲染 xterm（只读历史），叠加「SSH 连接已断开」提示、重新连接与关闭标签操作；明确说明重连会创建新 SSH 传输和新 Shell。若自动重连启用且错误码可重试，同一覆盖层展示倒计时/在途状态、「停止自动重连」或「取消自动重连」按钮；耗尽后显示「自动重连已停止」与手动重连入口。
- 工具栏提供左右/上下分屏；分屏仅改变两个窗格的可见布局，每个标签仍只有一个 xterm 与 PTY。未绑定窗格显示空状态，关闭窗格绑定不会关闭标签或 SSH 会话。
- Shell 打开中/关闭中显示遮罩；`closed/exited/error` 显示退出码/信号/固定错误与「重新打开 Shell」按钮，并明确说明 SSH 连接仍保留。
- 不包含 textarea 输入框或本地 shell；键盘输入全部经 preload 写入主进程 PTY，本地不做回显。
- 连接错误展示固定消息和补救指引（凭据、主机密钥变化、Agent 不可用等）。

### 分屏布局（P1-05）

- `features/terminal/splitLayout.ts` 定义运行态模型：固定 `pane-a`/`pane-b` 两个窗格、`row`/`column` 两个方向、比例 20%–80%（默认 50%）与焦点窗格。类型不进入共享 IPC、不写入设置或任何持久化文件。
- `workspaceStore` 持有 `split`，并在标签增删/激活时维护绑定：优先填充空窗格，否则替换当前焦点窗格；已绑定标签再次激活只移动焦点，不会在两个窗格重复显示同一标签。两个窗格都为空或最后一个标签关闭时自动退出分屏。
- 每个标签仍只挂载一个 `TerminalPane`/xterm 实例；分屏只是改变可见窗格与布局，不创建第二个终端实例，也不调用 SSH connect/disconnect。窗格解绑只隐藏终端，标签、SSH 会话、PTY 与输出缓冲保持不变。
- 工具栏提供「左右分屏」「上下分屏」，分隔条支持指针拖拽、方向键（2%）、Shift+方向键（10%）、Home/End 与双击复位；控件使用 `role="separator"` 与 20–80 的 `aria-valuenow`。
- 未绑定标签的窗格显示空状态，要求用户从标签栏选择会话；不会自动建立连接或从其他窗格借用会话。一个窗格断开、重连或取消连接不影响另一个窗格。

### 终端运行时与 xterm

终端实现刻意放在 React 状态之外：

- `useTerminalBridgeEvents` 在 `App` 根订阅 `terminal:output/status/exit`，因此切换到其他模块时输出仍会进入有上限的会话缓冲。
- `terminalRuntime.ts` 维护模块级状态：每**标签**重放缓冲（最多 256 KiB）、输出监听器集合、打开 Promise 去重、写入队列、尺寸去重键、事件 revision、`sessionId → tabId` 绑定与已忽略会话集合。
- `terminalStore` 以稳定标签 ID 为键，只保存 `TerminalShellSnapshot`（状态、尺寸、失败、退出信息）；**终端输出与输入从不进入 Zustand 或 React state**。
- `bindTerminalTab(tabId, sessionId)` 在收到 `connected` 快照时建立绑定；重连、关闭或标签被移除时解绑并把旧 `sessionId` 加入忽略集合，迟到输出不会串到其他标签。
- `XtermTerminal` 创建 `Terminal` + `FitAddon`：`convertEol: false`、字体族/字号/光标样式/闪烁/回滚行数来自持久化设置（默认 Cascadia、13px、block、闪烁、5,000 行），主题按当前解析后的深/浅色读取 CSS 变量；挂载时回放缓冲、订阅输出并注册 `term.onData` 发送输入。设置变化在 `requestAnimationFrame` 内原地更新 xterm 并重新 fit，不重建终端或 PTY。
- 输出由 preload 事件直接 `term.write(data)`；输入直接 `bridge.terminal.write`，不经过组件状态，也不做本地 echo。
- `ResizeObserver` + 60ms 防抖 + `requestAnimationFrame` 触发 FitAddon；仅当容器 `clientWidth/clientHeight ≥ 40` 且经过整数校验后发送 resize，避免零尺寸和隐藏容器导致的错误。
- 挂载时 `ensureTerminalShell` 通过 `getStatus` 确认权威状态，再决定复用或打开；事件 revision 防止较早的 `getStatus` 响应覆盖较新的推送状态。
- 组件卸载（标签切换、模块切换、StrictMode 双挂载）只释放 xterm 实例、监听器、定时器与 ResizeObserver，**不关闭 PTY**；PTY 只随用户关闭 Shell、SSH 断开或应用退出释放。
- 重新打开 Shell 时清空旧 transcript 并重置 xterm，避免把已退出会话的输出混入新 PTY。

## 12. 数据持久化

| 数据                        | 位置                                                     | 写入方                                                |
| --------------------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| 连接与分组                  | `<userData>/connections.json`                            | `ConnectionRepository`（原子写入、串行队列）          |
| 加密凭据                    | `<userData>/credentials.enc.json`                        | `EncryptedCredentialStore`（safeStorage 密文）        |
| 主机密钥信任                | `<userData>/known-hosts.json`                            | `FileHostKeyStore.trust/remove`                       |
| 会话状态                    | 主进程内存                                               | `SshService`（唯一权威）                              |
| Shell/PTY 状态与通道        | 主进程内存                                               | `SshService` / `ShellChannelManager`（唯一权威）      |
| SFTP 通道、主目录与路径锁   | 主进程内存                                               | `SftpService`（唯一权威；不持久化）                   |
| 端口转发规则                | `<userData>/port-forwards.json`                          | `PortForwardRepository`（版本化、strict、原子写入）   |
| 端口转发运行时              | 主进程内存                                               | `PortForwardService`（唯一权威；不持久化）            |
| 自定义快速命令与收藏        | `<userData>/quick-commands.json`                         | `QuickCommandRepository`（版本化、strict、原子写入）  |
| 命令历史                    | `<userData>/command-history.json`                        | `CommandHistoryRepository`（最多 200 条；不额外加密） |
| 应用设置                    | `<userData>/settings.json`                               | `SettingsRepository`（版本化 v6、strict、原子写入）   |
| 壁纸图片与展示元数据        | `<userData>/wallpapers/wallpaper.jpg` / `wallpaper.json` | `WallpaperService`（重编码 JPEG + 原子写入）          |
| 壁纸渲染投影                | 渲染进程内存                                             | `wallpaperStore`（data URL + 文件名，不落盘）         |
| 未完成传输任务快照          | `<userData>/transfer-journal.json`                       | `TransferService`（最多 100 条；仅活动/已中断）       |
| 结构化诊断日志              | `<userData>/logs/termforge*.log`                         | `Logger`（脱敏、轮转、限长；导出需用户选择路径）      |
| 传输任务、队列与临时文件    | 主进程内存 + 目标目录临时文件                            | `TransferService`（唯一权威；结束/退出清理）          |
| SFTP 目录条目、状态与选中项 | 渲染进程内存（按标签）                                   | `sftpStore`（应用运行期间）                           |
| 分屏布局与窗格绑定          | 渲染进程内存                                             | `workspaceStore`（运行态；不持久化）                  |
| 自动重连进度与定时器        | 渲染进程内存                                             | `sessionStore`（运行态；不持久化）                    |
| 终端输出重放缓冲            | 渲染进程内存（模块级，≤256 KiB/标签）                    | `terminalRuntime`（不进入 Zustand）                   |
| 传输任务投影                | 渲染进程内存                                             | `transferStore`（只读投影，按 `revision` 合并）       |
| 渲染镜像、偏好              | 渲染进程内存                                             | Zustand stores                                        |

连接仓库仍使用首启种子、strict schema 与版本化信封；损坏时停止加载。主机密钥仓库只保存 host/port、算法、OpenSSH SHA256 指纹与信任时间，同一端点只保留一条记录。传输任务历史、队列、速度采样与临时文件路径不落盘，只有未完成任务的展示快照进入传输日志，重启后水合为 `interrupted` 且不恢复执行；`.termforge-part-*` 与 `.termforge-backup-*` 只用于进行中/提交中的传输，正常结束后应被清理。

**端口转发持久化（P1-03）**：`port-forwards.json` 使用 `{ version: 1, data: { rules } }` 信封，读取时校验严格 schema、规则类型/地址/端口、连接 ID 格式与 ID 唯一性，最多 100 条；仓库通过串行队列与原子写入持久化，损坏或非法文件不会加载为可用规则。运行时状态（监听器、绑定端点、连接数、失败、`cleanupPending`）只存在于 `PortForwardService` 内存，不落盘；应用重启后所有规则保持 `stopped`，不会恢复监听，也不会自动重新绑定到新会话。规则不包含密码、私钥、口令或任何凭据引用。

**设置持久化（TASK-008，P1-04 扩展至 v3，P1-05 扩展至 v4，主题/字体重构扩展至 v6）**：`settings.json` 使用 `{ version: 6, preferences }` 信封，写入前用 strict schema 校验并由 `writeJsonFileAtomic` 原子替换。读取损坏文件时逐字段回退默认值、返回警告并保留原文件；读取 v5 文件时在内存中补入 `dbxThemeMode: 'system'`、`uiFontFamily: 'system'` 与 `uiFontSize: 13`，读取 v4 文件时还把旧 `dark/light` 主题映射为 `aurora/mist` 并补 `gradientIntensity: 35`，读取 v3 文件时补 `autoReconnectEnabled: false`，读取 v2 文件时再补 `commandHistoryEnabled: false`，读取 v1 文件时再补壁纸默认值（关闭、标准浓度），均不产生恢复警告，只有用户再次保存时才写成 v6。`SettingsRepository` 内所有读写串行执行。设置只包含主题/DBX 明暗、界面与终端字体/字号、终端光标/回滚、渐变强度、传输并发、日志级别、壁纸开关/浓度、命令历史开关与自动重连开关，不包含主机、用户名、路径、命令正文或任何秘密。共享 `shared/theme/catalog` 同时供渲染进程与主进程解析主题，主进程据此更新 Windows 标题栏按钮颜色与窗口底色；设置更新成功后立即应用日志级别与并发上限；命令历史开关在每次发送时实时读取，关闭后立即停止新增；自动重连开关由渲染端读取，关闭时立即清除所有待执行重试。

**快速命令持久化（P1-04）**：`quick-commands.json` 使用 `{ version: 1, data: { customCommands, builtInFavoriteIds } }` 信封，strict schema 校验 ID/正文/参数一致性、唯一性与数量上限（500/64），串行队列 + 原子写入；损坏或非法文件不会加载为可用命令，也不会被加载过程覆盖。内置命令不落盘，只保存收藏 ID。`command-history.json` 使用 `{ version: 1, data: { entries } }` 信封，最多 200 条、ID 唯一、按最新在前，串行队列 + 原子写入；损坏文件在读取时报错而不返回残缺记录，清空操作可写入空历史恢复可用状态。历史正文为最终渲染文本，不包含参数表、终端输出或凭据；该文件不额外加密，且命令正文不写入诊断日志。

**壁纸持久化**：`WallpaperService` 在 `<userData>/wallpapers/` 下保存由主进程重编码的 `wallpaper.jpg` 与 `wallpaper.json`（仅版本、原始文件名 basename、更新时间）。源图限制为 PNG/JPEG、非空、≤20 MiB，解码后最长边不超过 2,560px；写入使用唯一临时文件 + rename，失败时清理临时文件。读取只返回 JPEG data URL 与展示元数据，源路径不进入 renderer，也不写入日志。

**诊断日志（TASK-008）**：`Logger` 输出 `timestamp/level/module/event` 加脱敏元数据的 JSONL；默认级别 `info`，支持 `error/warn/info/debug`。单文件默认 2 MiB、保留 5 个文件，按大小轮转；单行超过 16 KiB 时降级为只含时间/级别/模块/事件的 `truncated` 行。`redact.ts` 对敏感键名（密码、token、私钥、Authorization、terminalInput/terminalOutput 等）、PEM 私钥、`key=value` 秘密、URI 用户信息做脱敏，并限制字符串 2,048 字符、数组 100 项、深度 6。日志写入失败只累计 `writeFailures`，绝不向 SSH/SFTP/传输调用抛错。日志导出由主进程原生保存对话框选择目标，只读取白名单日志文件，最多拼接 20 MiB，写入前再次文本脱敏；不提供日志内容读取 IPC。

## 13. 测试与质量门禁

`tests/unit` 使用 Vitest 4；UI 测试使用 jsdom + React Testing Library，存储/安全测试使用 Node 环境与临时目录。SSH/PTY/SFTP 测试使用可控的 fake `ssh2` Client/Channel/SFTPWrapper 与 fake host-key/credential 存储，端口转发测试使用 fake `SshForwardingSession`、真实本机回环监听/连接与手写 SOCKS5 客户端，快速命令测试使用 fake `SshService` 窄方法、mock bridge 与临时目录，分屏/自动重连测试使用真实 `workspaceStore`/`sessionStore` + fake bridge + fake xterm，渲染终端测试使用 fake xterm/FitAddon 与 mock preload bridge，**自动化测试不连接公网服务器，也没有真实 SSH/PTY/SFTP/端口转发集成测试**。P1-04 与 P1-05 另有受控验收入口（`tests/acceptance/quick-command-runtime.mjs`、`tests/acceptance/split-reconnect-runtime.mjs`）：启动源码模式 Electron、本地真实 `ssh2` 夹具服务器与 CDP 驱动的真实渲染层，执行真实 Shell 写入、分屏与连接取消/自动重连并截图；它们不是自动化单元测试，也不属于 Windows OpenSSH Server 或打包应用验收。

覆盖范围：

- 连接 schema、仓库持久化、损坏/写入失败、并发串行化；
- 凭据库无明文落盘、不可用时失败关闭；
- 主机密钥 `unknown/trusted/changed`、verify 不写盘、显式信任、存储失败、30 秒超时与迟到响应；
- `SshService` 密码/私钥/口令/Agent 配置、重复连接复用、远端关闭、错误脱敏、断开/取消/释放，以及 `getSftpClient` 的连接状态校验与 SSH 终态通知（Shell 单独退出不通知）；
- 跳板链（P1-02）：直连回归、单跳/两跳 `forwardOut` 拨号参数与 `sock` 链接、每跳独立主机密钥验证与挑战、跳板凭据失败归属跳、跳板主机密钥变化阻断、`forwardOut` 失败归属下一端点、跳板掉线中断目标、断开自内向外且无孤立 Client、同连接并发会话隔离；全部基于 fake `ssh2` Client 与 fake `forwardOut` 通道；
- PTY：`xterm-256color`、cols/rows 参数、复用、写入路由、`setWindow(rows, cols)` 顺序、UTF-8 跨包解码、输出批量与 sessionId、远端退出/通道错误/本地关闭只通知一次、退出后重开、打开失败/超时、SSH 断开同步关闭、释放；
- SFTP：POSIX 路径规范化/相对解析/名称校验/自然排序、元数据缺失与 mode/longname 回退、通道复用与并发 open、会话隔离、每次操作的会话归属校验、打开/读取/变更超时、迟到回调忽略、通道关闭与 dispose、目录错误映射、mkdir 不覆盖、rename 不覆盖与根路径拒绝、文件/符号链接/目录删除边界、受保护/浅层/非空目录拒绝、同路径并发冲突、变更超时 `outcome-unknown`；
- IPC 63 通道、7 个推送事件、sender/frame 校验、参数校验（含 SFTP 路径/名称、本地路径、传输 ID/批量/冲突策略、端口转发规则/启动/级联删除参数、快速命令草稿/模板参数/执行目标/历史 ID、壁纸无参数通道、`ssh:cancel-connect` 的 `clientId`）、主机密钥响应、凭据输入、终端尺寸/写入校验；
- preload 固定方法、SFTP/localFs/transfer/portForwards/quickCommands/commandHistory 命名空间冻结、订阅与取消订阅；
- 端口转发窄门面：四参数 `forwardOut` 顺序、`forwardIn`/`unforwardIn`、`tcp connection` 地址/端口解析、单监听器 accept/reject、关闭后拒绝新操作、迟到 Channel 销毁；
- 本地转发：真实回环监听、入站连接经 fake 门面打开 Channel、连接上限、目标失败只影响单连接、停止关闭监听与连接；
- 远程转发：`forwardIn` 实际端口、仅接受匹配目标的 `tcp connection`、主进程连接目标、超限拒绝、`unforwardIn`、解绑失败保留清理状态；
- 动态 SOCKS5：RFC 1928 no-auth CONNECT、IPv4/域名/IPv6、分片/合并包、完整 10 字节回复、不支持命令/地址类型、握手超时/字节上限、回环限制、连接上限与清理；
- 转发服务：状态机、监听成功才 `running`、暴露确认、连接/会话/规则上限、启动/停止幂等、运行中失败与 `cleanupPending`、会话结束停止、级联删除、`shutdown`、规则持久化与重启后 `stopped`；
- 端口转发 store 与页面：快照 revision、旧快照丢弃、非回环暴露确认、无已连接会话时禁止启动、活动规则禁止编辑/删除、失败保留权威状态、删除连接 impact/级联确认与失败重试；
- 快速命令模板：`{{identifier}}` 解析、重复参数去重、未闭合/不配对花括号拒绝、非法标识符、16 参数上限、控制字符/空值/超长值拒绝、字面单次替换不递归解析、渲染后空正文与长度上限；
- 快速命令仓库与历史仓库：strict 信封、ID/唯一性、500/64/200 上限、收藏 ID 校验、损坏文件不加载、清空损坏历史后可用、最新在前、单条删除与清空；
- 快速命令服务：内置只读投影、自定义 CRUD、模板服务端重渲染、`tabId`/`sessionId` 绑定与断线/Shell 未打开拒绝、请求 ID 去重、同标签在途锁、历史开关实时读取与关闭/失败警告、历史仅记录最终正文；
- 快速命令 store 与界面：目标捕获与失效禁用、发送前队列冲刷、请求 ID 单次生成、参数校验、预览、插入不追加回车、历史默认关闭/开启后默认勾选、清空二次确认、设置开关与明文存储说明、快捷键/工具栏/命令面板入口；
- 分屏（P1-05）：双窗格绑定/焦点/比例夹取/方向切换、空窗格优先填充、重复标签不跨窗格复制、关闭标签只解绑对应窗格、最后标签关闭退出分屏、布局操作从不调用 SSH bridge；工具栏与分隔条的键盘/指针交互、未绑定窗格空状态与单终端实例；
- 连接取消（P1-05）：按 `clientId` 只取消目标在途尝试、幂等、已完成连接不被断开、重复取消不重复释放、其他标签不受影响、凭据解析阶段与主机密钥等待阶段均可取消且不产生迟到 Client、迟到成功会话被清理；
- 自动重连（P1-05）：可重试错误码白名单、非白名单不重试、1/2/4/8/15 秒退避与 5 次上限、成功清除进度、耗尽终态、设置关闭/主动断开/关闭标签/应用退出清除定时器、等待中与在途取消、迟到成功释放、只在失败窗格重试且不影响相邻会话、倒计时/在途/耗尽 UI；
- 渲染层连接状态、提醒弹窗、凭据不进入 store、标签清理；
- 传输队列：FIFO、重复入队拒绝、全局/会话并发上限、移除等待任务、会话清理与重置；
- 传输服务：真实临时目录上的本地文件流与 fake SFTP 传输端口、临时文件写入/提交、真实字节进度与未知总大小、FIFO 调度、排队/运行中取消与临时清理、覆盖/重命名/跳过冲突、非法重命名、不静默覆盖、提交失败清理、手动重试的 `attempt`/`revision` 与重新校验、会话终止、退出/dispose；
- SFTP 传输端口：只写 `.termforge-part-*`、`wx`/`0600`、读路径校验、覆盖提交的备份/恢复/清理、拒绝非覆盖/非临时/跨目录/缺失临时文件、临时文件只读清理；
- 传输事件：订阅 `transfer:update`、投影同步、上传终态按 200ms 防抖刷新匹配 SFTP 标签、忽略下载/跳过任务、卸载清理定时器；
- 传输抽屉：未知进度不设置 `aria-valuenow`、冲突组与重命名校验、覆盖/取消/重试/清空历史路由；
- 终端运行时：并发打开去重、不可用会话、打开失败、退出后重开、输出隔离/上限、订阅引用计数、写入门控与分片、尺寸校验/去重、忘记会话后忽略迟到事件；
- xterm 组件：挂载打开、输出直写、输入路由、卸载不关闭 PTY、ResizeObserver 合法/零尺寸、StrictMode 双挂载、退出/错误覆盖层与重新打开，以及字体/字号/光标/回滚/主题的实时更新且不重建 PTY；
- SFTP store：打开/加载、会话切换清空、旧路径/旧会话迟到响应丢弃、错误状态映射、刷新保留选中与失效选中清理、mkdir/rename/delete 路由、失败与 `outcome-unknown` 状态、标签清理与重置；
- 设置仓库：默认值不创建文件、版本化持久化、v5→v6、v4→v6、v3→v6、v2→v6 与 v1→v6 内存迁移补齐 DBX 明暗/界面字体/自动重连/命令历史/壁纸默认值且不丢失已有值、不告警不覆盖、逐字段恢复警告且不覆盖原文件、损坏/不可读回退、非法更新与写入失败保持内存状态、并发更新串行化；
- 设置 store 与设置页：启动读取、乐观更新与完整快照提交、失败只回滚未再修改字段、非法补丁不调用 bridge、系统主题变化、缺少 bridge 时会话内降级、日志级别/并发保存、主机密钥显式确认删除、读取失败横幅与重试；
- 壁纸服务：扩展名/非普通文件/空文件/超 20 MiB 拒绝、解码失败、长边缩放至 2,560px、JPEG 质量 85、原子写入与临时文件清理、损坏元数据降级、读取 data URL、移除与取消；
- 壁纸 store 与界面：加载/失败投影、导入后自动开启、取消不改变设置、导入失败提示、移除后关闭壁纸模式、并发请求门控、选择/启用/浓度/移除路由与应用壳 `data-wallpaper` 属性；
- 日志：PEM/密码/API key/Authorization/URI 凭据脱敏、嵌套敏感键、Error/cause/循环引用、字符串/数组/深度上限、级别过滤、JSONL 元数据、按大小轮转、不可用目录不抛错、超长行截断；
- 退出编排：顺序执行、单步失败隔离、卡住步骤超时后继续、空报告；
- 传输排队列：动态并发上限与夹取、运行中降低上限自然收敛、非法上限不破坏现有配置；
- 传输日志：未完成任务在启动时水合为 `interrupted`、`outcome-unknown`、revision 递增、通知与重试拒绝；活动任务防抖写盘、损坏日志忽略；
- 传输抽屉：`interrupted` 显示「已中断」与结果未知、不提供重试、保留真实的重启说明。

门禁命令：`npm run typecheck`、`npm run lint`、`npm test`、`npm run build`。最近一次结果（P1-05，2026-10-24）：57 个测试文件、530 个用例全部通过；typecheck 与 `--max-warnings 0` lint 通过；构建成功，仅有 2 条 `zod` 注释导致的 Rollup annotation 警告。P1-05 受控验收另以源码模式 Electron + 本地真实 `ssh2` 夹具服务器 + CDP 执行，19/19 项通过并生成 10 张截图，产物位于 `release/acceptance/p1-05-split-reconnect/`。

### 未覆盖的环境

- 未在 Windows OpenSSH Server 或真实生产服务器上于 Electron 实窗中逐项验证 SSH/PTY/SFTP 行为。P1-04 受控验收使用本地真实 `ssh2` 夹具服务器与真实 Shell，在源码模式 Electron 中执行过快速命令发送与输入插入，但未覆盖远端退出、网络中断、系统 Agent 与全部 OpenSSH 兼容性。
- P1-04 的快速命令与命令历史未在 NSIS 打包安装包中重复验收；受控验收不是 Windows OpenSSH Server 验收，也未覆盖真实生产网络、系统休眠/唤醒、磁盘满与历史文件权限异常等环境。
- 未在真实跳板网络（两台以上真实服务器）中验收 ProxyJump 链路：跳板拨号、`forwardOut` 通道建立、每跳主机密钥确认与跳板凭据补录；跳板测试全部基于 fake `ssh2` Client 与 fake `forwardOut` 通道，不代表真实跳板服务器兼容性；也未在 Electron 实窗中验收跳板编辑器与链路状态展示。
- 未连接真实 SFTP 服务端执行目录浏览、文件操作、上传与下载；所有 SFTP/传输测试均使用 fake `SFTPWrapper` 或 fake 传输端口，不代表真实服务器兼容性。
- 传输测试使用真实本地文件流与 fake SFTP 传输端口；**这不是真实服务器集成测试**，未验证真实 OpenSSH/SFTP 的流背压、断线、权限与大文件行为。目录展开/截断/符号链接跳过也只有真实本地临时目录 + fake 传输端口测试。
- 未在 Electron 实窗中验证双栏拖拽上传/下载、本地面板导航与 OS 文件拖入（`webUtils.getPathForFile`）的真实交互；这些目前只有单元/组件测试（P1-01）。
- 未在 Electron 实窗中通过原生对话框执行上传/下载，未验证 Windows 文件名冲突、磁盘满、文件被占用与长路径等实机行为。
- 未进行真实服务器上的破坏性操作验收；删除/重命名/覆盖验收只允许针对专门创建的测试文件和测试目录。
- 未验证不同 OpenSSH 服务端对 PTY 尺寸、`TERM`、中断信号、SFTP `rename` 覆盖语义与符号链接的实际行为。
- 未在 Electron 实窗中验证设置保存/回滚、系统主题切换、日志轮转/导出/打开目录、主机密钥删除确认，以及 `before-quit` 的有界顺序清理；这些只有单元/组件测试。
- 未在 Electron 实窗中通过原生图片对话框导入壁纸，未验证真实 PNG/JPEG 解码、缩放、主题叠加、不同 DPI/窗口尺寸下的可读性，也未进行视觉效果验收；壁纸服务测试使用 mock `nativeImage` 与真实临时目录。
- 未在真实 SSH 服务器上验收端口转发（**未执行**）：本地转发、远程转发、SOCKS5 均只有 fake `SshForwardingSession`、本机回环监听/连接与手写 SOCKS5 客户端测试，未验证真实 OpenSSH 的 `forwardOut`/`tcpip-forward`/`cancel-tcpip-forward` 行为、服务器权限与真实防火墙/端口占用；未进行 Electron 实窗规则编辑/启动/停止/级联删除与暴露确认验收。
- P1-05 分屏与自动重连已在受控 Electron + 本地 `ssh2` 夹具 + CDP 中执行 19 项真实交互检查（10 张截图），覆盖双真实 Shell 分屏、窗格绑定/焦点/比例、定向取消、默认关闭、设置开启后的退避重试与 5 次耗尽、无输入重放与无秘密泄漏；**未在 Windows OpenSSH Server、真实网络抖动/丢包/休眠唤醒、公司代理或 NAT 环境、NSIS 打包安装包中验收**。真实服务器强制断开、跳板链断线与端口转发并存场景仍未覆盖。
- 未进行打包、签名、自动更新与跨平台实机验证。

## 14. 后续扩展

1. **终端增强**：复制/粘贴策略、搜索、终端主题细化、Shell 重连与多窗口附着；仍须保持输出不进入全局状态。
2. **传输增强**：远程目录递归下载、带宽限制、暂停/恢复与断点续传、持久化审计历史；任何续传都必须重新校验源、目标与未完成日志，不能把旧临时文件或 `interrupted` 快照当作已完成证据。
3. **SFTP 增强**：可选的递归删除（必须显式确认并在服务端逐项校验）、原子 rename 能力探测、目录变更推送或可控轮询、更多服务器兼容性验证。
4. **分屏与重连增强**：更多窗格、可持久化布局、跨窗口附着、会话恢复提示；任何扩展都不得让布局拥有 SSH 生命周期，也不得自动重放输入。自动重连的策略调整必须继续基于固定错误码、保持默认关闭与有限次数，并重新执行主机密钥与认证流程。
5. **更多认证**：keyboard-interactive、Pageant/第三方 Agent、proxy command 与 SOCKS 代理；ProxyJump 等价能力已由 P1-02 的有序跳板链实现（引用已保存连接），扩展时须延续「每跳独立凭据与主机密钥、失败归属到跳、全链依赖清理」的边界。
6. **主机密钥管理增强**：指纹搜索、批量审计与导入/导出；删除仍必须显式确认，且不改变当前活动会话。
7. **凭据管理 UI 与审计**：最小化、一次性凭据通道，避免把明文返回 React 状态。
8. **端口转发增强**：SOCKS5 用户名/密码或外部认证、UDP ASSOCIATE/BIND、Unix 域套接字转发、规则流量统计与审计、应用重启后的显式恢复策略、重连后的显式重新绑定；任何自动恢复都必须在 UI 中明确告知并重新校验会话、主机密钥与绑定能力，不能静默复用旧监听或旧 `sessionId`。
9. **快速命令增强**：命令导入/导出、参数历史与校验规则、可选的输出捕获或执行结果展示、更多内置诊断模板；任何自动执行、批量多目标发送或输出持久化都必须单独设计确认流程、日志脱敏与存储边界，不能默认开启。
10. **打包签名、自动更新与多平台验证**需另立任务。
