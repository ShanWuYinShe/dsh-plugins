/**
 * typert 协议类型 shim —— **仅供 @deepseek-ai/dsh-typert-generator 静态分析**，
 * 不是运行时兼容层，也不参与包编译（包的 tsconfig 仍从 npm 解析真实协议包）。
 *
 * 为什么需要：生成器用 `isTypeMetaSymbol()` 判定 @Remote / TypertRemoteService /
 * RemoteScope / bindTypertRemote 这些 marker，判定条件是「符号声明位于名为
 * @deepseek-ai/dsh-typert-protocol 的已登记工作区包内」，或「声明包裹在
 * declare module '@deepseek-ai/dsh-typert-protocol' 里」。宿主仓库把协议包作为
 * packages/typert/protocol 工作区成员并加进 tsconfig.host.json，因此天然满足；
 * 本仓是外部插件仓，协议包来自 npm（node_modules），不满足前者——若不做 shim，
 * 生成器看不到任何 @Remote 标记，会静默产出空工件。
 *
 * 本文件内容取自 @deepseek-ai/dsh-typert-generator@0.2.2-alpha.2 自带的
 * tests/fixtures/remote-model/typert-protocol.d.ts（官方用于验证「非工作区协议
 * 声明」场景的最小契约），并通过 tsconfig.host.json 的 paths 只映射到生成器
 * program：`"@deepseek-ai/dsh-typert-protocol": ["./scripts/lib/typert-protocol.d.ts"]`。
 *
 * 维护：协议包升级（约 0.2.x 每个 alpha/rc 线）时对比官方 fixture 与
 * node_modules/@deepseek-ai/dsh-typert-protocol 的 .d.ts 差异，只补本仓源码实际
 * 用到的 marker / 类型；生成器会在契约不匹配时报 TypertAnalysisError（不会静默降级）。
 *
 * 何时可以删除：官方生成器支持从 node_modules 解析协议包、或本仓改为把协议包
 * vendor 成工作区成员（packages/typert-protocol）时。
 *
 * 对应宿主源码：packages/typert/protocol/src/index.ts @ tag dsh-v0.2.2-alpha.2。
 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  export interface TypertLookup<Host, Wire> {
    readonly host: Host
    readonly wire: Wire
  }

  export interface TypertContext<Wire> {
    readonly wire: Wire
  }

  export interface TypertLookupMap {}
  export interface TypertContextMap {}
  export interface TypertRemoteMap {}
  export interface TypertRemoteScopeMap {}

  export interface RemoteFailure {
    readonly code: string
    readonly message: string
    readonly details: object
  }

  export type RemoteResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: RemoteFailure }

  export type RemoteDecoded<Value> = Value extends Uint8Array ? Uint8Array<ArrayBuffer>
    : Value extends string | number | boolean | bigint | symbol ? Value
      : Value extends object ? { [Key in keyof Value]: RemoteDecoded<Value[Key]> } : Value

  export type TypertRemoteNamespace<Namespace extends string> = {
    [Endpoint in keyof TypertRemoteMap as Endpoint extends `${Namespace}/${infer Method}`
      ? Method
      : never]: TypertRemoteMap[Endpoint]
  }

  export interface TypertRemoteNamespaceMap {}
  export interface TypertClientRemote extends TypertRemoteNamespaceMap {}

  export interface TypertRemoteValue<Value = unknown> {
    readonly create: () => { parse(value: unknown): Value }
    readonly description?: string
    readonly jsonSchema?: Readonly<Record<string, unknown>>
    readonly jsonSchemaError?: string
  }

  export type TypertCodec<Value = unknown> =
    | TypertRemoteValue<Value> & {
      readonly mode: 'strict'
      readonly typeSymbol: string
      readonly decode?: (value: unknown) => unknown
      readonly encode?: (value: unknown, writeBytes: (bytes: Uint8Array, path: readonly (string | number)[]) => null) => unknown
    }
    | { readonly mode: 'src-json' }

  export interface InvocationParameterDescriptor {
    readonly name: string
    readonly wire: string
    readonly source: 'json' | 'lookup'
    readonly lookup?: string
    readonly acceptsUndefined?: true
    readonly description?: string
    readonly codec: TypertCodec
  }

  export interface InvocationDescriptor {
    readonly id: string
    readonly service: string
    readonly namespace: string
    readonly method: string
    readonly implementation?: string
    readonly mode?: 'stream'
    readonly invocation:
      | { readonly kind: 'direct' }
      | { readonly kind: 'context'; readonly context: string; readonly wire: string; readonly codec: TypertCodec }
    readonly scope?: { readonly context: string; readonly wire: string }
    readonly parameters: readonly InvocationParameterDescriptor[]
    readonly uplink?: { readonly codec: TypertCodec }
    readonly cancellation?: { readonly parameter: 'signal' }
    readonly result: TypertCodec
    readonly description?: string
    readonly sourceLocation?: { readonly file: string; readonly line: number; readonly column: number }
  }

  export interface TypertRemoteInputOptions {
    readonly strict?: boolean
  }

  export type TypertRemoteMethod<Input extends object, Output, Mode extends 'unary' | 'stream' = 'unary', Uplink = never, DecodedOutput = Output> =
    Omit<InvocationDescriptor, 'mode' | 'invocation' | 'result'>
    & (Mode extends 'stream' ? { readonly mode: 'stream' } : { readonly mode?: never }) & {
      readonly invocation: { readonly kind: 'direct' }
      input(options?: TypertRemoteInputOptions): TypertRemoteValue<Input>
      readonly result: Extract<TypertCodec<Output>, { readonly mode: 'strict' }>
      invoke(remote: TypertClientRemote, input: Input, signal?: AbortSignal): Mode extends 'stream'
        ? RemoteStreamHandle<Output, Uplink> : Promise<RemoteResult<DecodedOutput>>
    }

  export interface TypertRemoteContribution {
    readonly package: string
    readonly descriptors: readonly InvocationDescriptor[]
  }

  export interface TypertRemoteInfo<Methods extends Readonly<Record<string,
    TypertRemoteMethod<object, unknown> | TypertRemoteMethod<object, unknown, 'stream', unknown>
  >> = Readonly<Record<string, TypertRemoteMethod<object, unknown> | TypertRemoteMethod<object, unknown, 'stream', unknown>>>>
    extends TypertRemoteContribution {
    readonly methods: Methods
  }

  export type RemoteStream<Out, In = never> = AsyncIterable<Out> & { readonly uplinkItem?: In }

  export interface RemoteStreamHandle<Out, In> extends AsyncIterable<Out> {
    send(item: In): void
    end(): void
    dispose(): void
  }

  export abstract class TypertRemoteService {
    readonly typertRemote: {
      readonly service: TypertRemoteService
      readonly serviceKey: string
      readonly namespace: string
    }
    protected constructor(
      ctx: unknown,
      serviceKey: string,
      options?: { readonly namespace?: string },
    )
  }

  export function bindTypertRemote<Service extends object>(
    service: Service,
    serviceKey: string,
    options?: { readonly namespace?: string },
  ): { readonly service: Service; readonly serviceKey: string; readonly namespace: string }

  export function Remote<This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void

  export function Remote(option: string | { readonly mode?: 'stream'; readonly name?: string; readonly resources?: object }):
  <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ) => void

  export function RemoteScope(
    key: Extract<keyof TypertContextMap, string>,
    option?: string | { readonly name?: string; readonly resources?: object },
  ):
  <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ) => void
}
