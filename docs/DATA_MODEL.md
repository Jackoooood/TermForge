# TermForge 数据模型

本文描述 TASK-008 至 P1-05 的类型、校验规则、持久化格式与状态生命周期。连接配置、加密凭据、主机密钥信任、应用设置与诊断日志已持久化；SSH 会话与 PTY 由主进程维护；工作区标签与 SSH 会话分离，标签 ID 作为 `clientId` 在重连后保持不变；终端输出只存在于 xterm 与有上限的重放缓冲；SFTP 页面读取真实远程目录元数据，SFTP 通道、文件操作与文件传输由主进程持有；传输任务以主进程为唯一权威，渲染端只保存按 `revision` 合并的只读投影，未完成任务只有用于显示 `interrupted` 的有界快照。壁纸图片由主进程校验、缩放和重编码，渲染端只保存带展示元数据的 JPEG data URL。P1-05 增加只存在于渲染运行态的双窗格布局、按 `clientId` 定向的连接取消确认，以及同样不持久化的自动重连进度；设置 v4 新增默认关闭的 `autoReconnectEnabled`，v5 引入三套经典主题与渐变强度，v6 引入 13 套 DBX 色板、`dbxThemeMode`、界面字体与界面字号。

## 1. 共享类型

类型定义位于 `src/shared/types/`，主进程、preload 与渲染进程共享。

### ConnectionProfile / ConnectionInput

```ts
type AuthMethod = 'password' | 'privateKey' | 'sshAgent'

interface ConnectionProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  groupId: string
  tags: string[]
  credentialRef?: string
  /** 有序跳板引用（最近的跳在前，1–4 项）；每项是另一已保存连接的 ID，不复制其凭据或 Socket。 */
  jumpConnectionIds: string[]
  favorite: boolean
  createdAt: string
  updatedAt: string
}

interface ConnectionInput {
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  groupId: string
  tags: string[]
  credentialRef?: string
  /** 缺省为 `[]`（`z.default`），旧 IPC 载荷不携带该字段时保持直连语义。 */
  jumpConnectionIds: string[]
}

interface ConnectionCatalog {
  connections: ConnectionProfile[]
  groups: ConnectionGroup[]
}
```

**关键不变量**

- `credentialRef` 是非机密指针：私钥文件路径、`file://` URL、`~` 路径或凭据库引用。
- `ConnectionProfile` 与 `ConnectionInput` 中**没有**密码、私钥内容或口令短语字段；运行时 schema 是 `z.strictObject`，任何未知字段（包括 `password`、`privateKey`、`passphrase`）都会被拒绝，无法被序列化到磁盘。
- `credentialRef` 拒绝控制字符和 PEM 私钥标记；它不保存凭据内容。
- `id` 由主进程生成：`conn-<UUID>`；`favorite`、`createdAt`、`updatedAt` 由仓库维护，不接受渲染进程直接写入。
- `ConnectionCatalog` 校验连接 ID 唯一、分组 ID 唯一，且每个 `connection.groupId` 必须指向已存在的分组。
- `jumpConnectionIds` 有序（最近的跳在前）、最多 `MAX_JUMP_HOPS = 4` 项、不得重复、不得自引用、必须指向目录内已存在的连接，且整个目录不得形成跳板环（`connectionCatalogSchema.superRefine` 三色 DFS 检测）。每跳的连接配置、凭据引用与主机密钥信任记录都取自被引用连接自身；跳板与目标不共享信任记录。删除连接时，仓库在同一次原子写入中剥离其他连接对它的引用。

### ConnectionGroup

```ts
interface ConnectionGroup {
  id: string
  name: string
  tone: 'neutral' | 'production' | 'testing' | 'local'
  sortOrder: number
}
```

- 首次启动由共享种子 `src/shared/fixtures/connectionSeed.ts` 写入 3 个分组：生产环境、测试环境、本地开发。
- 当前不支持分组的新增/重命名/删除，只有连接分组归属与搜索。
- 收藏不是分组，而是根据 `ConnectionProfile.favorite` 动态派生的视图。

### SshSessionSnapshot / SshSessionStatus

```ts
type SshSessionStatus =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'awaiting-host-key'
  | 'connected'
  | 'reconnecting'
  | 'closing'
  | 'disconnected'
  | 'error'

interface SshSessionSnapshot {
  clientId: string
  sessionId: string
  connectionId: string
  connectionName: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  status: SshSessionStatus
  /** 有序跳板快照（最近的跳在前）；直连为 `[]`。 */
  jumps: SshJumpHop[]
  /** 当前正在连接/认证的跳板；目标阶段与直连为 `null`。 */
  activeHop: SshJumpHop | null
  createdAt: string
  connectedAt: string | null
  hostKey: PresentedHostKey | null
  error: SshFailure | null
}

interface SshJumpHop {
  /** 1 起数，与 `jumps` 顺序一致（1 = 最近本机的一跳）。 */
  index: number
  connectionId: string
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
}
```

- **主进程快照是唯一权威**；渲染进程 `SessionInfo` 是它的显示镜像。
- 主进程会话 ID 由主进程生成：`ssh-<UUID>`；渲染进程不能指定或伪造。
- `clientId` 是渲染工作区标签的稳定 ID（`sshtab-<UUID>`）。一个标签重连时 `clientId` 不变、`sessionId` 更换；不同标签即使连接同一配置也各自拥有独立会话。
- 相同 `clientId` 的重复连接请求返回 `reused: true`；不会被其他标签复用。
- `connectedAt` 只在 SSH 握手完成后设置；`connected` 只表示传输层与认证完成，不代表已打开交互式 Shell。
- `reconnecting` 用于渲染端发起的手动重连，或自动重连的某次在途尝试；两种路径都创建新的 `sessionId`。自动重连默认关闭、最多 5 次且只对固定网络类错误码生效；其进度只存在于渲染端。
- `idle` 是类型中的初始状态，`SshService` 创建记录时直接进入 `connecting`。
- `jumps` 只包含非敏感公开信息（跳板自己的连接元数据）；跳板凭据、Socket 与 `forwardOut` 通道全部留在主进程，绝不进入快照。跳板仅按依赖顺序在快照中展示连接阶段。
- `snapshot.hostKey` 只记录**最终目标**的主机密钥；跳板密钥仅存在于各自的 `known-hosts.json` 记录与挑战弹窗中，不会被写成目标的身份。
- 渲染端 `SessionInfo` 额外保存稳定标签 `id`、`generation`、`hasTerminal`、`failure`、`jumps`、`activeHop` 等可序列化字段；不得包含 Client、Channel、xterm 或凭据。

### SessionAutoReconnect（运行态）

```ts
interface SessionAutoReconnect {
  /** 当前或即将执行的自动尝试序号，从 1 开始。 */
  attempt: number
  maxAttempts: number // 固定 5
  /** 下次自动尝试的 ISO 时间；在途或耗尽后为 null。 */
  nextRetryAt: string | null
  /** 有界序列在未恢复连接的情况下结束。 */
  exhausted: boolean
}
```

- `SessionInfo.autoReconnect` 为 `null` 表示没有待执行或进行中的自动重试；该对象只存在于渲染进程内存，不进入 IPC 快照、设置文件或传输日志。
- `attempt` 只在真正调度下一次重试时递增；`maxAttempts` 固定为 5。第 5 次尝试失败后写为 `{ attempt: 5, maxAttempts: 5, nextRetryAt: null, exhausted: true }`，不再调度。
- 退避延迟固定为 1、2、4、8、15 秒，由 `sessionStore` 的定时器执行；每次尝试都通过既有 `connect(connectionId, clientId)` 创建新会话，不保存旧 Client、Channel 或定时器。
- 设置关闭、用户取消、主动断开、关闭标签或应用退出会清除定时器并把该字段置 `null`；清除后迟到的失败不会重新排入重试。
- 只有 `network-error`、`connection-timeout`、`dns-failed`、`connection-refused`、`remote-closed` 会生成该状态；判断依据是固定 `SshFailure.code`，不是错误消息。

### SshConnectCancelAck

```ts
interface SshConnectCancelAck {
  cancelled: boolean
  /** 取消成功时为终结后的快照；未找到尝试时为 null；已完成连接返回当前快照。 */
  session: SshSessionSnapshot | null
}
```

- `cancelConnect(clientId)` 只按 `clientId` 查找在途记录；`connecting`、`authenticating`、`awaiting-host-key` 可被取消，`connected` 与终态返回 `cancelled: false`。
- 取消先把记录终结为 `disconnected(cancelled)` 并推送快照，再销毁已创建的临时 Client；因此重复取消幂等，迟到的握手成功不会把标签重新标记为已连接。
- 该操作不关闭渲染标签、不影响其他标签或分屏窗格；标签移除仍由渲染端关闭流程单独执行。

### TerminalSplitLayout（运行态）

```ts
type SplitPaneId = 'pane-a' | 'pane-b'
type SplitDirection = 'row' | 'column'

interface SplitPane {
  id: SplitPaneId
  tabId: string | null
}

interface TerminalSplitLayout {
  enabled: boolean
  direction: SplitDirection
  ratio: number // 0.2–0.8，默认 0.5
  focusedPaneId: SplitPaneId
  panes: Record<SplitPaneId, SplitPane>
}
```

- 分屏固定两个窗格；`row` 为左右排列，`column` 为上下排列。`ratio` 非有限值回退 0.5，越界夹取到 20%–80%。
- `panes[pane].tabId` 引用稳定标签 ID，不拥有 SSH 会话、PTY、xterm 或输出缓冲；一个标签最多绑定一个窗格。
- 该布局只存在于 `workspaceStore`，不进入 `settings.json`、IPC 或任何持久化文件；应用重启、关闭标签或两个窗格都为空时回到关闭状态。
- 布局操作不调用 `ssh.connect`/`ssh.disconnect`；解绑窗格只隐藏终端，不结束会话。

### SshFailure

```ts
type SshFailureCode =
  | 'configuration-invalid'
  | 'credential-required'
  | 'credential-invalid'
  | 'credential-unavailable'
  | 'host-key-changed'
  | 'host-key-rejected'
  | 'host-key-timeout'
  | 'host-key-storage-failed'
  | 'host-key-unsupported'
  | 'host-key-verification-failed'
  | 'dns-failed'
  | 'connection-refused'
  | 'connection-timeout'
  | 'authentication-failed'
  | 'network-error'
  | 'remote-closed'
  | 'agent-unavailable'
  | 'private-key-unreadable'
  | 'private-key-invalid'
  | 'cancelled'
  | 'internal'

interface SshFailure {
  code: SshFailureCode
  message: string
  credentialKind?: 'password' | 'privateKey' | 'passphrase'
  /** 失败发生在某跳板时带上该跳信息（1 起数）；缺省表示目标连接的失败。 */
  hop?: SshJumpHop
}
```

- `message` 是固定中文说明，不包含原始 `ssh2` 错误、主机细节或凭据。
- `credentialKind` 只在可补录凭据时出现，用于打开密码/私钥/口令弹窗。
- `hop` 用于把失败归属到具体跳板：认证失败/主机密钥变化/`forwardOut` 拨号失败/跳板断线都会带上对应跳；`forwardOut` 失败归属**正在拨往的下一端点**（下一跳或目标）。渲染层据此生成「经跳板 N（name）失败」文案与跳板凭据补录。

### HostKeyChallenge

```ts
interface HostKeyChallenge {
  requestId: string
  sessionId: string
  connectionId: string
  connectionName: string
  host: string
  port: number
  algorithm: HostKeyAlgorithm
  fingerprint: string
  expiresAt: string
  /** 该挑战属于某跳板时带上其信息；缺省表示最终目标。 */
  hop?: SshJumpHop
}
```

- 首次遇到未知主机密钥时由主进程生成，`requestId` 格式为 `hk-<UUID>`。
- `expiresAt` 为当前时间 + 30 秒；超时后请求失效，连接被取消。
- 渲染进程只能通过 `ssh:respond-host-key` 提交 `{ requestId, accepted }`；主进程重新查找请求并校验。
- 跳板与目标依次握手，因此同一时刻最多只有一个待确认挑战；每个端点的信任记录按该端点 host/port 独立存储，信任跳板不会自动信任目标。

### TerminalShellSnapshot / TerminalSize

