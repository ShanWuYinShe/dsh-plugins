/**
 * 宿主 service 面的最小类型接线。
 *
 * @deepseek-ai/dsh-sandbox 自带 `declare module '@deepseek-ai/cordis'` 的
 * Context 增强（`sandbox: SandboxProvider`），静态 import 该包即让插件在编译期
 * 看到官方契约——不再手写 ctx.sandbox 形状。
 *
 * `sandboxPolicy` 的官方增强在 @deepseek-ai/dsh-sandbox-policy（本包未依赖该包，
 * 避免把宿主内部实现包塞进插件依赖）：这里的 augmentation 只声明本插件实际
 * 消费的 `resolve()`，形状逐字取自官方源码
 * host-repo packages/sandbox/sandbox-policy/src/index.ts
 * （`resolve(request?: SandboxPolicyRequest): SandboxExecutionPolicy`）。
 * 官方该包被加载时两者类型一致，不会产生 declaration merge 冲突。
 */
import type {} from '@deepseek-ai/dsh-sandbox';
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox';

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandboxPolicy: {
      /** 逐调用解析沙盒策略（同步返回，见官方 SandboxPolicyService.resolve）。 */
      resolve(request?: { session?: unknown; mode?: SandboxMode }): SandboxExecutionPolicy;
    };
  }
}
