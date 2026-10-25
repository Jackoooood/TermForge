# TermForge 任务进度

本文件记录已交付阶段、当前边界与验证结果。日期均为本机开发时间。

## 任务总览

| 任务     | 范围                                                                                              | 状态                                                                     |
| -------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| TASK-001 | Electron + React + TypeScript 桌面工程、工作台 UI 基础与安全窗口配置                              | 已完成                                                                   |
| TASK-002 | 连接管理、本地持久化、凭据加密适配层、主机密钥存储模型与 IPC 边界                                 | 已完成                                                                   |
| TASK-003 | 主进程真实 SSH 连接、密码/私钥/口令/Agent 认证、主机密钥显式信任、状态与 UI 接入                  | 已交付（2026-10-22）                                                     |
| TASK-004 | 在既有 SSH 会话上接入真实 PTY、xterm.js 交互、尺寸同步、Shell 生命周期与终端 IPC                  | 已交付（2026-10-22）                                                     |
| TASK-005 | Connection/Session/Tab 分离、多标签独立 SSH、标签关闭/重连完整生命周期与真实状态同步              | 已交付（2026-10-22）                                                     |
| TASK-006 | 真实 SFTP 远程目录浏览、元数据、mkdir/rename/deleteFile/removeDirectory、会话隔离与生命周期       | 已交付（2026-10-22）                                                     |
| TASK-007 | 真实 SFTP 上传/下载、主进程文件流、FIFO 传输队列、冲突处理、取消/重试、进度与传输抽屉             | 已交付（2026-10-22）                                                     |
| TASK-008 | 安全加固、设置中心、脱敏日志与导出、可配置并发、传输中断恢复语义、有序有界退出与回归测试          | 已交付（2026-10-22）                                                     |
| TASK-009 | Windows x64 NSIS 打包、ASAR 与打包运行时验收、发布元数据/校验和、验收文档                         | 打包与运行验收完成；安装/卸载、签名、干净环境与 OpenSSH 待授权/待完成    |
| P1-01    | 本地与远程双栏文件管理、跨栏拖拽与传输队列联动（目录递归展开、符号链接策略、显式路径下载）        | 已交付（2026-10-23）                                                     |
| P1-02    | 有序跳板链路（ProxyJump 等价能力）：`forwardOut` 链式连接、每跳独立凭据与主机密钥、失败归属与清理 | 已交付（2026-10-23）                                                     |
| P1-03    | SSH 端口转发：本地/远程 TCP 与 SOCKS5 CONNECT-only、规则持久化、主进程运行态、生命周期与删除级联  | 已交付（2026-10-23）；真实 SSH 转发验收未执行                            |
| P1-04    | 快速命令与命令历史：命令库、`{{参数}}` 模板、插入/确认发送、只读内置命令、可关闭历史与独立存储    | 已交付（2026-10-23）；受控终端验收通过，OpenSSH/安装包验收未执行         |
| P1-05    | 会话分屏、定向连接取消与有界自动重连：两窗格运行态布局、`ssh:cancel-connect`、设置 v4 自动重连    | 已交付（2026-10-24）；受控验收 19/19，真实 OpenSSH/网络抖动/安装包未执行 |

## TASK-003 已交付内容

### 主进程 SSH

- `ssh2@1.17.0` 仅在主进程使用；`SshService` 独占 Client 生命周期。
- 会话 ID 由主进程生成（`ssh-<UUID>`），渲染进程只持有不透明 ID 与脱敏快照。
- TASK-003 阶段按连接复用活动会话；TASK-005 起改为每个渲染标签（`clientId`）一个独立会话，同一连接配置可并行多个 transport。最多 32 个活动会话；重复请求按 `clientId` 去重。
- 状态：`idle`、`connecting`、`authenticating`、`awaiting-host-key`、`connected`、`reconnecting`、`closing`、`disconnected`、`error`。
- 连接超时 90 秒（外层 95 秒守卫）、keepalive 30 秒 ×3、断开宽限 3 秒、主机密钥确认 30 秒。
- 支持主动断开、取消连接中会话、窗口关闭终止全部会话、应用退出释放资源。
- TASK-003 阶段**未实现自动重连**；`reconnecting` 当时仅为预留状态。P1-05 已实现默认关闭、固定错误码白名单、最多 5 次的有界自动重连（见 P1-05 交付内容）。

### 认证

- Password：从 safeStorage 凭据库读取密码。
- Private Key：读取用户配置的私钥文件，或使用凭据库中的私钥内容；加密私钥从凭据库读取口令。
- SSH Agent：Windows OpenSSH Agent 命名管道或 POSIX `SSH_AUTH_SOCK`；不支持 Pageant。
- 凭据缺失/格式错误/Agent 不可用均返回固定、可操作错误；密码、私钥与口令不进入渲染进程状态、连接配置或日志。
- 凭据补录 UI 使用非受控输入，提交后立即清空 DOM 值。

### 主机密钥

- 接入 `ssh2` `hostVerifier`，从实际握手公钥 blob 计算 OpenSSH SHA-256 指纹。
- 首次连接进入 `awaiting-host-key`，必须显式接受后才继续；接受时先写入 `known-hosts.json` 再放行。
- 已信任密钥完全匹配才放行；不匹配立即以 `host-key-changed` 拒绝。
- 拒绝、关闭弹窗、Esc、点击遮罩、30 秒超时、存储异常、窗口关闭、IPC 异常全部失败关闭；**没有自动信任分支**。
- 主机密钥记录只存 host/port、算法、指纹与时间戳。

### IPC 与渲染进程

- TASK-003 阶段为 12 个固定 invoke 通道 + 2 个只读推送事件；TASK-004 扩展为 17 个 invoke 通道 + 5 个推送事件。
- 主进程校验 sender、main frame、连接/会话/请求 ID 与参数 schema。
- preload 暴露冻结 bridge；无原始 `ipcRenderer`、无通用转发、无凭据读取。
- 事件订阅返回幂等取消订阅函数。
- 渲染端 `sessionStore` 只镜像主进程快照；推送事件驱动状态变化，主机密钥与凭据弹窗独立队列。
- 删除连接会关闭相关会话；断开/关闭标签会通知主进程。
- 工作台在 TASK-003 阶段移除了 xterm 与本地 DemoShell；TASK-004 已重新接入真实主进程 PTY 上的 xterm。

### 文档

- 更新 `docs/ARCHITECTURE.md`、`docs/SECURITY.md`、`docs/DATA_MODEL.md`、`docs/UI_SPEC.md` 与 `README.md`。
- 新增本文件 `docs/TASKS.md`。

## TASK-004 已交付内容

### 主进程 PTY

- 新增 `ShellChannelManager`，每 SSH 会话最多一个 PTY；通过 `client.shell({ term: 'xterm-256color', cols, rows })` 打开，复用既有 SSH Client，不为击键新建连接。
- Shell 状态：`idle/opening/open/closing/closed/exited/error`；`SSH connected` 与 `Shell open` 独立。
- 远程数据按 `Buffer` 接收，用 `StringDecoder('utf8')` 流式解码，跨包多字节字符不损坏。
- 输出 8ms 批量推送、64 KiB 立即 flush；积压 1,000,000 字符暂停通道，降至 250,000 恢复。
- 写入仅允许 `open` 状态；单次 IPC ≤65,536 字符；渲染端 32 KiB 分片并串行化。
- 尺寸同步使用 `channel.setWindow(rows, cols, 0, 0)`；Schema、服务与渲染运行时拒绝零/负数/小数/NaN/超限尺寸。
- 远端 `exit`、通道 `close`、通道 `error` 只通知一次；打开超时 15 秒并关闭迟到通道。
- SSH 断开/错误/取消/远端关闭/窗口关闭/应用退出都会关闭对应 PTY；被丢弃会话会清理运行时。
- 新增 5 个终端 IPC 通道与 3 个推送事件；preload `terminal` 命名空间冻结，只接受 ID、文本与尺寸。

### 渲染终端

- 新增 `terminalRuntime`：模块级重放缓冲（256 KiB/标签，TASK-005 起按稳定标签 ID 索引）、输出订阅、打开 Promise 去重、写队列、尺寸去重、事件 revision 与忽略会话；终端输出不进入 Zustand。
- 新增 `terminalStore`：只保存 Shell 生命周期快照。
- 新增 `XtermTerminal`：xterm.js + FitAddon，`convertEol: false`，输出直写、输入直接走 bridge，无本地回显。
- 使用 `ResizeObserver` + 60ms 防抖 + 可见性/整数尺寸校验同步 PTY；组件卸载/StrictMode 重放不关闭 PTY。
- Shell 退出/错误显示覆盖层与「重新打开 Shell」；关闭 Shell 不关闭 SSH 连接。
- 工具栏显示 Shell 状态与 `cols×rows`，可单独关闭 Shell；状态栏统计 Shell 数量。
- 设置页终端字号实时应用并触发尺寸同步。

### 测试

- 新增 `terminalRuntime.test.ts`、`xtermTerminal.test.tsx`；扩展 `sshService.test.ts`、`mainIpc.test.ts`、`preloadBridge.test.ts` 与 fake bridge。
- 覆盖打开/复用/失败/超时、输入路由与分片、UTF-8 跨包、输出 sessionId、PTY 尺寸顺序、退出/错误/SSH 断开、IPC 校验与 sender、订阅取消、组件卸载、ResizeObserver 与 StrictMode。
- 全部为 fake Client/Channel、mock bridge 与 fake xterm 测试，**没有真实 SSH/PTY 集成测试**。

## TASK-005 已交付内容

### 身份与主进程关联

- ConnectionProfile、SSH Session、Workspace Tab 三者分离：配置 ID（`conn-<UUID>`）、主进程会话 ID（`ssh-<UUID>`）与稳定标签 ID（`sshtab-<UUID>`）不再混用。
- 渲染标签 ID 同时作为 IPC `clientId`；`connect(connectionId, clientId)` 先按 schema 校验，再按 `clientId` 查找/去重。
- 每个标签拥有独立 `ssh2.Client`：同一连接配置在多个标签中会建立互不共享的 SSH transport；上限仍为 32 个活动会话。
- 快照新增 `clientId`；渲染端只接受 `clientId === tabId` 的返回与事件，拒绝把其他会话绑定到本地标签。
- 重连保持 `clientId`/标签不变，主进程生成新 `sessionId`；旧会话先经有界 disconnect 释放，再建立新 transport。

### 渲染标签模型

- 新增 `workspaceStore`：`tabOrder` 与 `activeTabId` 独立于 SSH 快照；关闭活动标签激活右邻居，否则左邻居。
- `sessionStore.sessions` 改为以稳定标签 ID 为键的 `Record`；`SessionInfo` 只含可序列化元数据（sessionId、状态、generation、hasTerminal、时间戳、主机密钥、失败信息），不含 Client/Channel/xterm/凭据。
- `openSession` 同步创建标签并调用主进程；仅对同一连接的 pending 标签快速去重，连接完成后再打开会创建新的独立会话。
- 标签状态完全由主进程快照驱动；点击按钮不会直接把标签标记为已连接。
- 同一连接多个标签时，标签栏显示 Shell 就绪图标，侧栏/服务器页汇总会话数量与状态。

### 关闭、重连与竞态

- `closeSession` 可按顺序概括为：标记 `closing` 并移出事件接受范围 → 清理提示与终端绑定/缓冲 → 等待未决连接（≤5 秒）→ 有界请求主进程断开 → 移除会话记录与标签 → 迟到事件按 `dismissedSessionIds` 丢弃；其他标签不受影响。
- 关闭幂等：`closingTabs`、`pendingConnects`、`disconnectPromises` 与重连 Promise 按标签去重，重复请求不会重复释放或误删新会话。
- 重连使用 `generation` 守卫；关闭/重连期间迟到的连接结果会被主动断开，不会重新出现在工作区。
- 被动断开保留终端历史但禁用输入；手动重连清除旧绑定与回放缓冲，明确提示“新 SSH 传输 + 新远程 Shell”，不声称恢复旧进程。
- 终端运行时按标签保存重放缓冲与 `sessionId → tabId` 绑定；旧 `sessionId` 进入忽略集合，替换绑定以显式绑定为准，避免旧输出串流。
- 组件卸载/标签切换只释放 xterm 实例、ResizeObserver 与监听器，不关闭 PTY；全局终端订阅由引用计数管理，后台标签输出仍进入其缓冲。

