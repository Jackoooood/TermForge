# TermForge 测试计划（TASK-008 基线，TASK-009 打包验收，壁纸、P1-01 双栏文件管理、P1-02 跳板、P1-03 端口转发、P1-04 快速命令与 P1-05 会话分屏/自动重连扩展）

本文记录 TASK-008 的自动化测试范围、门禁命令、手工验收清单与未覆盖风险，并补充壁纸皮肤模式、设置页分类导航、P1-01 本地/远程双栏文件管理、P1-02 跳板链路、P1-03 SSH 端口转发、P1-04 快速命令/命令历史与 P1-05 两窗格会话分屏/连接取消/自动重连的测试。**类型检查、lint 与单元测试通过不等于完整安全验证**；真实 SSH/SFTP 服务端、真实端口转发链路、Electron 实窗、原生对话框与操作系统凭据存储仍需单独验收。P1-03 的真实 SSH 端口转发验收状态为**未执行**。P1-04 已在受控环境中用源码 Electron + 本机 `ssh2` 夹具 + 真实 Shell 执行 CDP 驱动验收（18/18 检查、10 张截图）。P1-05 同样使用源码 Electron + 本机 `ssh2` 夹具 + CDP 执行受控验收（19/19 检查、10 张截图），但两者都**不是** OpenSSH 服务端验收，也**不是**安装包内验收；P1-05 的真实网络抖动与长时间断网仍未执行。

## 1. 测试目标

1. 验证设置文件在主进程的版本化、strict 校验、逐字段恢复、原子写入与并发串行化。
2. 验证渲染端设置的启动加载、乐观更新、失败回滚、系统主题解析与缺少 bridge 时的降级。
3. 验证诊断日志的级别过滤、结构化写入、敏感信息脱敏、轮转、超长行截断与写入失败不抛错。
4. 验证退出编排的顺序、单步超时与失败隔离。
5. 验证传输并发上限可动态调整且不破坏运行中任务。
6. 验证未完成传输日志只水合为 `interrupted`，不自动恢复、不提供重试，并向用户如实展示。
7. 验证新增 IPC 的 sender/frame、参数 schema、preload 冻结命名空间与主机密钥删除确认。
8. 验证壁纸导入在主进程的格式/大小/解码校验、缩放与 JPEG 转码、原子持久化、删除与只返回 JPEG data URL。
9. 验证设置 v1 读取时静默补齐壁纸默认值、不产生警告且不立即重写文件。
10. 验证壁纸开关、浓度、导入与删除在设置页和 app shell 上的行为及自动启用/停用。
11. 验证设置页分类导航的默认分类、点击与键盘切换、单面板可见性和 ARIA tab 语义。
12. 回归既有 SSH/PTY/SFTP/传输行为，确保 TASK-008、壁纸扩展、设置分类导航与 P1-01 未降低既有边界。
13. 验证本地路径规范化/父路径/面包屑/拼接与名称校验、条目排序纯函数的边界（根、UNC、大小写、numeric）。
14. 验证 `localFs` 只读列举边界：strict schema、错误归一、隐藏标记与 5,000 条截断，不返回文件内容。
15. 验证显式路径上传的目录展开语义（符号链接不跟随、跳过/截断计数、深度与任务上限）与 `enqueueDownloadPaths` 的本地目录校验。
16. 验证拖拽载荷编解码与 `getPathForFile` 入口，以及 `localPanelStore` 的 `requestId` 守卫、排序/隐藏/选择与按标签清理。
17. 验证端口转发地址规范化（仅 IP 字面量）、回环判定与规则 strict schema：本地/远程默认 `127.0.0.1`，动态强制回环，拒绝端口、主机名、未知字段与携带秘密的字段。
18. 验证规则仓库的版本化、原子写入、100 条上限、类型/连接不可变更、损坏文件不被覆盖与并发串行化；运行时状态不落盘。
19. 验证窄接口 `SshForwardingSession` 的四参数 `forwardOut`、远程监听注册/注销与 `tcp connection` 精确分发，不暴露 `ssh2.Client`、Channel 或原始错误。
20. 验证本地、远程与动态转发运行时的绑定、字节转发、并发上限、失败归属、超时与幂等清理。
21. 验证 SOCKS5（RFC 1928）仅 no-auth CONNECT 的 IPv4/域名/IPv6、分片/粘包、协议拒绝码、握手超时与长度上限。
22. 验证 `PortForwardService` 以主进程实际绑定结果为准：启动只在监听成功后进入 `running`，会话关闭即停止且不重绑、不自动重启，`cleanupPending` 阻断危险操作，退出清理失败不报成功。
23. 验证 7 个端口转发 IPC 的 sender/frame/schema、快照事件命名与 preload 冻结命名空间，不暴露 Socket、payload 或流量数据。
24. 验证端口转发页、编辑器、启动确认与删除连接级联确认的 UI 行为，以及过期快照不得把规则标为运行中。
25. 回归既有 SSH/PTY/SFTP/传输/跳板/壁纸/设置行为，确保 P1-03 未降低既有边界。
26. 验证快速命令模板的 `{{identifier}}` 解析/渲染：单次字面量替换、最多 16 个参数、参数值映射与残留占位符/畸形占位符/控制字符拒绝，不使用 `eval`/`new Function`/本地 Shell。
27. 验证快速命令仓库的版本化、strict schema、内置命令只读且仅可收藏、自定义命令 CRUD 与 500/64 上限、损坏文件不被覆盖与并发写入串行化。
28. 验证命令历史仓库的版本化、strict schema、最近 200 条、单条删除与清空、损坏恢复，并确认历史与诊断日志分离。
29. 验证设置 v3 默认 `commandHistoryEnabled=false`，v1/v2 读取补齐字段且不丢失既有偏好、不产生警告、不立即改写文件。
30. 验证 `QuickCommandService` 的目标校验（`tabId`/`sessionId`/`clientId`/连接状态/Shell `open`）、请求 ID 去重、同标签单发送在途、服务端重渲染正文与历史写入时机。
31. 验证终端写入队列的冲刷与插入语义：插入不发送回车、发送复用既有 `terminal:write`→`writeShell` 通道，不新建独立 SSH Client 或 `exec` 通道。
32. 验证快速命令 store 与界面的目标捕获/显式选择、过期目标禁用、历史默认勾选可取消、命令库/历史操作、设置开关与清空确认。
33. 验证 P1-04 的 9 个快速命令/历史 IPC 与 P1-05 的 `ssh:cancel-connect` 的 sender/frame/schema、63 通道 preload 冻结命名空间，以及应用日志不包含命令正文、参数或终端输入输出。
34. 回归既有 SSH/PTY/SFTP/传输/跳板/壁纸/设置/端口转发行为，确保 P1-04 未降低既有边界。
35. 验证两窗格分屏纯函数与 `workspaceStore`：仅 `pane-a`/`pane-b`、方向/比例夹取、标签绑定唯一、焦点切换、空窗格分配、关闭标签解绑与关闭不触发 SSH 会话操作。
36. 验证分屏 UI：工具栏按钮、方向切换、退出分屏、空窗格会话选择、窗格聚焦/移除、分隔条键盘与指针比例调整，以及切换分屏不建立/断开 SSH 连接。
37. 验证 `ssh:cancel-connect` 的 strict `clientId` schema、sender/frame 校验、幂等语义、进行中连接取消、已连接会话不被断开、其他标签不受影响与迟到成功清理。
38. 验证自动重连只对固定 `SshFailure.code` 白名单触发，按 1/2/4/8/15 秒退避、最多 5 次，并在认证失败、主机密钥变化、主动断开、用户取消、标签关闭、应用退出与设置关闭时停止。
39. 验证设置 v4 的 `autoReconnectEnabled` 默认关闭、strict 布尔、v1/v2/v3 读取迁移与失败回滚；关闭开关立即清理等待中的计时器。
40. 验证分屏与自动重连状态不持久化，主进程不保存计时器/重试任务，且每次重试重新执行主机密钥与认证流程，不重放输入或自动信任主机密钥。
41. 回归既有 SSH/PTY/SFTP/传输/跳板/壁纸/设置/端口转发/快速命令行为，确保 P1-05 未降低既有边界。