```ts
type TerminalShellStatus = 'idle' | 'opening' | 'open' | 'closing' | 'closed' | 'exited' | 'error'

type TerminalExitReason = 'remote-exit' | 'remote-close' | 'local-close' | 'ssh-closed' | 'error'

type TerminalFailureCode =
  | 'bridge-unavailable'
  | 'session-unavailable'
  | 'shell-open-failed'
  | 'shell-error'
  | 'ssh-disconnected'

interface TerminalSize {
  cols: number
  rows: number
}

interface TerminalShellSnapshot {
  sessionId: string
  status: TerminalShellStatus
  size: TerminalSize
  failure: { code: TerminalFailureCode; message: string } | null
  exit: { code: number | null; signal: string | null; reason: TerminalExitReason } | null
}
```

- `sessionId` 是既有 SSH 会话 ID；Shell 是它的从属资源，不能单独创建 SSH 连接。
- `SSH connected` 与 `Shell open` 是两个独立状态；快照不会携带终端输出。
- 尺寸在 IPC 中为 strict `{ cols, rows }`：整数、cols 1–2,000、rows 1–1,000；默认 80×24。
- 退出事件 `TerminalExitEvent` 为 `{ sessionId, code, signal, reason }`；状态事件就是完整 `TerminalShellSnapshot`。
- 终端输出事件为 `TerminalOutputEvent { sessionId, data }`，`data` 是主进程流式解码后的 UTF-8 文本；不含环境变量、凭据、Client/Channel 或完整会话环境。
- 每次终端写入最多 65,536 字符；渲染端按 32 KiB 分片并串行发送。

### RemoteFileEntry / SFTP 结果类型

```ts
type RemoteFileKind = 'directory' | 'file' | 'symlink'

interface RemoteFileEntry {
  id: string
  name: string
  /** 由所列目录与名称构造的规范化绝对 POSIX 路径。 */
  path: string
  kind: RemoteFileKind
  sizeBytes: number | null
  modifiedAt: string | null
  /** POSIX 模式串，如 `-rw-r--r--`；服务器未提供时为 null。 */
  permissions: string | null
}

interface RemoteDirectoryListing {
  sessionId: string
  path: string
  entries: RemoteFileEntry[]
  loadedAt: string
}

interface SftpOpenResult {
  sessionId: string
  /** 服务器 `realpath('.')` 返回的绝对主目录。 */
  homePath: string
}

interface SftpMutationAck {
  sessionId: string
  path: string
  operation: 'mkdir' | 'rename' | 'delete-file' | 'remove-directory'
}

interface SftpCloseAck {
  sessionId: string
  closed: boolean
}
```

- `id` 当前等于规范化 `path`，只用于本地选择和 React key；不跨会话保证唯一。
- `kind` 依据 `lstat`/目录条目属性判定，符号链接标记为 `symlink` 且不跟随；只有目录可通过双击进入。
- `sizeBytes` 仅对普通文件读取；目录、符号链接及服务器缺失/非法属性为 `null`。`modifiedAt` 为 ISO 字符串，服务器缺失、非正数或超出日期范围时为 `null`。`permissions` 无法从 mode 生成时为 `null`。UI 对 `null` 显示「未知」/`—`，不得用 0 或当前时间伪造。
- 名称支持空格、Unicode 与常见特殊字符；路径始终是绝对 POSIX 形式，不使用 Windows `path.join`。规范化会折叠 `.`、解析 `..` 与重复斜杠，服务端仍是路径有效性与权限的最终权威。
- `RemoteDirectoryListing.sessionId` 和 `path` 必须与请求一致；渲染端发现不匹配会丢弃结果并按错误处理。
- 变更确认 `SftpMutationAck.path` 是目标路径；`mkdir` 返回新目录路径，`rename` 返回目标路径，删除返回被删路径。操作结果只表示主进程收到成功回调，不代表服务器已同步落盘。
- `SftpOpenResult.homePath` 必须是以 `/` 开头的规范路径；同一会话的并发打开共享一次 home 解析。

### 本地文件系统类型（P1-01）

```ts
type LocalFileKind = 'directory' | 'file' | 'symlink'

interface LocalFileEntry {
  id: string
  name: string
  /** 规范化后的本地绝对路径。 */
  path: string
  kind: LocalFileKind
  sizeBytes: number | null
  modifiedAt: string | null
  hidden: boolean
}

interface LocalDirectoryListing {
  path: string
  /** 已处于卷或共享根时为 null。 */
  parentPath: string | null
  entries: LocalFileEntry[]
  /** 目录条目超过安全上限时为 true。 */
  truncated: boolean
  loadedAt: string
}

interface LocalRootEntry {
  name: string
  path: string
  kind: 'home' | 'drive' | 'root'
}

interface LocalRootsResult {
  home: string
  roots: LocalRootEntry[]
}

const MAX_LOCAL_DIRECTORY_ENTRIES = 5000
```

- 只有元数据跨 IPC：`localFs.roots`/`localFs.list` 返回名称、类型、大小、mtime 与隐藏标记，不读取文件内容，文件内容只由主进程传输管线读取。
- `id` 当前等于规范化 `path`，只用于选择与 React key；`kind` 依据 `lstat` 判定，符号链接标记为 `symlink` 且不跟随、不可双击进入。
- `sizeBytes` 仅对普通文件读取，目录、符号链接或属性不可用时为 `null`；`modifiedAt` 为 ISO 字符串，缺失或不可用时为 `null`，不以 0 或当前时间伪造。
- `hidden` 使用点前缀约定（macOS/Linux 语义）；Windows 属性隐藏不检测。
- 单目录条目上限 `MAX_LOCAL_DIRECTORY_ENTRIES = 5000`，超出时 `truncated: true`，UI 显示截断提示而不静默丢弃。
- 路径始终是本地绝对路径；相对路径、NUL/控制字符与 `\\.\`/`\\?\` 设备前缀在 schema 层被拒绝（1–4,096 字符）。列举失败归一为固定错误码，不返回原始 `fs` 错误或完整路径。

### 端口转发类型（P1-03）

```ts
type PortForwardType = 'local' | 'remote' | 'dynamic'
type PortForwardStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
type PortForwardStopReason = 'user' | 'session-ended' | 'connection-removed' | 'app-quit' | null

type PortForwardFailureCode =
  | 'session-ended'
  | 'connection-missing'
  | 'bind-failed'
  | 'remote-bind-failed'
  | 'remote-port-mismatch'
  | 'unbind-failed'
  | 'channel-open-failed'
  | 'target-unreachable'
  | 'handshake-timeout'
  | 'limit-exceeded'
  | 'protocol-error'
  | 'cleanup-failed'
  | 'internal'

interface LocalForwardRule {
  id: string // pf-<UUID>
  type: 'local'
  name: string
  connectionId: string
  bindAddress: string
  bindPort: number
  targetHost: string
  targetPort: number
  createdAt: string
  updatedAt: string
}

interface RemoteForwardRule extends Omit<LocalForwardRule, 'type'> {
  type: 'remote'
}

interface DynamicForwardRule {
  id: string
  type: 'dynamic'
  name: string
  connectionId: string
  /** 首版固定为 127.0.0.1，不支持非回环监听。 */
  bindAddress: '127.0.0.1'
  bindPort: number
  createdAt: string
  updatedAt: string
}

type PortForwardRule = LocalForwardRule | RemoteForwardRule | DynamicForwardRule

interface PortForwardRuntime {
  ruleId: string
  status: PortForwardStatus
  /** 启动时绑定的 SSH 会话；停止后为 null。 */
  sessionId: string | null
  boundAddress: string | null
  boundPort: number | null
  activeConnections: number
  startedAt: string | null
  lastStopReason: PortForwardStopReason
  failure: { code: PortForwardFailureCode; message: string } | null
  /** 停止/解绑/清理尚未确认完成；为 true 时禁止删除规则或连接。 */
  cleanupPending: boolean
}

interface PortForwardItem {
  rule: PortForwardRule
  runtime: PortForwardRuntime
}

interface PortForwardSnapshot {
  revision: number
  items: PortForwardItem[]
}

interface PortForwardUpdateEvent {
  snapshot: PortForwardSnapshot
}

interface StartPortForwardInput {
  ruleId: string
  sessionId: string
  /** 非回环本地/远程监听必须为 true，否则启动被拒绝。 */
  confirmExposure?: boolean
}

interface ConnectionRemovalImpact {
  connectionId: string
  portForwardRuleCount: number
  runningPortForwardCount: number
}

interface ConnectionRemovalOptions {
  cascadePortForwards?: boolean
}
```

- 规则只保存展示与连接信息，不包含密码、私钥、口令或凭据引用；`dynamic` 没有目标主机，监听地址由 schema 固定为 `127.0.0.1`。
- `PortForwardRuntime` 与监听器、Socket/Channel、连接计数只存在于主进程内存，不持久化。`status === 'running'` 只在监听器/远程绑定真实建立后由主进程写入，渲染进程不能推断或覆盖。
- `revision` 随规则/运行时/连接数/失败/清理状态变化单调递增；渲染端只接受更大 `revision` 的快照。`cleanupPending: true` 表示停止/解绑失败或清理未完成，删除规则/连接必须被阻止。
- 非回环 `local`/`remote` 规则在启动时要求 `confirmExposure: true`；`dynamic` 规则没有暴露确认入口，因为监听地址固定为回环。

### 快速命令与命令历史类型（P1-04）

```ts
type QuickCommandSource = 'built-in' | 'custom'

interface QuickCommandParameter {
  name: string
  defaultValue: string
}

interface QuickCommandDraft {
  name: string
  category: string
  description: string
  body: string
  parameters: QuickCommandParameter[]
}

interface QuickCommand extends QuickCommandDraft {
  id: string // builtin-<slug> 或 qc-<UUID>
  source: QuickCommandSource
  favorite: boolean
  editable: boolean
  createdAt: string | null
  updatedAt: string | null
}

interface PersistedCustomQuickCommand extends QuickCommandDraft {
  id: string // qc-<UUID>
  favorite: boolean
  createdAt: string
  updatedAt: string
}

interface QuickCommandStoreState {
  customCommands: PersistedCustomQuickCommand[]
  builtInFavoriteIds: string[]
}

interface QuickCommandSnapshot {
  commands: QuickCommand[]
}

interface QuickCommandExecuteBase {
  requestId: string
  tabId: string // sshtab-<UUID>
  sessionId: string // ssh-<UUID>
  recordHistory: boolean
}

type QuickCommandExecuteInput =
  | (QuickCommandExecuteBase & {
      kind: 'command'
      commandId: string
      parameterValues: Record<string, string>
    })
  | (QuickCommandExecuteBase & {
      kind: 'history'
      body: string
    })

interface QuickCommandExecuteAck {
  requestId: string
  body: string
  writtenAt: string
  historyRecorded: boolean
  historyWarning: string | null
}

interface CommandHistoryEntry {
  id: string // ch-<UUID>
  body: string
  sentAt: string
  tabId: string
  sessionId: string
  connectionId: string
  connectionName: string
  host: string
}

interface CommandHistoryAppendInput {
  body: string
  tabId: string
  sessionId: string
  connectionId: string
  connectionName: string
  host: string
}

interface CommandHistorySnapshot {
  entries: CommandHistoryEntry[]
}

interface CommandHistoryClearAck {
  cleared: number
}
```

- 内置命令是代码常量，不写入持久化文件；`PersistedCustomQuickCommand` 只保存用户创建的命令，`builtInFavoriteIds` 只保存内置命令 ID。
- `QuickCommand.parameters` 是正文中 `{{identifier}}` 的声明顺序投影，`defaultValue` 可为空；内置命令的参数默认值为空字符串，渲染端必须填写。
- `QuickCommandExecuteInput.kind === 'history'` 只用于用户确认后重发历史正文；两种输入都必须带显式 `tabId`/`sessionId`，主进程会重新校验绑定、连接状态与 Shell 状态。
- `QuickCommandExecuteAck.historyRecorded` 才表示历史已保存；`historyWarning` 说明历史关闭或保存失败，但不改变“命令已写入终端”的事实。
- `CommandHistoryEntry` 不包含参数表、终端输出、退出码、工作目录或任何凭据；`connectionName`/`host` 只是发送时的展示元数据，不与当前连接配置联动更新。

### TransferTask

```ts
type TransferDirection = 'upload' | 'download'
type TransferStatus =
  | 'queued'
  | 'preparing'
  | 'waitingForConflictResolution'
  | 'transferring'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'interrupted'

