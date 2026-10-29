# THIRD_PARTY_NOTICES — 第三方组件许可告知

本包发布的独立 CLI `lib/bin.js`（`dsh-any-connect` 命令）在构建期由
`scripts/build.mjs` 的第 4 阶段用 esbuild 打包成**单文件自包含 ESM**：入口模块及其
依赖闭包被内联进产物，运行时只保留 `node:` 内建模块的 import。这是必要的——bin 是
宿主 loader 之外的独立 node 进程，宿主 runtime resolution 不覆盖它，未内联的
`@deepseek-ai/*` 裸 import 会让用户在 profile 里执行时报 `ERR_MODULE_NOT_FOUND`。

本清单由 `lib/bin.js` 的构建期打包闭包（esbuild metafile）核对得出：**改动 bin 的
依赖闭包、或升级下列依赖后必须同步本文件**（版本为构建时 bun.lock 的实际解析结果）。
插件本体的 `lib/index.js` 与 `client/client.cjs` 不在此列——它们运行在宿主/浏览器
模块表内，依赖由宿主提供。

被内联的第三方组件全部为 MIT 许可：

| 组件 | 版本 | 许可 | 版权声明 |
| --- | --- | --- | --- |
| `@deepseek-ai/cordis` | 4.0.6-alpha.1 | MIT | Copyright (c) 2021-present Shigma |
| `@deepseek-ai/cosmokit` | 1.8.7-alpha.1 | MIT | Copyright (c) 2021-present Shigma |
| `@deepseek-ai/dsh-atomic-write` | 0.2.2-alpha.2 | MIT | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/dsh-home-paths` | 0.2.2-alpha.2 | MIT | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/dsh-storage` | 0.2.1-rc.3 | MIT | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/dsh-storage-domain` | 0.2.2-alpha.2 | MIT | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/dsh-storage-json` | 0.2.2-alpha.2 | MIT | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/dsh-timeout` | 0.2.2-alpha.2 | MIT | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/schemastery` | 3.18.6-alpha.1 | MIT | Copyright (c) 2021-present Shigma |
| `zod` | 4.4.3 | MIT | Copyright (c) 2025 Colin McDonnell |

上游源码：`@deepseek-ai/*` 组件来自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，
`zod` 来自 [colinhacks/zod](https://github.com/colinhacks/zod)。

## MIT License

Copyright (c) 2021-present Shigma
Copyright (c) 2026 DeepSeek
Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
