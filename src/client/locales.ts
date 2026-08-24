/** Dictionary namespace owned by this plugin (zh/en parity checked by CI). */
export const zh = {
  tab: '插件管理',
  placeholder: '插件管理加载中（T01 骨架）',
} as const

export const en = {
  tab: 'Plugin manager',
  placeholder: 'Plugin manager loading (T01 skeleton)',
} as const

export type ManagerLocaleKey = keyof typeof zh