type TransferConflictPolicy = 'overwrite' | 'rename' | 'skip'
type TransferErrorCode =
  | OperationErrorCode
  | 'source-missing'
  | 'source-not-file'
  | 'source-changed'
  | 'destination-unavailable'
  | 'connection-lost'
  | 'target-changed'
  | 'cancelled'
  | 'cleanup-failed'

interface TransferConflictInfo {
  targetPath: string
  suggestedName: string
  suggestedPath: string
}

interface TransferTask {
  id: string
  sessionId: string
  direction: TransferDirection
  fileName: string
  sourcePath: string
  destinationPath: string
  status: TransferStatus
  totalBytes: number | null
  transferredBytes: number
  progress: number | null
  speedBytesPerSecond: number | null
  errorCode: TransferErrorCode | null
  errorMessage: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  attempt: number
  conflictPolicy: TransferConflictPolicy | null
  conflict: TransferConflictInfo | null
  revision: number
}
```

**关键语义**

- `id` 由主进程生成（`transfer-<UUID>`），重试时保持不变；`sessionId` 必须是创建任务时的 SSH 会话，任务不会跨会话漂移。
- 上传的 `sourcePath` 是主进程原生文件对话框返回的本地绝对路径，`destinationPath` 是新建的远程文件路径；下载的 `sourcePath` 是用户选中的远程文件路径，`destinationPath` 是原生目录对话框选择目录下的同名本地路径。选择重命名冲突策略后 `destinationPath` 固定为用户确认的新路径，不再静默改写。
- `status` 只由主进程迁移。`queued → preparing → transferring → completed` 是成功路径；目标已存在且尚未决策时进入 `waitingForConflictResolution`；`cancelling` 是运行中取消的过渡态；`skipped` 仅由用户选择跳过产生。
- `totalBytes === null` 表示源大小未知，此时 `progress` 必须为 `null`，已传输字节仍真实更新；传输中的 `progress` 最高 99，提交完成且总大小已知时才为 100。零字节文件完成时 `progress` 为 100（总大小已知），未知总大小的完成任务保持 `null`。
- `speedBytesPerSecond` 来自最近 3 秒采样；样本不足或非有限值为 `null`。
- `attempt` 从 1 开始，手动重试加 1；`revision` 是单调递增的投影版本，`transferStore` 只有收到更大 `revision` 才覆盖本地快照。
- `conflict` 只在 `waitingForConflictResolution` 时存在；包含已存在的目标、建议名称与完整建议路径。`conflictPolicy` 记录用户已选择的策略。
- `completed` 任务也可能带 `errorCode: 'cleanup-failed'` 与警告消息，表示目标备份清理失败，但文件本身已提交成功。
- `interrupted` 只由重启时的传输日志水合产生（或日志中原本已记录的 `interrupted` 再次水合），固定带 `outcome-unknown`，`speedBytesPerSecond` 为 `null`；它表示上次退出时结果未确认，不代表失败或完成，也不提供重试入口。
- 批量上限 `MAX_TRANSFER_BATCH = 50`；单次上传/下载请求超过上限被拒绝。
- 传输任务历史、队列、速度采样与完整路径运行时不写入持久化文件；只有未完成任务的有界展示快照写入 `transfer-journal.json`（最多 100 条），重启后只用于水合 `interrupted`，不恢复执行，也不存在断点续传/暂停恢复状态。

**显式路径上传的结果**

```ts
interface TransferUploadEnqueueAck {
  tasks: TransferTask[]
  /** 未跟随的选择源符号链接数量。 */
  skippedSymlinks: number
  /** 类型不受支持或无名称的条目数量。 */
  skippedUnsupported: number
  /** 目录树超过展开任务上限时为 true。 */
  truncated: boolean
  /** 源被投放到的规范化远程目录。 */
  remoteDirectory: string
}
```

- 拖拽或面板选中目录时按 BFS 展开为逐文件任务，`relativeDirectory` 保留源目录名（复制语义）；顶层文件直接落到目标目录。
- 被排除的条目只以计数上报（`skippedSymlinks`/`skippedUnsupported`），绝不静默传输；超过任务数上限默认 500 时 `truncated: true` 并停止展开。
- `tasks` 只包含成功入队的任务快照；后续进度以各自的 `transfer:update` 事件推进。

### AppPreferences

```ts
type ClassicThemeStyle = 'aurora' | 'obsidian' | 'mist'
type DbxThemeStyle =
  | 'dbx-pearl'
  | 'dbx-mist'
  | 'dbx-graphite'
  | 'dbx-cobalt'
  | 'dbx-sage'
  | 'dbx-amber'
  | 'dbx-blush'
  | 'dbx-vscode'
  | 'dbx-idea'
  | 'dbx-xcode'
  | 'dbx-jetbrains'
  | 'dbx-cursor'
  | 'dbx-claude'
type ThemeStyle = ClassicThemeStyle | DbxThemeStyle
type ThemePreference = ThemeStyle | 'system'
type DbxThemeMode = 'system' | 'light' | 'dark'
type UiFontFamilyId = 'system' | 'segoe' | 'yahei'
type TerminalFontFamilyId =
  | 'cascadia'
  | 'consolas'
  | 'jetbrains'
  | 'fira'
  | 'source-code-pro'
  | 'sf-mono'
  | 'ibm-plex'
  | 'system'
type TerminalCursorStyle = 'block' | 'underline' | 'bar'
type LogLevel = 'error' | 'warn' | 'info' | 'debug'
type WallpaperIntensity = 'soft' | 'balanced' | 'strong'

interface AppPreferences {
  theme: ThemePreference
  dbxThemeMode: DbxThemeMode
  gradientIntensity: number
  uiFontFamily: UiFontFamilyId
  uiFontSize: number
  terminalFontFamily: TerminalFontFamilyId
  terminalFontSize: number
  terminalCursorStyle: TerminalCursorStyle
  terminalCursorBlink: boolean
  terminalScrollback: number
  transferMaxConcurrent: number
  transferMaxPerSession: number
  logLevel: LogLevel
  wallpaperEnabled: boolean
  wallpaperIntensity: WallpaperIntensity
  /** 默认 false；关闭时不新增命令历史。 */
  commandHistoryEnabled: boolean
  /** 默认 false；开启后仅对固定网络类错误自动重试，最多 5 次。 */
  autoReconnectEnabled: boolean
}
```

- 默认值：`aurora`、`dbxThemeMode: system`、渐变强度 35、界面字体 `system` / 13px、终端 `cascadia` / 13px、`block` 光标、闪烁开启、5,000 行回滚、全局并发 2、每会话并发 1、日志级别 `info`、壁纸关闭、`balanced` 浓度、命令历史关闭、自动重连关闭。
- 界面字号只允许 12/13/14/15；终端字号只允许 10–20 的整数；回滚行数只允许 1,000/5,000/10,000/20,000；全局并发 1–4；每会话并发 1–2，主进程还会把每会话值夹到全局值以内。壁纸开关、命令历史开关与自动重连开关为严格布尔，浓度仅 `soft/balanced/strong`。
- 界面与终端字体族保存白名单 ID，渲染端解析为固定字体栈，不接受任意 CSS。经典主题深浅固定（Aurora/Obsidian 深色、Mist 浅色）；DBX 色板由 `dbxThemeMode` 解析，`system` 使用 `matchMedia('(prefers-color-scheme: dark)')`，解析结果不写回偏好；`theme: system` 仅表示经典跟随系统（深色→Aurora、浅色→Mist）。主进程使用同一份共享解析器决定标题栏按钮与窗口底色。
- 偏好经 `settings:get/update` 在主进程持久化到 `settings.json`，不使用 localStorage；`settingsStore` 先乐观应用并在失败时回滚仍未被后续修改的字段。
- 界面字体/字号通过 `--tf-font-ui` 与 `--tf-font-scale` 作用于全部 UI token；终端字体/字号/光标/回滚与解析后的主题实时应用到 xterm；终端字号或回滚变化后重新 fit，触发 PTY 尺寸同步，但不重建终端或 PTY。
- `settings.json` v1 没有壁纸字段，v2 没有命令历史字段，v3 没有自动重连字段，v4 使用旧 `dark|light|system` 主题枚举，v5 没有 13 套 DBX 色板、`dbxThemeMode`、`uiFontFamily` 与 `uiFontSize`；读取时在内存中补默认值且不产生警告，下一次显式保存才写入 v6。命令历史开关在发送时实时读取，关闭后立即阻止新增；自动重连开关由渲染端读取，关闭时立即清除待执行重试。

### Wallpaper types

```ts
interface WallpaperState {
  dataUrl: string | null
  fileName: string | null
  updatedAt: string | null
}

interface WallpaperChooseResult {
  state: WallpaperState
  canceled: boolean
}
```

- `dataUrl` 只允许主进程生成的 `data:image/jpeg;base64,...`；`fileName` 只是原图 basename，用于展示，不包含路径；`updatedAt` 为 ISO 时间字符串。
- `WallpaperChooseResult.canceled` 为 `true` 时 `state` 保持当前值，不触发设置变更。
- 没有源路径、文件句柄、图片 Buffer 或通用文件读取字段。

### Host key types

```ts
type HostKeyAlgorithm =
  | 'ssh-ed25519'
  | 'ecdsa-sha2-nistp256'
  | 'ecdsa-sha2-nistp384'
  | 'ecdsa-sha2-nistp521'
  | 'rsa-sha2-512'
  | 'rsa-sha2-256'
  | 'ssh-rsa'

interface PresentedHostKey {
  host: string
  port: number
  algorithm: HostKeyAlgorithm
  fingerprint: string // OpenSSH SHA256:Base64
}

interface HostKeyRecord extends PresentedHostKey {
  trustedAt: string
  updatedAt: string
}

type HostKeyVerdict = 'trusted' | 'unknown' | 'changed'
```

- 指纹必须是 OpenSSH `SHA256:` Base64 形式（43 个 Base64 字符，可带一个 `=`）；同一 `host:port` 只能保存一条记录。
- `ssh-rsa` 是 ssh2 对 RSA 原始公钥 blob 的算法名，即使协商签名算法为 `rsa-sha2-*`；因此类型列表包含它。
- 记录只表达显式信任决定，不包含公钥之外的机密。
- 主机名匹配大小写不敏感。

### Credential storage status

```ts
type CredentialProtection = 'windows-dpapi' | 'macos-keychain' | 'linux-keyring' | 'unavailable'

interface CredentialStorageStatus {
  available: boolean
  protection: CredentialProtection
  message: string
}

interface SecurityStatus {
  credentialStorage: CredentialStorageStatus
  hostKeyPolicy: 'explicit-trust-only'
}
```

- 渲染进程只能读取状态；凭据写入通过 `ssh:set-credential` 进入主进程，**没有读取凭据的 IPC**。
- `available: false` 时所有凭据操作在主进程中直接拒绝，不存在明文回退。

### IPC result types

```ts
type OperationErrorCode =
  | 'invalid-input'
  | 'not-found'
  | 'storage-unavailable'
  | 'storage-corrupt'
  | 'storage-read-failed'
  | 'storage-write-failed'
  | 'limit-exceeded'
  | 'conflict'
  | 'unavailable'
  | 'internal'

type OperationResult<T> =
  { ok: true; value: T } | { ok: false; error: { code: OperationErrorCode; message: string } }
