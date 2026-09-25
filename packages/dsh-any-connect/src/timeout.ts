/**
 * 宿主 deadline 抽象（dsh-timeout）+ 本地回退。
 *
 * dsh-timeout 只在 devDependencies 里（类型与 CI 可解析），不能成为运行时
 * import——正式安装只装 dependencies + optionalDependencies，devDep 会被
 * 裁掉，静态 import 会让插件在生产宿主里加载即炸。因此这里动态 import +
 * 回退（与 remote.ts 的 loadTypert 同一模式）：CI/开发环境走宿主真实语义
 * （可分类的 TimeoutReason code），生产环境走同语义的本地实现。
 *
 * @module dsh-any-connect/timeout
 */

/** 可释放的融合信号：上游取消 OR 超时任一触发即 abort，dispose 拆 timer。 */
export interface DeadlineHandle {
  signal: AbortSignal;
  dispose(): void;
}

type DeadlineFactory = (upstream: AbortSignal | undefined, timeoutMs: number, code: string) => DeadlineHandle;

let factory: DeadlineFactory | null = null;
let factoryPromise: Promise<DeadlineFactory | null> | null = null;

async function loadFactory(): Promise<DeadlineFactory | null> {
  if (factory !== null) return factory;
  // 缓存 import 的 promise 而非「已探测」布尔:启动时多个变体并发首调
  // deadlineSignal,布尔会让后到者不等首个 import 落地就直接落回本地
  // 实现——同一次冷启动内超时原因部分可分类(宿主 TimeoutReason)、
  // 部分不可(本地普通 Error)。import 失败同样缓存:生产环境 devDep 被裁
  // 是稳定状态,重复重试只会反复抛模块解析错误。
  factoryPromise ??= import('@deepseek-ai/dsh-timeout')
    .then((mod) => {
      if (typeof mod.deadline !== 'function') return null;
      // Host Deadline 的释放方法是 [Symbol.dispose]（lib 需 esnext.disposable，
      // 见 tsconfig.base.json）；这里包一层普通 dispose，调用方无感知。
      factory = (upstream, timeoutMs, code) => {
        const d = mod.deadline(upstream, timeoutMs, code);
        return { signal: d.signal, dispose: () => d[Symbol.dispose]() };
      };
      return factory;
    })
    .catch(() => null);
  return factoryPromise;
}

/**
 * 本地回退：与宿主 deadline 同语义（融合上游取消 + 可分类超时原因），
 * reason 是普通 Error 而非 TimeoutReason。导出供单测（host 路径在装有
 * 该包的环境走真实实现，这里只钉回退语义）。
 */
export function localDeadlineSignal(upstream: AbortSignal | undefined, timeoutMs: number, code: string): DeadlineHandle {
  if (!(timeoutMs > 0)) {
    // 与宿主一致：非正超时=不设 timer，只融合上游取消。
    if (upstream === undefined) {
      const idle = new AbortController();
      return { signal: idle.signal, dispose: () => {} };
    }
    return { signal: upstream, dispose: () => {} };
  }
  const controller = new AbortController();
  const onUpstreamAbort = () => controller.abort(upstream?.reason);
  if (upstream !== undefined) {
    if (upstream.aborted) controller.abort(upstream.reason);
    else upstream.addEventListener('abort', onUpstreamAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error(`${code}: timed out after ${timeoutMs}ms`)), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      upstream?.removeEventListener('abort', onUpstreamAbort);
    },
  };
}

/** 融合上游取消与超时的信号（宿主优先，缺席回退本地）。用完必须 dispose，
 * 否则 timer 挂住事件循环（此前手写三件套同类泄漏的注释见 upstream.ts）。 */
export async function deadlineSignal(upstream: AbortSignal | undefined, timeoutMs: number, code: string): Promise<DeadlineHandle> {
  const make = await loadFactory();
  if (make === null) return localDeadlineSignal(upstream, timeoutMs, code);
  return make(upstream, timeoutMs, code);
}

/** 在融合信号下跑一段工作并保证拆 timer：JSON 短读等“取 signal 回调”形态专用。 */
export async function withTimeout<T>(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
  code: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const handle = await deadlineSignal(upstream, timeoutMs, code);
  try {
    return await fn(handle.signal);
  } finally {
    handle.dispose();
  }
}
