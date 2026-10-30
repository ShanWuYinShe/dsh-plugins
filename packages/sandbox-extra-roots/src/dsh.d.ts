/**
 * 宿主 service 面的最小类型接线（只声明局部类型，不做 Context 增强）。
 *
 * @deepseek-ai/dsh-sandbox 自带 `declare module '@deepseek-ai/cordis'` 的
 * Context 增强（`sandbox: SandboxProvider`），静态 import 该包即让插件在编译期
 * 看到官方契约——不再手写 ctx.sandbox 形状。
 *
 * `sandboxPolicy` 的官方增强在 @deepseek-ai/dsh-sandbox-policy（本包未依赖该包，
 * 避免把宿主内部实现包塞进插件依赖）。这里**不做** `declare module` 增强：
 * 本地增强与官方 SandboxPolicyService 的属性类型不同，而插件发布产物
 * lib/index.d.ts 会带上该增强，消费者同时看到两份官方类型时会触发 TS2717
 * （subsequent property declarations must have the same type）。改为只导出
 * 局部类型，使用点显式 cast 取用（见 wrap.ts 的 fs 包装）。
 *
 * 形状逐字取自官方源码 host-repo packages/sandbox/sandbox-policy/src/index.ts
 * （`resolve(request?: SandboxPolicyRequest): SandboxExecutionPolicy`，同步返回）。
 */
import type {} from '@deepseek-ai/dsh-sandbox';
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox';

/** 本插件实际消费的宿主 sandboxPolicy 服务面（官方 SandboxPolicyService 的子集）。 */
export interface HostSandboxPolicy {
  /** 逐调用解析沙盒策略（同步返回，见官方 SandboxPolicyService.resolve）。 */
  resolve(request?: { session?: unknown; mode?: SandboxMode }): SandboxExecutionPolicy;
}