### 主进程与应用退出

- `SshService.dispose()` 与窗口关闭路径同步停止新连接、关闭全部 Shell/Client、清理计时器与监听器；退出流程不等待单个卡住的会话。
- 主进程断开仅影响目标 `sessionId`；重复断开返回当前快照或 `not-found`，不破坏其他会话。
- 应用退出不持久化任何 Client、Channel 或活动 `sessionId`；重启后标签与远程进程均不恢复。

### 测试

- 扩展 `stores.test.ts`：多标签独立 open、同连接 pending 去重、关闭/重连竞态、关闭中重复请求、迟到快照过滤、按连接批量关闭。
- 扩展 `terminalRuntime.test.ts`、`xtermTerminal.test.tsx`：按标签绑定、重连后旧会话输出忽略、后台标签缓冲、卸载不关闭 PTY。
- 扩展 `sshService.test.ts`：不同 `clientId` 的独立 transport 与按 `clientId` 去重。
- 扩展组件测试（标签栏、工作台、提示、连接管理）以适配 `Record` + `workspaceStore` 模型。
- 全部使用 fake SSH Client/Channel、mock bridge、fake 存储与 fake xterm；**没有真实 SSH/PTY 集成测试，也没有 Electron 实窗手工验收**。

## TASK-006 已交付内容

### 主进程 SFTP

- 新增 `SftpService`：在已 `connected` 的 SSH 会话上通过 `client.sftp()` 打开真实 SFTP 通道；每个 SSH 会话最多复用一条 `SFTPWrapper`，不会由渲染进程创建新 SSH 连接。
- 每次操作都通过 `SshService.getSftpClient(sessionId)` 重新校验会话存在、归属与连接状态；SSH 断开、关闭标签、窗口关闭或应用退出时通知并释放 SFTP 通道。
- 支持 `open`（`realpath('.')` 解析主目录）、`list`、`stat`、`mkdir`、`rename`、`deleteFile`、`removeDirectory`、`close`；读取使用 30 秒超时，打开通道 15 秒超时。
- 并发 `open` 共享同一个 home 解析 Promise；每条 SSH 会话的 SFTP 操作通过路径锁防止同一目标并发变更。
- `mkdir`/`rename` 在服务端变更前检查目标，已存在时拒绝而不是静默覆盖；主进程拒绝重命名根目录，UI 将重命名目标限制在同一父目录。
- `deleteFile` 拒绝真实目录；`removeDirectory` 拒绝根目录、受保护的系统顶层目录、深度 <2 的目录、符号链接、非目录与非空目录；**代码中没有递归删除分支**。
- 变更请求已发出但传输中断或超时返回 `outcome-unknown`，不宣称成功或失败；未决请求在通道丢失时结束。
- 目录条目映射：依据 mode/`longname` 判定目录、文件、符号链接；仅文件读取 size；mtime 转为 ISO 或 `null`；mode 转为 POSIX 权限串或 `null`；按目录 → 符号链接 → 文件、名称自然排序。
- POSIX 路径在所有层共享：绝对路径、规范折叠 `.`/`..`/重复斜杠，不使用 Windows `path.join`；名称支持空格、Unicode 与特殊字符，拒绝 `/`、NUL、控制字符、`.` 与 `..`。

### IPC 与 preload

- 新增 8 个固定 invoke 通道：`sftp:open/list/stat/mkdir/rename/delete-file/remove-directory/close`；总通道数为 25。SFTP 没有新增推送事件。
- 主进程对每条消息执行 sender/main frame 校验与 strict schema 校验；所有 SFTP 操作都重新确认会话归属，不信任渲染进程传入的 `sessionId`。
- preload 暴露冻结的 `sftp` 命名空间，只接受 `sessionId`、绝对路径与名称；没有文件内容、上传、下载、递归删除或任意对象参数，`SFTPWrapper` 不跨 IPC。
- 错误统一归一为固定 `OperationError`；原始 `ssh2` 错误、服务器路径、目录条目与堆栈不返回渲染进程。

### 渲染层

- 新增按标签隔离的 `sftpStore`：保存会话 ID、home、当前路径、条目、选中项、加载/错误状态与进行中操作；`requestId` + `sessionId` 守卫丢弃旧目录/旧会话的迟到响应。
- 重写 SFTP 页面：SSH 会话选择器、真实远程双栏、面包屑/返回/路径输入/刷新、新建目录/重命名/删除对话框、加载/空/错误/断开状态。
- 左侧「本地」面板明确标注 `TASK-007` 且不展示模拟文件；SFTP 页面不提供上传、下载或传输队列入口。
- 删除仅针对文件、符号链接或空目录，需要二次确认；`outcome-unknown` 提示结果未知并自动刷新，不自动重试。
- 切换 SSH 会话或标签关闭时重置/清理对应 SFTP 状态；远端目录数据不进入其他标签，也不进入全局持久化状态。

### 测试

- 新增 `sftpService.test.ts`（20 个用例）：打开/复用/并发 home 解析、列表与 stat、元数据、mkdir/rename/删除安全、路径锁、超时、通道丢失、会话释放、`outcome-unknown`。
- 新增 `sftpStore.test.ts`（18 个用例）：打开/加载、重复 open、会话切换、旧路径/旧会话响应丢弃、错误映射、刷新保留选择、mkdir/rename/删除路由、会话不匹配、清理。
- 新增 `remotePath.test.ts` 及 `sftpMetadata` 相关测试；扩展 `mainIpc.test.ts`、`preloadBridge.test.ts`、`sshService.test.ts`、`fakeBridge` 与组件测试。
- 全部使用 fake SSH Client / `SFTPWrapper`、mock bridge 与 fake 存储；**没有真实 SSH/SFTP 集成测试，也没有 Electron 实窗手工验收**。

## TASK-007 已交付内容

### 共享模型与 IPC

- `TransferTask` 增加 9 个状态：`queued`、`preparing`、`waitingForConflictResolution`、`transferring`、`cancelling`、`completed`、`failed`、`cancelled`、`skipped`；包含方向、源/目标路径、真实字节数、`null` 表示未知的总量与进度、速度、尝试次数、冲突策略/信息、固定错误码/消息与单调 `revision`。
- 新增 7 个固定 invoke 通道：`transfer:enqueue-upload`、`enqueue-download`、`cancel`、`retry`、`resolve-conflict`、`list`、`clear-history`；新增 1 个 `transfer:update` 推送事件。总通道数 32、推送事件 6。
- 所有参数用 strict schema 校验：`transferId` 必须匹配 `transfer-<id>`；上传只接受 `sessionId` + 远程目录，下载只接受 `sessionId` + 1–50 个绝对远程路径；`resolve-conflict` 仅允许 `overwrite/rename/skip`，`rename` 必须带合法新名称，其他策略禁止携带名称。
- 渲染进程不能传入本地绝对路径、文件大小、临时路径或任务状态；本地路径只能由主进程原生对话框产生并写入任务快照。
- preload `transfer` 命名空间冻结，只暴露上述 7 个方法与 `onUpdate` 订阅；没有流、路径读写、任意 IPC 或 `SFTPWrapper` 访问。

### 主进程传输服务

- 新增 `TransferService` 与 `TransferQueue`：FIFO 调度，默认全局并发 2、每 SSH 会话并发 1；任务进入终态、取消或失败时释放槽位，队列不会因异常路径永久占位。
- 上传：原生多选文件对话框，单次最多 50 个；拒绝目录、符号链接与非普通文件；每个文件创建独立任务，目标为当前远程目录；选择前后都重新确认会话与远程目录可用。
- 下载：仅接受普通远程文件，目录与符号链接不加入任务；原生目录选择器确定本地目标；每个文件创建独立任务。
- 上传写入远程同目录 `.termforge-part-<uuid>` 临时文件（`wx`、`0600`），下载写入本地同目录临时文件；传输完成后校验字节数、源文件大小/修改时间与临时文件状态，再通过同目录 `rename` 提交。
- 覆盖已存在目标时先把原文件改名为 `.termforge-backup-<uuid>`，提交失败时恢复；提交成功或恢复后删除备份。仅清理本任务记录在案的临时文件/备份，不触碰用户原有文件或其他进程的文件。
- 进度：按真实字节每 200 ms 推送；速度来自 3 秒滑动窗口；未知总量保持 `null` 并以不确定进度展示，传输中最多显示 99%，只有 `completed` 才显示 100%；不使用 NaN/Infinity。
- 冲突：准备阶段检测目标已存在进入 `waitingForConflictResolution`；用户选择覆盖、重命名或跳过。覆盖/重命名在提交前再次检查目标，跳过立即进入 `skipped`；建议名称最多尝试 20 次。
- 取消：排队中/待冲突立即 `cancelled`；运行中进入 `cancelling`、中止流并在 8 秒内等待收敛；已进入提交阶段时拒绝取消并提示稍后查看结果；重复取消幂等。
- 失败/取消可手动重试：沿用任务 ID、`attempt + 1`、`revision + 1`，重新校验会话、源与目标，不自动重试、不声称断点续传。
- 会话进入终态时，该会话的排队/待冲突任务标记 `failed(connection-lost)`，进行中任务中止；提交阶段任务不强行中断，等待有界结果。窗口关闭/应用退出取消所有未提交任务，临时文件清理上限 10 秒。
- 传输历史与任务状态只存在主进程内存，不持久化；应用重启后不恢复任务，也不恢复未完成文件。（TASK-008 起仅将未完成任务的最多 100 条展示快照写入传输日志，重启后显示为 `interrupted`，仍不恢复执行。）

### 渲染层

- `transferStore` 是主进程快照的只读投影：按 `revision` 丢弃过期更新，按创建时间排序；提供 enqueue/cancel/retry/resolve/clear/sync 动作，不自行生成任务或进度。
- 新增 `useTransferBridgeEvents`：应用根订阅 `transfer:update`、启动时同步任务；上传进入终态（`completed`/`failed`/`cancelled`）后，对匹配会话与目标父目录的 SFTP 标签做 200 ms 防抖刷新，`skipped` 不触发。
- SFTP 页面改为双栏：左侧「本地 → 远程」只提供系统文件对话框入口与任务计数；右侧远程面板支持 `Ctrl/⌘` 多选、`Shift` 连选、工具栏上传/下载、底部选区信息与下载（只包含文件）。
- 传输抽屉替换模拟数据：展示真实状态、源/目标路径、字节进度、速度、尝试次数、固定错误与指引；内联冲突面板提供覆盖/重命名/跳过；支持取消、失败/取消后重试、从主进程刷新与清空已结束记录。
- 设置页「清空传输记录」只移除终态任务，进行中任务继续由主进程管理；状态栏显示任务总数、进行中数量与待处理冲突数量。
- 未加入断点续传、暂停/恢复、自动重启执行、目录递归上传/下载或带宽限制。（TASK-008 已加入可配置并发与中断快照展示，但不恢复执行。）

### 测试

- 新增 `transferQueue.test.ts`：FIFO、全局/会话并发上限、槽位释放、重复任务抑制、移除与重置。
- 新增 `transferService.test.ts`：上传/下载成功（含空文件）、临时文件与提交、覆盖备份/恢复、未知大小、真实进度、冲突跳过/重命名/覆盖、取消排队/上传中任务、失败重试、跨会话终止隔离、对话框互斥、不安全远程文件名拒绝、清理与退出。
- 新增 `transferDrawer.test.tsx`、`transferEvents.test.tsx`：状态/进度/错误渲染、冲突表单校验与动作、取消/重试/清空、事件投影 revision、过期快照丢弃、上传完成后的目录刷新与防抖清理。
- 扩展 `mainIpc.test.ts`、`preloadBridge.test.ts`、`sftpService.test.ts`、`stores.test.ts`、`appShell.test.tsx` 与 `fakeBridge`，覆盖新通道、sender/frame、schema 拒绝、冻结 bridge、传输端口、任务投影与 UI 入口。
- 传输测试使用真实本地临时目录与真实 Node 文件流，但远端仍是 fake `SFTPWrapper`（内存/磁盘替身）；**不是真实 SFTP 服务器集成测试**，原生文件对话框也未在自动化测试中真实弹出。