## 2. 测试环境

| 项目     | 值                                                   |
| -------- | ---------------------------------------------------- |
| 操作系统 | Windows 10 19045 x64                                 |
| Node.js  | v24.18.0                                             |
| Electron | 45.0.0                                               |
| React    | 19.3.1                                               |
| Vitest   | 4.1.12                                               |
| 测试环境 | Node（主进程/存储/日志）与 jsdom（React 组件/store） |
| 日期     | 2026-10-24                                           |

测试不连接公网，不需要真实 SSH 服务器。主进程测试使用 fake `ssh2` Client/Channel、fake `SFTPWrapper`/传输端口；渲染测试使用 mock preload bridge 与 fake xterm。设置、日志、壁纸与显式路径传输测试使用真实临时目录和真实文件系统（P1-01 的目录展开、临时文件与提交使用真实本地文件流）；壁纸测试只 mock Electron `nativeImage` 的解码结果，不依赖真实图片解码器。P1-03 的本地转发与 SOCKS5 测试在 `127.0.0.1` 上创建真实 `net` 监听并连接，SSH 通道一侧仍为 fake `forwardOut`/`forwardIn` 端口；测试不连接任何外部 SSH 主机，也不验证真实服务器转发行为。P1-04 的单元测试使用 fake `SshService`/mock bridge；受控验收则启动源码 Electron（`isPackaged:false`）并连接本机 `ssh2` 测试服务端（真实密码认证、PTY/Shell），通过 CDP 驱动真实渲染进程输入并检查命令库、发送、历史、设置与日志文件。该验收**不是** OpenSSH 服务端、真实网络或安装包验收。P1-05 单元测试使用 fake `SshService`/mock bridge/fake xterm 验证分屏与重连状态机；受控验收启动源码 Electron + 本机 `ssh2` 夹具（真实密码认证、PTY/Shell、服务端主动关闭通道模拟意外断线），通过 CDP 驱动分屏、取消连接与自动重连并检查截图；真实 OpenSSH、真实网络抖动与安装包仍未执行。

## 3. 自动化测试范围

### 3.1 新增与重点扩展文件

