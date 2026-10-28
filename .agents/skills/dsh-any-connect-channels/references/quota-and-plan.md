# 额度与计划：响应样本与排查细节

本文件是 SKILL.md「四、Start Plan 额度」与「六、额度展示」的取证细节。

## Start Plan billing/balance 响应要点

```
GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance[?app_version=<ver>]
    Authorization: Bearer <zcodejwttoken>
    X-Device-Mid: <稳定 UUIDv4>
```

- `data.plans[]`：活动名 `name`、`plan_id`、`ends_at`（秒级 epoch）、`entitlements[]`（每个含 `capabilities: ["model:<id>"]`）。
- `data.balances[]`：`show_name` / `total_units` / `used_units` / `remaining_units` / `expires_at` / `period_start` / `period_end`，
  单位是 **token**，不是积分。
- 实测样本（单池活动）：`ZCode Trust Build`，GLM-5.3-Flash 100,000,000 tokens。
- 实测样本（多池活动）：`ZCode 1024 Dev Day`（`plan_id: zcode-v3-start-plan-1024`）两个 entitlement
  （GLM-5.3-Flash 300M / GLM-5.3 200M），`balances[]` 每个模型一个 bucket，`capabilities` 绑定各自模型——
  **池子互不通用，消费哪个模型只扣它的池**。
- `period: "one_time"`：额度是每日一次性池子、不结转；`used_units` 只增不减，响应里没有结转字段。
  `expires_at` 不是"当日"硬规则：2026-09-30 样本恰为当日 16:00Z，1024 活动则是三天后（10-26 01:00Z）——
  `sameDay` 按到期时刻是否落在本地今日动态判定，不硬编码。
- 同族端点：`billing/current`、`billing/preview` 可直接读；`billing/claim` 需要阿里云验证码
  （无码 → `400 code 3007 captcha verify failed`）。
- `X-Device-Mid` 缺失/每请求随机 → `400 code 3001` 或 `429`。取值：`~/.zcode/v2/telemetry-state.json` 的 `deviceMid` →
  `$DSH_HOME/.dsh-any-connect/zcode-device-mid`（自生成并持久化；0.4.x 起文件名无点前缀并移入 state 子目录，
  旧名 `$DSH_HOME/.zcode-device-mid` 仅作兼容读取、命中时迁移到新路径）。

## 每日领取（preview / claim）

从 `app.asar` 偏移 271347225（`claimManualPlan`）取证并实测：

```
GET  /api/v1/zcode-plan/billing/preview?app_version=<v>&platform=<p>
     Authorization: Bearer <zcodejwttoken>          # 纯 HTTP，无需 captcha
     -> data.plans[] = 今日可领取清单（今日已领过则 []）
POST /api/v1/zcode-plan/billing/claim
     Authorization: Bearer <zcodejwttoken>
     Content-Type: application/json
     X-Aliyun-Captcha-Verify-Param: <captchaVerifyParam>   # 必需
     X-ZCode-App-Version: <v>   X-Platform: <p>
     body: {"plan_id": "<id>"}
```

- `preview` 可在 Node 侧直接调用（实测 200 + `plans: []`）——**这是插件能自动化的上限**。
- `claim` 的 captcha 由渲染进程 `window.AliyunCaptcha`（阿里云 SDK）签发，客户端走 `startTracelessVerification()` 无感验证；
  token 由阿里云服务端签发并与浏览器指纹绑定，**纯 Node/HTTP 侧无法生成**；不带该头一律
  `HTTP 400 {"code":3007,"msg":"captcha verify failed"}`。
- 结论：**「探测自动、领取手动」**。插件 `src/zcode-plan-claim.ts`：无 captcha 时根本不发请求，直接短路为 `captcha-required`
  （一等公民状态，不是笼统 failed），绝不伪装成已领取。