```

`OperationResult` 只携带允许列表中的错误码和预先定义的安全消息；原始文件系统错误、`ssh2` 错误、Zod issue 和堆栈不会进入渲染进程。

### TermForgeBridge

```ts
interface TermForgeBridge {
  getAppInfo(): Promise<AppInfo>
  getSecurityStatus(): Promise<SecurityStatus>
  /** 解析被拖入的 OS 文件的绝对路径（`webUtils`）；无磁盘路径时返回空串。 */
  getPathForFile(file: File): string
  connections: {
    list(): Promise<OperationResult<ConnectionCatalog>>
    create(input: ConnectionInput): Promise<OperationResult<ConnectionProfile>>
    update(id: string, input: ConnectionInput): Promise<OperationResult<ConnectionProfile>>
    remove(
      id: string,
      options?: ConnectionRemovalOptions,
    ): Promise<OperationResult<ConnectionMutationAck>>
    setFavorite(id: string, favorite: boolean): Promise<OperationResult<ConnectionProfile>>
  }
  ssh: {
    connect(connectionId: string, clientId: string): Promise<OperationResult<SshConnectResult>>
    cancelConnect(clientId: string): Promise<OperationResult<SshConnectCancelAck>>
    disconnect(sessionId: string): Promise<OperationResult<SshSessionSnapshot>>
    getStatus(sessionId: string): Promise<OperationResult<SshSessionSnapshot>>
    respondToHostKey(
      requestId: string,
      accepted: boolean,
    ): Promise<OperationResult<SshHostKeyResponseAck>>
    saveCredential(input: SshCredentialInput): Promise<OperationResult<SshCredentialAck>>
    onSessionStatus(listener: (event: SshStatusEvent) => void): () => void
    onHostKeyRequest(listener: (event: SshHostKeyRequestEvent) => void): () => void
  }
  terminal: {
    open(sessionId: string, size: TerminalSize): Promise<OperationResult<TerminalOpenResult>>
    write(sessionId: string, data: string): Promise<OperationResult<TerminalAck>>
    resize(sessionId: string, size: TerminalSize): Promise<OperationResult<TerminalAck>>
    close(sessionId: string): Promise<OperationResult<TerminalAck>>
    getStatus(sessionId: string): Promise<OperationResult<TerminalShellSnapshot>>
    onOutput(listener: (event: TerminalOutputEvent) => void): () => void
    onStatus(listener: (event: TerminalStatusEvent) => void): () => void
    onExit(listener: (event: TerminalExitEvent) => void): () => void
  }
  sftp: {
    open(sessionId: string): Promise<OperationResult<SftpOpenResult>>
    list(sessionId: string, path: string): Promise<OperationResult<RemoteDirectoryListing>>
    stat(sessionId: string, path: string): Promise<OperationResult<RemoteFileEntry>>
    mkdir(
      sessionId: string,
      parentPath: string,
      name: string,
    ): Promise<OperationResult<SftpMutationAck>>
    rename(
      sessionId: string,
      sourcePath: string,
      targetPath: string,
    ): Promise<OperationResult<SftpMutationAck>>
    deleteFile(sessionId: string, path: string): Promise<OperationResult<SftpMutationAck>>
    removeDirectory(sessionId: string, path: string): Promise<OperationResult<SftpMutationAck>>
    close(sessionId: string): Promise<OperationResult<SftpCloseAck>>
  }
  localFs: {
    roots(): Promise<OperationResult<LocalRootsResult>>
    list(path: string): Promise<OperationResult<LocalDirectoryListing>>
  }
  transfer: {
    enqueueUpload(
      sessionId: string,
      remoteDirectory: string,
    ): Promise<OperationResult<TransferTask[]>>
    enqueueUploadPaths(
      sessionId: string,
      remoteDirectory: string,
      localPaths: string[],
    ): Promise<OperationResult<TransferUploadEnqueueAck>>
    enqueueDownload(
      sessionId: string,
      remotePaths: string[],
    ): Promise<OperationResult<TransferTask[]>>
    enqueueDownloadPaths(
      sessionId: string,
      remotePaths: string[],
      localDirectory: string,
    ): Promise<OperationResult<TransferTask[]>>
    cancel(transferId: string): Promise<OperationResult<TransferTask>>
    retry(transferId: string): Promise<OperationResult<TransferTask>>
    resolveConflict(
      transferId: string,
      choice: TransferConflictPolicy,
      newName?: string,
    ): Promise<OperationResult<TransferTask>>
    list(): Promise<OperationResult<TransferTask[]>>
    clearHistory(): Promise<OperationResult<TransferClearAck>>
    onUpdate(listener: (event: TransferUpdateEvent) => void): () => void
  }
  portForwards: {
    list(): Promise<OperationResult<PortForwardSnapshot>>
    create(input: PortForwardCreateInput): Promise<OperationResult<PortForwardItem>>
    update(id: string, input: PortForwardUpdateInput): Promise<OperationResult<PortForwardItem>>
    remove(id: string): Promise<OperationResult<PortForwardRemoveAck>>
    start(
      ruleId: string,
      sessionId: string,
      options?: { confirmExposure?: boolean },
    ): Promise<OperationResult<PortForwardItem>>
    stop(id: string): Promise<OperationResult<PortForwardItem>>
    getConnectionRemovalImpact(
      connectionId: string,
    ): Promise<OperationResult<ConnectionRemovalImpact>>
    onSnapshot(listener: (event: PortForwardUpdateEvent) => void): () => void
  }
  quickCommands: {
    list(): Promise<OperationResult<QuickCommandSnapshot>>
    create(input: QuickCommandDraft): Promise<OperationResult<QuickCommand>>
    update(id: string, input: QuickCommandDraft): Promise<OperationResult<QuickCommand>>
    remove(id: string): Promise<OperationResult<{ id: string }>>
    setFavorite(id: string, favorite: boolean): Promise<OperationResult<QuickCommand>>
    execute(input: QuickCommandExecuteInput): Promise<OperationResult<QuickCommandExecuteAck>>
  }
  commandHistory: {
    list(): Promise<OperationResult<CommandHistorySnapshot>>
    remove(id: string): Promise<OperationResult<{ id: string }>>
    clear(): Promise<OperationResult<CommandHistoryClearAck>>
  }
  settings: {
    get(): Promise<OperationResult<SettingsSnapshot>>
    update(preferences: AppPreferences): Promise<OperationResult<SettingsSnapshot>>
  }
  hostKeys: {
    list(): Promise<OperationResult<HostKeyRecord[]>>
    remove(host: string, port: number): Promise<OperationResult<HostKeyRemovalAck>>
  }
  logs: {
    getInfo(): Promise<OperationResult<LogInfo>>
    exportLogs(): Promise<OperationResult<LogExportAck>>
    openFolder(): Promise<OperationResult<LogFolderAck>>
  }
  wallpaper: {
    get(): Promise<OperationResult<WallpaperState>>
    choose(): Promise<OperationResult<WallpaperChooseResult>>
    remove(): Promise<OperationResult<WallpaperState>>
  }
}
```

`IPC_CHANNELS` 共 63 个 invoke 通道：`app:get-info`、`connections:list/create/update/remove/set-favorite`、`security:get-status`、`ssh:connect/cancel-connect/disconnect/get-status/respond-host-key/set-credential`、`terminal:open/write/resize/close/get-status`、`sftp:open/list/stat/mkdir/rename/delete-file/remove-directory/close`、`local-fs:roots/list`、`transfer:enqueue-upload/enqueue-download/enqueue-upload-paths/enqueue-download-paths/cancel/retry/resolve-conflict/list/clear-history`、`port-forwards:list/create/update/remove/start/stop/connection-impact`、`quick-commands:list/create/update/remove/set-favorite/execute`、`command-history:list/remove/clear`、`settings:get/update`、`host-keys:list/remove`、`logs:get-info/export/open-folder`、`wallpaper:get/choose/remove`。另有 7 个主进程 → 渲染进程事件：`ssh:session-status`、`ssh:host-key-request`、`terminal:output/status/exit`、`transfer:update`、`port-forwards:snapshot-updated`。没有通用转发，没有由渲染进程提交的文件大小、状态、文件内容或 Socket payload 通道；上传/下载批量入队可携带本地路径，但由主进程逐条重新校验后才读取任何文件。快速命令历史只通过 `command-history:list` 返回元数据与正文，没有终端输出读取或日志内容读取通道。

`SettingsSnapshot = { preferences: AppPreferences; warnings: string[] }`；`HostKeyRemovalAck = { removed: boolean }`；`LogInfo = { directory, level, files: { name, sizeBytes, modifiedAt }[], writeFailures }`；`LogExportAck = { exported: boolean }`；`LogFolderAck = { opened: boolean }`；`WallpaperChooseResult = { state: WallpaperState; canceled: boolean }`。

## 2. 持久化格式

### 连接目录

`<userData>/connections.json`：

```json
{
  "version": 2,
  "data": {
    "groups": [{ "id": "production", "name": "生产环境", "tone": "production", "sortOrder": 1 }],
    "connections": [
      {
        "id": "conn-prod-web-01",
        "name": "prod-web-01",
        "host": "10.20.4.11",
        "port": 22,
        "username": "deploy",
        "authMethod": "privateKey",
        "groupId": "production",
        "tags": ["nginx", "web"],
        "credentialRef": "~/.ssh/prod_ed25519（仅演示引用）",
        "jumpConnectionIds": ["conn-stage-bastion"],
        "favorite": true,
        "createdAt": "2026-09-08T08:30:00.000Z",
        "updatedAt": "2026-10-18T12:10:00.000Z"
      }
    ]
  }
}
```

- 当前版本为 `2`（P1-02 起）；未知版本或额外字段视为 `storage-corrupt`。
- **v1 → v2 迁移**：v1 文件（无 `jumpConnectionIds`）由 `parsePersistedConnectionCatalog` 冻结 schema 解析后，为每个连接补 `jumpConnectionIds: []`，迁移结果经当前 schema 重新校验并立即原子写回；重新校验失败或写回失败均按 `storage-corrupt` 停止加载，不覆盖原文件。
- 首次启动且文件不存在时写入共享种子（3 个分组、7 个连接；`conn-stage-api-01` 作为演示引用 `conn-stage-bastion`）；文件存在时绝不重新播种。
- 写入使用临时文件 + rename，内容格式化为 2 空格缩进并带结尾换行。
- Windows 上 `rename` 对瞬时 `EPERM`/`EACCES`/`EBUSY` 做有限退避重试；其他错误立即失败。
- 所有仓库操作通过 Promise 队列串行执行。
- 修改操作在磁盘写入成功后才更新内存状态；写入失败时原文件保持不变。
- 创建/更新时校验跳板引用（自引用、不存在、循环引用分别拒绝）；删除连接时级联剥离引用并更新受影响连接的 `updatedAt`（同一次原子写入）。

### 凭据库

`<userData>/credentials.enc.json`：

```json
{
  "version": 1,
  "entries": [
    {
      "reference": "termforge://connection/conn-prod-web-01/private-key",
      "ciphertext": "<Base64 of safeStorage ciphertext>",
      "createdAt": "2026-10-22T08:00:00.000Z",
      "updatedAt": "2026-10-22T08:00:00.000Z"
    }
  ]
}
```

- 只存引用与加密后的 Base64，不存明文密码或私钥。
- 引用规范：
  - `termforge://connection/<connectionId>/password`；
  - `termforge://connection/<connectionId>/private-key`；
  - `termforge://connection/<connectionId>/passphrase`。
- `ssh:set-credential` 只在连接存在且 `kind` 与认证方式匹配时写入；SSH Agent 连接拒绝保存。
- 读取/保存/删除前检查操作系统保护状态；不可用时不创建文件、不操作已有文件。
- 解密失败返回 `storage-corrupt`，不回退为密文或明文。
- 单个秘密上限 65,536 字符 / 条目；凭据库最多 2,000 条。

### 主机密钥记录

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

- 当前版本为 `1`；文件由主进程在首次接受主机密钥时创建。
- 同一 `host:port` 只能有一条记录；`trust` 会替换该端点的已有记录。
- `verify` 只读；`trust` 是唯一写入入口；`remove` 删除记录。
- 损坏或版本不支持时停止加载，不覆盖现有信任决定。
- `host-keys:list` 返回记录副本；`host-keys:remove` 只接受 host/port 并返回 `{ removed }`。设置页在用户确认后调用删除；删除不会断开活动会话，下次连接该端点会重新确认。
- 删除连接不会删除主机密钥记录；删除连接会尽力清理该连接对应的密码/私钥/口令凭据引用。

### 端口转发规则

`<userData>/port-forwards.json`：

