/**
 * locales.ts — 设置卡片文案（zh/en）与 locale 命名空间。
 *
 * 2026-10-08 从 425 行的单体 client/index.tsx 拆出。
 *
 * @module sandbox-extra-roots/locales
 */



export const NS = "settings.plugins.sandboxExtraRoots";

export const zh = {
  title: "沙盒额外允许目录（sandbox-extra-roots）",
  summary: "为 workspace-write 沙箱追加可写目录（在官方白名单之外）",
  hint: "workspace-write 模式下，除官方白名单（工作区根 + /tmp + 平台临时目录）外额外允许写入的目录。每行一个绝对路径，支持 ~ 表示用户主目录。",
  unsaved: "有未保存的修改",
  discard: "放弃修改",
  saving: "保存中…",
  save: "保存",
  saveFailed: "保存失败",
  saved: "已保存，下次沙盒调用生效",
  loadFailed: "读取配置失败",
  loading: "加载中…",
  roots: "额外可写目录（每行一个绝对路径，支持 ~）",
  rootsCount: "共 {n} 个目录",
  presetsTitle: "常用工具缓存（一键添加）", 
  placeholder: "~/data\n/tmp/cache",
  rootDanger: "第 {n} 行“{v}”为根目录或整盘，将破坏沙盒隔离边界，已被禁止保存",
  rootHomeAncestor: "第 {n} 行“{v}”为用户主目录祖先，将破坏主目录隔离边界，已被禁止保存",
  rootInvalid: "第 {n} 行“{v}”不是绝对路径，已被禁止保存（支持 ~ 开头或绝对路径）",
  rootDuplicate: "第 {n} 行“{v}”与前面的目录重复，保存时将自动合并去重",
  rootSystem: "第 {n} 行“{v}”为系统受限目录，宿主将自动过滤忽略此目录",
};
export const en = {
  title: "Extra sandbox roots (sandbox-extra-roots)",
  summary: "Extra writable roots for the workspace-write sandbox, beyond the official allow-list",
  hint: "Extra writable roots under workspace-write mode, on top of the official allow-list (workspace root + /tmp + platform temp dirs). One absolute path per line; ~ expands to your home directory.",
  unsaved: "Unsaved changes",
  discard: "Discard",
  saving: "Saving…",
  save: "Save",
  saveFailed: "Save failed",
  saved: "Saved; takes effect on the next sandbox call",
  loadFailed: "Failed to load config",
  loading: "Loading…",
  roots: "Extra writable roots (one absolute path per line; ~ allowed)",
  rootsCount: "{n} roots",
  presetsTitle: "Common tool caches (one-tap add)",
  placeholder: "~/data\n/tmp/cache",
  rootDanger: "Line {n} “{v}” is a root directory or drive, which breaks sandbox isolation and cannot be saved",
  rootHomeAncestor: "Line {n} “{v}” is an ancestor of the home directory, which breaks home isolation and cannot be saved",
  rootInvalid: "Line {n} “{v}” is not an absolute path and cannot be saved (must be absolute or start with ~)",
  rootDuplicate: "Line {n} “{v}” duplicates a previous root and will be deduplicated on save",
  rootSystem: "Line {n} “{v}” is a protected system directory and will be filtered out by host",
};
