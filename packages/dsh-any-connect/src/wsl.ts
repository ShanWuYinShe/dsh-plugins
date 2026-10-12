/**
 * wsl.ts — WSL 运行环境判定与 Windows 路径/环境变量转换。
 *
 * 2026-10-12 从 auth-paths.ts 抽出：WSL 判定原本只在「凭据文件发现」一处用，
 * WorkBuddy 5.6 的加密凭据让 Electron 解密助手也要在 WSL 里经 interop 找到
 * Windows 侧的 App（见 desktop-discovery*.ts），两处共享同一份判定与路径转换，
 * 不再各自为政。
 *
 * 判定保持「环境纯」由调用方传参可覆写：需要注入测试的模块（发现链路）一律
 * 以显式 `wsl: boolean` 穿参，只有组合根（atRestKeyProviderFor、凭证路径
 * 候选）才读真实环境——单测不因运行在 WSL 里而行为漂移。
 *
 * @module dsh-any-connect/wsl
 */

import { release } from 'node:os'
import { join } from 'node:path'

/**
 * Whether this Linux process is running inside Windows Subsystem for Linux.
 *
 * 环境信号优先（WSL_DISTRO_NAME / WSL_INTEROP），内核版本串兜底（自定义 init
 * 可能清掉 env，但 microsoft 内核串总在）。非 Linux 恒 false。
 */
export function isWsl(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  kernelRelease: string = release(),
): boolean {
  if (platform !== 'linux') return false
  if (env['WSL_DISTRO_NAME'] !== undefined || env['WSL_INTEROP'] !== undefined) return true
  return kernelRelease.toLowerCase().includes('microsoft')
}

/** Convert a Windows drive path to WSL's conventional `/mnt/<drive>` form.
 *
 * 已是 POSIX 形式（/ 开头）的原样返回；解析不出盘符（UNC、相对路径）返回
 * undefined，由调用方决定回落——这里不猜。
 */
export function windowsPathForWsl(value: string | undefined): string | undefined {
  const path = value?.trim()
  if (!path) return undefined
  if (path.startsWith('/')) return path
  const drivePath = /^([a-z]):[\\/](.*)$/iu.exec(path)
  if (drivePath === null) return undefined
  return join('/mnt', drivePath[1]!.toLowerCase(), ...drivePath[2]!.split(/[\\/]+/u))
}

/**
 * 把一个变量追加进 WSLENV 的 **WSL→Win32 方向**（`/w` 旗标）。
 *
 * WSL 经 interop 拉起 Windows 进程时，只有 WSLENV 点名的变量才会传到 Windows
 * 侧环境——ELECTRON_RUN_AS_NODE 这类「Linux 侧设了、Windows 侧必须收到」的
 * 开关必须走这条通道，否则 Electron 会以完整 GUI 形态启动而不是 run-as-node。
 * 既有条目（含宿主注入的 WT_SESSION 之类）原样保留；同名变量无论带哪个方向
 * 旗标都不重复追加。
 */
export function appendWslEnvDirection(wslenv: string | undefined, name: string): string {
  const entries = (wslenv ?? '').split(':').map(entry => entry.trim()).filter(entry => entry !== '')
  if (!entries.some(entry => entry === name || entry.startsWith(name + '/'))) {
    entries.push(name + '/w')
  }
  return entries.join(':')
}

/**
 * 解密助手子进程的完整环境：ELECTRON_RUN_AS_NODE 恒设；WSL 下再经 WSLENV
 * 的 /w 方向把它送进 Windows 侧进程（见 {@link appendWslEnvDirection}）。
 * 非原语环境变量一律原样透传——桌面 App 自身可能依赖宿主的常规 Windows 环境。
 */
export function helperSpawnEnv(base: NodeJS.ProcessEnv, wsl: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ELECTRON_RUN_AS_NODE: '1' }
  if (wsl) {
    const wslenv = appendWslEnvDirection(env['WSLENV'], 'ELECTRON_RUN_AS_NODE')
    if (wslenv !== '') env['WSLENV'] = wslenv
  }
  return env
}
