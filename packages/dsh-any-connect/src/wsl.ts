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
 * 允许继承给解密助手子进程的环境变量白名单。
 *
 * 被 spawn 的是**第三方桌面 App 的 Electron 二进制**（WorkBuddy / WorkBuddy AI，
 * 用户机器上可执行文件）——它只需要「Electron 以 node 形态跑起来 + 找到自己的
 * 用户目录」这一组变量。宿主的完整 `process.env` 里还有 DSH 运行时凭据
 * （`DEEPSEEK_API_KEY`、各类 `*_TOKEN`），把环境原样交给第三方二进制等于在
 * 进程启动那一刻就把它们暴露给任何能读 `/proc/<pid>/environ` 或崩溃转储的环节
 * （RULE-057：不可信输出不得继承环境）。
 *
 * 名单按「Electron/WSL interop 实际需要」取最小集：
 * - POSIX 侧：`PATH`（node 形态下 Electron 自身不再解析 PATH，但崩溃处理/子工具
 *   可能用）、`HOME`/`TMPDIR`/`LANG`/`LC_ALL`/`TZ`；
 * - Windows 侧（WSL interop 经 /mnt 拉起 Windows 进程时由 interop 服务转交）：
 *   `USERPROFILE`/`HOMEDRIVE`/`HOMEPATH`/`APPDATA`/`LOCALAPPDATA`/`PROGRAMDATA`/
 *   `PROGRAMFILES*`/`SystemRoot`/`windir`/`TEMP`/`TMP`/`PATHEXT`/`Path`；
 * - WSL interop 本身：`WSL_INTEROP`（interop 通信必需）、`WSL_DISTRO_NAME`/
 *   `WSLENV`（变量转发通道）、`WT_SESSION`/`WT_PROFILE_ID`（终端身份，只读诊断）。
 *
 * 名单之外的变量一律不继承——包括所有凭据和 `DSH_HOME` 这类宿主私有路径。
 */
const HELPER_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'WSL_DISTRO_NAME',
  'WSL_INTEROP',
  'WSLENV',
  'WT_SESSION',
  'WT_PROFILE_ID',
])

/**
 * 凭据类环境变量的保守剔除规则（白名单之外的第二道闸）。
 *
 * 白名单已经挡住全部非必需变量，这条规则防的是「将来往白名单里加变量时顺手
 * 加进一个凭据名」：任何名字里带 KEY/SECRET/TOKEN/PASSWORD/CREDENTIAL 的变量
 * 都不允许进子进程环境。
 */
const SENSITIVE_ENV_PATTERN = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i

/**
 * 具名 DSH 凭据的固定剔除清单：即使有人把通配规则改宽，这几个名字也必须消失。
 * 都是宿主运行时真实使用的凭据变量名（另见宿主文档的凭据环境变量约定）。
 */
const NAMED_DSH_CREDENTIALS: ReadonlySet<string> = new Set([
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_TOKEN',
  'DSH_API_KEY',
  'DSH_TOKEN',
])

/**
 * 解密助手子进程的环境：**白名单 + 敏感剔除**，而不是继承宿主完整环境。
 *
 * `ELECTRON_RUN_AS_NODE` 恒设；WSL 下再经 WSLENV 的 /w 方向把它送进 Windows 侧
 * 进程（见 {@link appendWslEnvDirection}）——这一项是固定注入，不来自宿主环境。
 *
 * 桌面 App 自身可能依赖宿主常规环境的说法，用白名单就足以满足：Electron 以
 * node 形态启动只需要路径/临时目录/语言时区这一小撮变量，而 Windows interop
 * 会由 interop 服务补齐 Windows 侧自己的环境。
 */
export function helperSpawnEnv(base: NodeJS.ProcessEnv, wsl: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (!HELPER_ENV_ALLOWLIST.has(name)) continue
    if (SENSITIVE_ENV_PATTERN.test(name)) continue
    if (NAMED_DSH_CREDENTIALS.has(name)) continue
    env[name] = value
  }
  if (wsl) {
    const wslenv = appendWslEnvDirection(env['WSLENV'], 'ELECTRON_RUN_AS_NODE')
    if (wslenv !== '') env['WSLENV'] = wslenv
  }
  return env
}
