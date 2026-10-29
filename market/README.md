# dsh-plugins 插件索引与静态 npm registry（自动生成）

本目录由 CI 从 GitHub Releases 生成，**请勿手工编辑**；生成器、站点布局与校验方式见主仓
`RELEASING.md` 的「插件索引与静态 registry」一节。

当前随 alpha 适配线发布；收敛合入 main 后，索引源 URL 会随之换成 main 路径。

- `index.json`：DSH「自定义插件索引」要添加的索引源
- `icons/`：索引里相对引用的插件图标
- `npm/`：静态 npm registry 的 packument（索引里每个版本的 `source.registry` 指向它）

重新生成：推送任一 `<包目录>-v<版本>` tag（publish workflow 会在发布后自动生成并更新本目录），
或在 Actions 里手动触发 publish workflow（workflow_dispatch，用于回填/修复）。