```json
{
  "version": 1,
  "data": {
    "rules": [
      {
        "id": "pf-4b0e...",
        "type": "local",
        "name": "本地 Web 调试",
        "connectionId": "conn-prod-web-01",
        "bindAddress": "127.0.0.1",
        "bindPort": 18080,
        "targetHost": "127.0.0.1",
        "targetPort": 8080,
        "createdAt": "2026-10-23T08:00:00.000Z",
        "updatedAt": "2026-10-23T08:00:00.000Z"
      },
      {
        "id": "pf-9c1d...",
        "type": "dynamic",
        "name": "SOCKS 调试",
        "connectionId": "conn-prod-web-01",
        "bindAddress": "127.0.0.1",
        "bindPort": 1080,
        "createdAt": "2026-10-23T08:00:00.000Z",
        "updatedAt": "2026-10-23T08:00:00.000Z"
      }
    ]
  }
}
```

- 当前版本为 `1`，信封为 `{ version, data: { rules } }`；strict schema 校验规则类型、名称、IP 字面量监听地址、1–65,535 端口、连接 ID 格式与 ID 唯一性，最多 100 条。
- 只保存规则；运行时状态、监听器、绑定端点、活动连接数、失败、`cleanupPending` 与 SSH `sessionId` 不落盘。应用启动后规则统一为 `stopped`，必须由用户重新选择已连接会话并显式启动。
- `dynamic` 规则持久化的 `bindAddress` 必须是 `127.0.0.1`；`local`/`remote` 规则的非回环监听只是已保存的配置，不表示已获得暴露确认，启动时仍需再次确认。
- 写入使用临时文件 + rename 原子替换；仓库内所有读写通过 Promise 队列串行化；写入失败不更新内存状态。规则文件损坏或版本不支持时停止加载，不静默丢弃或改写原文件。
- `update` 不能改变规则类型或 `connectionId`；删除连接时的级联删除由 `PortForwardService.removeForConnection` 执行，任何停止/清理失败都会中止删除。
- 规则不包含密码、私钥、口令、凭据引用或任何流量内容。

### 应用设置

`<userData>/settings.json`：

```json
{
  "version": 6,
  "preferences": {
    "theme": "dbx-cobalt",
    "dbxThemeMode": "system",
    "gradientIntensity": 35,
    "uiFontFamily": "system",
    "uiFontSize": 13,
    "terminalFontFamily": "cascadia",
    "terminalFontSize": 13,
    "terminalCursorStyle": "block",
    "terminalCursorBlink": true,
    "terminalScrollback": 5000,
    "transferMaxConcurrent": 2,
    "transferMaxPerSession": 1,
    "logLevel": "info",
    "wallpaperEnabled": false,
    "wallpaperIntensity": "balanced",
    "commandHistoryEnabled": false,
    "autoReconnectEnabled": false
  }
}
```

- 当前版本为 `6`；`preferences` 必须是 strict schema，未知字段整体视为无效。
- v5 文件缺少 `dbxThemeMode`、`uiFontFamily` 与 `uiFontSize` 时分别补 `system`、`system`、13；v4 文件还使用旧 `dark|light|system` 主题枚举（`dark→aurora`、`light→mist`）并缺 `gradientIntensity`（补 35）；v3 文件缺少 `autoReconnectEnabled` 时补 `false`；v2 文件再缺少 `commandHistoryEnabled` 时补 `false`；v1 文件同时缺少壁纸字段，补默认值（关闭、标准）。迁移只在内存中发生，不返回恢复警告，也不因读取而覆盖原文件；用户下次保存时写成 v6。
- `autoReconnectEnabled` 必须为严格布尔；它只允许开启有界自动重试，不保存任何重试进度、定时器、会话 ID 或失败历史。
- 文件不存在时返回默认值且**不创建文件**；首次显式修改才写入。
- 严格版本解析失败时逐字段 `.catch(default)` 恢复，返回警告并保留原文件；不因读取而覆盖。
- 写入使用临时文件 + rename 原子替换；仓库内读写通过 Promise 队列串行化，写入失败不更新内存状态。
- 只保存非敏感偏好，不保存连接、凭据、命令正文、日志路径、壁纸路径或任意本地/远程路径；命令历史开关只表示是否允许新增历史。

### 快速命令存储

`<userData>/quick-commands.json`：

```json
{
  "version": 1,
  "data": {
    "customCommands": [
      {
        "id": "qc-5f0c...",
        "name": "查看应用日志",
        "category": "日志",
        "description": "查看指定服务的最近日志",
        "body": "journalctl -u {{service}} -n 100 --no-pager",
        "parameters": [{ "name": "service", "defaultValue": "nginx" }],
        "favorite": false,
        "createdAt": "2026-10-23T09:00:00.000Z",
        "updatedAt": "2026-10-23T09:00:00.000Z"
      }
    ],
    "builtInFavoriteIds": ["builtin-uptime"]
  }
}
```

- 当前版本为 `1`，信封为 `{ version, data: { customCommands, builtInFavoriteIds } }`；strict schema 校验字段、ID、模板参数一致性与唯一性。
- 上限：自定义命令 500 条、内置收藏 64 条、每条正文 4,096 字符、参数 16 个；名称 64、分类 32、说明 256、参数名 32、参数值 512 字符。
- 只保存用户命令与收藏 ID；内置命令正文来自代码，不落盘。文件不包含凭据、会话、终端输出或历史记录。
- 写入使用临时文件 + rename 原子替换，仓库内读写串行化；写入失败不更新内存状态。损坏、版本不支持或 schema 不通过时停止加载，不以空数据覆盖原文件。
- 删除自定义命令不会删除 `command-history.json` 中已记录的历史；收藏变化也不影响历史。

### 命令历史存储

`<userData>/command-history.json`：

```json
{
  "version": 1,
  "data": {
    "entries": [
      {
        "id": "ch-0a7e...",
        "body": "journalctl -u nginx -n 100 --no-pager",
        "sentAt": "2026-10-23T09:10:00.000Z",
        "tabId": "sshtab-...",
        "sessionId": "ssh-...",
        "connectionId": "conn-prod-web-01",
        "connectionName": "prod-web-01",
        "host": "10.20.4.11"
      }
    ]
  }
}
```

- 当前版本为 `1`，信封为 `{ version, data: { entries } }`；strict schema 校验 ID 唯一性、正文长度/单行、ISO 时间与目标元数据，最多 200 条。
- 只保存最终渲染正文与发送目标元数据；不保存参数表、终端输入输出、退出码、工作目录、命令输出、凭据或 SSH 对象。
- 历史默认关闭；只有 `commandHistoryEnabled === true` 且本次发送 `recordHistory === true` 时才追加。关闭设置不会删除已有记录。
- 新记录按最新在前，超过 200 条时丢弃最旧记录；单条删除与清空都通过串行队列 + 原子写入。清空遇到损坏文件时写入空历史以恢复可用状态。
- 该文件**不额外加密**，依赖操作系统账户与磁盘权限；正文不进入诊断日志，但本文件本身可被同账户进程读取。
- 损坏、版本不支持或 schema 不通过时读取失败，不返回残缺记录，也不会因读取而覆盖原文件；用户可通过清空操作恢复。

### 壁纸存储

`<userData>/wallpapers/`：

- `wallpaper.jpg`：主进程重编码后的 JPEG（最长边 ≤2,560px，质量 85）。
- `wallpaper.json`：`{ version: 1, fileName: string, updatedAt: string }`；文件名仅为源图 basename，不保存路径。元数据损坏或缺失时仍可返回图片 data URL，但 `fileName`/`updatedAt` 为 `null`。
- 源图限制：`.png/.jpg/.jpeg`、普通文件、1 字节–20 MiB；解码失败、零尺寸或重编码为空时拒绝。
- 写入使用唯一临时文件 + rename；失败时清理临时文件并返回固定错误。`remove` 只删除上述两个固定文件。
- 读取结果只投影为 `WallpaperState`；不返回源路径、文件内容或图像对象。

### 传输任务日志

`<userData>/transfer-journal.json`：

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "transfer-...",
      "sessionId": "ssh-...",
      "direction": "upload",
      "fileName": "report.csv",
      "sourcePath": "C:\\tmp\\report.csv",
      "destinationPath": "/srv/report.csv",
      "status": "transferring",
      "totalBytes": 1024,
      "transferredBytes": 512,
      "progress": 50,
      "createdAt": "2026-10-22T08:00:00.000Z",
      "attempt": 1,
      "revision": 7
    }
  ]
}
```

- 当前版本为 `1`，最多 100 条；只记录活动/等待状态或已水合的 `interrupted` 任务，正常完成/取消/失败任务不写入。
- 写入使用 250ms 防抖 + 原子替换；退出时等待传输收敛后强制冲洗，单次冲洗有 1.5 秒上限。
- 启动时 strict 校验；损坏、不可读或版本不支持时静默忽略，不影响传输服务启动。
- 水合只创建 `interrupted` + `outcome-unknown` 快照，`revision + 1`，不恢复队列、流、临时路径或字节计数；不会自动执行。
- 快照包含展示用源/目标路径，可能泄露用户名与目录结构，但不含文件内容、凭据、临时文件名或句柄。

### 诊断日志

`<userData>/logs/termforge.log`（轮转后为 `termforge.1.log` … `termforge.4.log`）：

- JSONL，每行至少 `timestamp`、`level`、`module`、`event`；元数据经深度脱敏，单行最多 16 KiB，超限时降级为 `{ truncated: true }` 摘要行。
- 默认级别 `info`；单文件 2 MiB、最多 5 个文件（含当前文件），按大小轮转；目录 `0700`、文件 `0600`。
- `LogInfo.files` 只列出匹配 `termforge*.log` 的文件，按修改时间倒序；不含内容。
- 日志不记录终端输入/输出、命令、文件内容、凭据、远程路径或任务文件名；导出由用户选择目标路径，最多读取 20 MiB 并再次脱敏，文件末尾可带固定导出头。

## 3. 表单与 IPC 校验（Zod）

`src/shared/schemas/connection.ts` 中的 `connectionFormSchema` 接收字符串输入并输出规范化的 `ConnectionInput`：

| 字段            | 规则                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------- |
| `name`          | trim 后必填，最多 64 字符                                                                    |
| `host`          | trim 后必填，最多 253；不允许空白、`/`、`\`、`@`、`?`、`#`、`://`；合法主机名、IPv4 或 IPv6  |
| `port`          | 字符串必须为数字，转换为整数后限定 1–65535                                                   |
| `username`      | trim 后必填，最多 64 字符                                                                    |
| `authMethod`    | `password` / `privateKey` / `sshAgent`                                                       |
| `groupId`       | 非空字符串                                                                                   |
| `tags`          | 按中英文逗号拆分、trim、大小写不敏感去重；最多 8 个，每个最多 24 字符；原始输入最多 300 字符 |
| `credentialRef` | trim 后最多 512 字符；空字符串转为 `undefined`；拒绝控制字符和私钥标记                       |

主机校验细节：

- IPv4 必须为四段且每段 ≤255。
- 主机名按 DNS label 规则校验（总长 ≤253，单 label 1–63，不以连字符开头/结尾）。
- IPv6 支持压缩形式 `::` 与方括号形式 `[::1]`，拒绝多个 `::` 或段数非法。
- 主机框不接受 `host:port` 写法，端口必须填在独立字段。

SSH IPC schema：

| 输入            | 规则                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| 连接 ID         | `conn-<UUID>` 格式，主进程仍需在仓库中查找                                                            |
| 客户端标签 ID   | `sshtab-<UUID>` 格式；每标签最多一个活动会话，主进程按 `clientId` 去重与关联                          |
| 会话 ID         | `ssh-[A-Za-z0-9][A-Za-z0-9_-]{0,95}`，且必须存在于主进程会话表；渲染端不能借任意 ID 访问其他资源      |
| 主机密钥请求 ID | `hk-...`，且必须对应未决 challenge                                                                    |
| 凭据输入        | strict `{ connectionId, kind, secret }`；kind 限 password/privateKey/passphrase；secret 1–65,536 字符 |
| 主机密钥响应    | strict `{ requestId, accepted: boolean }`                                                             |
| 终端尺寸        | strict `{ cols, rows }`；整数，cols 1–2,000，rows 1–1,000                                             |
| 终端写入        | 字符串，1–65,536 字符                                                                                 |

SFTP IPC schema（`src/shared/schemas/sftp.ts`）：