## TASK-008 已交付内容

### 风险清单（按严重程度）

| 严重程度 | 风险                                                     | 处理                                                                                              |
| -------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 高       | 设置只存在内存，重启丢失；写入失败若仍显示成功会误导用户 | 版本化 strict schema + 原子持久化；乐观更新失败时局部回滚并提示；损坏文件逐字段恢复且不覆盖原文件 |
| 高       | 统一日志可能把密码、私钥、终端输出或文件内容写盘         | 仅记录固定事件与非敏感元数据；结构化深度脱敏 + 文本脱敏；导出路径由主进程对话框选择并再次脱敏     |
| 高       | 重启后把未完成传输当作完成或自动续传，造成虚假结果       | 未完成任务日志；重启只水合为 `interrupted`/`outcome-unknown`，不排队、不续传、不提供重试          |
| 高       | 退出时单个卡住的传输/SSH 永久阻塞，或清理步骤互相拖死    | 顺序执行传输 → SFTP → SSH → 日志，每步独立 4 秒上限；单步失败继续；退出流程幂等                   |
| 中       | 并发上限变更可能终止运行中任务或让每会话值超过全局值     | `TransferQueue.setLimits` 只影响后续调度；每会话夹到全局以内；非法值在 schema 与运行时双重拒绝    |
| 中       | 主机密钥记录无法在应用内撤销，用户只能手改文件           | 设置页只读列表 + 确认弹窗删除；不中断当前会话；下次连接重新确认；不把删除描述为吊销当前连接       |
| 中       | 删除连接后凭据条目成为孤儿                               | profile 删除成功后尽力删除 password/private-key/passphrase 引用；失败不回滚、不泄露秘密           |
| 低       | 日志无上限增长或单条超大元数据拖慢主进程                 | 2 MiB × 5 轮转、单行 16 KiB、导出最多 20 MiB；写入失败只计数不抛错                                |

### 后端与共享层

- 新增 `logger.ts`、`redact.ts` 与 `logService.ts`：级别过滤、JSONL 写入、大小轮转、深度/长度上限、敏感键与文本脱敏、固定目录打开与原生对话框导出。
- 新增 `settingsRepository.ts` 与 `shared/schemas/settings.ts`、`shared/types/preferences.ts`：默认值、strict 校验、逐字段恢复、警告、串行读写与原子写入。
- 新增 `shutdown.ts`：`runBoundedCleanup` 逐步顺序执行、独立超时、错误/超时隔离与报告。
- `TransferQueue` 增加 `setLimits`、上限夹取与运行中降低上限的自然收敛；`TransferService` 增加可配置并发、任务日志、启动水合、`interrupted` 重试拒绝与幂等 `dispose()`。
- `main/index.ts`：启动时加载设置与日志、应用运行时偏好；窗口关闭取消传输/SSH；`before-quit` 使用有序有界清理并防止重入。
- IPC 增加 7 个固定通道（settings/host-keys/logs），全部做 sender/frame 校验与参数 schema；删除连接后清理凭据引用；preload 新增三个冻结命名空间。
- 传输类型与共享 schema 增加 `interrupted` 状态和 `transfer-journal.json` v1 信封（最多 100 条）。

### 渲染层与设置中心

- 重写 `settingsStore`：启动加载、写队列、revision 守卫防止启动响应覆盖用户新编辑、乐观更新、局部回滚、失败 Toast、系统主题解析与刷新；保留原有同步入口。
- `App` 应用 `resolvedTheme` 到 `data-theme`/`colorScheme` 并监听系统主题变化；`XtermTerminal` 使用持久化字体/字号/光标/闪烁/回滚/主题并在设置变化时原地更新，不重建 PTY。
- `SettingsView` 增加外观、终端、传输并发、诊断日志、存储与凭据、主机密钥列表/删除确认、应用信息；读取失败横幅与重试、恢复警告、日志信息刷新/导出/打开目录。
- `TransferDrawer` 真实展示 `interrupted`：不提供重试、显示「结果未知」、说明不会自动续传与清理边界。
- 删除连接弹窗明确凭据清理与主机密钥记录保留范围。

### 测试与文档

- 新增 `settingsRepository.test.ts`、`settingsStore.test.ts`、`settingsView.test.tsx`、`logging.test.ts`、`shutdown.test.ts`。
- 扩展 `transferQueue.test.ts`、`transferService.test.ts`、`transferDrawer.test.tsx`、`xtermTerminal.test.tsx`、`mainIpc.test.ts`、`preloadBridge.test.ts` 与 `fakeBridge`。
- 更新 `README.md`、`ARCHITECTURE.md`、`SECURITY.md`、`DATA_MODEL.md`，新增 `TEST_PLAN.md`。
- 未新增真实 SSH/SFTP 集成测试；设置/日志的自动化测试使用临时目录，主机密钥/对话框/桥接仍为 fake 或 stub。

## TASK-009 打包与验收

### 风险清单（按严重程度）

| 严重程度 | 风险                                                        | 处理                                                                                                                                  |
| -------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 高       | 未签名安装包被误当作正式发布物                              | 固化 `NotSigned` 实测结果；发布说明与 README 明确标注测试构建，签名完成前不得对外分发                                                 |
| 高       | 主机密钥变化被错误归类为 `internal`，用户无法判断是安全拒绝 | 运行时验收发现；修复 verifier 失败写入顺序并补充错误映射与回归测试，重新打包后 15/15 通过                                             |
| 高       | 安装/卸载/升级未实测却写成“安装验收通过”                    | 本轮未安装/卸载；验收文档将安装、卸载、覆盖升级列为未执行与发布阻塞                                                                   |
| 中       | ASAR 混入测试/源码/开发地址或秘密                           | 审计 524 个条目：顶层仅 `node_modules`、`out`、`package.json`；无 `.map`/`.env`/测试/源码条目与开发服务器 URL；持久化文件泄漏检查为 0 |
| 中       | 本机 `release/` 文件占用导致打包失败                        | 记录 `EPERM`/`EBUSY`；使用相同配置输出到临时目录后复制安装包/blockmap 到 `release/`，不把失败伪装成一次成功                           |
| 中       | 干净 `npm ci` 跳过安装脚本，Electron 缺失                   | 记录 `allow-scripts` 行为；手动执行 `node node_modules/electron/install.js` 后 v45.0.0；干净副本 typecheck/测试/构建/目录打包均通过   |
| 低       | 临时品牌图标被误认为正式资产                                | 发布说明标注“待品牌确认”，不声称正式品牌资源                                                                                          |
| 低       | 无 git 仓库导致来源不可追溯                                 | 构建元数据 `commit=unavailable`，未伪造哈希                                                                                           |

### 已交付

- `electron-builder@26.15.3` + NSIS Windows x64 one-click per-user 配置：`appId=com.termforge.desktop`、`productName=TermForge`、ASAR、开始菜单快捷方式、无桌面快捷方式、卸载保留用户数据、`asInvoker`、中英文安装界面。
- 未签名测试安装包 `release/TermForge Setup 0.1.0.exe`（112,995,715 字节，SHA-256 `85a868cd…bd5d2`）与 blockmap；`release/SHA256SUMS.txt`、`release/build-metadata.json`。
- `scripts/release-manifest.mjs`：从真实安装包、ASAR、可执行文件与验收报告生成 SHA-256、大小、签名状态、PE 版本资源、环境版本、ASAR 审计结果与 Git 状态。
- `tests/acceptance/ssh-fixture-server.mjs`、`tests/acceptance/packaged-runtime.mjs`：本地 `ssh2` 夹具 + CDP 驱动打包应用的两阶段验收。
- `docs/releases/0.1.0.md`、`docs/releases/0.1.0-acceptance.md`；README 与任务状态同步，未把未执行项写成通过。

### 验收结果

- 打包应用运行时：15/15 通过，0 项失败、0 项秘密/终端输出泄漏；覆盖 `file://` 加载、CSP、凭据、首次主机密钥信任、终端回显/尺寸、双标签隔离、SFTP Unicode/空格路径与变更、主机密钥变化拒绝、删除后重新信任、设置更新、日志、重启持久化与受信重连。
- 质量门禁：typecheck、lint、31 文件/284 用例、生产构建、生产依赖审计（0 漏洞）均通过。
- 干净副本：`npm ci` 退出码 0（536 包）；Electron 二进制需手动安装；`cpu-features` 未安装；typecheck/测试/构建/`electron-builder --dir` 均退出码 0。
- 安装包与 `TermForge.exe` Authenticode 均为 `NotSigned`；ASAR 顶层结构与禁止条目检查通过。

### 未执行与阻塞

- 未执行实际安装、卸载、卸载后用户数据保留与旧版本覆盖升级。
- 未执行代码签名；无干净 Windows 虚拟机/CI；未启用或测试 Windows OpenSSH Server。
- 未在打包应用中自动化原生上传/下载对话框与传输流；未逐项点击全部 UI。
- 图标待品牌确认；无 git commit；8 个 moderate 开发依赖告警未逐项处置。
- 本机直接输出 `release/` 会被文件锁阻断，最终产物使用临时输出目录；详见验收文档第 4 节。

## P1-01 已交付内容

### 共享模型、本地路径与 IPC

- 新增 `LocalFileEntry`、`LocalDirectoryListing`、`LocalRootEntry` 与 `LocalRootsResult`（`src/shared/types/localFs.ts`）：只含名称、类型、大小、mtime 与 `hidden`；`hidden` 采用点前缀约定，不读取 Windows 隐藏属性；单目录条目上限 `MAX_LOCAL_DIRECTORY_ENTRIES = 5000`，超出时返回 `truncated: true`。
- 新增只读本地 IPC：`local-fs:roots`（无参数，返回主目录与磁盘/根入口、`home`）与 `local-fs:list`（strict `{ path }`）；路径必须是绝对本地路径，且不含 NUL/控制字符与 `\\.\`/`\\?\` 设备前缀。invoke 通道总数 42 → 46，推送事件仍为 6 个。
- 传输新增 2 个通道：`transfer:enqueue-upload-paths`（strict `{ sessionId, remoteDirectory, localPaths 1–50 }`）与 `transfer:enqueue-download-paths`（strict `{ sessionId, remotePaths 1–50, localDirectory }`）；新增 `TransferUploadEnqueueAck`（`tasks`、`skippedSymlinks`、`skippedUnsupported`、`truncated`、规范化 `remoteDirectory`）。
- 新增本地路径纯函数（`src/shared/localFs/localPath.ts`）：盘符大写、UNC 与 `/` 根识别、`.`/`..` 解析、父路径与面包屑、根判定、条目名派生、排序（目录/符号链接/文件分组 + 名称断连、自然排序）；配套 Windows-first 文件名策略（`src/shared/transfer/localFileName.ts`）拒绝保留名、`<>:"/\|?*`、控制字符、尾随空格/句点与超长名称。
- preload 新增冻结 `localFs` 命名空间（`roots`/`list`），`transfer` 扩展为 9 个 invoke 方法；没有通用转发或任意路径访问。

### 主进程

- 新增 `LocalFsService`：只读列举本地目录与根入口；先校验绝对路径与设备前缀，再 `lstat`/`readdir`；受条目上限约束；固定错误码 `invalid-input`/`not-found`/`not-a-directory`/`unavailable`；不读取文件内容。
- `TransferService.enqueueUploadPaths`：源路径先 `normalizeLocalPath` 去重；顶层文件直接落入目标目录，目录按 BFS 展开为逐文件任务并保留文件夹名与相对结构（复制语义，同 Explorer/WinSCP）；符号链接只计数不跟随；不支持的类型（设备/管道/含分隔符的名称）计数跳过；目录深度上限 64、单次展开任务上限默认 500（可注入），超出截断并报告；顶层 drop 目标必须已存在，嵌套子目录由 `ensureRemoteDirectory` 补建。
- `TransferService.enqueueDownloadPaths`：把显式远程文件路径下单到指定本地目录；拒绝磁盘根目录、设备前缀、非法远程名与相对路径；目标缺失或非目录映射为 `unavailable`；下载任务仍只包含普通远程文件。
- 目录展开、跳过与截断只影响本次入队结果，任务本身仍走既有 FIFO 队列、冲突处理与临时文件提交管线。