| 文件                                           | 环境  | 重点覆盖                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/settingsRepository.test.ts`        | node  | 默认值不创建文件；版本化写入/重启读取；v1 读取时静默补壁纸默认值且不改写；v2/v1 读取补齐 `commandHistoryEnabled:false` 且保留既有值；v3 读取补齐 `autoReconnectEnabled:false` 并写入 v4；逐字段恢复警告且不覆盖原文件；损坏/不可读回退；非法更新与写入失败保持内存状态；并发更新串行化                                                                                                                                                                                        |
| `tests/unit/settingsStore.test.ts`             | jsdom | 读取持久化偏好与警告；乐观更新并提交完整偏好；写失败局部回滚与 Toast；非法补丁不调用 bridge；系统主题与 OS 变化；缺少 bridge 时会话内降级                                                                                                                                                                                                                                                                                                                                     |
| `tests/unit/settingsView.test.tsx`             | jsdom | 默认选中外观、8 类分类的点击与方向键/Home/End 切换、单面板可见；系统主题、日志级别、全局并发保存；壁纸导入后自动启用、开关、浓度与删除；命令历史开关与清空确认、明文披露；自动重连默认关闭、开启保存与说明文案；日志信息/导出/打开目录；主机密钥删除必须确认；设置读取失败横幅与重试                                                                                                                                                                                          |
| `tests/unit/wallpaperService.test.ts`          | node  | 空状态；取消；扩展名/大小/非普通文件拒绝；解码失败；最大边 2560 缩放与 JPEG q85；不放大小图；原子写入与数据 URL；写失败无临时残留；元数据损坏；删除                                                                                                                                                                                                                                                                                                                           |
| `tests/unit/wallpaperStore.test.ts`            | jsdom | 启动加载；导入后自动启用一次；取消不改变状态；导入失败只提示不启用；删除后清空并停用；busy 防重入                                                                                                                                                                                                                                                                                                                                                                             |
| `tests/unit/logging.test.ts`                   | node  | PEM/密码/API key/Authorization/URI 凭据脱敏；嵌套敏感键；Error/cause/循环引用；字符串/数组/深度上限；级别过滤；JSONL；轮转；目录不可用；超长行截断                                                                                                                                                                                                                                                                                                                            |
| `tests/unit/shutdown.test.ts`                  | node  | 顺序执行；单步失败隔离；卡住步骤超时后继续；空报告                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tests/unit/transferQueue.test.ts`             | node  | 动态上限与夹取；运行中降低上限自然收敛；非法上限不破坏现有配置                                                                                                                                                                                                                                                                                                                                                                                                                |
| `tests/unit/transferService.test.ts`           | node  | 传输日志水合为 `interrupted`/`outcome-unknown`、revision 递增、通知、重试拒绝；活动任务防抖写盘；损坏日志忽略；显式路径上传的顶层文件/目录 BFS 展开、符号链接与不支持类型计数、深层目录与任务上限截断、非法与不存在路径拒绝；显式路径下载的本地目录校验与根目录拒绝                                                                                                                                                                                                           |
| `tests/unit/transferDrawer.test.tsx`           | jsdom | `interrupted` 显示「已中断」、结果未知、无重试、真实重启说明                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tests/unit/xtermTerminal.test.tsx`            | jsdom | 字体/字号/光标/闪烁/回滚/主题实时应用；重新 fit；PTY 不重建；终端实例唯一                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tests/unit/mainIpc.test.ts`                   | node  | 63 通道；settings/host-keys/logs/wallpaper/local-fs/transfer/port-forwards/quick-commands/command-history/ssh 的 sender、schema、dispatch；`ssh:cancel-connect` 只接受 `clientId`；壁纸错误脱敏；端口转发启动确认与快照事件；快速命令执行与历史通道；删除连接的级联影响复核；既有通道回归                                                                                                                                                                                     |
| `tests/unit/preloadBridge.test.ts`             | node  | 冻结命名空间（含 `localFs`、`getPathForFile`、`portForwards`、`quickCommands`、`commandHistory` 与 `ssh.cancelConnect`）；新增方法调用固定通道；63 次 invoke；订阅取消幂等                                                                                                                                                                                                                                                                                                    |
| `tests/unit/appShell.test.tsx`                 | jsdom | 壁纸启用时 app shell 输出 `data-wallpaper`/浓度与内联 `--tf-wallpaper-image`；无壁纸时保持关闭                                                                                                                                                                                                                                                                                                                                                                                |
| `tests/unit/localPath.test.ts`                 | node  | 归一化/父路径/面包屑/拼接与名称校验；排序分组（目录→链接→文件、numeric、大小写）；`/` 根与 UNC 边界；跨分隔符 `..` 逃逸折叠                                                                                                                                                                                                                                                                                                                                                   |
| `tests/unit/localFsService.test.ts`            | node  | roots/list 只读列举；不存在/非目录/无权限错误归一为固定码；隐藏标记与 5,000 条截断；不读取文件内容；条目中的符号链接只标记不跟随                                                                                                                                                                                                                                                                                                                                              |
| `tests/unit/localPanelStore.test.ts`           | jsdom | 按标签初始化与根列表；加载/刷新/排序/隐藏/选择；`requestId` 守卫丢弃迟到响应；失败提示；`reset`/`forgetTab` 按标签清理                                                                                                                                                                                                                                                                                                                                                        |
| `tests/unit/fileDrag.test.tsx`                 | jsdom | 两个自定义 MIME 载荷编解码；跨会话载荷与非法 JSON 拒绝；OS 文件经 `getPathForFile` 且空路径忽略；`useDropZone` 计数防闪烁                                                                                                                                                                                                                                                                                                                                                     |
| `tests/unit/connectionSchemas.test.ts`         | node  | 跳板引用 schema（有序、去重、禁自引用、存在性、上限 4）；悬空/自引用/成环在 catalog 校验中拒绝；旧载荷缺省 `jumpConnectionIds` 补 `[]`；`parsePersistedConnectionCatalog` 的 v1 迁移（补空数组、标记 `migratedFromVersion`）、v2 通过、version 3/损坏/重复 id 拒绝                                                                                                                                                                                                            |
| `tests/unit/localStorage.test.ts`              | node  | repository 创建/更新时的跳板校验（缺失引用、自引用、反向成环提示文案）；删除跳板连接后级联剥离引用并更新 `updatedAt`；v1 文件加载后写回 v2；v1 内悬空 groupId 重验证失败判定 storage-corrupt 且不动原文件                                                                                                                                                                                                                                                                     |
| `tests/unit/sshService.test.ts`                | node  | 除既有 SSH 用例外的跳板链用例：直连回归无转发；单跳/两跳 `forwardOut(srcIP, srcPort, dstIP, dstPort)` 参数与 `sock` 链接顺序；每跳独立主机密钥验证与挑战（跳板 challenge 带 `hop`）；跳板凭据失败归属跳；跳板主机密钥变化阻断；拨号失败归属下一端点；跳板掉线中断目标；断开自内向外且无孤立 destroy；同连接并发会话隔离。P1-05 新增：`cancelConnect` 取消进行中连接、收敛为 `disconnected(cancelled)`、幂等、不关闭标签/不影响其他会话，迟到成功按 epoch 丢弃并清理 transport |
| `tests/unit/connectionForm.test.tsx`           | jsdom | 跳板编辑器：从已保存连接添加/上移/下移/移除、路径预览文案、提交载荷 `jumpConnectionIds`；编辑模式排除自身；达到 `MAX_JUMP_HOPS` 后控件禁用与提示                                                                                                                                                                                                                                                                                                                              |
| `tests/unit/portForwardAddress.test.ts`        | node  | IPv4 与带括号 IPv6 规范化；拒绝主机名、畸形字面量与越界字节；仅 `127.0.0.0/8` 与 `::1` 视为回环；16 字节 IPv6 格式化                                                                                                                                                                                                                                                                                                                                                          |
| `tests/unit/portForwardSchema.test.ts`         | node  | 本地/远程默认回环并可规范化；动态强制回环且拒绝客户端选择地址；端口/主机名/携带秘密字段拒绝；更新判别式不允许切换类型；版本信封与重复 id；启动请求的 `confirmExposure` 默认 `false`                                                                                                                                                                                                                                                                                           |
| `tests/unit/portForwardRepository.test.ts`     | node  | 首次加载空版本化存储与原子写入；动态规则强制回环；更新不可更换连接或类型；非法规则零写入；单条/按连接删除；100 条上限；损坏或版本不支持不覆盖；并发创建串行化                                                                                                                                                                                                                                                                                                                 |
| `tests/unit/sshForwardingSession.test.ts`      | node  | 四个显式 `forwardOut` 参数按序传递；通道打开与绑定错误传播；`forwardIn`/`unforwardIn` 参数；`tcp connection` 只交给一个监听器；拒绝未处理/畸形/未决/抛错连接；关闭后停止分发且幂等；迟到通道被销毁                                                                                                                                                                                                                                                                            |
| `tests/unit/portForwardRuntimeSupport.test.ts` | node  | 单规则并发上限与槽位一次性释放；全局闸门跨规则共享且 `releaseAll` 清空；双向管道关闭时只销毁两端一次                                                                                                                                                                                                                                                                                                                                                                          |
| `tests/unit/portForwardLocalRuntime.test.ts`   | node  | 监听请求地址并经 `forwardOut` 转发字节；单个目标通道失败不关闭监听；绑定失败返回错误且无残留监听；停止关闭监听与全部连接一次                                                                                                                                                                                                                                                                                                                                                  |
| `tests/unit/portForwardRemoteRuntime.test.ts`  | node  | 匹配端点入站连接转到本地目标；拒绝其他远程端点；远程绑定失败停止接收；`forwardIn` 挂起超时与迟到绑定解绑；绑定端口不匹配时解绑实际端口；停止拆除连接并只解绑一次；解绑失败可重试；会话已关闭时跳过解绑                                                                                                                                                                                                                                                                        |
| `tests/unit/portForwardDynamicRuntime.test.ts` | node  | IPv4 CONNECT 转发到目标；域名 CONNECT 同包负载保留；协议错误回包后监听仍可用；通道失败回 `general failure`；静默客户端握手超时；单规则连接上限与释放；停止关闭监听与活动连接                                                                                                                                                                                                                                                                                                  |
| `tests/unit/socks5Protocol.test.ts`            | node  | 分片 no-auth IPv4 CONNECT；域名 CONNECT 粘包负载；IPv6 CONNECT；BIND 回 `0x07`；不支持地址类型回 `0x08`；仅不支持认证方法回 `0xff`；保留字段/零端口回一般失败；空域名拒绝并移除监听；版本不支持直接关闭；静默超时清理；握手字节超限安全失败                                                                                                                                                                                                                                   |
| `tests/unit/portForwardService.test.ts`        | node  | 持久化规则以 `stopped` 列出且不触碰 SSH；CRUD 与快照发布；未知连接拒绝；仅连接状态匹配的会话可启动并报告实际端口；动态规则启动；本地绑定失败进入 `error` 而非 `running`；非回环暴露确认；错误会话拒绝；会话关闭停止且不重绑；解绑失败进入 `cleanupPending` 并阻断编辑/删除/重启；连接级联删除失败中止并可重试；活动规则上限与退出停止；清理失败不报告成功关闭                                                                                                                 |
| `tests/unit/portForwardUi.test.tsx`            | jsdom | 仅渲染主进程权威状态、实际绑定端点与失败；非回环启动必须勾选暴露确认；无匹配已连接会话时拒绝启动；新建本地规则默认回环；忽略过期快照且被拒绝的启动不会把规则标为运行中                                                                                                                                                                                                                                                                                                        |
| `tests/unit/connectionManagement.test.tsx`     | jsdom | 删除连接确认；持久化失败保留对话框与安全错误；级联删除端口转发规则需显式勾选确认；影响检查完成前禁止删除；影响加载失败显示重试而非空列表                                                                                                                                                                                                                                                                                                                                      |
| `tests/unit/quickCommandTemplate.test.ts`      | node  | 占位符解析与顺序；单次字面量替换（值中的 `{{x}}` 不再二次展开）；参数值映射；残留/畸形/未闭合占位符、重复参数、超过 16 个参数、控制字符与超长输入拒绝；渲染结果去除尾部换行                                                                                                                                                                                                                                                                                                   |
| `tests/unit/quickCommandRepository.test.ts`    | node  | 首次加载空版本化状态与原子写入；内置命令不可创建/修改/删除、只能收藏且上限 64；自定义命令创建/更新/删除、名称/正文 strict 校验、500 条上限；损坏或版本不支持不覆盖；并发写入串行化                                                                                                                                                                                                                                                                                            |
| `tests/unit/commandHistoryRepository.test.ts`  | node  | 版本化 `{version:1,data:{entries}}`；最近 200 条；单条删除与幂等；清空并在损坏时重建空状态；strict schema 拒绝未知字段与重复 ID；并发追加串行化                                                                                                                                                                                                                                                                                                                               |
| `tests/unit/quickCommandService.test.ts`       | node  | 内置在前、自定义按更新时间排序与收藏合并；参数渲染后仅写入“预览正文 + 一个回车”；历史关闭时不记录；历史持久化失败不改变发送成功；目标 tab/session 变化、断连与 Shell 关闭时零写入且不重定向；参数集合不匹配拒绝；请求 ID 去重与同标签单在途；历史重发不做模板处理；未知内置收藏拒绝                                                                                                                                                                                           |
| `tests/unit/quickCommandStore.test.ts`         | jsdom | 无 bridge 降级；库/历史加载与错误；抽屉打开捕获可发送目标；保存/删除/收藏后本地合并；插入校验目标且不自动发送；发送前冲刷终端队列并在目标变化时中止；请求 ID 由 compose 会话复用                                                                                                                                                                                                                                                                                              |
| `tests/unit/quickCommandUi.test.tsx`           | jsdom | 内置命令只读但可收藏、自定义可编辑；历史关闭披露与清空二次确认；预览渲染参数、预选捕获目标、历史勾选默认开启；捕获目标失效时不自动切换并要求重新选择；全局关闭时强制不记录；插入历史正文不执行；编辑器推导参数、拒绝畸形正文并保存                                                                                                                                                                                                                                            |
| `tests/unit/terminalRuntime.test.ts`           | jsdom | 既有 PTY/输出/粘贴用例之外，新增排队输入后插入不带换行、flush 等待活动队列与按标签隔离                                                                                                                                                                                                                                                                                                                                                                                        |
| `tests/unit/stores.test.ts`                    | jsdom | 既有工作区/SFTP/端口转发 store 回归之外，新增连接取消与手动重连取消、迟到成功断开、关闭标签清理；自动重连仅在可重试失败后调度、1/2/4/8/15 秒退避、5 次上限、成功清除、主动断开/取消/设置关闭/标签关闭中止且不重放输入                                                                                                                                                                                                                                                         |
| `tests/unit/workspaceSplit.test.ts`            | jsdom | 分屏默认关闭、方向/比例夹取；开启时绑定活动标签与第二个标签、空窗格分配、焦点切换、绑定唯一性；关闭标签解绑但不影响其他标签；移除窗格绑定；分屏纯函数不涉及 SSH 会话                                                                                                                                                                                                                                                                                                          |
| `tests/unit/terminalSplitUi.test.tsx`          | jsdom | 左右/上下分屏按钮、方向切换与退出；空窗格下拉选择、无候选禁用；窗格聚焦、移除仅解绑；分隔条键盘/双击比例与 ARIA；分屏切换不调用 SSH 连接/断开                                                                                                                                                                                                                                                                                                                                 |
| `tests/unit/autoReconnectUi.test.tsx`          | jsdom | 等待重试倒计时与「停止自动重连」、进行中「取消自动重连」、耗尽终态；提示文案不声称恢复旧 Shell 或重放输入；取消回调调用                                                                                                                                                                                                                                                                                                                                                       |

