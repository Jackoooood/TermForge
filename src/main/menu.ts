import { Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

export function installApplicationMenu(isDev: boolean): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    ...(isDev
      ? [
          {
            label: '开发',
            submenu: [
              { role: 'reload' as const, label: '重新加载' },
              { role: 'toggleDevTools' as const, label: '开发者工具' },
            ],
          },
        ]
      : []),
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