| 输入         | 规则                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| SFTP 会话 ID | 与 SSH 会话 ID 相同，必须匹配 `ssh-...` 且存在于主进程会话表并处于 `connected`                             |
| 远程路径     | 1–4,096 字符；必须以 `/` 开头；拒绝 NUL 与控制字符；主进程再做 POSIX 规范化                                |
| 新建目录     | strict `{ sessionId, parentPath, name }`；名称 1–255 字符，拒绝 `/`、`.`、`..`、纯空白、NUL 与控制字符     |
| 重命名       | strict `{ sessionId, sourcePath, targetPath }`；两端均按远程路径校验，源与目标不能相同                     |
| 删除文件     | strict `{ sessionId, path }`                                                                               |
| 删除目录     | strict `{ sessionId, path }`；必须是非根、非受保护顶层、深度 ≥2 的目录；服务端确认是目录、非符号链接且为空 |
| 关闭 SFTP    | strict `{ sessionId }`                                                                                     |

- 所有 SFTP 输入为 `z.strictObject`，未知字段（包括 Client/Channel 引用、凭据或文件内容字段）会被拒绝。
- 主进程每次调用都通过 `SshService.getSftpClient(sessionId)` 重新验证会话存在、归属与连接状态，不信任渲染进程传入的 ID。
- 远程路径允许空格、Unicode 与常见特殊字符；不允许通过相对路径或 NUL 绕过。路径规范化只改善输入，不替代服务器端权限检查。

本地文件系统 IPC schema（`src/shared/schemas/localFs.ts`）：

| 输入     | 规则                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------- |
| 本地路径 | `localPathSchema`：1–4,096 字符；必须为绝对路径；拒绝 NUL 与控制字符；拒绝 `\\.\`/`\\?\` 设备前缀 |
| 列举目录 | strict `{ path }`；不存在、非目录或不可读时归一为固定错误码，不返回原始 `fs` 错误与完整路径       |

- `localFs:roots` 无参数，返回固定 home 与驱动器/根列表；两个方法都只读元数据，不读取文件内容、不写盘。

传输 IPC schema（`src/shared/schemas/transfer.ts`）：

| 输入             | 规则                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 传输任务 ID      | `transfer-[A-Za-z0-9-]+`，1–120 字符，且必须存在于主进程任务表                                                                    |
| 上传请求         | strict `{ sessionId, remoteDirectory }`；会话必须匹配 SFTP 规则，目录必须是绝对 POSIX 路径                                        |
| 上传（显式路径） | strict `{ sessionId, remoteDirectory, localPaths: string[] }`；1–50 条本地路径，逐条按 `localPathSchema` 校验                     |
| 下载请求         | strict `{ sessionId, remotePaths: string[] }`；1–50 个唯一远程路径，全部按远程路径校验；根目录 `/` 被拒绝                         |
| 下载（显式路径） | strict `{ sessionId, remotePaths, localDirectory }`；远程路径同上；本地目录按 `localPathSchema` 校验且必须已存在                  |
| 取消/重试        | strict `{ transferId }`                                                                                                           |
| 冲突处理         | strict `{ transferId, choice, newName? }`；`choice` 限 `overwrite/rename/skip`；`rename` 必须提供非空 `newName`，其他策略不得携带 |
| 清空历史         | 无参数                                                                                                                            |

- 传输请求不接受文件大小、任务状态、流、句柄或 Client/Channel 引用；本地路径只由两个显式入队通道提交，并由主进程逐条重新校验（存在性、类型、无设备前缀、目录展开深度与任务上限）；其余路径值由主进程从原生对话框与 SFTP 元数据获得。
- `enqueueUpload` 在打开原生对话框前后都重新校验远程目录；`enqueueDownload` 先 `probe` SFTP 通道，再打开原生目录对话框并校验本地目录。
- `enqueueUploadPaths`/`enqueueDownloadPaths` 不打开对话框：本地路径逐条 `lstat` 校验存在性与类型，目录按 BFS 展开（符号链接不跟随；超出深度上限 64 的目录计入不支持跳过；展开任务上限默认 500 超出后截断），被排除条目按计数上报；下载目标本地目录必须已存在且不是磁盘根目录。
- 下载文件名在创建任务前与提交前都按 Windows-first 本地文件名规则校验（保留名、`<>:"/\|?*`、控制字符、尾随空格/句点、长度上限）；上传的远程名称按 POSIX 规则校验。
- `resolveConflict` 的 `rename` 名称在任务方向对应的一侧再次校验；所有冲突决策都会让任务重新排队并在准备阶段重新检查目标，提交阶段还会再检查一次。

设置/主机密钥/日志/快速命令 IPC schema：

| 输入                   | 规则                                                                                                                                                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 设置更新               | strict `AppPreferences`；主题为 16 套风格或 `system`、DBX 模式三选一、界面/终端字体 ID 白名单、界面字号 12–15、终端字号 10–20、回滚/并发仅预设整数、布尔严格、日志级别四选一、壁纸开关布尔、壁纸浓度三选一、命令历史开关布尔；未知字段整体拒绝                         |
| 主机密钥删除           | `host` 为合法主机名/IPv4/IPv6（trim、≤253 字符），`port` 为 1–65,535 整数；主进程按端点删除记录                                                                                                                                                                        |
| 日志查询/导出/打开目录 | 无参数；导出目标路径由主进程原生保存对话框产生，渲染进程不能指定路径                                                                                                                                                                                                   |
| 壁纸读取/选择/移除     | 无参数；图片源由主进程原生图片对话框产生，扩展名、文件类型、大小与解码结果由主进程校验                                                                                                                                                                                 |
| 快速命令草稿           | strict `{ name, category, description, body, parameters }`；名称 1–64、分类 1–32、说明 ≤256、正文 1–4,096；正文单行且不含控制字符；参数名必须与正文占位符按顺序一致、唯一、最多 16 个；参数默认值 ≤512                                                                 |
| 快速命令执行           | strict discriminated union（`kind: 'command' \| 'history'`）；`requestId` 8–96 字符；`commandId` 为 `qc-…`/`builtin-…`；参数值键必须是合法参数名、值非空且 ≤512；`tabId` 为 `sshtab-…`、`sessionId` 为 `ssh-…`；`recordHistory` 布尔；历史正文 1–4,096、允许字面花括号 |
| 快速命令/历史删除      | strict `{ id }`；命令 ID 为 `qc-…`，历史 ID 为 `ch-…`；未知 ID 返回 `not-found`                                                                                                                                                                                        |

错误通过 `toConnectionFieldErrors` 收敛为字段级对象；遇到首个错误时，表单将焦点移动到对应输入。提交期间禁用动作；主进程或磁盘失败时显示内联错误并允许重试。

## 4. 种子与真实数据

共享种子 `src/shared/fixtures/connectionSeed.ts`：

- 3 个分组：生产环境、测试环境、本地开发。
- 7 个连接，包含不同认证方式、端口、收藏状态与凭据引用占位。
- 不含密码、私钥内容或可用的真实主机；地址使用 RFC1918 私网。
- 种子仅用于首次启动；编辑为真实主机后才能连接。

渲染端不包含任何 SFTP 文件 fixture：远程目录、条目元数据与操作结果全部来自主进程 `SftpService`；本地文件也不展示伪造目录，本地面板只显示主进程 `LocalFsService` 的只读列举结果，上传入口为原生文件对话框或显式路径拖拽/选择（由主进程逐条重新校验）。

`transferStore` 不生成演示任务：所有任务都来自主进程 `TransferService`，携带真实传输字节、状态与会话 ID；`TransferDrawer` 不访问文件系统，也不自行计算完成状态。

SSH 会话、连接状态、主机密钥、SFTP 与传输数据都没有渲染端 fixture。

## 5. 数据流与状态归属