### 3.2 回归套件

完整套件现有 57 个测试文件，覆盖连接 schema/仓库（含跳板引用与 v1→v2 迁移）、凭据库与解析、主机密钥、SSH 服务（含跳板链式连接、失败归属与连接取消）、PTY 与终端运行时（含输入队列与插入）、多标签与分屏 store、自动重连状态机、SFTP 路径/服务/store、本地路径纯函数与 `localFs` 服务、本地面板 store 与拖拽载荷、传输服务/队列/事件/抽屉（含显式路径展开）、设置仓库/store/页面（含分类导航、命令历史与自动重连开关）、日志、关闭编排、壁纸服务/store 与组件/app shell、连接表单跳板编辑器、P1-03 的端口转发地址/schema/仓库、窄接口、本地/远程/动态运行时、SOCKS5 协议、服务状态机、IPC/preload、页面与删除级联、P1-04 的模板/快速命令仓库/历史仓库/发送服务/store/界面，以及 P1-05 的分屏模型/UI、自动重连 UI 与取消连接。`npm test` 结果为 57 个文件、530 个用例全部通过（2026-10-24 P1-05 重跑：`Test Files 57 passed (57)`、`Tests 530 passed (530)`、`Duration 24.39s`）；其中 3 个 P1-05 新增文件 22 个用例全部通过（分屏模型 13、分屏 UI 6、自动重连 UI 3），相关修改套件（`stores`、`sshService`、`settingsRepository`、`settingsView`、`mainIpc`、`preloadBridge`、`fakeBridge`）无回归。

## 4. 安全与边界测试矩阵

