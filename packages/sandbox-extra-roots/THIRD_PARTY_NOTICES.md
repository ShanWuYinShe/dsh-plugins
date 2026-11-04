# THIRD_PARTY_NOTICES — 浏览器产物内联的第三方代码

本包发布的浏览器产物 `client/client.cjs` 由 `scripts/build.mjs` 第 3 阶段用 esbuild
打包。宿主模块表提供 `react` / `react/jsx-runtime` / `zod`（构建期 declared external），
其余依赖闭包被内联进产物——其中包含 **Typert 官方生成器产出的客户端工件**
（`lib/typert.remote-client.js`）对 `@deepseek-ai/dsh-typert-protocol` 的
`remote-info` 工厂引用。`remote-info` 是纯数据工厂、无共享运行时身份，宿主模块表
不提供它，因此必须随产物内联（与官方客户端打包的 INLINE_SAFE/GENERATED_REMOTE
判定一致）。

插件本体的 `lib/*.js` 运行在宿主 Node 侧，宿主依赖由宿主 profile runner 的
runtime resolution 供给，不在本清单范围内。

被内联的第三方组件为 MIT 许可：

| 组件 | 版本 | 许可 | 版权声明 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-typert-protocol`（`./remote-info`） | 0.2.2-rc.1 | MIT | Copyright (c) 2026 DeepSeek |

升级宿主基线（`engines.dsh`）或 `@deepseek-ai/dsh-typert-protocol` 后，请确认
`client/client.cjs` 的内联闭包与本表一致（构建产物中出现 `jsonSchemaError` 即表示
`remote-info` 被内联；`test/third-party-notices.test.ts` 会核对本文件的声明）。
