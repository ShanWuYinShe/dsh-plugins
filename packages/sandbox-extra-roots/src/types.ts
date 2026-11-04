/**
 * types.ts — Remote 服务面（网关 get/set）的边界类型。
 *
 * 这些类型是 Host 与 Client 的公共 wire 契约：typert 生成器从 Host 方法签名
 * 生成 ./remote 调用面时，按包内公共非根子路径（package.json 的 "./types"）
 * 引用它们，因此必须保持 JSON 可序列化、只在此处定义一份。JSDoc 会被生成器
 * 收进工件（线上描述/JSON Schema），改类型时一并维护注释。
 *
 * @module @chaoset/sandbox-extra-roots/types
 */

/** 本插件的生效配置（与 plugin-config.ts 的默认值同形）。 */
export interface SandboxExtraRootsConfig {
  /** workspace-write 模式下额外允许写入的目录（绝对路径；生效前已 canonical 化、去重并过滤危险根）。 */
  extraWritableRoots: string[];
}

/** get() 的返回：当前生效配置的快照。 */
export interface SandboxExtraRootsGetResult {
  /** 当前生效配置。 */
  config: SandboxExtraRootsConfig;
}

/** set() 的入参：允许覆盖的配置字段（缺省字段保持当前值）。 */
export interface SandboxExtraRootsSetRequest {
  /** 新的额外可写目录列表；相对路径与危险根会被拒绝。 */
  extraWritableRoots?: string[];
}

/** set() 的返回：已写入官方 configEditor（由 Loader 对账后生效）。 */
export interface SandboxExtraRootsSetResult {
  /** 是否持久化成功（失败会抛错，不会静默返回 false）。 */
  saved: boolean;
}