| 边界              | 自动化断言                                                                                                                                                                  | 结果                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| IPC sender/frame  | 无主窗口、伪造 sender/frame 均拒绝；新通道同样调用 `assertTrustedSender`                                                                                                    | 通过                    |
| 设置参数          | strict schema；主题/字体/字号/回滚/并发/日志级别白名单；未知字段、NaN、越界整体拒绝；拒绝时零写入                                                                           | 通过                    |
| 设置持久化        | 版本信封；默认值不落盘；损坏文件逐字段恢复且不覆盖；写失败不更新内存                                                                                                        | 通过                    |
| 设置并发          | 多次更新串行执行，最终状态与最后一次成功写入一致                                                                                                                            | 通过                    |
| 设置 UI 失败      | bridge 失败回滚未被后续修改的字段；显示危险 Toast；不显示成功                                                                                                               | 通过                    |
| 设置分类导航      | 默认选中外观；8 个 `tab` 只有一个可见 `tabpanel`；点击与方向键/Home/End 同步选中态、焦点和内容                                                                              | 通过（单测 + 实窗）     |
| 日志脱敏          | 敏感键名、PEM、`password=...`、`api_key:`、`Authorization`、URI 内嵌凭据、循环引用与超深对象                                                                                | 通过                    |
| 日志容量          | 单行 16 KiB 降级；文件轮转保留数量；字符串/数组/深度上限；不可用目录只计数不抛错                                                                                            | 通过                    |
| 日志导出          | 渲染端不能提交路径；导出由主进程对话框决定；读取上限 20 MiB；不提供内容读取 IPC                                                                                             | 代码审查 + mainIpc 测试 |
| 主机密钥删除      | 只接受合法 host/port；未知端点 `removed:false`；UI 必须确认；不调用 SSH 断开                                                                                                | 通过                    |
| 凭据清理          | 删除连接后尝试删除三个凭据引用；cleanup 失败不回滚连接，也不返回秘密                                                                                                        | 通过                    |
| 传输并发          | 全局 1–4、每会话 1–2；每会话夹到全局；运行中降上限不终止任务；非法值拒绝                                                                                                    | 通过                    |
| 本地路径 schema   | 绝对路径、1–4,096 字符；NUL/控制字符与 `\\.\`/`\\?\` 前缀拒绝；未知字段整体拒绝                                                                                             | 通过                    |
| 本地列举          | 不存在/非目录归一为固定错误码；隐藏标记、5,000 条截断；不返回文件内容、原始 `fs` 错误或句柄                                                                                 | 通过                    |
| 显式路径上传      | 顶层文件直落目标目录；目录 BFS 展开保留源文件夹名；符号链接与不支持类型按计数跳过；超出深度上限 64 的目录计入跳过；展开任务上限 500 超出后 `truncated`                      | 通过                    |
| 显式路径下载      | 本地目录必须存在；远程根目录 `/` 与本地磁盘根目录作为目标均被拒绝；批量 1–50                                                                                                | 通过                    |
| 拖拽载荷          | 只接受两个自定义 MIME；跨会话载荷与非法 JSON 拒绝；OS 文件经 `getPathForFile`，空路径被忽略                                                                                 | 通过                    |
| 跳板引用校验      | 重复/自引用/悬空引用/成环/超过 4 个整体拒绝；`remove` 级联剥离引用；v1→v2 迁移只补空数组不猜引用                                                                            | 通过                    |
| 跳板链路拨号      | 直连无 `forwardOut`；每跳 `forwardOut` 指向下一端点（最后一跳拨目标）；目标 Client 的 `sock` 为上一跳转发通道；快照 `jumps`/`activeHop` 不含凭据                            | 通过                    |
| 跳板安全隔离      | 每跳按自身 `host:port` 独立验证主机密钥；跳板 challenge 带 `hop` 且信任只落该端点；跳板被信任不使目标被信任                                                                 | 通过                    |
| 跳板失败归属      | 认证失败/主机密钥变化/拨号失败/跳板掉线带 `hop`；`forwardOut` 失败归属正在拨往的下一端点；任一跳失败销毁已建 Client                                                         | 通过                    |
| 跳板资源清理      | 断开按依赖自内向外 `end()`；终态只推送一次；同一连接并发会话互不影响                                                                                                        | 通过                    |
| 传输中断          | 日志 strict 校验；只生成 `interrupted`；revision+1；不重新入队；重试返回冲突/未知结果；无重试按钮                                                                           | 通过                    |
| 关闭编排          | 顺序执行；单步超时/失败后继续；退出只执行一次                                                                                                                               | 通过                    |
| 壁纸导入          | 仅 `.png/.jpg/.jpeg`、≤20 MiB、必须是普通文件；解码为空/JPEG 为空/写入失败均返回固定错误；写失败不留临时文件                                                                | 通过                    |
| 壁纸转码          | 最大边超过 2560 时等比缩小到 2560；小图不放大；固定 JPEG q85；只返回 JPEG data URL                                                                                          | 通过                    |
| 壁纸持久化        | 写入 `wallpapers/wallpaper.jpg` 与 `wallpaper.json`；删除同时清理两者；元数据损坏时仍提供图片但不显示文件名                                                                 | 通过                    |
| 壁纸设置迁移      | 读取 v1 设置时静默补 `wallpaperEnabled:false`/`wallpaperIntensity:'balanced'`；无警告、不立即改写                                                                           | 通过                    |
| 壁纸渲染          | 只有启用且存在 data URL 时输出 `data-wallpaper="on"`、浓度与 `--tf-wallpaper-image`；删除后停用                                                                             | 通过                    |
| 壁纸 IPC          | 三个通道均有 sender 校验、固定 dispatch；服务内部错误被归一为固定消息，不泄露路径或原始错误                                                                                 | 通过                    |
| 转发地址与 schema | 仅接受 IPv4/IPv6 字面量；本地/远程默认 `127.0.0.1`；动态固定回环；端口 1–65535；拒绝主机名、未知字段与秘密字段；更新不可切换类型或连接                                      | 通过                    |
| 规则持久化        | `{version:1,data:{rules}}` 版本信封；原子写入；上限 100；运行时状态不落盘；损坏/不支持版本不覆盖；并发创建串行化                                                            | 通过                    |
| 转发窄接口        | `forwardOut` 四参数按序传递；只暴露 `Duplex` 与绑定端点；`tcp connection` 只分发一次；迟到/畸形/未决连接拒绝；关闭后幂等停止                                                | 通过                    |
| 本地转发运行时    | 监听请求地址并转发字节；单通道失败不影响监听；绑定失败进入错误状态且无残留监听；停止关闭监听与全部连接一次                                                                  | 通过                    |
| 远程转发运行时    | 只接受匹配端点；`forwardIn` 超时与迟到绑定会解绑；绑定端口不匹配时解绑实际端口；停止拆除连接并只解绑一次；解绑失败可重试；会话已关闭时不解绑                                | 通过                    |
| SOCKS5 协议       | 仅 no-auth CONNECT；IPv4/域名/IPv6；分片与粘包；BIND 回 `0x07`、未知地址类型回 `0x08`、认证方法不支持回 `0xff`、保留字段/零端口回一般失败；版本错误关闭；超时与握手长度上限 | 通过                    |
| 动态转发运行时    | CONNECT 经 `forwardOut` 转发；通道失败回一般失败且监听继续可用；静默客户端握手超时；单规则连接上限；停止关闭监听与连接                                                      | 通过                    |
| 转发状态机        | 规则默认 `stopped`；只在监听成功后进入 `running`；绑定失败为 `error`；会话关闭即停止且不重绑；不自动重启；`cleanupPending` 阻断编辑/删除/重启；退出清理失败不报告成功       | 通过                    |
| 暴露确认          | 非回环绑定必须 `confirmExposure`；服务端拒绝不会放宽绑定；远程默认 `127.0.0.1`；动态监听强制 `127.0.0.1`                                                                    | 通过                    |
| 端口转发 IPC      | 7 个通道均校验 sender/frame 与 strict schema；`port-forwards:snapshot-updated` 推送快照；不提供 payload、Socket、句柄或流量读取                                             | 通过                    |
| 连接级联删除      | 影响检查失败不得显示为空；需显式勾选确认；任一规则停止失败中止删除并可重试；删除顺序为先规则后连接                                                                          | 通过                    |
| 快速命令模板      | 仅 `{{identifier}}`；单次字面量替换不做二次展开；最多 16 个参数；拒绝残留/畸形/未闭合占位符、重复参数与控制字符；不使用 `eval`/`new Function`/本地 Shell                    | 通过                    |
| 快速命令仓库      | 版本化与原子写入；内置命令只读且仅可收藏（上限 64）；自定义 500 条上限；非法草稿零写入；损坏/版本不支持不覆盖；并发写入串行化                                               | 通过                    |
| 命令历史存储      | `{version:1,data:{entries}}` strict；最近 200 条；单条删除与清空；损坏时清空重建空状态；未知字段/重复 ID 拒绝；与应用日志分离                                               | 通过                    |
| 历史默认关闭      | 新安装 `commandHistoryEnabled=false`；全局关闭时发送不写历史；设置开关开启后发送框默认勾选且可取消；关闭时 UI 明确披露                                                      | 通过                    |
| 快速命令目标      | 校验 `tabId`/`sessionId`/`clientId`/连接状态/Shell `open`；目标失效时零写入且不切换；flush 后再次校验；请求 ID 去重与同标签单在途                                           | 通过                    |
| 终端通道复用      | 插入不带换行、不自动执行；发送追加一个回车；仅经既有 `terminal:write`→`writeShell`；不新建 SSH Client 或 `exec` 通道                                                        | 通过                    |
| 命令历史隐私      | 只记录显式成功发送的渲染后正文与目标元数据；不记录终端输出/退出码/原始输入；应用日志不包含命令正文、参数或历史内容                                                          | 通过                    |
| 快速命令 IPC      | 9 个通道校验 sender/frame 与 strict schema；不提供任意执行、输出读取或日志内容读取；错误归一为固定消息                                                                      | 通过                    |
| 设置 v3           | `SETTINGS_STORE_VERSION=3`；`commandHistoryEnabled` 默认 `false`；v1/v2 读取补齐字段且不丢失既有值、不立即改写文件                                                          | 通过                    |
| 快速命令 UI       | 预览后才可发送；显式选择目标；过期目标禁用确认；内置只读；历史勾选可取消；清空需二次确认                                                                                    | 通过                    |
| 设置 v4           | `SETTINGS_STORE_VERSION=4`；`autoReconnectEnabled` 默认 `false` 且 strict 布尔；v1/v2/v3 读取补齐字段、保留既有偏好并内存迁移；写失败回滚                                   | 通过                    |
| 分屏模型          | 仅两个窗格；比例 20%–80%、默认 50%；标签绑定唯一；焦点切换、空窗格分配、关闭标签解绑；纯函数不调用 SSH 连接/断开                                                            | 通过                    |
| 分屏 UI           | 工具栏方向切换/退出、空窗格选择、窗格聚焦/移除、分隔条键盘与双击；切换分屏不建立或断开 SSH 会话；另一窗格状态不被改写                                                       | 通过                    |
| 取消连接          | `ssh:cancel-connect` 只接受 `sshtab-<UUID>`；幂等；取消进行中尝试并收敛为 `disconnected(cancelled)`；不关闭标签、不影响已连接会话或其他标签；迟到成功被断开清理             | 通过                    |
| 自动重连触发      | 只对 `network-error`/`connection-timeout`/`dns-failed`/`connection-refused`/`remote-closed` 调度；认证失败、主机密钥变化、主动断开、用户取消不调度                          | 通过                    |
| 自动重连边界      | 最多 5 次、1/2/4/8/15 秒退避；成功清除；取消/关闭标签/应用退出/设置关闭清理计时器；达到上限为 `exhausted` 终态                                                              | 通过                    |
| 自动重连安全      | 每次重试重新执行主机密钥与认证流程；不自动信任、不忽略认证失败；不重放终端输入、快速命令或未确认数据；不声称旧 Shell 已恢复                                                 | 通过（单测 + 受控验收） |
| 运行态不持久化    | 分屏布局/绑定/焦点、自动重连计时器与尝试次数不写入设置或会话存储；主进程不保存重连任务                                                                                      | 通过                    |
| 既有 IPC/preload  | 63 通道全部有对应冻结方法与 invoke 次数；订阅取消幂等                                                                                                                       | 通过                    |

## 5. 门禁命令与结果（2026-10-24 P1-05 重跑）

| 命令                | 结果                               | 证据摘要                                                                                                                                               |
| ------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run typecheck` | 通过（EXIT=0）                     | `tsc --noEmit --composite false` 检查 Node 侧与 Web 侧，无错误（P1-05 重跑）                                                                           |
| `npm run lint`      | 通过（EXIT=0，`--max-warnings 0`） | `eslint . --max-warnings 0` 无警告（P1-05 重跑；修复验收脚本未使用变量后通过）                                                                         |
| `npm test`          | 通过（EXIT=0）                     | `Test Files 57 passed (57)`、`Tests 530 passed (530)`，`Duration 24.39s`；P1-05 新增 3 个文件 22 用例全部通过（分屏模型 13、分屏 UI 6、自动重连 UI 3） |
| `npm run build`     | 通过（EXIT=0）                     | 构建成功；仅 2 条既有 zod Rollup 注释提示（`node_modules/zod/v4/core/regexes.js`、`node_modules/zod/v4/core/util.js`），无新增警告                     |