### 渲染层

- 新增 `localPanelStore`（按标签）：`roots`/`home` 入口、路径与父路径、条目、排序、隐藏文件开关、单选/多选与 `requestId` 守卫；旧目录/旧会话响应被丢弃；关闭标签与全局重置时清理（重连保留本地状态）。
- 新增 `LocalFilePanel`：面包屑、路径输入、返回上一级、刷新、排序（名称/大小/时间）、隐藏文件开关、系统对话框上传入口、上传到远程与传输队列按钮、落点高亮；根视图显示主目录与磁盘入口；相对路径与设备前缀在渲染端拦截，主进程仍再次校验；错误横幅保留旧条目并提供重试。
- 新增 `features/sftp/fileDrag.ts`：自定义 MIME 载荷（本地路径列表、远程文件会话载荷）只在内存中传递；OS 文件拖入经 `webUtils.getPathForFile` 解析；`useDropZone` 用 dragenter/dragleave 计数防止高亮闪烁。
- `RemoteFilePanel` 支持多选/单个普通文件拖出（仅已连接会话），并接受本地文件/目录拖入；`SftpView` 把落点转成 `enqueueUploadPaths`/`enqueueDownloadPaths`，提示跳过与截断；跨会话拖拽载荷被拒绝；磁盘根目录不能作为下载目标。
- `transferStore` 增加 `enqueueUploadPaths`/`enqueueDownloadPaths` 投影动作；`sessionStore` 在关闭标签与全局重置时清理本地面板状态。

### 测试

- 新增 `localPath.test.ts`（9 用例）、`localFsService.test.ts`（4 用例，真实临时目录与 junction 符号链接）、`fileDrag.test.tsx`（7 用例，载荷往返、非字符串过滤与 drop zone 计数）、`localPanelStore.test.ts`（7 用例，守卫、排序与选择钳制）。
- 扩展 `transferService.test.ts`：目录展开保留文件夹名与结构、符号链接跳过、不支持类型与缺失源/目标错误、上限截断、显式路径下载与不安全目标拒绝。
- 修复基线 `appShell.test.tsx` 图标按钮断言（改用 `aria-label`）。
- 全部使用 fake SFTP 传输端口与真实本地临时目录；**没有真实 SFTP 服务器集成测试，也没有 Electron 实窗拖拽/原生 OS 拖入验收**。

## 质量门禁结果

运行环境：Windows 10 19045 x64、Node.js v24.18.0、npm 11.17.0、Electron 45.0.0、Vitest 4.1.12。

| 命令                       | 结果                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`        | 通过（Node 侧 + Web 侧）                                                                                |
| `npm run lint`             | 通过（`--max-warnings 0`）                                                                              |
| `npm test`                 | 通过：57 个测试文件、530 个用例（P1-05 重跑，2026-10-24）                                               |
| `npm run build`            | 通过；Rollup 输出 2 条来自 `zod` 内部注释的 annotation 警告，不影响产物                                 |
| `npm audit --omit=dev`     | 通过：生产依赖 0 个已知漏洞                                                                             |
| 打包运行时验收（TASK-009） | 15/15 通过，0 项秘密/终端输出泄漏；使用本地 `ssh2` 夹具 + CDP，详见 `docs/releases/0.1.0-acceptance.md` |

测试全部使用 fake SSH Client/Channel、fake `SFTPWrapper`、fake 存储、mock preload bridge 与 fake xterm，不连接公网服务器，也不依赖真实 SSH/SFTP 服务端；传输测试会使用真实本地临时目录与 Node 文件流，设置/日志测试使用真实临时目录，但不代表真实远端集成测试。原生文件/目录/保存对话框在自动化测试中由 stubbed picker 代替，未真实弹出。类型检查、lint 与测试通过不等于完整安全验证；TASK-009 的打包运行时验收使用本地 `ssh2` 夹具与 CDP，**不是 Windows OpenSSH Server 验收，也不是逐项 UI 手工验收**；实际安装/卸载/升级、代码签名与干净 Windows 环境仍未执行。

### P1-01 门禁回归（2026-10-23）

| 命令                | 结果                               | 证据摘要                                                                                                                 |
| ------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `npm run typecheck` | 通过（EXIT=0）                     | Node 侧与 Web 侧均无错误                                                                                                 |
| `npm run lint`      | 通过（EXIT=0，`--max-warnings 0`） | 修复 `LocalFilePanel` 一处 `react-hooks/exhaustive-deps` 后无警告                                                        |
| `npm test`          | 通过（EXIT=0）                     | `Test Files 37 passed (37)`、`Tests 341 passed (341)`；P1-01 相关 5 个文件 47 用例全部通过                               |
| `npm run build`     | 通过（EXIT=0）                     | `out/main/index.js 268.84 kB`、`out/preload/index.js 9.49 kB`、renderer JS 1,684.23 kB、CSS 110.03 kB；2 条 zod 注释警告 |

该轮回归未在 Electron 实窗中执行拖拽/本地面板手工验收，相关手工清单项（51–53）仍未执行。

### 测试期间修复的问题

- 新增本地路径测试发现 `localParentPath`/`splitLocalBreadcrumbs` 对 `/` 根路径会拼出 `//usr` 之类的错误父路径；已改为按根的分隔符统一拼接（Windows/UNC 行为不变）。
- 完整测试套件并发运行时，`connections.json` 的原子写入在 Windows 上偶发 `rename` 失败（`EPERM`/`EACCES`/`EBUSY` 类瞬时占用）。已为 `writeJsonFileAtomic` 增加仅针对这三个错误码的有限退避重试；随后连续 3 次完整套件均通过。
- 该问题未在真实用户目录中复现；重试只覆盖临时文件 → 目标文件的改名，不改变原子写入语义或错误脱敏。
- SFTP 并发 `open` 曾各自解析一次 home：已改为共享 `homeOpening` Promise，并补充“并发打开只调用一次 `realpath('.')`”的测试。

## P1-02 已交付内容

### 共享模型、schema 与持久化迁移

- `ConnectionProfile`/`ConnectionInput` 新增 `jumpConnectionIds: string[]`（有序、去重、禁自引用、最多 `MAX_JUMP_HOPS = 4`）；新增 `SshJumpHop`（`index` 1-based、`connectionId`、`name`、`host`、`port`、`username`、`authMethod`），随 `SshSessionSnapshot.jumps`/`activeHop`、`SshFailure.hop` 与 `HostKeyChallenge.hop` 下发（`src/shared/types/`）。
- catalog 校验新增跳板图不变量：引用必须存在、禁自引用、DFS 三色无环检测（新环必经被修改节点的可达性检查）。`connections.json` 信封版本 1 → 2，冻结 `persistedConnectionCatalogV1Schema` 与 `parsePersistedConnectionCatalog`：v1 文件加载时补 `jumpConnectionIds: []`、重验证后写回 v2。
- 仓库层（`connectionRepository`）：create/update 校验跳板引用并给出固定中文错误（缺失引用、自引用、成环）；`remove` 级联把被删连接从其他连接的引用中剥离并更新 `updatedAt`。种子数据中 `stage-api-01 → stage-bastion` 为演示性单跳引用。

### 主进程链式连接

- `SshService` 按 `jumpConnectionIds` 顺序建链：跳板 1 直连 TCP，其后每一跳用上一跳 `client.forwardOut(srcIP, srcPort, dstIP, dstPort)` 打开转发通道并作为下一跳 Client 的 `sock`；最终目标 Client 照常承载终端与 SFTP，`ShellChannelManager`/`SftpService` 无需改动。
- 每一跳独立按各自连接记录解析凭据、独立按各自 `host:port` 校验主机密钥；同一时刻只有一个待决主机密钥挑战，来自跳板的 challenge 带 `hop`；跳板凭据补录经 `failure.hop.connectionId` 写入跳板自己的加密凭据记录。
- 失败归属：认证失败/主机密钥变化/跳板掉线归属对应跳；`forwardOut` 拨号失败归属正在拨往的下一端点；95 秒 ready guard 超时归属 `activeHop`。任何一跳失败立即销毁已建立的跳板 Client 与转发通道。
- 断开按依赖自内向外清理（先目标后逐跳跳板），全链 close 收敛后只推送一次终态；`disconnect`/`cancelAll`/`dispose` 覆盖全链，不留下孤立 Client。快照只含跳板元数据（不含凭据与 Socket），`hostKey` 只记录目标端点指纹。

### 渲染层

- `ConnectionForm` 高级选项新增跳板编辑器：从已保存连接添加（自身与重复排除、达到 4 个后禁用）、上移/下移、移除、`本机 → 跳板 → 目标` 路径预览；`ConnectionEditorModal` 向表单传入连接目录。
- 工作台 `TerminalPane` 在连接/认证/等待主机密钥阶段标明活动跳（`正在连接跳板 N/M 名称（host:port）` 等），元数据区显示「连接路径」；失败文案经 `formatSshFailureMessage` 统一前缀「经跳板 N（名称）失败」（侧栏、标签栏、服务器页三处）。
- 主机密钥弹窗对跳板挑战展示「跳板」字段与「该信任仅适用于此跳板；最终目标仍会单独要求确认」；凭据补录弹窗标题标注「跳板 N」；`styles/views.css` 新增 `.jump-chain` 系列样式。

### 测试

- 新增跳板用例 22 个：`connectionSchemas.test.ts` +5（引用/环/迁移）、`localStorage.test.ts` +3（仓库校验、级联剥离、v1→v2 写回）、`sshService.test.ts` +11（直连回归、单跳/两跳拨号与 `sock` 链接、每跳独立主机密钥与挑战、跳板凭据失败归属、主机密钥变化阻断、拨号失败归属下一端点、跳板掉线中断、断开自内向外、并发隔离）、`connectionForm.test.tsx` +3（编辑器交互、自身排除、上限禁用）。
- fake `ssh2` Client 新增 `forwardOut`/`deferForward`/`completeForward`；**全部基于 fake Client 与 fake 转发通道，没有真实跳板网络（两台以上真实服务器）验收，也没有 Electron 实窗跳板编辑器验收**。

### P1-02 门禁回归（2026-10-23）

| 命令                | 结果                               | 证据摘要                                                                                                                 |
| ------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `npm run typecheck` | 通过（EXIT=0）                     | `tsc --noEmit --composite false` 检查 Node 侧与 Web 侧，无错误                                                           |
| `npm run lint`      | 通过（EXIT=0，`--max-warnings 0`） | `eslint . --max-warnings 0` 无警告                                                                                       |
| `npm test`          | 通过（EXIT=0）                     | `Test Files 37 passed (37)`、`Tests 363 passed (363)`，`Duration 17.66s`；P1-02 相关 4 个文件 75 用例全部通过            |
| `npm run build`     | 通过（EXIT=0）                     | `out/main/index.js 280.80 kB`、`out/preload/index.js 9.49 kB`、renderer JS 1,696.58 kB、CSS 112.23 kB；2 条 zod 注释警告 |

该轮回归未在 Electron 实窗执行跳板编辑器与链路状态手工验收，也未在真实跳板网络执行链路验收；手工清单第 54–56 项仍未执行。

### P1-02 测试期间修复的问题

- 新增两跳测试的期望值写错（把 hop1 的 `forwardOut` 目标写成 hop2 自身 host；实收为下一端点地址，即 hop1 拨向 hop2）：实收值正确，修正测试期望后 48 个 `sshService` 用例全绿。
- 版本升级 1 → 2 使 3 个既有测试断言需按新语义更新（envelope v1/v2 通过性、`persisted.version`、unsupported 版本号）——均为预期行为变化，非产品缺陷；迁移路径已验证（v1 补空数组写回 v2）。

## P1-03 已交付内容

