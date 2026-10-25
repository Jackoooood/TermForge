export interface BuiltInQuickCommand {
  id: string
  name: string
  category: string
  description: string
  body: string
}

/**
 * Built-in commands are deliberately read-only diagnostics. State-changing
 * maintenance commands belong in user-defined commands, where the send
 * confirmation is explicit.
 */
export const BUILT_IN_QUICK_COMMANDS: readonly BuiltInQuickCommand[] = Object.freeze([
  {
    id: 'builtin-uptime',
    name: '系统运行时间',
    category: '基础信息',
    description: '查看系统已运行时间与平均负载',
    body: 'uptime',
  },
  {
    id: 'builtin-disk-usage',
    name: '磁盘使用率',
    category: '基础信息',
    description: '以人类可读格式查看各挂载点的磁盘占用',
    body: 'df -h',
  },
  {
    id: 'builtin-memory',
    name: '内存使用',
    category: '基础信息',
    description: '查看物理内存与交换分区使用情况',
    body: 'free -h',
  },
  {
    id: 'builtin-kernel',
    name: '内核信息',
    category: '基础信息',
    description: '查看内核版本、主机名与系统架构',
    body: 'uname -a',
  },
  {
    id: 'builtin-identity',
    name: '当前身份',
    category: '基础信息',
    description: '查看当前用户、UID 与所属用户组',
    body: 'id',
  },
  {
    id: 'builtin-service-status',
    name: '服务状态',
    category: '服务诊断',
    description: '查看 systemd 服务当前状态（只读，不重启服务）',
    body: 'systemctl status {{service}} --no-pager',
  },
  {
    id: 'builtin-service-journal',
    name: '服务最近日志',
    category: '服务诊断',
    description: '查看 systemd 服务最近 100 行日志',
    body: 'journalctl -u {{service}} -n 100 --no-pager',
  },
  {
    id: 'builtin-listening-ports',
    name: '监听端口',
    category: '网络诊断',
    description: '列出 TCP/UDP 监听端口及对应进程',
    body: 'ss -tulpn',
  },
  {
    id: 'builtin-ip-addresses',
    name: '网络地址',
    category: '网络诊断',
    description: '查看网卡地址与链路状态',
    body: 'ip addr',
  },
  {
    id: 'builtin-ping',
    name: '连通性测试',
    category: '网络诊断',
    description: '向目标主机发送 4 个 ICMP 探测包',
    body: 'ping -c 4 {{host}}',
  },
  {
    id: 'builtin-tail-file',
    name: '查看文件尾部',
    category: '文件查看',
    description: '查看文件末尾 100 行内容',
    body: 'tail -n 100 {{path}}',
  },
  {
    id: 'builtin-search-file',
    name: '文件内容搜索',
    category: '文件查看',
    description: '在文件中按原样搜索并显示匹配行号',
    body: 'grep -n {{pattern}} {{path}}',
  },
])