构建提示来自 zod 包内注释位置，Rollup 会移除注释，不影响产物。未运行打包、签名或安装包测试。P1-04 受控验收使用 `tests/acceptance/quick-command-runtime.mjs`，结果为 `{"status":"passed","checks":18,"screenshots":10}`，产物位于 `release/acceptance/p1-04-quick-commands/`。P1-05 受控验收使用 `tests/acceptance/split-reconnect-runtime.mjs` 启动源码 Electron（`isPackaged:false`）+ 本机 `ssh2` 测试服务端（真实密码认证、PTY/Shell、服务端主动结束通道模拟意外断线）+ CDP，结果为 `{"status":"passed","checks":19,"screenshots":10}`，产物位于 `release/acceptance/p1-05-split-reconnect/`；覆盖两窗格分屏与方向/比例、空窗格、取消连接、意外断线与有界自动重连、设置 v4；报告明确记录 `realOpenSsh: "not executed"`、`networkJitter: "not executed"`。两者都**不覆盖** OpenSSH 服务端、安装包、真实网络与逐项 UI 手工点击。P1-03 的真实 SSH 端口转发验收状态仍为**未执行**。

## 6. 手工/受控验收清单（部分执行）

以下场景大部分**没有**在 Electron 实窗或真实服务器执行，不得在交付报告中标记为通过（例外：壁纸启用态（浓）、快捷菜单与关闭后恢复纯色已于 2026-10-22 在开发构建的 Electron 实窗中通过隔离 `userData` + CDP 检查；设置分类导航的默认外观、点击与方向键/Home/End 切换、单面板可见、960px 横向标签条以及壁纸态香槟金活动项已于 2026-10-23 在 `npm run build` 产物中通过隔离 `--user-data-dir` + CDP 检查；设置页内容区铺满工作区、服务器侧栏展开/收起时左右边距均为 20px、960px 窄屏布局与 1200×500 短窗内部滚动也于 2026-10-23 以同样方式验证；P1-04 的快速命令库/快捷键/真实 Shell 发送与插入/历史开关/自定义命令预览/历史记录/双会话过期目标/删除与清空/v3 设置与日志检查已于 2026-10-23 用源码 Electron + 本机 `ssh2` 夹具 + CDP 通过 18 项受控检查；P1-05 的两窗格分屏/方向与比例/空窗格/取消连接/意外断线与有界自动重连/设置 v4 已于 2026-10-24 用源码 Electron + 本机 `ssh2` 夹具 + CDP 通过 19 项受控检查并生成 10 张截图；原生导入对话框、安装包内行为、真实 OpenSSH 与真实网络抖动仍未执行）：