### 风险清单（按严重程度）

| 严重程度 | 风险                                             | 处理                                                                                                                        |
| -------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 高       | 渲染进程点击后就把规则显示为运行中，实际监听失败 | 主进程唯一权威：只在 `net.listen`/`forwardIn` 成功后进入 `running`；失败进入 `error`；渲染端只镜像快照，pending 不写状态    |
| 高       | 本地/远程转发绑定到 `0.0.0.0` 导致无意暴露       | 本地与远程默认 `127.0.0.1`；非回环地址必须显式 `confirmExposure`；服务器拒绝绑定时不自动放宽；SOCKS5 强制回环               |
| 高       | Socket、Channel 或应用层负载跨 IPC 泄露          | 仅暴露窄 `SshForwardingSession`（`Duplex` + 绑定端点）；渲染端只拿到规则/运行态快照；不读取、不记录、不转发 payload         |
| 高       | SSH 断开或退出后本地监听器/远程绑定残留          | 会话关闭即停止规则；停止/解绑有 5 秒上限；失败进入 `error(cleanupPending)` 并阻断编辑/删除/重启；退出按序清理且失败不报成功 |
| 中       | 重启后假定监听器仍存在，或重连后静默迁移到新会话 | 运行时状态不持久化，规则启动后一律 `stopped`；不自动重启；会话不匹配拒绝启动；重连不重绑、不迁移                            |
| 中       | 删除连接后留下孤儿规则或仍运行的监听器           | 删除前返回规则数与运行数；必须显式勾选级联确认；先停止并删除规则，任一失败中止连接删除并可重试                              |
| 中       | 无真实 SSH 转发验收却宣称协议兼容                | 自动化仅使用 fake `forwardOut`/`forwardIn` 与真实回环 `net` 监听；真实 SSH 端口转发验收状态明确为**未执行**                 |
| 低       | 规则/连接无上限导致资源耗尽                      | 规则 100、活动规则 32、单规则连接 64、全局连接 256；连接/握手 10 秒、停止 5 秒；常量集中定义并被 schema/服务/测试共同引用   |
| 低       | 自定义 SOCKS5 解析器存在协议缺陷                 | 独立 RFC 1928 模块 + 11 个协议用例（分片/粘包/IPv4/域名/IPv6/拒绝码/超时/长度上限）；仅 no-auth CONNECT，未交付 UDP/BIND    |

### 共享模型、schema 与持久化

- 新增 `src/shared/types/portForward.ts`：`PortForwardType`（`local`/`remote`/`dynamic`）、规则、`PortForwardRuntime`、`PortForwardSnapshot`、启动输入、连接删除影响与固定失败类型；规则不含凭据、私钥、口令或任意 Socket。
- 新增 `src/shared/constants/portForward.ts`：规则 100、活动规则 32、单规则连接 64、全局连接 256、连接/握手超时 10 秒、停止/解绑超时 5 秒；schema、服务与文档共用同一组常量。
- 新增 `src/shared/schemas/portForward.ts`：strict 判别联合；绑定地址只接受 IPv4/IPv6 字面量；本地/远程默认 `127.0.0.1`；动态固定 `127.0.0.1`；端口 1–65535；启动请求的 `confirmExposure` 默认 `false`；更新不可切换类型或连接。
- 新增 `PortForwardRepository`（`<userData>/port-forwards.json`，`{ version: 1, data: { rules } }`）：原子写入、100 条上限、并发串行化、删除单条/按连接删除、损坏或版本不支持时不覆盖原文件；运行时状态不落盘。

### 主进程与 IPC

- 新增 `SshForwardingSession` 窄门面：只暴露四参数 `forwardOut(srcIP, srcPort, dstIP, dstPort)`、`forwardIn`、`unforwardIn`、`tcp connection` 订阅与关闭；不暴露 `ssh2.Client`、Channel、原始错误或跳板逻辑。P1-02 链式连接保持原样。
- 本地转发：真实 `net.createServer({ pauseOnConnect: true })` 监听，按连接打开 `forwardOut` 通道并双向 pipe；绑定失败不留下监听器；停止幂等关闭监听与连接。
- 远程转发：`forwardIn` 绑定远程地址/端口，按端点精确分发 `tcp connection` 到本地 `net.createConnection`；拒绝不匹配端点与超限连接；超时/迟到绑定会解绑；停止调用 `unforwardIn` 并拆除连接。
- 动态转发：仅回环 SOCKS5 服务器；RFC 1928 no-auth CONNECT，支持 IPv4、域名与 IPv6；分片/粘包/剩余字节处理；协议错误返回固定拒绝码；连接/握手超时与并发上限；停止关闭监听与活动连接。
- 新增 `PortForwardService`：串行化规则操作；启动前校验规则、连接存在、会话 `connected` 且 `connectionId` 匹配、活动规则上限与暴露确认；仅在真实绑定成功后写入 `running`；会话关闭即停止且不重绑；`cleanupPending` 阻断编辑/删除/重启；`removeForConnection` 先停止再删规则，任一失败中止；`shutdown` 汇总真实清理结果。
- IPC 新增 7 个固定通道（`port-forwards:list/create/update/remove/start/stop/connection-impact`）与 `port-forwards:snapshot-updated` 推送事件；总通道数 46 → 53，推送事件 6 → 7。全部执行 sender/main frame 与 strict schema 校验；删除连接时复核影响并要求 `cascadePortForwards`。
- preload 新增冻结 `portForwards` 命名空间（7 个方法与 1 个订阅）；不暴露 Socket、Channel、流量、监听器句柄或任意路径。

### 渲染层

- 新增 `portForwardStore`：按 `revision` 合并主进程快照，忽略过期事件；启动/停止/删除 pending 只影响本地按钮状态，不写入运行态；失败显示固定错误。
- 新增端口转发页、规则编辑器、启动确认弹窗与删除确认弹窗：展示规则、所属连接、状态、实际绑定端点、连接数、会话选择与失败原因；非回环本地/远程绑定必须勾选暴露风险确认；运行中或 `cleanupPending` 规则禁用编辑/删除。
- 应用菜单与命令面板加入「端口转发」入口；`usePortForwardBridgeEvents` 在应用根订阅快照事件。
- 删除连接弹窗加载规则影响，显示规则数与运行数；必须勾选「我已确认停止并删除这 N 条端口转发规则，随后再删除该连接。」后才允许删除；影响加载失败显示重试，不显示空列表；级联失败保留对话框与连接。

### 测试

- 新增 11 个测试文件、76 个用例：`portForwardAddress` 4、`portForwardSchema` 6、`portForwardRepository` 8、`sshForwardingSession` 7、`portForwardRuntimeSupport` 3、`portForwardLocalRuntime` 4、`portForwardRemoteRuntime` 8、`portForwardDynamicRuntime` 7、`socks5Protocol` 11、`portForwardService` 13、`portForwardUi` 5。
- 扩展 `mainIpc`、`preloadBridge`、`stores`、`connectionManagement` 与 `appShell`，覆盖 53 通道/7 事件、端口转发 schema 与 sender、快照事件、连接删除级联确认与导航入口。
- 本地转发与 SOCKS5 测试使用真实 `127.0.0.1` 监听与客户端，SSH 侧为 fake `forwardOut`；远程转发为 fake `forwardIn`/`tcp connection`；**没有真实 SSH 服务器、真实 `AllowTcpForwarding`、真实网络抖动或 Electron 实窗端口转发验收**。

### P1-03 门禁回归（2026-10-23）