```text
主进程 connections.json
  → ConnectionRepository（schema 校验、队列、原子写入）
    → IPC handler（sender/frame + input 校验，OperationResult）
      → preload 固定方法
        → ipcConnectionService（错误归一 + 返回值校验）
          → connectionStore
            → ServerSidebar / ServersView / ConnectionEditorModal / DeleteConnectionModal

用户点击服务器
  → sessionStore.openSession（立即创建 sshtab-<UUID> 工作区标签）
    → bridge.ssh.connect(connectionId, tabId)
      → SshService 校验连接存在性、解析凭据、为每个 clientId 创建独立 ssh2 Client
        → hostVerifier → FileHostKeyStore.verify
          → 事件 ssh:host-key-request → HostKeyConfirmModal
            → bridge.ssh.respondToHostKey
              → trust 写盘成功后放行
        → ready → 状态事件 ssh:session-status（带 clientId）
          → useSshBridgeEvents → sessionStore.applySshSnapshot
            → 工作台状态面板 / 标签状态

SSH connected 后
  → XtermTerminal 挂载 → terminalRuntime.bindTerminalTab(tabId, sessionId) → ensureTerminalShell(tabId, size)
    → bridge.terminal.getStatus/open（按标签去重）
      → SshService.openShell → client.shell({ term, cols, rows })
        → ShellChannelManager 持有 Channel
          → data → StringDecoder → 批量 terminal:output
            → terminalRuntime 按标签绑定路由到会话，缓冲 + 直写 xterm
          → term.onData → 32 KiB 分片队列 → terminal:write → channel.write
          → ResizeObserver/FitAddon → terminal:resize → setWindow(rows, cols)
        → exit/close/error/SSH 断开 → terminal:status + terminal:exit
          → terminalStore 覆盖层 / 重开

SFTP 页面（标签 SSH 已 connected）
  → SftpView 选择工作区标签 → sftpStore.open(tabId, sessionId)
    → bridge.sftp.open(sessionId)
      → IPC handler（sender/frame + strict schema）
        → SshService.getSftpClient(sessionId) 重新验证归属与 connected
          → SftpService 复用/创建该 SSH 会话唯一的 SFTPWrapper
            → realpath('.') → homePath
      → sftpStore.load(tabId, sessionId, homePath)
        → bridge.sftp.list(sessionId, path)
          → SftpService.list → wrapper.readdir → 元数据映射 + 排序
            → 校验 sessionId / path / requestId 后写入 sftpStore
              → RemoteFilePanel 渲染真实远程目录

本地面板枚举（只读，与远程栏独立）
  → LocalFilePanel → localPanelStore.ensure(tabId) → bridge.localFs.roots()
    → IPC handler（sender/frame + strict schema）→ LocalFsService 返回 home 与驱动器列表
      → localPanelStore.load(tabId, path) → bridge.localFs.list(path)
        → LocalFsService lstat → 元数据映射 + 排序（目录/链接/文件分组）
          → 校验 tabId / requestId 后写入 localPanelStore
            → LocalFilePanel 渲染真实本地目录（不含文件内容，符号链接不可进入）

SFTP 变更（mkdir / rename / deleteFile / removeDirectory）
  → SftpView 确认对话框 → sftpStore 检查标签、sessionId 与 ready
    → bridge.sftp.* → 主进程 schema + 会话归属校验
      → SftpService 路径锁 + stat 预检（mkdir/rename）或删除安全校验
        → SFTP 请求 → 成功回调 / 映射错误 / outcome-unknown
          → sftpStore.operation 提示 + 完成成功后重新 load 当前目录

传输入队与执行
  → 三个入口：上传按钮（原生对话框）/ 本地面板多选或 OS 文件拖入远程栏 / 远程多选或拖入本地栏
    → transferStore.enqueueUpload(sessionId, remoteDirectory)
      或 enqueueUploadPaths(sessionId, remoteDirectory, localPaths)
      或 enqueueDownload(sessionId, remotePaths)
      或 enqueueDownloadPaths(sessionId, remotePaths, localDirectory)
      → IPC（sender/frame + strict schema）
        → TransferService 校验远程目录/会话；显式路径逐条 lstat 校验存在性与类型
          → 目录 BFS 展开（符号链接不跟随、深度 ≤64、任务上限 500 超出截断）
          → 原生多文件对话框 / 原生目录选择对话框（仅按钮入口）
          → 每个文件创建独立 TransferTask 与 TaskRuntime
            → FIFO 队列（默认全局 2、每会话 1；可由设置调整）
              → preparing → 同目录 .termforge-part-* 临时文件
                → transferring → fs 流 ↔ SFTP 流 + 字节计数
                  → commit：同目录 rename（覆盖时先备份再替换）
                    → completed / failed / cancelled
      → transfer:update 推送完整快照
        → transferStore 按 revision 合并
          → TransferDrawer 渲染进度、冲突、错误与操作
          → 上传终态（非 skipped）触发 200ms 防抖刷新匹配 SFTP 目录

端口转发创建/启动/停止
  → PortForwardsView → portForwardStore.createRule/startRule/stopRule
    → bridge.portForwards.create/update/start/stop
      → IPC sender/frame + strict schema
        → PortForwardService 串行执行规则状态机
          → 校验连接配置、目标会话 connected 与 connectionId 一致
            → start：活动规则上限 + 暴露确认 + acquireForwardingSession(sessionId)
              → 本地监听 / forwardIn 远程监听 / 回环 SOCKS5 服务器
                → 监听真实建立后才写入 running 并发布 revision+1 快照
                  → port-forwards:snapshot-updated → portForwardStore.applySnapshot
                    → 规则状态、绑定端点、连接数与失败信息展示
              → stop：关闭监听/解绑 → 收敛后 stopped；失败保留 error/cleanupPending
          → 会话结束或门面关闭 → session-ended 停止；不自动重连/迁移
      → 连接删除前：connectionStore.loadDeleteImpact()
        → bridge.portForwards.getConnectionRemovalImpact(connectionId)
          → 有规则时要求显式级联确认
            → connectionService.remove(id, { cascadePortForwards: true })
              → PortForwardService.removeForConnection 先停止并删除全部规则
                → 任一步失败则中止，不删除连接

快速命令库与发送
  → 工具栏/命令面板/Ctrl+Shift+K → quickCommandStore.openDrawer(tabId?)
    → 捕获当前活动标签的 { tabId, sessionId }（仅 Shell open 的标签）
    → bridge.quickCommands.list / bridge.commandHistory.list
      → QuickCommandService：内置命令（代码常量） + 自定义命令（quick-commands.json）
        → QuickCommandDrawer 渲染命令库/历史，搜索与分类只在渲染层过滤
  → 新建/编辑自定义命令 → quickCommandStore.saveCommand
    → IPC + strict schema（名称/正文/参数一致性与长度）
      → QuickCommandRepository 串行 + 原子写入 quick-commands.json
        → 返回 QuickCommand 投影，刷新列表

快速命令发送
  → 用户选择命令/历史 → ComposeModal 显示预览、参数与显式目标
    → 目标来自当前可发送标签列表；不因后台切换自动改选
    → 点击「发送并执行」→ quickCommandStore 校验 tabId/sessionId/Shell open
      → flushTerminalInput(tabId) 冲刷该标签已排队输入 → 再次校验目标
        → bridge.quickCommands.execute({ requestId, tabId, sessionId, ... })
          → QuickCommandService：请求 ID 去重 + 每标签在途锁
            → requireTarget：getStatus(sessionId) 绑定 tabId、connected、Shell open
              → resolveBody：内置/自定义正文重新解析并字面渲染；历史正文按用户确认内容
                → SshService.writeShell(sessionId, body + "\r")
                  → 既有 ShellChannelManager 写入远程 PTY
              → recordHistory：实时读取 commandHistoryEnabled
                → 开启且勾选：CommandHistoryRepository.append → command-history.json
                → 关闭/保存失败：historyRecorded=false + 固定警告，不回滚已写命令
          → ExecuteAck → 仅在 historyRecorded 时刷新历史
  → 「插入」→ insertTerminalInput(tabId, sessionId, body) → 同一写入队列，不追加回车

设置保存
  → SettingsView → settingsStore.updatePreferences(patch)
    → 本地 strict 校验 + 乐观应用（resolvedTheme 重新计算）
      → bridge.settings.update(完整 AppPreferences)
        → IPC sender/frame + strict schema
          → SettingsRepository 串行校验并原子写入 settings.json
            → applyRuntimePreferences（logger.setLevel、transferService.setConcurrencyLimits）
              → SettingsSnapshot 返回
      → 失败：只回滚仍等于本次提交值的字段 + 危险 Toast；不静默假装保存

壁纸导入
  → WallpaperPicker / SettingsView → wallpaperStore.chooseWallpaper()
    → bridge.wallpaper.choose()（无参数）
      → 主进程原生图片对话框 → 扩展名/普通文件/大小校验
        → nativeImage 解码 → 最长边缩放至 2,560px → JPEG q85
          → 原子写入 wallpapers/wallpaper.jpg + wallpaper.json
            → 返回 { state: { dataUrl, fileName, updatedAt }, canceled }
      → wallpaperStore 保存 data URL；导入成功时自动 settings.updatePreferences({ wallpaperEnabled: true })
        → App 设置 data-wallpaper="on" 与 --tf-wallpaper-image

未完成传输恢复（只读）
  → 主进程启动 → TransferService.hydrateJournal()
    → 读取并 strict 校验 transfer-journal.json
      → 为每条记录创建 status=interrupted、errorCode=outcome-unknown、revision+1 的任务快照
        → transfer:list / TransferDrawer 展示「已中断」，不自动排队、不续传、不提供重试

手动重连（同一标签）
  → sessionStore.reconnectSession(tabId)（generation +1，解绑旧 sessionId）
    → bridge.ssh.disconnect(旧 sessionId)
    → bridge.ssh.connect(connectionId, 同一 tabId) → 新 sessionId
      → 旧 sessionId 的迟到事件被 terminalRuntime / sessionStore 忽略
      → 新 Shell 是新 PTY，不恢复旧远程进程
      → sftpStore 在 sessionId 变化时重置路径/条目，旧 SFTP 响应被守卫丢弃
```

- 服务器搜索词 `searchQuery` 存在 `connectionStore`，被侧栏与服务器页共享。
- SFTP 的当前路径、条目、加载/错误状态、选中项与进行中操作属于 `sftpStore`，按稳定标签 ID 索引；导航栈外的对话框与表单属于 `SftpView` 局部状态。
- 本地文件面板的当前路径、条目、根列表（home/驱动器）、排序与隐藏开关、选中项与加载/错误状态属于 `localPanelStore`，按稳定标签 ID 索引并以 `requestId` 守卫迟到响应；不保存文件内容，面板卸载或会话清理时按标签清理。
- 连接编辑器、删除确认属于 `connectionStore`；表单值属于 `ConnectionForm` 局部状态。
- Toast、bridge/安全状态属于 `appStore`。
- 主机密钥 challenge 队列与凭据提示元数据属于 `sshPromptStore`。
- 工作区 `tabOrder` / `activeTabId` 属于 `workspaceStore`；标签到 SSH 会话的显示镜像、`dismissedSessionIds`、`closingTabs` 与并发连接去重属于 `sessionStore`。
- Shell 生命周期快照属于 `terminalStore`，以稳定标签 ID 为键；终端输出、写队列、重放缓冲、标签 ↔ 会话绑定与尺寸去重属于模块级 `terminalRuntime`（同样按标签 ID 索引），不进入 React/Zustand。
- SFTP 通道、路径锁、待决请求与 home 解析属于主进程 `SftpService`，不进入渲染进程。
- 传输任务、队列、流、本地/远程临时文件路径、速度采样与清理状态属于主进程 `TransferService`；渲染端 `transferStore` 只保存任务快照投影、面板开关与同步错误，不保存文件句柄、流或任务真实状态。冲突输入、按钮忙碌状态与删除确认属于组件局部状态。
- 端口转发规则以主进程 `PortForwardRepository`（`port-forwards.json`）为持久化权威，运行时状态、监听器、Socket/Channel、连接计数与清理状态属于主进程 `PortForwardService`；渲染端 `portForwardStore` 只保存快照投影、请求中规则 ID 与编辑器/启动/删除目标，不保存监听器、流量或任务真实状态。连接删除的 impact 与级联确认状态属于 `connectionStore`。
- 应用设置以主进程 `SettingsRepository` 为持久化权威，渲染端 `settingsStore` 保存当前会话镜像、解析后的主题、加载状态、警告与错误；写入队列和本地 revision 位于模块级变量，不持久化。
- 壁纸图片以主进程 `WallpaperService` 与 `<userData>/wallpapers/` 为权威，渲染端 `wallpaperStore` 只保存主进程返回的 data URL、文件名、更新时间与操作状态；不使用浏览器存储，不读取本地文件。
- 日志内容、轮转与导出属于主进程 `Logger`/`LogService`；渲染端只保存 `LogInfo` 元数据与操作状态，从不接收日志行内容。
- 主机密钥信任记录以 `FileHostKeyStore` 为权威；设置页只保存列表副本与删除操作状态，不缓存指纹之外的数据。

## 6. 存储与生命周期

| 数据                     | 位置                                | 生命周期                                                              |
| ------------------------ | ----------------------------------- | --------------------------------------------------------------------- |
| 连接与分组               | `<userData>/connections.json`       | 跨重启持久化；首启种子；损坏则停止加载                                |
| 加密凭据条目             | `<userData>/credentials.enc.json`   | 跨重启持久化；无保护时拒绝操作；无明文回退                            |
| 主机密钥信任记录         | `<userData>/known-hosts.json`       | 显式接受后持久化；`verify` 不写入                                     |
| SSH 会话（客户端、状态） | 主进程内存                          | 每个标签一个独立会话；断开/取消/关闭标签/窗口关闭/应用退出时释放      |
| Shell/PTY（通道、状态）  | 主进程内存                          | Shell 打开期间；退出/关闭/SSH 断开/应用退出时释放                     |
| SFTP 通道与路径锁        | 主进程内存                          | 每 SSH 会话最多一条复用通道；SSH 断开/关闭标签/应用退出时释放         |
| SFTP 浏览状态            | `sftpStore`（按标签）               | 应用运行期间；切换会话/关闭标签后重置或清理                           |
| 本地面板浏览状态         | `localPanelStore`（按标签）         | 应用运行期间；按 `requestId` 守卫；会话清理时按标签清理               |
| 终端重放缓冲             | 渲染进程模块级内存（≤256 KiB/标签） | 标签存续；关闭标签/重连/重置时清理                                    |
| 渲染会话镜像             | `sessionStore`                      | 应用运行期间；被主进程快照覆盖                                        |
| 自动重连进度/定时器      | `sessionStore` + 模块级定时器       | 应用运行期间；取消/断开/关闭标签/设置关闭/退出时清除；不持久化        |
| 分屏布局与窗格绑定       | `workspaceStore`                    | 应用运行期间；不持久化；不拥有 SSH/PTY 生命周期                       |
| 主机密钥/凭据提示        | `sshPromptStore`                    | 应用运行期间；终态或用户操作后清理                                    |
| 传输任务/队列/历史       | 主进程 `TransferService` 内存       | 应用运行期间；结束任务可被清空；退出时中止并清理                      |
| 未完成传输快照           | `<userData>/transfer-journal.json`  | 最多 100 条；防抖/退出冲洗；重启水合为 `interrupted`，不恢复执行      |
| 传输临时文件             | 本地/远程目标目录                   | `.termforge-part-*`；取消/失败/退出时清理；覆盖提交短暂使用备份       |
| 传输任务投影             | `transferStore`                     | 应用运行期间；按 `revision` 合并；可随重置清空                        |
| 端口转发规则             | `<userData>/port-forwards.json`     | 跨重启持久化；损坏则停止加载；启动后规则保持 `stopped`                |
| 端口转发运行时           | 主进程内存                          | 仅运行期间；停止/会话结束/退出时关闭监听与连接，不持久化              |
| 端口转发快照             | `portForwardStore`                  | 应用运行期间；按 `revision` 合并；不保存监听器、流量或凭据            |
| 端口转发删除影响/确认    | `connectionStore`                   | 删除弹窗打开期间；失败可重试；不持久化                                |
| 自定义快速命令/收藏      | `<userData>/quick-commands.json`    | 跨重启持久化；损坏停止加载；内置命令不落盘                            |
| 命令历史                 | `<userData>/command-history.json`   | 跨重启持久化；最多 200 条；默认关闭；不额外加密                       |
| 快速命令投影/抽屉状态    | `quickCommandStore`                 | 应用运行期间；命令与历史投影、搜索、目标候选、弹窗状态                |
| 应用设置                 | `<userData>/settings.json`          | 跨重启持久化；损坏时逐字段恢复并保留原文件；v1–v5 读取时内存迁移至 v6 |
| 设置镜像/解析主题        | `settingsStore`                     | 应用运行期间；启动加载并在写失败时局部回滚                            |
| 壁纸图片/元数据          | `<userData>/wallpapers/`            | 跨重启持久化；重编码 JPEG + basename；移除时删除                      |
| 壁纸投影                 | `wallpaperStore`                    | 应用运行期间；只保存 data URL、文件名与更新时间                       |
| 诊断日志                 | `<userData>/logs/termforge*.log`    | 轮转保留最多 5 个文件；导出另存到用户选择路径                         |
| 主机密钥管理列表         | 渲染进程 `SettingsView` 局部状态    | 打开页面/手动刷新时读取；删除后重新加载                               |
| 应用信息                 | 主进程 `getAppInfo()`               | 每次启动通过 bridge 读取                                              |