1. 深/浅/系统主题切换与重启保留；系统主题随 OS 变化且不覆盖偏好。
2. 终端字体/字号/光标/闪烁/回滚实时生效，PTY 不重建，尺寸同步正常。
3. 设置写入失败（只读目录/磁盘满）时局部回滚与错误提示。
4. 设置文件损坏时逐字段恢复、警告展示与原文件保留。
5. 日志轮转、级别过滤、导出文件内容检查、不可写目录计数。
6. 主机密钥列表、删除确认、取消删除、当前会话不中断、下次连接重新确认。
7. 传输中退出/强杀后重启显示「已中断」，无自动续传与重试。
8. 运行中降低并发上限，任务继续完成且新任务按新上限调度。
9. 退出时传输/SFTP/SSH/日志顺序清理与单步超时上限。
10. 删除连接后的凭据清理（需在隔离测试账号与测试凭据上验证）。
11. 真实 SSH 密码/私钥/口令/Agent 认证、主机密钥变化拒绝、PTY 交互。
12. 真实 SFTP 目录浏览、变更、上传/下载、冲突、取消、断线清理。
13. 壁纸导入（真实 PNG/JPEG、大图、超大文件、损坏或非图片）、预览、开关与浓度实时效果、重启保留、删除后恢复纯色；终端、输入框与表单保持不透明，浅/深主题下文本可读。
14. 双栏本地浏览与拖拽（P1-01）：本地面板主目录/磁盘入口、面包屑、路径输入与返回上一级；条目元数据与系统资源管理器一致；把文件与文件夹拖到远程面板验证目录展开语义与截断提示；把远程文件拖入本地面板验证目标目录，并确认拖到磁盘根目录、跨会话载荷被拒绝。
15. 跳板链路（P1-02，需两台以上真实服务器）：配置单跳与多跳链路，验证逐跳主机密钥确认与跳板凭据补录归属、失败文案「经跳板 N（名称）失败」、跳板信任与目标信任相互独立、以及断开后无孤立连接；未在真实跳板网络执行。
16. 本地转发（P1-03，需受控 SSH 测试服务）：新建本地 TCP 规则，选择该连接已连接的会话启动，确认主进程返回实际绑定端口、本机字节双向转发、目标不可达时错误归属、停止后端口释放；重启应用后规则必须保持 `stopped`，不得自动监听。
17. 远程转发（P1-03，需受控 SSH 测试服务）：默认在服务器 `127.0.0.1` 绑定并验证远程访问；非回环绑定必须显式确认；服务器拒绝（如 `AllowTcpForwarding no`、端口占用）时保持错误状态、不得自动放宽绑定；停止后 `unforwardIn` 释放远程端口。
18. 动态 SOCKS5（P1-03）：仅经 `127.0.0.1` 提供 no-auth CONNECT，使用受控客户端验证 IPv4、域名与 IPv6 目标、并发上限、协议错误响应与停止后无残留监听；确认不支持 UDP ASSOCIATE/BIND/SOCKS4、不记录也不读取应用层负载。
19. 会话归属与断线（P1-03）：仅允许规则所属连接的原会话启动；其他连接或未连接会话被拒绝；SSH 断开时规则停止且不静默迁移到新会话；重连后不自动重启原规则。
20. 暴露确认与清理失败（P1-03）：本地非回环绑定的风险提示与确认复选框、取消后保持 `stopped`；绑定/解绑失败显示主进程固定错误而非运行中；`cleanupPending` 期间编辑、删除与重启均被阻断，重试成功后才解除。
21. 连接级联删除（P1-03）：删除含运行中规则的连接时先显示规则/运行数量；取消不改变任何规则；确认后按“停止并删除规则→删除连接”执行；任一步失败时保留连接并显示可重试错误，不得把部分成功报告为完成。
22. 端口转发页与编辑器（P1-03，Electron 实窗）：菜单导航、规则列表、启动/停止/编辑/删除操作、状态与失败文案、启动会话选择、暴露确认、空状态与页脚安全说明；未在 Electron 实窗执行。
23. 快速命令入口与命令库（P1-04，受控实窗已执行部分）：工具栏「快速命令」、命令面板动作与 `Ctrl/Cmd+Shift+K` 打开右侧抽屉；内置命令只读、仅可收藏/复制，自定义命令可创建/编辑/删除；分类与搜索过滤。受控验收覆盖了工具栏/快捷键入口、命令库渲染与自定义命令创建，未逐项验证命令面板、所有分类与搜索组合。
24. 插入与发送（P1-04，受控实窗已执行）：插入只写入终端输入且不追加回车、不自动执行；发送前显示渲染后预览与参数，必须显式选择已连接且 Shell `open` 的目标；目标在打开后失效时不得自动切换或重发；双会话时必须只发送到所选会话。受控验收覆盖了真实 Shell 的插入、发送、双会话显式选择与过期目标拒绝。
25. 命令历史（P1-04，受控实窗已执行部分）：新安装默认关闭；设置开启后发送确认框「记录本次发送」默认勾选且可取消；历史只记录显式成功发送的渲染后正文，不记录原始终端输入或输出；搜索、复制、插入、确认重发、单条删除与清空确认。受控验收覆盖默认关闭、开启后记录、渲染后正文、删除与清空；未验证重启后历史保留、搜索/复制/重发与损坏文件恢复的实窗行为。
26. 历史隐私与设置（P1-04，受控实窗已执行）：设置页显示历史开关、清空按钮与「`command-history.json` 未额外加密」披露；关闭时后续发送不新增历史；应用日志不出现命令正文、参数或历史内容；设置文件当时为 v3 且历史文件为 v1。受控验收检查了设置披露、关闭后零新增、v3 设置、v1 历史文件与日志文本；P1-05 已将设置升级到 v4。
27. 快速命令未执行场景（P1-04）：真实 OpenSSH 服务端、生产网络延迟/断线、安装包内行为、原生菜单与系统级快捷键冲突、屏幕阅读器/键盘焦点陷阱、输入法组合输入、超长命令/参数、命令发送期间的高频终端输出、多个窗口并发发送（当前单窗口）、历史文件权限/ACL 与跨用户隔离。
28. 快速命令边界确认（P1-04）：内置命令只读且首版均为只读诊断命令（不含重启/变更类）；自定义命令发送前必须经过预览与显式确认；模板不做 Shell 转义承诺，参数值由用户负责；不因启动、连接建立或重连自动执行任何命令；不在后台标签切换时改变发送目标。
29. 两窗格分屏布局（P1-05，受控实窗已执行部分）：左右/上下分屏、方向切换、退出分屏；两个窗格同时显示各自真实终端；空窗格下拉只列出其他已打开标签，选择后绑定；关闭标签只解绑该窗格；分隔条拖动、方向键、Home/End 与双击 50% 生效。受控验收覆盖分屏启停、方向与比例、空窗格绑定，未逐项验证所有键盘组合。
30. 分屏隔离（P1-05，受控实窗已执行部分）：一个窗格断开/重连/关闭 Shell 不影响另一窗格的 SSH 状态、终端输出与输入；分屏操作不新增 SSH 连接或 PTY；切换标签与关闭窗格不产生跨会话输出串流。
31. 取消连接（P1-05，受控实窗已执行）：连接中点击「取消连接」保留标签、停止进行中尝试、不关闭另一窗格；取消后按钮回到可重连状态；迟到的连接成功被主进程断开清理；已连接会话的「断开连接」不被误当作取消。
32. 自动重连默认关闭（P1-05，受控实窗已执行）：新安装/迁移后设置关闭；关闭时意外断线停留终态，不自动调度；开启后仅网络类错误显示「等待自动重连」并倒计时。
33. 自动重连有界与清理（P1-05，受控实窗已执行部分）：服务端主动结束通道后触发 1/2/4/8/15 秒退避，最多 5 次；「停止/取消自动重连」立即清除；认证失败、主机密钥变化、主动断开、关闭标签、退出应用与关闭设置开关均不重试；次数耗尽显示「自动重连已停止」。受控验收覆盖一次成功自动重连、取消与完整 5 次耗尽；错误码白名单、主动断开与相邻窗格隔离由自动化测试覆盖，未在真实网络条件下逐一触发五类错误码。
34. 自动重连安全语义（P1-05）：每次重试重新执行主机密钥校验与认证；未知/变化的主机密钥不会被自动信任；断线前输入、未发送快速命令与终端缓冲不会被重放；界面不声称旧 Shell/前台进程已恢复。
35. 设置 v4（P1-05，受控实窗已执行）：设置页「自动重连」默认关闭、开启后写入 `settings.json` v4；v3/v2/v1 文件读取后内存迁移；关闭开关立即停止等待中的重连；写入失败显示错误并回滚。
36. P1-05 未执行场景：真实 OpenSSH Server、真实网络抖动/丢包/长时间断网、五类错误码逐一触发的真实网络条件、系统休眠/唤醒、代理/VPN 切换、NSIS 打包安装包、多窗口并发与屏幕阅读器/输入法下的分屏交互。

完整手工清单见 `docs/TASKS.md` 第 71–78 项及既有 1–70 项。

## 7. 未覆盖风险