- 判定三态：探测成功有清单 = `available`；探测成功清单为空 = `none`（今日已领）；**探测失败/超时/401 = `unknown`，绝不塌成 `none`**
  （塌成 none 会让用户以为"今天没得领"而白丢一次领取）。字段透出在 Start Plan 变体的 status（`startPlanClaim`）。

## Coding Plan 窗口额度（pill 的 5 小时 / 7 天来源）

```
GET https://bigmodel.cn/api/monitor/usage/quota/limit
    Authorization: Bearer <coding-plan api-key>        # 就是聊天请求用的那把 key
```

实测（本机 individual-coding-plan key）返回：

```json
{ "code": 200, "msg": "操作成功", "data": { "level": "pro", "limits": [
  { "type": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": 0,  "nextResetTime": 1791403544725 },
  { "type": "TOKENS_LIMIT", "unit": 6, "number": 1, "percentage": 24, "nextResetTime": 1791865446983 },
  { "type": "TIME_LIMIT",   "unit": 5, "number": 1, "usage": 1000, "currentValue": 0,
    "remaining": 1000, "nextResetTime": 1793026354999 } ] } }
```

- `unit` 语义（按实测时间差反推）：**3 = 小时、6 = 周、5 = 月**；`number` 是数量。
- `TOKENS_LIMIT` 只给 `percentage`，且它是**已用**百分比（客户端界面显示的进度就是它）——
  窗口要报剩余就 `remain = 100 - percentage`、`limit = 100`、`unit = '%'`。
- `TIME_LIMIT` 给 `usage/currentValue/remaining`（工具调用次数）。
- `nextResetTime` 是**毫秒** epoch（与 `billing/balance` 的秒级 `ends_at` 不同，别搞混）。
- 客户端侧类名是 `BigModelUsageQuotaProvider`；z.ai 系账号走另一支 URL（`ZCODE_BIGMODEL_USAGE_QUOTA_URL` / `BIGMODEL_USAGE_QUOTA_URL` 可覆盖）。
- 拿 `zcodejwttoken` 当 Bearer 会 `401 令牌已过期或验证不正确`——这条端点只认 coding-plan 的 **api-key**
  （`open.bigmodel.cn` 同路径也通，两者返回同样数据）。
- 实现：`src/zcode-quota.ts`（解析 + 映射）+ `ZCodeUpstreamClient.fetchCodingPlanQuota`；
  端点不可用或形状不符一律 `undefined` → 查询器回退订阅有效性窗口，绝不编数字。

## pill 三个坑的完整版

1. **saved 目录可能是旧版本写的**：`catalogStore` 存「上次成功拉取的名单」，白名单上线前写进去的是上游并集
   （实测某升级用户 saved 里躺着 11 个 Coding Plan 模型）；启动时 saved 先于 live 发布 → 用户先看到一整屏越界模型。
   修法：发布 saved 前用同一份白名单过滤（`filterByCodingPlanWhitelist`，白名单不可得则原样返回）。
2. **Start Plan 跨天后 accounts 为空**：每日 00:00 后旧池子作废、新池子未发放/未领取时 `balances` 为空；
   pill 若回落到通用的「该 provider 不上报额度」会让人以为额度功能坏了——`startPlanWindows` 应如实回「Start Plan: 今日待领取」。
3. **Plugins 页版本号来自磁盘 package.json，不代表运行中进程**：`dsh plugin add` 只改磁盘与 node_modules，
   正在跑的 dsh 仍用启动时加载的旧模块。用户说「已经是新版了」却仍看到旧行为（如 11 个模型、pill 没有新窗口）时，
   先看 `$DSH_HOME/cache/dsh-any-connect/zcode-catalog.json`（2026-10-11 起目录化；历史平铺 `~/.dsh/.zcode-catalog.json` 属旧版布局）内容：若是旧行为的特征就说明进程没重启。**重启必须完全退出 dsh 进程**（刷新页面不算）；
   `lsof -p <pid>` 可确认进程打开的 DSH_HOME 文件。