## 7. 状态与资源不变量

- 主进程是 SSH 状态的唯一权威；渲染进程不把 `connected` 推断为终端已就绪，也不因点击按钮直接把标签视为已连接。
- Shell 状态同样以主进程为权威；`open` 只表示 PTY 通道就绪。
- 工作区标签 ID（`sshtab-<UUID>`）是稳定身份，同时作为主进程 `clientId`；标签生命周期独立于 SSH 会话，手动重连保留标签但更换 `sessionId`。
- 每个标签最多一个活动 SSH 会话；不同标签即使使用同一连接配置，也各自创建独立 Client 与 PTY，不共享 transport。
- 分屏固定两个窗格，布局只引用标签 ID，不拥有会话、PTY 或终端实例；绑定/解绑/焦点/比例变化不得调用 SSH connect/disconnect，也不得关闭或迁移任何会话。
- 自动重连只由固定错误码触发，最多 5 次并以 1/2/4/8/15 秒退避；每次尝试都创建新 `sessionId` 并重新执行认证与主机密钥校验。用户取消、主动断开、关闭标签、设置关闭或应用退出必须立即清除定时器与进度；不重放输入，不自动信任新密钥。
- `ssh:cancel-connect` 只终结指定 `clientId` 的在途尝试，返回 `cancelled: false` 表示没有可取消尝试或连接已完成；取消不得关闭标签，也不得影响其他窗格。
- 每个 session ID 只对应一个 SSH 记录与最多一个活动 Shell；Shell 退出后可在同一 SSH 会话上重开，但会创建新的 PTY，旧远程进程不会恢复。
- SFTP 是 SSH 会话的从属资源：只能对已存在且 `connected` 的会话打开，不能由渲染进程创建新连接；每个 SSH 会话最多复用一条 SFTP 通道。
- 每次 SFTP 调用都在主进程重新验证 `sessionId` 的归属与连接状态；渲染进程传入的 ID、路径与名称不能直接转为 Channel 访问。
- SFTP 路径始终是绝对 POSIX 形式；元数据缺失时使用 `null`，不以 0 或当前时间伪造；符号链接不跟随。
- 目录删除是非递归的：拒绝根目录、受保护的顶层系统目录、深度 <2 的目录、符号链接、非目录与非空目录；没有任何递归删除分支。
- 同一路径的变更操作在主进程加锁；并发重复请求返回 `conflict`，渲染端也在操作进行中禁用提交。操作成功后才重新加载目录；`outcome-unknown` 必须由用户刷新核实，不能自动重试。
- SFTP 请求以 `requestId` + `sessionId` 守卫：切换到新目录或新会话后，旧请求的迟到响应必须被丢弃，不能覆盖当前路径或条目。
- 关闭标签、SSH 断开、窗口关闭或应用退出会释放对应 SFTP 通道并拒绝待决操作；SFTP 不持久化路径、条目或通道，重启后从主目录重新读取。
- 传输任务以主进程为唯一权威；渲染端只在收到更大 `revision` 时更新任务，迟到 IPC 响应不会回退状态。渲染端不能指定 `id`、`sessionId`、总大小或任务状态；本地路径只能经两个显式入队通道提交，由主进程逐条重新校验后才读取任何文件。
- 本地文件列举是只读的：`localFs` 只返回元数据，条目中的符号链接只标记类型、不跟随目标；单目录 5,000 条上限超出时标记 `truncated`；旧会话或旧请求的迟到响应必须被 `requestId` 守卫丢弃，不能覆盖当前面板状态。
- 每个传输任务在开始前重新验证源、目标目录与冲突；临时文件必须位于目标同目录并带 `.termforge-part-` 前缀，提交是同目录 rename。非覆盖提交遇到已存在目标必须失败，不能静默替换。
- 取消排队或等待冲突的任务会立即结束；运行中取消先进入 `cancelling` 并销毁流，由收尾流程清理临时文件；提交开始后不可取消。
- 重试只针对 `failed/cancelled`，保留任务 ID 但递增 `attempt` 与 `revision`，并重新校验会话、源和目标；`interrupted` 明确拒绝重试，因为上次结果未知；不存在断点续传或暂停恢复。
- SSH 会话终止时，该会话的排队/等待冲突任务失败为 `connection-lost`，运行中任务中止；已开始提交的任务由提交流程收尾。
- 每个 SSH 会话最多 `transferMaxPerSession` 个活动传输（1–2），全局最多 `transferMaxConcurrent` 个（1–4，且不小于每会话上限）；任务占用的槽位在准备、取消与清理期间保持，结束后释放给下一个 FIFO 任务。降低上限不终止运行中任务，只影响后续调度。
- 关闭窗口与退出会请求停止传输并执行有界清理；未收敛任务留在传输日志中，重启后只显示 `interrupted`，无法确认清理时会明确提示临时文件可能残留，不声称已全部删除。
- 端口转发规则状态以主进程为唯一权威：`running` 只在监听器/远程绑定真实建立后出现，启动失败/停止失败/清理失败都必须保留 `error`（必要时 `cleanupPending`），渲染端不能因点击按钮或旧快照把规则视为运行中或已停止。
- 端口转发规则启动时绑定显式选择的 `sessionId`；SSH 会话结束/重连不会把规则静默迁移到新会话，也不会自动重启。应用重启后规则保持 `stopped`，不假定本地或远程监听仍然存在。
- 非回环本地/远程监听在启动时必须重新获得显式暴露确认；`dynamic` 监听地址固定为 `127.0.0.1`。远程服务器拒绝绑定时不得自动扩大地址或端口范围。
- 每个端口转发规则最多 64 个连接，全局最多 256 个；超出时拒绝新连接。停止/解绑最多等待 5 秒，未收敛必须保留 `cleanupPending` 并阻止删除规则/连接。
- 删除连接时先停止并删除该连接下的规则、后删除连接；有规则时必须显式级联确认。任一规则停止/清理失败都会中止删除，不能把未确认的清理描述为成功。
- 内置快速命令是只读诊断常量，只能收藏或复制，不能编辑/删除；自定义命令可修改，但应用不会在创建、启动、连接或重连时自动执行任何命令。
- 快速命令模板只做 `{{identifier}}` 字面单次替换，不使用 `eval`/`new Function`/本地 shell，也不承诺通用 shell 转义；主进程在发送时重新解析与渲染，不信任渲染端预览。
- 发送目标必须由用户显式选择；渲染端与主进程都校验 `tabId`/`sessionId` 绑定与 Shell `open`。目标关闭、断开或被替换时拒绝发送，不自动切换其他标签、不自动重发。
- 同一标签同时只允许一个快速命令发送在途；请求 ID 被主进程短期去重，重试复用同一 ID 不会重复写入。发送前必须冲刷该标签已排队的终端输入。
- 命令历史默认关闭；只有设置开启且本次发送勾选记录时才追加，关闭后不新增但保留已有记录。历史只保存最终渲染正文与目标元数据，不保存参数表、终端输入输出、退出码或凭据，也不写入诊断日志。
- 命令历史写入成功只表示“已记录这次写入”，不表示远端命令执行成功；写入终端后历史保存失败只返回警告，不回滚命令。
- `quick-commands.json` 与 `command-history.json` 都采用版本化 strict 信封、串行队列与原子替换；损坏文件不会被读取为可用数据，也不会在读取阶段被覆盖。历史文件不额外加密，依赖操作系统账户与磁盘权限。
- 删除自定义命令不会删除历史；清空历史不会删除自定义命令、设置或诊断日志。

- 设置写入是串行的：每次更新提交完整偏好对象，前一次写入完成后才执行下一次；失败只回滚仍未被后续修改的字段，内存状态与磁盘状态可能短暂不一致，但 UI 必须显示写入失败而不是假装成功。
- 设置文件损坏不会在读取阶段被覆盖；只有用户显式保存时才写入新的完整信封。
- 日志写入绝不抛出到业务调用；达到级别、轮转或目录不可用只影响诊断记录，不影响 SSH/SFTP/传输/设置功能。
- 日志与传输快照不包含终端输入/输出、文件内容或凭据；`interrupted` 快照中的路径仅用于展示，不能作为自动恢复依据。
- 临时文件清理只针对本任务创建并记录的 `.termforge-part-*`；不删除用户原有目标或与本任务无关的 `.termforge-*` 文件。
- 每个标签的 SFTP 浏览状态相互独立；多个标签即使连接同一服务器，也各自拥有独立 SSH 会话与 SFTP 通道。
- 关闭标签按顺序执行：标记 `closing` 并禁止交互 → 解绑终端 → 等待未决连接有界完成 → 请求主进程断开 → 移除标签；重复关闭是幂等的，迟到事件不会写回已关闭标签。
- 组件卸载/标签切换不清除 PTY；用户关闭 Shell、断开 SSH、关闭标签、窗口关闭或应用退出才释放通道。
- 终端输出不写盘、不进 Zustand；重放缓冲有 256 KiB/标签上限，标签移除后清理。高频输出只进入模块级运行时和 xterm。
- 主机密钥 challenge 在以下任一情况失效：用户响应、30 秒超时、连接取消、会话断开、窗口关闭、应用退出。
- 未决 challenge 失效时必须向 `ssh2` 回调 `false`，不得保留挂起 Promise。
- `dispose()` 后任何 SSH/终端/SFTP/传输服务调用都会失败关闭，包括 `getSftpClient`、全部 SFTP 操作与新的传输请求。
- 应用退出时先阻止新的连接/重连与传输，再按传输 → SFTP → SSH → 日志的顺序执行有界清理；每步独立超时，单步卡住不会阻止后续步骤。未收敛的传输以 `interrupted` 快照保留，退出流程不会把未确认任务标记为完成。
- 删除连接后相关会话标签关闭，主进程会话由渲染端请求断开；连接刷新后 `retainConnections` 清理陈旧标签。

## 8. 未来数据层建议（未实现）

1. **传输增强**：目录递归下载（本地目录浏览与目录递归上传已在 P1-01 实现）、带宽限制、暂停/恢复、断点续传、持久化审计历史；任何续传都必须重新校验源、目标与未完成日志，不能把旧临时文件或 `interrupted` 快照当作已完成证据。
2. **SFTP 增强**：原子重命名、服务端权限预检、可选的受控递归删除（必须显式确认）、目录变更推送与操作审计。
3. **主机密钥管理增强**：搜索、审计、导入/导出；删除仍必须显式确认，且不改变当前活动会话。
4. **凭据管理**：只读元数据列表、删除与审计；不向渲染进程返回秘密。
5. **分屏与重连增强**：更多窗格或可持久化布局、跨窗口附着与会话恢复提示；任何扩展都不得让布局拥有 SSH 生命周期，也不得改变自动重连的固定错误码、默认关闭与有限次数语义。自动重连本身已在 P1-05 实现，端口转发规则仍不得静默迁移到新会话。
6. **端口转发增强**：SOCKS5 认证、UDP ASSOCIATE/BIND、Unix 域套接字、流量统计与审计、显式应用重启恢复策略；规则持久化格式升级时需提供版本迁移并保持运行时不落盘。
7. **终端增强**：终端搜索、复制粘贴策略、会话恢复/多窗口附着；不得把输出改存到全局 React 状态。
8. **快速命令增强**：命令导入/导出、参数模板校验规则、可选输出捕获与执行结果；任何自动执行、批量多目标发送、历史加密或输出持久化都必须单独设计确认流程与存储边界，不能默认开启。
9. **模式迁移**：为设置、连接、端口转发规则、快速命令与传输日志的 `version` 增加显式迁移函数，并在写入前备份。
10. **日志治理**：大小/保留数量可配置、按级别分文件、导出前预览字节数；不得增加“读取任意日志内容”的 IPC。