- 没有真实 OpenSSH/SFTP 服务器集成测试；fake 实现不能证明服务器兼容性、背压、权限或符号链接语义。
- 没有逐项点击 UI 的 Electron E2E；TASK-009 增加了 CDP 驱动打包应用运行时验收，但不覆盖全部控件与原生对话框。导航/权限/CSP 的窗口行为仍依赖代码审查、该运行时验收与手工验收。
- 原生文件/目录/保存对话框在测试中均为 stub，未验证 Windows 长路径、保留名、磁盘满、文件占用与取消行为。
- P1-01 本地面板与拖拽未在 Electron 实窗验收：拖拽测试使用合成 `DataTransfer` 事件，`webUtils.getPathForFile` 与真实 OS 拖放（资源管理器、跨应用）行为未验证；本地面板未在真实用户目录验证符号链接/junction、Windows 保留名与 ACL 权限差异。
- P1-02 跳板链路未在真实跳板网络验收：链式连接测试全部基于 fake `ssh2` Client 与 fake `forwardOut` 通道，未验证真实 `forwardOut` 的背压/半关闭语义、跳板服务器禁用 TCP 转发时的真实报错、多跳下的网络抖动与超时分布；跳板编辑器与链路状态展示也未在 Electron 实窗逐项验收。
- P1-03 端口转发未在真实 SSH 服务验收：本地/远程/动态测试的 SSH 侧均为 fake `forwardOut`/`forwardIn` 通道，未验证真实服务器 `AllowTcpForwarding` 配置、`forwardIn` 绑定语义、远程端口冲突、IPv6 监听、半关闭/背压、网络中断与服务器重启；真实 SSH 端口转发验收状态为**未执行**。
- SOCKS5 只实现 no-auth CONNECT：不支持用户名/密码认证、UDP ASSOCIATE、BIND 与 SOCKS4；未与第三方客户端（浏览器、`curl` 等）做真实兼容性验收，握手超时与 1 KiB 长度上限可能拒绝异常客户端。
- 非回环绑定的暴露控制仅依赖启动前确认：应用不管理操作系统防火墙，也不列出允许访问的来源；一旦用户确认，局域网/公网可达性取决于主机网络与防火墙配置。
- 本地与远程监听器在进程被强杀、断电或网络中断后可能残留：`cleanupPending` 只能在应用仍存活时重试解绑，远程服务器是否立即释放端口取决于服务器实现，客户端无法保证。
- 连接级联删除先删除规则再删除连接：若连接持久化删除随后失败，规则已被移除且不会自动恢复；影响检查与删除之间存在计数变化的小窗口，属于已知残余风险。
- 端口转发页、编辑器、启动暴露确认与连接级联删除 UI 未在 Electron 实窗逐项验收；现有测试为 jsdom 组件测试与 mock bridge。
- P1-04 快速命令未在真实 OpenSSH 服务端、生产网络或安装包内验收：受控验收使用源码 Electron + 本机 `ssh2` 夹具 + 真实 Shell，18/18 检查与 10 张截图只能证明该环境下的行为，不能替代 OpenSSH 兼容性、打包后行为、系统快捷键冲突、输入法与真实网络时序验证。
- 模板替换是字面量替换，不是 Shell 转义：参数值中的 `;`、`$()`、引号等会原样进入终端命令；UI 只提示“参数将原样插入”，不能把预览当作安全审查。
- 快速命令发送成功不等于远端执行成功：应用不读取 PTY 输出或退出码，无法判断命令是否被 Shell 接受、是否报错或是否长时间运行；远端 Shell 历史仍可能记录命令正文。
- 目标校验与写入之间仍存在竞态：主进程在写入前重新检查 `sessionId`/`clientId`/连接状态/Shell 状态，并按标签限制单发送在途，但远端 Shell 可能在检查后立即退出；应用不会自动重试或重定向，用户需自行确认终端状态。
- 命令历史以明文 JSON 保存在 `<userData>/command-history.json`，包含命令正文、连接名称与主机；未额外加密，渲染进程被 XSS 攻陷时可经 bridge 读取或删除历史；应用日志不记录命令正文，但无法防止操作系统级文件读取或备份泄露。
- 命令历史只按最近 200 条保留，不提供导入/导出、跨设备同步、按连接过滤或审计；清空是本地删除，不触碰远端 Shell 历史。
- 快速命令不提供自动补全、条件判断、多目标发送、定时执行或本地 Shell 执行；内置命令为 Linux 常用只读诊断，非 Linux 远端可能因缺少命令而失败。
- 快速命令 UI 的键盘焦点、屏幕阅读器语义、暗/浅主题、窄窗布局与输入法组合输入未逐项验收；现有 UI 测试为 jsdom + mock bridge。
- P1-05 未在真实 OpenSSH、真实网络抖动或安装包内验收：受控验收使用源码 Electron + 本机 `ssh2` 夹具 + CDP，19/19 检查与 10 张截图只能证明该环境下的分屏、取消与有界重连行为；真实丢包、DNS 故障、连接拒绝、防火墙中断、系统休眠/唤醒与服务器长连接保持策略未覆盖。
- 自动重连只在渲染进程调度，关闭窗口或渲染进程崩溃即停止；主进程不保存重试任务，因此后台/重启后的自动重连不存在，也不应被描述为“后台保活”。
- 自动重连成功只重建 SSH 与新的 PTY；旧 Shell、前台进程、工作目录、未完成输入、快速命令与端口转发均不会恢复，用户需自行重新建立运行上下文。
- 分屏布局只在运行态且仅支持两个窗格；窗口极窄、超大缩放或高 DPI 下的分隔条命中区域、双终端同时高频输出与焦点切换流畅度未做性能/压力验收。
- 取消连接与底层 `ssh2` 握手/认证回调存在极短竞态窗口：应用会先收敛状态并按 epoch 丢弃迟到成功，但物理连接可能在取消后短暂完成再由主进程清理；未在真实高延迟网络中测量该窗口。
- 转发测试覆盖状态机与协议边界，但未进行压力/模糊测试或安全审计；动态转发监听固定回环降低了暴露面，但不代表渲染进程或本机其他进程不可滥用 SOCKS 入口。
- 未验证真实 DPAPI/Keychain/keyring、系统主题事件、日志目录 ACL 与多用户隔离。
- 设置写入与强杀退出之间的最后写入窗口、传输日志与强杀时序仍存在不可完全排除的竞态。
- 日志脱敏是模式匹配的第二道防线，未知格式仍可能漏检；主要依赖“只记录固定事件”的调用约束与代码审查。
- 壁纸测试 mock 了 `nativeImage`，未验证真实图片解码、EXIF 方向、带 alpha 的 PNG、超大像素图的内存峰值与高 DPI 缩放质量；缩放后的 JPEG 仍以 data URL 常驻渲染进程内存。
- 壁纸启用态（浓）、快捷菜单与关闭恢复纯色已在开发构建的 Electron 实窗检查；未在 NSIS 安装包、真实原生导入/移除、柔/标准浓度切换、浅色主题、不同 DPI 与低性能设备上验证合成效果和帧率。
- 未进行压力/模糊测试、第三方安全审计或签名产物验证；TASK-009 已执行生产依赖审计（0 个已知漏洞）与未签名安装包的 Authenticode 状态检查。

## 8. 后续任务

1. 搭建隔离的 OpenSSH/SFTP 测试服务端（含至少两跳的跳板拓扑），执行认证、PTY、目录、传输、断线、权限、Unicode 与多跳链路集成测试；同时开启受控 TCP 转发，覆盖本地/远程/SOCKS5 的实际绑定、字节转发、端口冲突、服务器禁用转发、半关闭、背压、超时与断线重连。
2. 引入逐项 UI 的 Electron 实窗 E2E（如 Playwright/Electron）覆盖主题、壁纸导入/删除与浓度、设置、日志导出、主机密钥删除、P1-01 本地面板与跨栏拖拽、跳板编辑器与链路状态展示、P1-03 端口转发页/编辑器/暴露确认/连接级联删除、P1-04 快速命令库/历史/编辑器/发送确认/快捷键、原生对话框与退出流程。
3. 在 Windows 上验证 DPAPI 与用户目录 ACL；补充跨用户隔离与日志文件权限检查。
4. 验证强杀/断电后的传输日志与临时文件语义，必要时增加启动时残留文件提示（不得自动删除未知文件）。
5. 执行实际安装、卸载、用户数据保留与旧版本覆盖升级验收；在干净 Windows 虚拟机/CI 上复现打包。
6. 配置正式代码签名与自动更新链路，验证签名链、时间戳与安装后安全行为。
7. 评估日志脱敏的自动化属性测试与结构化字段白名单，减少对正则的依赖。
8. 处理 8 个 moderate 开发依赖告警并记录处置/接受理由。
9. 在受控 OpenSSH（含非 Linux Shell 场景）与安装包中验证 P1-04：命令插入/发送、目标失效、历史开关与持久化、快捷键冲突、输入法、历史文件权限与日志分离。
10. 评估命令历史的额外保护（如操作系统加密存储）与可选的导入/导出/审计；任何加密或迁移必须保持 strict schema、原子写入与损坏保护，并明确“发送成功≠执行成功”。
11. 若未来引入 Shell 感知的参数转义，必须按目标 Shell 明确语义并单独测试；在未实现前继续把模板定义为字面量替换，不对外宣称安全转义。
12. 在真实 OpenSSH 与受控网络环境中验证 P1-05：五类可重试错误码逐一触发、五级退避与 5 次耗尽、用户取消与主动断开抑制、认证失败/主机密钥变化不重试、分屏两窗格独立断线与高频输出、设置 v4 迁移与写入失败回滚；同时验证安装包内行为与系统休眠/唤醒。

TASK-009 的打包运行时验收与未执行项见 `docs/releases/0.1.0-acceptance.md`；该验收使用本地 `ssh2` 夹具与 CDP，不替代上述 OpenSSH、安装/卸载、签名与逐项 UI E2E。