| 命令                | 结果                               | 证据摘要                                                                                                                  |
| ------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck` | 通过（EXIT=0）                     | `tsc --noEmit --composite false` 检查 Node 侧与 Web 侧，无错误                                                            |
| `npm run lint`      | 通过（EXIT=0，`--max-warnings 0`） | `eslint . --max-warnings 0` 无警告                                                                                        |
| `npm test`          | 通过（EXIT=0）                     | `Test Files 48 passed (48)`、`Tests 445 passed (445)`，`Duration 22.10s`；P1-03 新增 11 个文件 76 用例全部通过            |
| `npm run build`     | 通过（EXIT=0）                     | `out/main/index.js 353.38 kB`、`out/preload/index.js 10.96 kB`、renderer JS 1,760.38 kB、CSS 112.92 kB；2 条 zod 注释警告 |

该轮回归未在 Electron 实窗执行端口转发页、编辑器、启动暴露确认与连接级联删除验收，也未在任何真实 SSH 服务器执行本地/远程/SOCKS5 转发验收；**真实 SSH 端口转发验收：未执行**。手工清单第 57–63 项仍未执行。

### P1-03 测试期间修复的问题

- 端口转发编辑器判别联合构造曾触发 TS2322；改为按 `values.type` 分支显式构造本地/远程/动态输入，避免把可选字段混入错误分支。
- 新增「端口转发」菜单后 `appShell` 的菜单断言缺少新项；更新期望标签并补充视图入口断言。
- `portForwardUi` 新建规则测试曾把默认目标地址与输入拼接成非法主机；测试改为先清空输入再填写。
- 完整套件中连接删除测试在影响检查仍加载时点击确认；测试改为等待 `loadDeleteImpact` 完成并重置新增状态。
- UI 曾允许删除运行中的规则，而服务正确拒绝；已改为对活动/`cleanupPending` 规则禁用删除并同步确认文案。

## P1-04 已交付内容

### 风险清单（按严重程度）

| 严重程度 | 风险                                                  | 处理                                                                                                                                                  |
| -------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 高       | 快速命令另建执行通路，绕过 SSH 会话管理与既有输入队列 | 只复用既有 `terminal:write` → `SshService.writeShell`；不新建独立 SSH Client、不创建任意 `exec` 通道、不使用本地 Shell；插入走同一终端写入队列        |
| 高       | 目标在打开后被切换、重连、关闭，命令被发到错误会话    | 打开时仅捕获可发送目标；发送必须显式选择；主进程校验 `tabId`/`sessionId`/`clientId`/连接状态/Shell `open`；失效时零写入且不自动切换；flush 后再次校验 |
| 高       | 重复点击或网络歧义重试导致命令写入两次                | 每个 compose 会话生成固定 `requestId` 并在重试时复用；主进程保留最近 200 个请求 ID 去重，并按标签限制同时只有一个发送在途                             |
| 中       | 命令正文/参数进入应用日志或意外采集终端输出           | 历史与应用日志分离；日志只记录固定事件；历史只保存显式勾选且发送成功的渲染后正文与目标元数据，不保存输出/退出码；测试与受控验收检查日志无命令文本     |
| 中       | 模板求值或参数被当作代码/本地 Shell 执行              | 仅支持 `{{identifier}}`；单次字面量替换；无 `eval`/`new Function`/本地 Shell；拒绝畸形占位符与控制字符；明确不承诺 Shell 转义                         |
| 中       | 内置命令误改远端状态                                  | 首版 12 个内置命令均为只读诊断；移除 `systemctl restart`；内置命令不可编辑/删除，仅可收藏、复制、插入或发送                                           |
| 中       | 「插入」被误认为已执行                                | 插入只写入输入行、不追加回车、不自动执行；确认框与成功 Toast 均明确说明；发送才追加一个回车                                                           |
| 低       | 自定义命令/历史/收藏无上限导致存储与 UI 压力          | 自定义 500、历史 200、收藏 64、参数 16、正文 4,096 等常量集中定义并被 schema、仓库与 UI 共用                                                          |
| 低       | 历史文件为明文，可能泄露命令正文与主机信息            | 明确披露 `command-history.json` 未额外加密；默认关闭；提供全局开关、单条删除与清空；文件损坏不覆盖，清空时重建空状态                                  |

### 共享模型、设置与持久化

- 新增 `src/shared/types/quickCommands.ts`：`QuickCommand`、`QuickCommandDraft`、`PersistedCustomQuickCommand`、`CommandHistoryEntry`、执行输入/回执与历史快照；执行输入只含 `requestId`、显式目标、参数或历史正文，不含任意客户端状态。
- 新增 `src/shared/constants/quickCommands.ts`：存储版本、ID 前缀与 500/200/64/16 等上限；新增 `src/shared/quickCommands/template.ts`（解析/渲染/控制字符校验）与 `builtIns.ts`（12 个只读诊断命令）。
- 新增 `src/shared/schemas/quickCommands.ts`：草稿、执行、删除、历史 strict schema；模板参数列表必须与正文一致；历史信封 `{ version: 1, data: { entries } }` 最多 200 条并拒绝重复 ID。
- 设置升级到 v3：`commandHistoryEnabled` 默认 `false`；v2/v1 读取补齐字段并保留既有值，不产生警告、不立即改写文件。
- 新增 `QuickCommandRepository`（`quick-commands.json`）与 `CommandHistoryRepository`（`command-history.json`）：版本化、strict 校验、原子写入、串行化、损坏文件不覆盖；内置命令只读，收藏与自定义命令持久化。

### 主进程与 IPC

- 新增 `QuickCommandService`：合并内置与自定义命令、保存收藏；执行时重新渲染模板，校验目标标签/会话/连接/Shell 状态，经 `SshService.writeShell` 写入“正文 + `\r`”；写入成功后才按设置与勾选记录历史；历史持久化失败只返回警告，不把已写入的终端操作报告为失败。
- 历史默认关闭；全局关闭时即使请求携带 `recordHistory: true` 也不写入；历史重发不做模板处理。
- IPC 新增 9 个固定通道（`quick-commands:list/create/update/remove/set-favorite/execute`、`command-history:list/remove/clear`）；总通道数 53 → 62，推送事件保持 7 个。全部执行 sender/main frame 与 strict schema 校验。
- preload 新增冻结 `quickCommands`（6 个方法）与 `commandHistory`（3 个方法）命名空间；不暴露原始 `ipcRenderer`、SSH Client、文件系统或内部会话对象。

### 渲染层

- `terminalRuntime` 新增按稳定标签 ID 维护的写入队列：普通输入、快速命令插入与发送共用队列；发送前 `flushTerminalInput` 等待已排队输入，插入不追加换行。
- 新增 `quickCommandStore`：库/历史加载、目标捕获、保存/删除/收藏、插入与执行；执行前校验目标、冲刷队列、再次校验，失败时不自动重发；同一 compose 会话复用请求 ID。
- 新增快速命令右侧抽屉、命令编辑器与发送/插入确认框：命令库/历史切换、搜索、分类/收藏筛选、内置只读标识、删除与清空内联确认、历史关闭警告；确认框展示参数、最终预览、显式目标与会话、历史勾选和真实执行说明。
- SSH 工具栏新增「快速命令」入口，命令面板新增「打开快速命令」，`Ctrl/Cmd+Shift+K` 打开抽屉；不自动执行任何命令。
- 设置页「会话与传输记录」新增命令历史开关、明文披露与清空确认；壁纸/主题/终端等其他设置不受影响。

### 测试

- 新增 6 个测试文件、41 个用例：`quickCommandTemplate` 7、`quickCommandRepository` 7、`commandHistoryRepository` 5、`quickCommandService` 10、`quickCommandStore` 5、`quickCommandUi` 7。
- 扩展 `settingsRepository`（v1/v2→v3 默认值与保留）、`settingsView`（历史开关/清空/披露）、`terminalRuntime`（插入无回车与 flush）、`mainIpc`/`preloadBridge`（P1-04 阶段 62 通道，P1-05 起为 63）、`fakeBridge`（新命名空间）。
- 受控验收 `tests/acceptance/quick-command-runtime.mjs`：源码 Electron（`isPackaged:false`）+ 本机 `ssh2` 测试服务端（真实密码认证、PTY/Shell）+ CDP，18/18 检查通过、10 张截图，产物位于 `release/acceptance/p1-04-quick-commands/`。检查包括历史默认关闭、快捷键/抽屉、真实 Shell 发送与插入、双会话过期目标、自定义命令预览、历史记录、删除/清空、v3 设置与日志无命令正文。
- **没有**在 Windows OpenSSH Server、生产网络、安装包或重启后的应用上执行 P1-04 验收；受控验收不能替代这些场景。

### P1-04 门禁回归（2026-10-23）

| 命令                | 结果                               | 证据摘要                                                                                                                  |
| ------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck` | 通过（EXIT=0）                     | `tsc --noEmit --composite false` 检查 Node 侧与 Web 侧，无错误                                                            |
| `npm run lint`      | 通过（EXIT=0，`--max-warnings 0`） | `eslint . --max-warnings 0` 无警告                                                                                        |
| `npm test`          | 通过（EXIT=0）                     | `Test Files 54 passed (54)`、`Tests 490 passed (490)`，`Duration 25.63s`；P1-04 新增 6 个文件 41 用例全部通过             |
| `npm run build`     | 通过（EXIT=0）                     | `out/main/index.js 391.13 kB`、`out/preload/index.js 12.52 kB`、renderer JS 1,863.00 kB、CSS 123.27 kB；2 条 zod 注释警告 |

该轮回归另执行了 P1-04 受控终端验收（18/18、10 张截图），但未在 Windows OpenSSH Server、真实网络、安装包或逐项 UI 手工点击中验收；P1-03 的真实 SSH 端口转发验收仍为**未执行**，不因 P1-04 验收完成而改变。

### P1-04 测试期间修复的问题

- 受控验收脚本首次启动 Electron 时继承了 `ELECTRON_RUN_AS_NODE=1`，进程按 Node 运行并静默退出；改为在 spawn 环境删除该变量后正常启动。
- 验收脚本曾把 `getAppInfo()` 当作 `OperationResult` 读取；实际返回普通 `AppInfo`，已修正检查逻辑。
- Testing Library 的 `user-event` 会把模板中的 `{{` 当作转义花括号，导致模板输入断言失败；模板/命令正文用例改用 `fireEvent.change` 输入。
- 多个界面用例按可见文本查询标签时受到必填星号与图标影响；改为按可访问名称/角色查询。
- 验收报告对象曾包含循环引用，无法 JSON 序列化；已改为只提取可序列化的检查结果。

## P1-05 已交付内容

### 风险清单（按严重程度）

| 严重程度 | 风险                                                   | 处理                                                                                                                                                                       |
| -------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 高       | 自动重连放宽主机密钥或认证检查，造成安全降级           | 每次重试重新创建 Client 并重新执行主机密钥校验与认证/跳板流程；不自动信任、不忽略认证失败；只按固定 `SshFailure.code` 白名单调度，不匹配错误文本                           |
| 高       | 认证失败、主机密钥变化、用户取消或主动断开后仍持续重试 | 渲染端先判断错误码与主动断开抑制标记；取消、断开、关闭标签、关闭窗口/应用退出、关闭设置开关都会清除计时器；最多 5 次后进入 `exhausted` 终态                                |
| 高       | 取消连接误关标签、波及其他标签/窗格或留下迟到会话      | `ssh:cancel-connect` 只接受 `clientId`；主进程按标签定向取消，先收敛为 `disconnected(cancelled)` 再销毁 transport；迟到成功按 epoch 丢弃并断开，不关闭标签、不影响其他会话 |
| 高       | 分屏操作建立额外 SSH 连接或让窗格串流                  | 分屏仅是 `workspaceStore` 运行态与 CSS 布局；每个标签仍只有一个 SSH 会话与一个终端实例；切换/移除窗格不调用 `ssh:connect`/`ssh:disconnect`                                 |
| 中       | 自动重连重放断线前输入、快速命令或旧 Shell 状态        | 不缓存、不重放终端输入/快速命令；重连只重建 SSH 与新 PTY；UI 明确说明旧远程进程、工作目录与前台程序不会恢复                                                                |
| 中       | 分屏/重连运行态被写入磁盘，重启后误恢复                | 分屏布局、绑定、焦点、计时器与尝试次数仅存在内存；设置只持久化布尔 `autoReconnectEnabled`，重启不恢复任何重连任务                                                          |
| 中       | 设置从 v3 升级时旧文件被误判损坏或丢失既有偏好         | 设置 v4 读取 v1/v2/v3 时在内存迁移，缺失 `autoReconnectEnabled` 按 `false`；strict 布尔、未知字段拒绝、原文件不在读取阶段被覆盖                                            |
| 低       | 两个窗格同时高频输出或窄窗口拖动比例造成卡顿           | 每个终端仍使用既有模块级重放缓冲与分片写入；分隔条比例夹取 20%–80%；未做专门的压力/性能验收，列为残余风险                                                                  |

### 共享模型与运行态

- 新增 `src/renderer/src/features/terminal/splitLayout.ts`：`SplitPaneId`（`pane-a`/`pane-b`）、`SplitDirection`（`row`/`column`）、比例常量 0.2–0.8（默认 0.5）、`TerminalSplitLayout` 与纯函数（夹取、按标签查找窗格、可见窗格、另一窗格）。
- `workspaceStore` 新增运行态 `split`：开关、方向、比例、焦点窗格与两个窗格的 `tabId` 绑定；开启时把活动标签放入 `pane-a`，有第二个已打开标签则自动绑定 `pane-b`，否则显示空窗格；点击标签优先填空窗格，无空窗格时替换焦点窗格绑定但不关闭原标签；关闭标签解绑对应窗格，两格皆空时退出分屏。
- 分屏状态不写入设置、连接或会话存储；`resetTabs` 恢复默认单窗格。

### 渲染层

- `TerminalWorkspace` 在分屏时同时渲染两个绑定标签的 `TerminalPane`，其余标签仅隐藏；新增 `TerminalEmptyPane`（空窗格说明、候选会话下拉、点击标签栏提示）、`TerminalPaneHeader`（窗格标识、聚焦、仅解绑不移除会话）与 `TerminalSplitDivider`（指针拖动、方向键/Shift、Home/End、双击 50%、ARIA `separator` 与 20–80 值）。
- `TerminalToolbar` 新增「左右分屏」「上下分屏」「退出分屏」及方向切换按钮，`title` 明确不建立/不关闭 SSH 会话；取消连接按钮覆盖连接中、认证中、等待主机密钥与自动重连进行中。
- 新增 `AutoReconnectNotice`：等待重试显示倒计时与「停止自动重连」，进行中显示「取消自动重连」，耗尽显示「自动重连已停止」；文案明确仅重试网络类错误、不重放输入、不自动信任新主机密钥、不恢复旧 Shell。
- `sessionStore` 新增自动重连状态机：固定错误码白名单、1/2/4/8/15 秒退避、最多 5 次、成功清除、主动断开/取消/关闭标签/设置关闭清理；新增 `cancelConnect` 与手动重连取消路径，使用 epoch、`cancelledTabs` 与 `dismissedSessionIds` 处理迟到成功与关闭竞态。

### 主进程、IPC 与设置

- 新增窄 IPC `ssh:cancel-connect`：`SshConnectCancelAck { cancelled, session }`；只接受 `sshClientIdSchema`（`sshtab-<UUID>`），经 `assertTrustedSender` 与 strict schema 校验。通道总数 62 → 63，推送事件保持 7 个。
- `SshService.cancelConnect(clientId)` 只取消该 `clientId` 的进行中尝试：标记用户取消、以 `disconnected(cancelled)` 收敛状态，再销毁 Client/跳板链与临时资源；幂等，无进行中尝试返回 `cancelled:false`；不关闭标签、不影响其他会话，迟到成功按 epoch 丢弃。preload `ssh` 新增 `cancelConnect`，仍为冻结命名空间。
- 设置升级到 v4：新增 strict 布尔 `autoReconnectEnabled`（默认 `false`）；v1/v2/v3 读取时内存迁移并保留既有偏好，不产生警告、不立即改写；写入仍串行、原子替换，失败局部回滚。
- 设置页「会话与传输记录」新增自动重连复选框、默认关闭状态与完整边界说明；关闭开关立即停止等待中的自动重连计时器。

### 测试与受控验收

- 新增 3 个测试文件、22 个用例：`workspaceSplit` 13、`terminalSplitUi` 6、`autoReconnectUi` 3；扩展 `stores`（取消/重连/自动重连状态机）、`sshService`（取消连接）、`settingsRepository`（v3→v4）、`settingsView`、`mainIpc`（63 通道）、`preloadBridge` 与 `fakeBridge`。
- 覆盖：分屏默认关闭、绑定唯一、焦点/空窗格/关闭解绑、分隔条键盘与比例夹取；取消连接幂等与隔离、迟到成功断开；自动重连仅对五类错误码调度、退避与上限、成功清除、主动断开/取消/设置关闭中止、不重放输入；设置 v4 迁移与默认关闭；分屏操作不调用 SSH 连接/断开。
- 受控验收 `tests/acceptance/split-reconnect-runtime.mjs`：源码 Electron（`isPackaged:false`）+ 本机 `ssh2` 测试服务端（真实密码认证、PTY/Shell、服务端主动结束通道模拟意外断线）+ CDP，19/19 检查通过、10 张截图，产物位于 `release/acceptance/p1-05-split-reconnect/`；报告记录 `realOpenSsh: "not executed"`、`networkJitter: "not executed"`。
- **没有**在 Windows OpenSSH Server、真实网络抖动/长时间断网、系统休眠/唤醒、代理/VPN 切换、安装包或逐项 UI 手工点击中执行 P1-05 验收；受控验收不能替代这些场景。

### P1-05 门禁回归（2026-10-24）

| 命令                | 结果                               | 证据摘要                                                                                              |
| ------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `npm run typecheck` | 通过（EXIT=0）                     | `tsc --noEmit --composite false` 检查 Node 侧与 Web 侧，无错误                                        |
| `npm run lint`      | 通过（EXIT=0，`--max-warnings 0`） | 修复验收脚本未使用变量后无警告                                                                        |
| `npm test`          | 通过（EXIT=0）                     | `Test Files 57 passed (57)`、`Tests 530 passed (530)`，`Duration 24.39s`；P1-05 新增 3 个文件 22 用例 |
| `npm run build`     | 通过（EXIT=0）                     | 构建成功；仅 2 条既有 zod Rollup 注释警告，无新增警告                                                 |

该轮回归另执行 P1-05 受控验收（19/19、10 张截图），但未在真实 OpenSSH、真实网络抖动、安装包或逐项 UI 手工点击中验收；P1-03 的真实 SSH 端口转发验收仍为**未执行**。

### P1-05 测试期间修复的问题

- `tests/acceptance/split-reconnect-runtime.mjs` 中 `setup` 变量赋值后未使用，触发 `@typescript-eslint/no-unused-vars`；移除无用的 `const setup =` 后 lint 通过，验收脚本行为不变。
- 分屏开启时点击标签若直接替换焦点窗格，会误以为关闭原会话；实现改为优先填空窗格并在无空窗格时仅替换绑定，补充 UI/模型测试确保不触发 SSH 断开。
- 自动重连在主动断开后曾存在迟到失败重新调度的窗口；通过 `autoReconnectSuppressedTabs` 与手动断开标记抑制，测试覆盖主动断开/取消/关闭标签。
- 设置 v3 文件读取时若直接按 v4 strict 校验会失败；改为按版本迁移后再校验，缺失字段按 `false`，保留 v1/v2/v3 既有偏好。
- 取消连接与连接成功存在竞态；主进程先收敛为 `disconnected(cancelled)` 再销毁 transport，渲染端按 epoch/取消标记丢弃迟到成功并请求断开。

## 明确未实现

- 断点续传、暂停/恢复、自动重启执行、远程目录递归下载、跨主机或跨会话批量编排、自动同步、远程编辑、文件比较与带宽限制。
- 完整传输历史持久化与操作审计 UI；当前只有未完成任务最多 100 条的展示快照会跨重启保留。
- SFTP 递归删除、服务端权限预检与操作审计 UI；当前删除只允许文件、符号链接或空目录。
- 无限/后台自动重连（当前仅渲染进程内、默认关闭、最多 5 次的有界重试）；重连不恢复旧 Shell、前台进程、传输或端口转发。keyboard-interactive 仍未实现。
- 端口转发高级形态：SOCKS5 用户名/密码认证、UDP ASSOCIATE、BIND、SOCKS4、Unix 域套接字转发、通用 HTTP/HTTPS 代理、断点续传与按规则限速/审计；当前仅支持本地 TCP、远程 TCP 与回环 no-auth SOCKS5 CONNECT。
- 端口转发自动重启/会话迁移：应用重启后规则保持 `stopped`，SSH 重连后不自动重绑、不静默切换到新 `sessionId`。
- 端口转发的流量检查、负载日志、应用层协议识别与访问控制列表；当前只转发字节，不读取、不记录 payload。
- 端口转发规则的导入/导出、分组、批量启停与运行时长统计。
- 跳板高级形态：`ProxyCommand`/`ssh -J` 配置导入、跳板连接跨会话复用与跳板链自动重连（当前每标签每会话独立建链，同一连接并发标签不共享跳板 Client）。
- Pageant、第三方 SSH Agent。
- 凭据管理/审计 UI；主机密钥只支持列表与删除，不支持导入/导出或轮换审计。
- 日志内容读取 IPC、按日志级别分文件与保留数量可配置。
- 终端搜索、复制粘贴策略、多窗口附着与终端会话持久化。
- 快速命令高级形态：自动补全、条件/循环、定时执行、多目标群发、命令输出与退出码采集、Shell 感知转义、命令级权限/审批、导入/导出、跨设备同步、命令历史额外加密或审计；当前仅支持单目标插入/发送、字面量模板与最近 200 条明文历史。
- 超过两个窗格的分屏、跨窗格标签拖拽迁移、布局持久化与多窗口分屏；当前仅支持两个运行态窗格，不改变 SSH 会话生命周期。
- 正式代码签名、自动更新、安装/卸载/覆盖升级实机验收、干净 Windows 虚拟机/CI 与 macOS/Linux 发布验证。Windows x64 NSIS **未签名测试包**已生成。
- 真实 Windows OpenSSH Server 的 SSH/PTY/SFTP 集成测试、真实原生对话框验收与逐项 UI 手工验收；TASK-009 仅有本地 `ssh2` 夹具与 CDP 驱动的打包运行时验收。

## 手工验证清单（部分执行）

以下场景除标注「受控实窗已执行」的 P1-04/P1-05 项外，均为待办验收项，本次交付**没有**真实 OpenSSH 服务端或安装包结果。P1-04 与 P1-05 的受控验收均使用源码 Electron + 本机 `ssh2` 夹具 + CDP，不等同于 OpenSSH、真实网络或安装包验收。

1. 在 Electron 实窗连接真实 OpenSSH 服务端，分别验证密码、私钥、加密私钥口令与系统 Agent。
2. 首次连接确认指纹；拒绝、关闭、超时均不得建立连接；重建 `known-hosts.json` 后再次确认。
3. 服务端更换主机密钥，确认连接被 `host-key-changed` 阻止。
4. 在终端执行 `pwd`、`ls`、`cd`、`clear` 与含中文/ANSI 颜色的命令，确认输出来自真实远端且无本地重复回显。
5. 调整窗口尺寸/侧栏折叠，确认 `cols×rows` 更新、远程程序（如 `top`/`vim`）按新尺寸重排。
6. 使用 Ctrl+C、Ctrl+D 与远端 `exit`，确认中断、Shell 退出与覆盖层状态正确；退出后点击「重新打开 Shell」验证同一 SSH 会话复用。
7. 点击「关闭 Shell」，确认 SSH 连接仍保持；再断开 SSH，确认 Shell 通道与状态清理。
8. 断网/恢复、服务器主动断开、客户端主动断开，观察状态与资源释放。
9. 凭据库不可用时确认连接失败且无明文回退。
10. 用 Windows OpenSSH Agent 与未启动 Agent 两种情况验证提示。
11. 对同一服务器连续打开两个标签，分别在各自终端执行 `cd /tmp` 与 `pwd`，确认两个 SSH transport、Shell 与工作目录互不影响。
12. 在多个标签间切换，确认输出/回放保留、非活动标签不触发 openShell 或 disconnect；观察状态栏会话/Shell 计数。
13. 连接中、主机密钥确认中、重连中分别关闭标签，确认迟到连接结果被丢弃且其他标签保持连接。
14. 关闭活动/非活动标签与最后一个标签，确认活动标签切换规则、空状态与其他会话不受影响。
15. 被动断开后确认历史只读、输入禁用；手动重连确认提示创建新 SSH 与新 Shell，旧远程进程不会恢复。
16. 退出应用时保留一个无响应会话，确认退出不被阻塞，所有 Client/PTY 被释放。
17. 连接真实 OpenSSH 服务端并打开 SFTP 页面：确认复用既有 SSH 会话、显示服务器 `realpath('.')` 主目录；不得再次要求认证或主机密钥确认。
18. 浏览目录：验证面包屑、返回上一级、双击目录与输入绝对/相对路径；准备含空格、中文、Unicode、特殊字符的测试目录，确认名称原样展示。
19. 元数据：确认文件/目录/符号链接类型、文件大小、修改时间与 POSIX 权限；对服务器不返回属性的条目确认显示未知而不是 0。
20. 错误状态：在隔离测试环境验证不存在目录、权限不足与断网；确认错误提示、指引、重试与断开状态，且不会显示其他会话的数据。
21. 在专为本测试创建的目录中执行新建目录与重命名；确认目标已存在时被拒绝、不会覆盖，重命名文件/目录后通过远程 Shell `ls` 核实。
22. 仅删除专门创建的测试文件，确认删除成功且刷新后消失；不要删除真实业务文件。
23. 仅删除专门创建的空目录，确认成功；再创建包含文件的测试目录，确认删除被拒绝且内容保持不变。
24. 在一次性测试服务器上尝试删除 `/`、`/etc`、`/home` 与顶层目录，确认被主进程拒绝；该测试不应在生产服务器执行。
25. 并发/重复操作：快速重复新建或重命名，确认界面禁用与主进程 `conflict` 提示，不产生重复条目。
26. 多标签隔离：同一服务器打开两个标签，分别浏览不同目录并执行测试操作，确认 SFTP 通道、路径与操作互不影响；关闭其中一个标签不影响另一个。
27. 生命周期与迟到响应：快速切换目录/会话、关闭标签、断开 SSH 与退出应用，确认旧响应不覆盖新路径、SFTP 通道被释放，重连后从主目录重新加载。
28. 结果未知路径：在可控网络中断下触发变更操作，确认显示 `outcome-unknown`、自动刷新且不自动重试（若无法稳定复现，记录为未验证）。
29. 在隔离测试服务器的一次性目录中准备小文件、大文件、空文件、含空格/中文/Unicode 名称的文件，使用原生多选对话框一次上传多个，确认每个文件是独立任务、真实字节进度、最终文件大小与远程 `ls`/`sha256sum` 一致。
30. 上传同名文件触发冲突：分别验证「跳过」「重命名」（非法名称被拒、合法名称创建新文件）与「覆盖」（原文件被替换、目录中不残留 `.termforge-part-*`/`.termforge-backup-*`）。
31. 下载多个远程文件到专门的本地测试目录，确认只包含文件、不包含目录/符号链接；校验下载后的大小与校验和，并验证同名本地冲突的三种处理。
32. 总大小未知/空文件场景：确认界面显示「大小未知」或不确定进度，不伪造 100%、NaN 或 Infinity；完成后才显示 100%。
33. 取消：分别在排队中、传输中、待冲突与正在提交时触发取消，确认排队/待冲突立即取消、传输中进入 `正在取消` 后终止、提交阶段被拒绝且提示稍后查看结果；重复点击取消无副作用。
34. 失败与重试：使用不存在/无权限的测试路径制造失败，确认固定错误与指引；修复后点击重试，确认尝试次数增加、重新校验源/目标并产生正确结果；不声称断点续传。
35. 队列并发：同时加入超过 3 个上传/下载任务，确认全局最多 2 个、同一会话最多 1 个运行，其余排队；取消/失败后队列继续推进，不出现永久占位。
36. 会话生命周期：在传输中关闭标签、断开 SSH、服务器主动断线，确认该会话任务停止并标记连接丢失；其他会话任务不受影响；提交阶段任务不显示为已完成直到主进程确认。
37. 应用退出：在传输中关闭窗口/退出应用，确认退出不被卡住、任务停止、本任务创建的临时文件在 10 秒清理上限内被尽力删除；记录强杀场景可能残留的 `.termforge-*` 文件。
38. 上传完成后保持目标目录打开，确认列表在约 200 ms 防抖后自动刷新，完成后文件出现且不把临时文件当作最终文件；`skipped` 任务不触发刷新。
39. 传输抽屉：确认关闭面板不中断传输、重新打开/同步后状态与主进程一致、清空已结束只移除终态任务、状态栏数量与冲突数正确。
40. 原生对话框边界：取消文件/目录选择不创建任务；尝试选择 51 个文件确认被拒绝；尝试上传目录或下载目录/符号链接确认不会创建任务。
41. 安全边界：确认渲染进程无法读取文件内容、本地路径不能通过 IPC 提交、伪造 `transferId`/`sessionId` 或跨会话操作被拒绝；失败时不显示原始 fs/SFTP 错误、堆栈或临时文件名。
42. 设置持久化：逐项修改主题（深/浅/系统）、字体/字号/光标/闪烁/回滚、并发与日志级别，重启后确认全部保留；切换系统深浅色，确认 `system` 跟随且不覆盖为固定主题。
43. 设置失败：模拟不可写目录或写入失败，确认界面显示失败并把仍未被后续修改的字段恢复到保存前的值，不显示保存成功。
44. 设置损坏：手工写入无效字段/未知版本后启动，确认逐字段回退、显示警告、原文件未被读取流程覆盖；显式保存后才写新文件。
45. 日志：确认日志目录存在、文件大小轮转（可临时调小上限）、级别过滤生效；导出时确认原生保存对话框、文件头与内容不含密码/私钥/终端输出/文件内容；在不可写目录下确认写入失败计数增加且应用不崩溃。
46. 主机密钥删除：设置页列表展示已信任端点；删除时出现确认弹窗；取消不删除；确认后当前 SSH 会话不断开，重新连接该端点必须再次确认。
47. 传输中断：在传输中正常退出或强制结束，重启后确认任务显示「已中断 / 结果未知」、无重试按钮、无自动排队；核对目标端后手动重新发起。
48. 并发变更：传输运行中把全局并发从 4 降到 1、每会话从 2 降到 1，确认运行中任务不被终止、新任务按新上限调度；非法值被拒绝。
49. 退出顺序：在传输、SFTP 与 Shell 活动时退出，确认按传输 → SFTP → SSH → 日志清理，单步卡住不超过约 4 秒且应用最终退出。
50. 删除连接：删除带密码/私钥/口令的连接，确认凭据条目被尽力删除；主机密钥记录仍保留，其他连接与会话不受影响。
51. 双栏本地浏览（P1-01）：验证本地面板主目录/磁盘入口、面包屑、路径输入（相对路径与 `..` 解析）、返回上一级、刷新、排序与隐藏文件开关；确认条目元数据与系统资源管理器一致，缺失元数据显示未知而不是 0；确认只读取元数据、不读取文件内容。
52. 拖拽上传（P1-01）：把普通文件与含子目录的文件夹分别拖到远程面板，确认顶层文件直落目标目录、文件夹保留自身名称与相对结构（逐文件任务）；符号链接被跳过并提示；超出深度/数量上限时报告截断；拖拽期间面板落点高亮，上传完成后远程列表自动刷新。
53. 拖拽下载与边界（P1-01）：把选中的远程文件（含多选）拖入左侧本地面板当前目录，确认目标正确；尝试拖到磁盘根目录、跨会话拖拽载荷与含设备前缀的路径，确认被拒绝并给出提示；确认拖拽只传路径载荷、文件内容仍由主进程处理。
54. 单跳链路（P1-02，需两台真实服务器，**未执行**）：为连接配置 1 个跳板后连接，确认按「跳板 → 目标」顺序分别弹出主机密钥确认；工作台显示连接路径 `本机 → 跳板 → 目标`，终端与 SFTP 正常；断开后确认两端 Client 都被释放、无孤立连接。
55. 多跳与失败归属（P1-02，需三台真实服务器，**未执行**）：配置两跳链路后连接，确认逐跳认证；制造跳板失败（错误凭据、服务器禁止 TCP 转发或中途断开），确认文案带「经跳板 N（名称）失败」、跳板凭据补录归属正确、已建立的跳板被清理；修复后重连成功。
56. 跳板信任隔离（P1-02，**未执行**）：更换跳板主机密钥，确认连接被 `host-key-changed` 阻止且归属该跳板、目标的信任记录不受影响；删除跳板信任记录后仅需重新确认跳板；确认跳板凭据补录只影响跳板自身的连接记录。
57. 本地 TCP 转发（P1-03，需受控 SSH 测试服务，**未执行**）：新建本地规则并选择该连接已连接的会话启动，确认返回实际绑定端口、本机双向字节转发、目标不可达时的固定错误归属、停止后端口释放；重启应用后规则保持 `stopped` 且不自动监听。
58. 远程 TCP 转发（P1-03，需受控 SSH 测试服务，**未执行**）：默认在服务器 `127.0.0.1` 绑定并验证远程访问；非回环绑定必须显式确认；服务器拒绝（`AllowTcpForwarding no`、端口占用）时保持错误且不自动放宽；停止后远程端口被 `unforwardIn` 释放。
59. 动态 SOCKS5（P1-03，**未执行**）：仅经 `127.0.0.1` 提供 no-auth CONNECT，使用受控客户端验证 IPv4、域名与 IPv6 目标、并发上限、协议错误响应与停止后无残留监听；确认不支持 UDP ASSOCIATE/BIND/SOCKS4，且不记录、不读取应用层负载。
60. 会话归属与断线（P1-03，**未执行**）：仅允许规则所属连接的原会话启动；其他连接或未连接会话被拒绝；SSH 断开时规则停止且不静默迁移到新会话；重连后不自动重启原规则。
61. 暴露确认与清理失败（P1-03，**未执行**）：本地非回环绑定的风险提示与确认复选框、取消后保持 `stopped`；绑定/解绑失败显示主进程固定错误而非运行中；`cleanupPending` 期间编辑、删除与重启均被阻断，重试成功后才解除。
62. 连接级联删除（P1-03，**未执行**）：删除含运行中规则的连接时先显示规则/运行数量；取消不改变任何规则；确认后按停止并删除规则 → 删除连接执行；任一步失败时保留连接并显示可重试错误，不得把部分成功报告为完成。
63. 端口转发页与编辑器（P1-03，Electron 实窗，**未执行**）：菜单导航、规则列表、启动/停止/编辑/删除操作、状态与失败文案、启动会话选择、暴露确认、空状态与页脚安全说明。
64. 快速命令入口与命令库（P1-04，受控实窗已执行部分）：工具栏「快速命令」、命令面板动作与 `Ctrl/Cmd+Shift+K` 打开右侧抽屉；内置命令只读、仅可收藏/复制，自定义命令可创建/编辑/删除；分类与搜索过滤正常。受控验收覆盖工具栏/快捷键、库渲染与自定义命令创建，未逐项覆盖命令面板、全部分类与搜索组合。
65. 插入与发送（P1-04，受控实窗已执行）：插入只写入当前输入行、不追加回车、不自动执行；发送前展示参数与最终预览，必须显式选择已连接且 Shell `open` 的目标；目标在窗口打开后失效时不得自动切换或重发；双会话时必须只发送到所选会话。受控验收已用真实 Shell 验证插入、发送、双会话选择与过期目标拒绝。
66. 命令历史（P1-04，受控实窗已执行部分）：新安装默认关闭；设置开启后发送确认框「记录本次发送」默认勾选且可取消；历史只记录显式成功发送的渲染后正文，不记录原始终端输入、输出或退出码；支持搜索、复制、插入、确认重发、单条删除与清空确认。受控验收覆盖默认关闭、开启后记录、渲染后正文、删除与清空；未验证重启后保留、搜索/复制/重发与损坏恢复的实窗行为。
67. 历史隐私与设置（P1-04，受控实窗已执行）：设置页显示历史开关、明文披露与清空按钮；关闭后发送不新增历史；应用日志不出现命令正文/参数/历史内容；设置文件为 v3、历史文件为 v1。受控验收已检查这些文件与日志。
68. 快速命令未执行场景（P1-04，**未执行**）：真实 OpenSSH 服务端、生产网络延迟/断线、安装包内行为、重启后历史保留、原生菜单/系统级快捷键冲突、输入法组合输入、屏幕阅读器与键盘焦点、超长命令/参数、高频终端输出、多窗口并发发送、历史文件 ACL 与跨用户隔离。
69. 快速命令安全边界确认（P1-04，受控实窗已执行部分）：内置命令只读且不含变更类；自定义命令必须预览并显式确认；模板不做 Shell 转义承诺；不因启动、连接建立或重连自动执行；不在后台标签切换时改变目标。受控验收覆盖了内置只读标识、预览与历史默认勾选、过期目标不切换；未覆盖所有内置命令在真实非 Linux Shell 下的表现。
70. P1-04 文档与状态（已完成）：README、ARCHITECTURE、DATA_MODEL、SECURITY、TEST_PLAN、UI_SPEC 与本文件记录快速命令边界、存储、日志分离与验收范围；P1-03 的真实 SSH 转发验收仍保持**未执行**。
71. 两窗格分屏（P1-05，受控实窗已执行部分）：左右/上下分屏、方向切换与退出；两个窗格同时显示真实终端；空窗格下拉只列出其他已打开会话；关闭标签只解绑对应窗格；分隔条指针拖动、方向键、Home/End 与双击 50% 生效。受控验收覆盖启停、方向/比例与空窗格绑定，未逐项验证所有键盘组合与高 DPI。
72. 分屏隔离（P1-05，受控实窗已执行部分）：一个窗格断开/重连/关闭 Shell 不影响另一窗格的 SSH 状态、终端输出与输入；分屏操作不新增 SSH 连接或 PTY；切换标签不产生跨会话输出串流。
73. 取消连接（P1-05，受控实窗已执行）：连接中点击「取消连接」保留标签、停止进行中尝试、不关闭另一窗格；取消后回到可重连状态；迟到成功被主进程断开清理；已连接会话的断开不被误当作取消。
74. 自动重连默认关闭与触发（P1-05，受控实窗已执行部分）：新安装/迁移后默认关闭；关闭时意外断线停留终态；开启后仅网络类错误显示倒计时；服务端主动结束通道后按 1/2/4/8/15 秒退避、最多 5 次；耗尽显示「自动重连已停止」。受控验收覆盖一次成功自动重连、取消与完整 5 次耗尽，未在真实网络条件下逐一触发五类错误码。
75. 自动重连清理与安全（P1-05，自动化 + 受控实窗部分执行）：认证失败、主机密钥变化、主动断开、用户取消、关闭标签、退出应用与关闭设置开关均停止重试；每次重试重新执行主机密钥与认证；未知/变化的主机密钥不自动信任；断线前输入与快速命令不重放；不声称旧 Shell 已恢复。受控实窗覆盖用户取消与关闭设置开关；错误码白名单、主动断开与相邻窗格隔离由自动化测试覆盖，未在受控实窗逐项执行。
76. 设置 v4（P1-05，受控实窗已执行）：设置页自动重连默认关闭、开启后写入 v4；v3/v2/v1 读取迁移并保留既有偏好；关闭开关立即清理等待计时器；写入失败显示错误并回滚。
77. P1-05 未执行场景（**未执行**）：真实 OpenSSH Server、真实网络抖动/丢包/长时间断网、五类错误码的真实网络条件、系统休眠/唤醒、代理/VPN 切换、NSIS 打包安装包、多窗口并发、屏幕阅读器与输入法下的分屏交互。
78. P1-05 文档与状态（已完成）：README、ARCHITECTURE、DATA_MODEL、SECURITY、TEST_PLAN、UI_SPEC 与本文件记录分屏、取消连接、自动重连边界、设置 v4 与验收范围；P1-05 仅在受控夹具环境中通过，不能标记为真实 OpenSSH/网络/安装包验收完成。
