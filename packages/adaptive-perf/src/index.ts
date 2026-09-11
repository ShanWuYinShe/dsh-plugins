/**
 * adaptive-perf — 极简性能自适应插件（@chaoset/adaptive-perf）
 *
 * 目标：让「标准模式（standard）」「PTC 模式（code）」与「创造模式
 * （cordis）」达到与「极简模式（minimal）」相同级别的高性能。极简模式快
 * 的原因（对源码的对照结论）：
 *   1. persona 配置了 includeRuntimeContext: false —— 每次模型请求不注入
 *      "Current runtime context" 快照（文件策略 / 审批策略等动态段）；
 *   2. 工具目录极小（只有 bash + str_replace_editor）—— 每个请求的
 *      tool schema 与（PTC 的）SDK 参考段都随之变小；
 *   3. persona 为 complete 固定提示，无其它全局 prompt 段；
 *   4. 不挂 skill 目录提醒（~9KB）与 AGENTS.md 摘要注入。
 *
 * 本插件在多个维度上做"动态自适应"（而不是静态裁剪），全部参照
 * dsh-anchored-standard（https://github.com/xiaobright/dsh-anchored-standard）
 * 的实测结论：
 *   A. 运行时上下文抑制：对目标 preset 的会话调用
 *      agent.ctx.systemPrompt.suppressRuntimeContext()（与极简模式同一机制），
 *      每次请求省掉快照文本，零功能损失。
 *   B. 真实 Minimal 工具对（bootstrap.realPair，0.5.0 新增）：首轮"轨迹"
 *      （模型思维链风格）由请求 #1 可见的**工具 schema** 决定，且只有与
 *      Minimal 逐字相同的 schema 才能锚定（issue #11：真实工具对 5/5 锚定，
 *      任何 standard 系 schema——包括 sandboxed bash/read——11/11 落入
 *      standard-like）。仅收窄目录不够：standard/code preset 根本没有
 *      str_replace_editor，其 bash 也是 sandboxed schema。因此本插件把
 *      Minimal 的**真实工具对**（持久 PTY bash + str_replace_editor，官方
 *      minimal preset 同一批插件、同一份描述）挂进 agent 作用域工具层
 *      （scoped registration 按名阴影继承工具），首轮目录 = 真实工具对；
 *      PTC 的 SDK 参考段同样按可见目录渲染，同步缩小。
 *   C. 首轮锚定（bootstrap）：请求 #1 只暴露真实工具对，剥离自动注入上下文
 *      （技能目录提醒 skill-catalog、AGENTS.md 摘要 agent-instructions；
 *      用户主动的技能手势不过滤）；首个**持久**晋升信号（首个 tool/call 或
 *      assistant/message，promoteOn 可选 either/tool-call/assistant-message）
 *      后**完整恢复**该模式的全部工具目录与常规上下文注入（0.7.0，
 *      dsh-anchored-standard 语义：只锚定首轮，不减少后续功能）；阶段从
 *      持久会话事件推导，resume/reload 不丢状态，晋升信号持久（compaction
 *      不重置）；bootstrap.maxTokens（可选）给请求 #1 封顶输出预算，晋升后
 *      剥离。
 *   D. 常驻上下文抑制（suppressInjectedContext，0.5.0 新增，0.7.0 默认
 *      开启）：true = 整个会话剥离技能目录提醒与 AGENTS.md 摘要注入（功能
 *      可见性由常驻发现工具 dev_tool_search / skill_search / skill_load
 *      承担——实测晋升后恢复注入会把轨迹拉回 standard-like）；false =
 *      只剥离首轮，晋升后恢复常规注入（opt-in）。
 *   E. 工具目录自适应精简（leanByDefault，0.7.0 默认关闭的 opt-in）：开启时
 *      按"工具族"隐藏高开销低频工具（子代理 / 工作流 / ralph / goal 等编排
 *      类），只保留核心编码工具，随后根据两类信号在会话内"单调升级"放行
 *      对应工具族（只升不降）：
 *        - 关键词信号：用户消息命中某工具族的触发词（如"子代理"）→ 放行该族；
 *        - 失败信号：PTC 的 run_code 程序调用被隐藏工具报 UNKNOWN_TOOL
 *          （tools/result 失败文本含工具名）→ 放行该族，下次程序即可调用。
 *
 * 实现全部使用 dsh 公开服务契约（Inspect 确认）：
 *   - ctx.agentPresets.composedPreset(agent.ctx)  读取会话所属 preset
 *   - agent.ctx.systemPrompt.suppressRuntimeContext()  抑制上下文快照
 *   - agent.ctx.systemPrompt.section()  按名阴影 prompt 段（persona/引导段）
 *   - agent.ctx.tools.schemas(agent)  读取该 agent 当前可见工具（限制交集）
 *   - agent.ctx.tools.restrict({ deny })  按 agent 作用域裁剪继承工具
 *   - agent.ctx.plugin()  挂载官方 minimal preset 同款插件（持久 bash /
 *       str_replace_editor / 其依赖的 terminals 与本地 fs）
 *   - agent/pre-step（waterfall） 首轮剥离自动注入上下文
 *   - agent/request（waterfall） 首轮输出预算封顶
 *   - session/event  增量喂入持久事件（晋升信号）
 *   - agent/created、agent/disposed、agent/inbox/inserted、tools/result 事件
 * 监听器都注册在 host 根作用域（与 dsh-agent-presets 自身同款用法），事件按
 * scope 过滤分发，子作用域派发的事件根监听器可收到；waterfall 均以 prepend
 * 注册保证"最外层"（剥离是最后一道变换）。
 *
 * 配置：cordis.patch.yml 的 config（安装默认）与
 *       ~/.dsh/plugins/adaptive-perf/config.json（设置页 UI，权威）合并，
 *       保存后热生效（新会话立即生效；已运行会话按新配置重算限制）。
 *
 * 依赖：真实工具对需要官方插件包（@deepseek-ai/dsh-terminal 等，声明为
 * optionalDependencies）。它们不可用时本插件自动降级（告警 + 退回旧行为：
 * 只收窄目录、不替换 schema），绝不拖垮 harness。
 */

import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConfigStore } from './config-store.js';

// remote 服务（设置页 UI 的配置读写）可选：typert-protocol 不可用时
// 动态 import 失败，核心功能（自适应）照常工作。
let PluginConfigGateway: any = null;
try {
  ({ PluginConfigGateway } = await import('./remote.js'));
} catch (error) {
  console.warn('adaptive-perf: settings gateway unavailable: ' + ((error as Error)?.message ?? String(error)));
}

// 宿主 settings 体系的 schema 库（dsh-settings 0.1.0-rc.7+ 用 schemastery）。
// DSH profile 的 hoisted node_modules 直接解析；仓库测试环境无此包时为
// null，settings namespace 注册段静默跳过（fail-safe）。
let Schema: any = null;
try {
  ({ default: Schema } = await import('@deepseek-ai/schemastery'));
} catch {}

export const name = 'adaptive-perf';

/**
 * 默认配置。apply 时与 YAML 传入的 config 合并（cordis 不合并小写 config 导出）。
 *
 * families：工具族。每族可配 tools（该族工具名，需存在于目标 preset 的目录，
 * 插件运行时按实际可见工具取交集，不会因改名/缺失而崩溃）与 keywords（用户消息
 * 命中任一触发词即放行该族；大小写不敏感；匹配方式由 keywordMatchMode 决定，
 * 默认 smart：含 CJK 的触发词用子串匹配、纯 ASCII 词用词边界匹配）。
 *
 * bootstrap：首轮锚定（参照 dsh-anchored-standard 的实测结论）。请求 #1 只暴露
 * bootstrap.tools（真实 Minimal 工具对），剥离 suppressedContextSources 列出的
 * 自动注入上下文；首个持久晋升信号（promoteOn）后完整恢复全部工具与常规注入
 * （晋升是持久信号，compaction/end 不重置）；maxTokens>0 时给请求 #1 封顶输出
 * 预算（晋升后剥离）。
 */
export const DEFAULT_CONFIG = {
  /** 总开关：关闭后插件对会话不产生任何影响。 */
  enabled: true,
  /** 应用自适应的 agent preset 列表（composedPreset 返回值）。'ptc' 是
   * DSH 0.1.2 起对原 'code'（PTC 模式）的重命名；保留 'code' 兼容
   * 0.1.1-rc.x 安装版宿主，宿主不存在的 id 不会有会话命中，无副作用。 */
  presets: ['standard', 'code', 'ptc', 'cordis'],
  /**
   * 默认策略（0.7.0）：首轮锚定、晋升后 resident 目录（dsh-anchored-standard
   * 语义）。非极简 preset 的会话：请求 #1 按极简条件组装（真实 Minimal 工具
   * 对 + 极简 persona + 屏蔽全局引导段 + 剥离自动注入 + 抑制运行时快照）以
   * 锚定极简轨迹；首个持久晋升信号后进入 resident 阶段——保留 bootstrap 工具
   * 对 + 常驻发现工具（dev_tool_search / skill_search / skill_load），完整
   * 目录经 dev_tool_search 按需解锁（避免晋升时一次性倒出完整目录把轨迹拉回
   * standard-like，anchored-standard 实测的"晋升后回退"问题），常规上下文
   * 注入恢复可见——功能不减少。工具目录默认零裁剪（leanByDefault 关闭，
   * 编排类工具族始终可用）；需要时可在设置页按需开启。
   */
  /** 抑制运行时上下文快照（等同极简模式的 includeRuntimeContext: false）。 */
  suppressRuntimeContext: true,
  /** 会话启动时默认隐藏编排类工具族（核心编码工具始终保留）。 */
  leanByDefault: false,
  /** 用户消息命中工具族触发词时自动放行该族（会话内单调）。 */
  escalateOnKeyword: true,
  /** 工具调用失败（UNKNOWN_TOOL 文本含隐藏工具名）时自动放行该族。 */
  escalateOnUnknownTool: true,
  /**
   * 触发词匹配模式：smart（默认）= 含 CJK 的关键词保持子串匹配（\b 词边界
   * 对非 [A-Za-z0-9_] 字符无定义，纯 CJK 词会永不命中），纯 ASCII 词用词
   * 边界匹配——避免 "goalish"/"goalie" 命中 "goal"、"refork" 命中 "fork"
   * 这类常见英文词的子串误触发；substring = 一律子串（0.7.2 及以前的行为）；
   * word = 一律词边界（ASCII 字母/数字/下划线之外的位置视为边界，CJK 词
   * 也可用）。
   */
  keywordMatchMode: 'smart',
  /**
   * 常驻上下文抑制（0.5.0）：true = 整个会话剥离自动注入上下文
   * （skill-catalog 技能目录提醒、agent-instructions AGENTS.md 摘要）；
   * false = 只在 bootstrap 未晋升阶段剥离，晋升后恢复注入（0.7.0 默认，
   * 与 dsh-anchored-standard 一致：只锚定首轮、不减少后续功能）。
   */
  suppressInjectedContext: true,
  /** 核心编码工具（不进入任何限制族；此处仅作文档展示）。 */
  coreTools: [
    'bash', 'read', 'write', 'edit', 'glob', 'grep', 'read_image',
    'job_output', 'job_list', 'job_kill',
    'todo_write', 'ask_user_question', 'web_search', 'skill', 'exit_plan_mode',
  ],
  /** 默认隐藏、按需放行的工具族。 */
  families: {
    delegation: {
      enabled: true,
      tools: ['subagent', 'subagent_fork', 'send_message', 'list_agents', 'interrupt_agent'],
      keywords: ['子代理', '子agent', '委托', '分派', '派给', '子任务', 'subagent', 'delegate', 'fork'],
    },
    workflow: {
      enabled: true,
      tools: ['workflow'],
      keywords: ['工作流', 'workflow', '编排', '多阶段'],
    },
    ralph: {
      enabled: true,
      tools: ['ralph'],
      keywords: ['ralph', '全新agent', 'fresh agent'],
    },
    goal: {
      enabled: true,
      tools: ['create_goal', 'get_goal', 'update_goal'],
      keywords: ['长期目标', '跨轮次', '目标追踪', 'goal'],
    },
  },
  /** 首轮锚定（参照 dsh-anchored-standard）。 */
  bootstrap: {
    /** 是否启用首轮锚定。 */
    enabled: true,
    /**
     * 是否挂载真实 Minimal 工具对（0.5.0）：把官方 minimal preset 的持久
     * PTY bash + str_replace_editor 挂进 agent 作用域（按名阴影 standard 的
     * sandboxed bash），使请求 #1 的 schema 与 Minimal 逐字相同。依赖
     * @deepseek-ai 官方插件包，不可用时自动降级为旧行为（仅收窄目录）。
     */
    realPair: true,
    /** 请求 #1 可见的工具（真实 Minimal 工具对）。 */
    tools: ['bash', 'str_replace_editor'],
    /** 晋升触发：either（默认）/ tool-call / assistant-message。 */
    promoteOn: 'either',
    /** 请求 #1 剥离的自动注入上下文 source.kind；[] 关闭剥离。 */
    suppressedContextSources: ['skill-catalog', 'agent-instructions'],
    /** 晋升后 resident 目录的常驻发现工具（按需解锁完整目录）。 */
    discoveryTools: ['dev_tool_search', 'skill_search', 'skill_load'],
    /** 请求 #1 的输出预算封顶（token）；0 = 不封顶（opt-in）。 */
    maxTokens: 0,
  },
  /**
   * 极简提示词层（语域锚定，参照 dsh-anchored-standard 的完整条件）。
   *
   * 参考实现指出：首轮"轨迹"（思维链风格）锚定需要 **Minimal 的完整 system
   * prompt**——只收窄工具 schema 不够。本层对目标 preset 的会话：
   *   - suppressSections：按名阴影屏蔽全局引导段（harness:identity、
   *     harness:source、app:web-surface），空段在装配时被丢弃，等同极简
   *     complete persona 的效果（plan-mode 段、PTC 的 SDK 段不受影响）；
   *   - persona：按名阴影替换 deployment:persona 为极简语域的短 persona
   *     （默认与极简模式逐字相同；留空则不替换）。
   * 两处都是 agent 作用域的 prompt 段阴影，仅影响目标会话，随会话销毁自动
   * 释放；对已恢复/已晋升的旧会话同样生效（不依赖 bootstrap 阶段）。
   */
  minimalPrompt: {
    /** 是否启用极简提示词层。 */
    enabled: true,
    /** 替换后的 persona 文本；与极简模式相同可完全对齐语域。留空不替换。 */
    persona: 'You are a helpful software engineer assistant.',
    /** 屏蔽全局引导段（identity / source / web-surface）。 */
    suppressSections: true,
  },
};

/** 轻量配置校验/归一化：非法字段回退默认值，避免 config.json 或 remote.set
 * 写入错误类型后在事件路径上抛 TypeError。 */
function boolValue(value: any, fallback: any) {
  return typeof value === 'boolean' ? value : fallback;
}

/** 归一化字符串列表。显式数组（含空数组）是合法配置值，原样保留（仅过滤
 *  非 string/空白项）——否则用户无法通过设置页清空 presets / bootstrap.tools
 *  等列表（清空保存后会被悄悄替换回默认值）。回退默认仅用于非数组输入，或
 *  字符串按分隔符解析后为空的情况。 */
function stringList(value: any, fallback: any) {
  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
  }
  if (typeof value === 'string') {
    const out = value.split(/[,，\s]+/).filter((v) => v.length > 0);
    return out.length > 0 ? out : fallback;
  }
  return fallback;
}

/** 与 stringList 相同，但 undefined 之外的一切输入都不回退默认（显式空数组、
 *  清空的字符串都保持为空——suppressedContextSources 的"留空=不剥离"语义）。 */
function stringListOrEmpty(value: any, fallback: any) {
  if (value === undefined) return fallback;
  return stringList(value, []);
}

export function normalizeConfig(source: any, defaults: any = DEFAULT_CONFIG): any {
  const raw = source !== null && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const merged = { ...defaults, ...raw };
  const families: any = {};
  const rawFamilies = raw.families !== null && typeof raw.families === 'object' && !Array.isArray(raw.families)
    ? raw.families
    : defaults.families;
  for (const [id, fam] of Object.entries(defaults.families as Record<string, any>)) {
    const candidate = rawFamilies[id] !== null && typeof rawFamilies[id] === 'object' && Array.isArray(rawFamilies[id]) === false
      ? rawFamilies[id]
      : fam;
    families[id] = {
      enabled: boolValue(candidate.enabled, fam.enabled),
      tools: stringList(candidate.tools, fam.tools),
      keywords: stringList(candidate.keywords, fam.keywords),
    };
  }
  // 自定义工具族(UI 与 validateConfig 都允许任意 id):不合并进来的话,
  // 用户在设置页新建的族会"保存成功"却被静默丢弃,永不生效。
  for (const [id, cand] of Object.entries(rawFamilies as Record<string, any>)) {
    if (Object.prototype.hasOwnProperty.call(defaults.families, id)) continue;
    if (cand === null || typeof cand !== 'object' || Array.isArray(cand)) continue;
    families[id] = {
      enabled: boolValue(cand.enabled, true),
      tools: stringList(cand.tools, []),
      keywords: stringList(cand.keywords, []),
    };
  }
  const rawBootstrap = raw.bootstrap !== null && typeof raw.bootstrap === 'object' && !Array.isArray(raw.bootstrap)
    ? raw.bootstrap
    : defaults.bootstrap;
  const db = defaults.bootstrap;
  const promoteOn = rawBootstrap.promoteOn === 'tool-call' || rawBootstrap.promoteOn === 'assistant-message'
    ? rawBootstrap.promoteOn
    : rawBootstrap.promoteOn === 'either' ? 'either' : db.promoteOn;
  const maxTokensRaw = rawBootstrap.maxTokens;
  const maxTokens = Number.isSafeInteger(maxTokensRaw) && maxTokensRaw > 0 ? maxTokensRaw : 0;
  const bootstrap = {
    enabled: boolValue(rawBootstrap.enabled, db.enabled),
    realPair: boolValue(rawBootstrap.realPair, db.realPair),
    tools: stringList(rawBootstrap.tools, db.tools),
    promoteOn,
    suppressedContextSources: stringListOrEmpty(rawBootstrap.suppressedContextSources, db.suppressedContextSources),
    discoveryTools: stringList(rawBootstrap.discoveryTools, db.discoveryTools),
    maxTokens,
  };
  const rawMP = raw.minimalPrompt !== null && typeof raw.minimalPrompt === 'object' && !Array.isArray(raw.minimalPrompt)
    ? raw.minimalPrompt
    : defaults.minimalPrompt;
  const dm = defaults.minimalPrompt;
  const minimalPrompt = {
    enabled: boolValue(rawMP.enabled, dm.enabled),
    persona: typeof rawMP.persona === 'string' ? rawMP.persona.trim() : dm.persona,
    suppressSections: boolValue(rawMP.suppressSections, dm.suppressSections),
  };
  return {
    enabled: boolValue(merged.enabled, defaults.enabled),
    presets: stringList(merged.presets, defaults.presets),
    suppressRuntimeContext: boolValue(merged.suppressRuntimeContext, defaults.suppressRuntimeContext),
    leanByDefault: boolValue(merged.leanByDefault, defaults.leanByDefault),
    escalateOnKeyword: boolValue(merged.escalateOnKeyword, defaults.escalateOnKeyword),
    escalateOnUnknownTool: boolValue(merged.escalateOnUnknownTool, defaults.escalateOnUnknownTool),
    keywordMatchMode: MATCH_MODES.includes(raw.keywordMatchMode) ? raw.keywordMatchMode : defaults.keywordMatchMode,
    suppressInjectedContext: boolValue(merged.suppressInjectedContext, defaults.suppressInjectedContext),
    coreTools: stringList(merged.coreTools, defaults.coreTools),
    families,
    bootstrap,
    minimalPrompt,
  };
}

/** remote.set 的严格校验：非法值直接拒绝并返回错误，而不是静默写坏文件。 */
export const MATCH_MODES = ['smart', 'substring', 'word'];

export function validateConfig(partial: any): void {
  if (partial === null || typeof partial !== 'object' || Array.isArray(partial)) {
    throw new TypeError('adaptive-perf config must be a plain object');
  }
  const boolFields = ['enabled', 'suppressRuntimeContext', 'leanByDefault', 'escalateOnKeyword', 'escalateOnUnknownTool',
    'suppressInjectedContext'];
  for (const key of boolFields) {
    if (partial[key] !== void 0 && typeof partial[key] !== 'boolean') {
      throw new TypeError(`adaptive-perf config field "${key}" must be a boolean`);
    }
  }
  if (partial.keywordMatchMode !== void 0 && !MATCH_MODES.includes(partial.keywordMatchMode)) {
    throw new TypeError(`adaptive-perf config field "keywordMatchMode" must be one of ${MATCH_MODES.map((m) => `"${m}"`).join(' | ')}`);
  }
  for (const key of ['presets', 'coreTools']) {
    if (partial[key] !== void 0 && !(Array.isArray(partial[key]) && partial[key].every((v) => typeof v === 'string'))) {
      throw new TypeError(`adaptive-perf config field "${key}" must be an array of strings`);
    }
  }
  if (partial.families !== void 0) {
    if (partial.families === null || typeof partial.families !== 'object' || Array.isArray(partial.families)) {
      throw new TypeError('adaptive-perf config field "families" must be an object');
    }
    for (const [id, fam] of Object.entries(partial.families as Record<string, any>)) {
      if (fam === null || typeof fam !== 'object' || Array.isArray(fam)) {
        throw new TypeError(`adaptive-perf config family "${id}" must be an object { enabled, tools, keywords }`);
      }
      if (fam.enabled !== void 0 && typeof fam.enabled !== 'boolean') {
        throw new TypeError(`adaptive-perf config family "${id}".enabled must be a boolean`);
      }
      for (const key of ['tools', 'keywords']) {
        if (fam[key] !== void 0 && !(Array.isArray(fam[key]) && fam[key].every((v) => typeof v === 'string'))) {
          throw new TypeError(`adaptive-perf config family "${id}".${key} must be an array of strings`);
        }
      }
    }
  }
  if (partial.bootstrap !== void 0) {
    const b = partial.bootstrap;
    if (b === null || typeof b !== 'object' || Array.isArray(b)) {
      throw new TypeError('adaptive-perf config field "bootstrap" must be an object');
    }
    if (b.enabled !== void 0 && typeof b.enabled !== 'boolean') {
      throw new TypeError('adaptive-perf config field "bootstrap.enabled" must be a boolean');
    }
    if (b.realPair !== void 0 && typeof b.realPair !== 'boolean') {
      throw new TypeError('adaptive-perf config field "bootstrap.realPair" must be a boolean');
    }
    if (b.promoteOn !== void 0 && !['either', 'tool-call', 'assistant-message'].includes(b.promoteOn)) {
      throw new TypeError('adaptive-perf config field "bootstrap.promoteOn" must be "either" | "tool-call" | "assistant-message"');
    }
    if (b.maxTokens !== void 0 && !(Number.isSafeInteger(b.maxTokens) && b.maxTokens >= 0)) {
      throw new TypeError('adaptive-perf config field "bootstrap.maxTokens" must be a non-negative safe integer');
    }
    for (const key of ['tools', 'suppressedContextSources', 'discoveryTools']) {
      if (b[key] !== void 0 && !(Array.isArray(b[key]) && b[key].every((v) => typeof v === 'string'))) {
        throw new TypeError(`adaptive-perf config field "bootstrap.${key}" must be an array of strings`);
      }
    }
  }
  if (partial.minimalPrompt !== void 0) {
    const m = partial.minimalPrompt;
    if (m === null || typeof m !== 'object' || Array.isArray(m)) {
      throw new TypeError('adaptive-perf config field "minimalPrompt" must be an object');
    }
    if (m.enabled !== void 0 && typeof m.enabled !== 'boolean') {
      throw new TypeError('adaptive-perf config field "minimalPrompt.enabled" must be a boolean');
    }
    if (m.suppressSections !== void 0 && typeof m.suppressSections !== 'boolean') {
      throw new TypeError('adaptive-perf config field "minimalPrompt.suppressSections" must be a boolean');
    }
    if (m.persona !== void 0 && typeof m.persona !== 'string') {
      throw new TypeError('adaptive-perf config field "minimalPrompt.persona" must be a string');
    }
  }
}

// ── 纯函数（导出便于回归测试）────────────────────────────────────────────

/**
 * 被极简提示词层屏蔽的全局引导段（name, order）。段名与 dsh-app-boot /
 * dsh-web-app 的注册一致；阴影按 name 覆盖（宿主 layer.sections.insert 按
 * name upsert），order 仅参与最终排序、不参与匹配，且空段在装配时被丢弃。
 * DSH 0.1.2 把这些段的 order 调整为 -1000/-900/-800（0.1.1 为
 * -100/-99/-98），此处沿用 0.1.2 参考值，对新旧宿主效果一致。
 */
export const SECTION_SHADOWS = [
  ['harness:identity', -1000],
  ['harness:source', -900],
  ['app:web-surface', -800],
];

/** persona 段的注册名与顺序（dsh-system-prompt 的 PERSONA_SECTION/PERSONA_ORDER）。 */
export const PERSONA_SECTION_NAME = 'deployment:persona';
export const PERSONA_SECTION_ORDER = 0;

/** 提取一条用户消息的顶层文本（text 块拼接）。 */
export function extractUserText(message: any): string {
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return '';
  let text = '';
  for (const block of message.content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    }
  }
  return text;
}

/** CJK 文字（日文假名 / 汉字扩展区与基本区 / 韩文谚文）。 */
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 单个关键词是否命中。边界判定用 lookaround（`(?<![A-Za-z0-9_])kw(?![A-Za-z0-9_])`）
 * 而不是 `\b`：`\b` 只在 \w 与非 \w 之间成立，纯 CJK 关键词两侧/内部不存在
 * 这样的过渡，`\b子代理\b` 会永不命中；lookaround 对 "的子代理"（CJK 相邻）、
 * "goal"（英文整词）、"goalish"（词中子串，拒绝）给出一致且可预期的语义。
 */
function keywordHits(loweredText: string, keyword: string, mode: string): boolean {
  const kw = keyword.toLowerCase();
  if (mode === 'substring') return loweredText.includes(kw);
  const bounded = new RegExp(`(?<![a-z0-9_])${escapeRegExp(kw)}(?![a-z0-9_])`).test(loweredText);
  if (mode === 'word') return bounded;
  // smart：含 CJK 的触发词保持子串匹配（中文没有词边界概念，"子代理"这类
  // 词在自然语句里就该命中）；纯 ASCII 词用词边界——'goal'/'fork' 这类常见
  // 英文词若用子串匹配，陈述句里的 goalish/refork 都会误触发放行。
  return CJK_CHAR.test(kw) ? loweredText.includes(kw) : bounded;
}

/**
 * 大小写不敏感的关键词匹配：任一关键词命中即返回 true。
 * @param mode - 'smart'（默认）/ 'substring' / 'word'，见 DEFAULT_CONFIG.keywordMatchMode。
 */
export function matchKeywords(text: any, keywords: any, mode: any = 'smart'): boolean {
  if (!Array.isArray(keywords) || keywords.length === 0) return false;
  const haystack = String(text ?? '').toLowerCase();
  if (haystack.length === 0) return false;
  const resolved = MATCH_MODES.includes(mode) ? mode : 'smart';
  return keywords.some((k) => typeof k === 'string' && k.length > 0 && keywordHits(haystack, k, resolved));
}

/** 收集一次工具调用失败的模型可见文本（error 字段 + content 文本块）。 */
export function collectFailureText(result: any): string {
  if (result === null || typeof result !== 'object') return '';
  const parts = [];
  const error = result.error;
  if (error !== null && typeof error === 'object') {
    if (typeof error.code === 'string') parts.push(error.code);
    if (typeof error.message === 'string') parts.push(error.message);
    if (typeof error.text === 'string') parts.push(error.text);
  }
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  }
  return parts.join('\n');
}

// ── 真实 Minimal 工具对（0.5.0，参照 dsh-anchored-standard issue #11）──────

/**
 * 官方 minimal preset 的持久 bash 工具描述，逐字一致。schema（参数）由
 * @deepseek-ai/dsh-tool-bash-persistent 提供，与 minimal preset 挂的是同一
 * 个包；描述在这里显式传入，保证与 minimal 的 agent.cordis.yml 完全一致。
 */
export const MINIMAL_BASH_DESCRIPTION = [
  'Run commands in a bash shell',
  '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
  "* You don't have access to the internet via this tool.",
  '* You do have access to a mirror of common linux and python packages via apt and pip.',
  '* State is persistent across command calls and discussions with the user.',
  "* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.",
  '* Please avoid commands that may produce a very large amount of output.',
  "* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.",
].join('\n');

/**
 * 被真实工具对按名阴影的工具引导段：standard 的 sandboxed bash 注册了
 * `tool:bash` 引导段，挂载真实工具对后该文本已与可见工具不符，按名阴影为
 * 空段（装配时丢弃）。阴影按 name 覆盖，order 仅排序：DSH 0.1.2 的
 * FIRST_PARTY_SECTION_ORDER.TOOL_BASH 为 1000（0.1.1 为 105），效果一致。
 */
export const TOOL_GUIDANCE_SHADOWS = [
  ['tool:bash', 1000],
];

/** 真实工具对挂载所需的官方插件包说明符（声明在 optionalDependencies）。 */
export const REAL_PAIR_SPECS = {
  terminal: '@deepseek-ai/dsh-terminal',
  terminalBash: '@deepseek-ai/dsh-terminal-bash',
  bashPersistent: '@deepseek-ai/dsh-tool-bash-persistent',
  fsLocal: '@deepseek-ai/dsh-fs-local',
  strReplaceEditor: '@deepseek-ai/dsh-tool-str-replace-editor',
};

/**
 * 官方包默认导入：安装闭包共享 fallback（$DSH_HOME/profiles/node_modules，
 * harness 启动时 heal 出来的依赖闭包镜像，与 harness 同模块实例）优先，
 * 失败再走本包依赖树。源码运行 + 本地路径安装时插件 realpath 在插件仓库，
 * 裸 import 无法解析官方包，这一 fallback 是真实工具对能挂载的关键；
 * npm 安装模式下它同样命中 harness 同源包，优于 profile 内的依赖副本。
 * Node ESM 不支持目录导入：用包目录的 package.json 作 require 锚解析入口
 * 文件（require.resolve 默认 realpath 化，得到 harness 同源实体路径）。
 */
function defaultRealPairImport(spec: string): Promise<any> {
  try {
    const dshHome = process.env.DSH_HOME?.trim() ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh');
    const anchor = join(dshHome, 'profiles', 'node_modules', spec, 'package.json');
    const real = realpathSync(createRequire(anchor).resolve(spec));
    return import(pathToFileURL(real).href);
  } catch {}
  return import(spec);
}

/**
 * 加载真实 Minimal 工具对所需模块。任一包不可用即整体返回 null（调用方
 * 降级为旧行为），绝不抛出。
 * @param importFn - 测试可注入的 import 实现（默认经安装闭包 fallback 导入）。
 */
export async function loadRealPairModules(importFn?: any): Promise<any> {
  const dynamicImport = importFn ?? defaultRealPairImport;
  const modules: any = {};
  for (const [key, spec] of Object.entries(REAL_PAIR_SPECS)) {
    try {
      const mod = await dynamicImport(spec);
      modules[key] = mod?.default ?? mod;
    } catch {
      modules[key] = null;
    }
  }
  if (Object.keys(REAL_PAIR_SPECS).some((key) => modules[key] === null)) return null;
  return modules;
}

/**
 * 计算真实工具对的挂载清单（纯函数，便于测试）：
 * 顺序 = 依赖在前（terminals → backend → bash；fs → editor）。
 * @param modules - loadRealPairModules 的结果。
 * @param cwd - str_replace_editor 本地 fs 的工作目录（会话 cwd）。
 */
export function realPairMounts(modules: any, cwd: any): any[] {
  if (modules === null || modules === void 0) return [];
  const resolvedCwd = typeof cwd === 'string' && cwd.length > 0
    ? cwd
    : (process.env.DSH_CWD && process.env.DSH_CWD.trim().length > 0 ? process.env.DSH_CWD : process.cwd());
  return [
    { module: modules.terminal, config: {} },
    { module: modules.terminalBash, config: { timeoutMs: REALPAIR_TIMEOUT_MS } },
    { module: modules.bashPersistent, config: { timeoutMs: REALPAIR_TIMEOUT_MS, description: MINIMAL_BASH_DESCRIPTION } },
    { module: modules.fsLocal, config: { cwd: resolvedCwd } },
    { module: modules.strReplaceEditor, config: { maxOutputChars: REALPAIR_MAX_OUTPUT_CHARS } },
  ];
}

/**
 * 在 agent 作用域挂载真实工具对（scoped registration 按名阴影继承工具）。
 * 每个挂载是一个独立 fiber，dispose 时全部副作用（工具/schema/服务）撤销。
 * @param agent - 目标 agent（其 ctx 必须带 scope 标签）。
 * @param mounts - realPairMounts 的结果。
 * @param warn - 日志回调。
 * @returns 可释放的 disposer 列表。
 */
export function mountRealPair(agent: any, mounts: any, warn: any): any[] {
  const disposers: any[] = [];
  if (agent === null || typeof agent !== 'object' || typeof agent.ctx?.plugin !== 'function') return disposers;
  for (const mount of mounts) {
    if (mount?.module === null || mount?.module === void 0) continue;
    try {
      const fiber = agent.ctx.plugin(mount.module, mount.config ?? {});
      disposers.push(() => {
        quietDispose(() => fiber.dispose());
      });
    } catch (error) {
      warn?.(`mountRealPair failed for ${String(mount.module?.name ?? 'module')}: ${String((error as Error)?.message ?? String(error))}`);
    }
  }
  return disposers;
}



// ── 命名常量（避免魔法数字散落；值与语义绑定，改动需同步注释）────────
/** realPair 工具对里 bash 类工具的命令超时（5 分钟，与官方 minimal preset 对齐）。 */
const REALPAIR_TIMEOUT_MS = 300000;
/** str_replace_editor 单次输出的字符封顶。 */
const REALPAIR_MAX_OUTPUT_CHARS = 16000;
/** dev_tool_search 单次返回的匹配条目上限。 */
const DEV_SEARCH_MATCH_LIMIT = 25;
/** dev_tool_search 结果里单条描述的最大字符数。 */
const DEV_SEARCH_DESC_CHARS = 90;
/** skill_search 单次返回的匹配条目上限。 */
const SKILL_SEARCH_MATCH_LIMIT = 20;
/** preset lookup 失败告警的全局上限：pre-step 每条消息都会探测未接管会话，
 *  宿主服务长期故障时不能每条消息刷一条 warn。 */
const MAX_PRESET_LOOKUP_WARNINGS = 20;

/**
 * 释放路径的静默执行：单个 disposer（或任意清理 thunk）的失败不抛出、
 * 不打断其余清理。全量吞错是有意的 fail-safe——卸载/重建路径上任何一步
 * 失败都不应影响后续步骤与主流程；需要排查时看宿主日志的 warn。
 */
function quietDispose(dispose: () => void): void {
  try { dispose(); } catch {}
}

/** 逐个静默释放一个 disposer 集合（数组 / Map.values() / Set 皆可迭代）。 */
function disposeAll(disposers: Iterable<() => void>): void {
  for (const dispose of disposers) quietDispose(dispose);
}

/**
 * 从 agent/pre-step 的 decision.messages 剥离指定 source.kind 的消息。
 * 保留原数组引用（未变化时）便于调用方判断。
 */
export function stripSuppressedMessages(messages: any, suppressedSources: any): any {
  if (!Array.isArray(messages) || suppressedSources.size === 0) return messages;
  const kept = messages.filter((message) => {
    const kind = message?.source?.kind;
    return typeof kind !== 'string' || !suppressedSources.has(kind);
  });
  return kept.length === messages.length ? messages : kept;
}

// ── bootstrap 锚定（参照 dsh-anchored-standard 的实测结论）──────────────

/** promoteOn 配置 → 晋升的持久事件类型集合。 */
export const PROMOTE_EVENTS = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
};

/**
 * dev_tool_search：搜索完整可见目录并按名解锁工具（解锁结果下一请求生效，
 * 经 syncBootstrap 重算 deny 集；解锁记录写入 a.unlocked，resume-safe 由
 * loadUnlockedFromEvents 从持久事件恢复）。
 */
export function createDevToolSearch({ schemasOf, onUnlock, catalogHint }: any): any {
  // 必传：文案由调用方按当前常驻集合描述（skill_search/skill_load 是否
  // 常驻因阶段而异），本函数不内置默认值，避免两份文案漂移。
  if (typeof catalogHint !== 'string' || catalogHint.length === 0) {
    throw new Error('createDevToolSearch: catalogHint is required');
  }
  const hint = catalogHint;
  return {
    name: 'dev_tool_search',
    description: [
      'Discover and unlock tools that are NOT currently available.',
      '',
      hint,
      '',
      'If the current task needs internet, delegation, workflows, goals, images, background jobs, or multi-agent coordination, call dev_tool_search FIRST — do not try to work around them with bash.',
      '',
      'Usage: pass `query` to search the catalog (returns matching tool names + descriptions), then pass `toolNames` with exact names to unlock them. Unlocked tools appear from the next request on and stay unlocked for the session.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'search keywords (e.g. "web", "subagent")' },
        toolNames: { type: 'array', description: 'exact tool names to unlock', items: { type: 'string' } },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_a: any, value: any) => [{ type: 'text', text: value.text }],
    },
    async execute(args: any, exec: any) {
      const query = args !== null && typeof args === 'object' && typeof args.query === 'string' ? args.query.trim() : '';
      const unlock = args !== null && typeof args === 'object' && Array.isArray(args.toolNames)
        ? args.toolNames.filter((name: any) => typeof name === 'string' && name.length > 0)
        : [];
      const lines = [];
      if (unlock.length > 0) {
        let available = new Set<string>();
        try {
          const schemas = typeof schemasOf === 'function' ? (schemasOf(exec) ?? []) : [];
          for (const schema of schemas) {
            if (schema !== null && typeof schema === 'object' && typeof schema.name === 'string') available.add(schema.name);
          }
        } catch {}
        const ok = unlock.filter((name: any) => available.has(name));
        if (ok.length > 0 && typeof onUnlock === 'function') {
          try { await onUnlock(ok, exec); } catch {}
        }
        if (ok.length > 0) lines.push(`Unlocked for the next request: ${ok.join(', ')}`);
        const missing = unlock.filter((name: any) => !available.has(name));
        if (missing.length > 0) lines.push(`Not found in catalog: ${missing.join(', ')}`);
      }
      if (query.length === 0 && unlock.length === 0) {
        lines.push('Provide `query` to search the catalog, or `toolNames` to unlock tools.');
        return { text: lines.join('\n') };
      }
      if (query.length === 0) {
        return { text: lines.join('\n') || 'Nothing to do.' };
      }
      try {
        const schemas = typeof schemasOf === 'function' ? (schemasOf(exec) ?? []) : [];
        const wanted = query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
        const matches = schemas
          .filter((schema: any) => {
            if (schema === null || typeof schema !== 'object') return false;
            const haystack = `${schema.name || ''} ${schema.description || ''}`.toLowerCase();
            return wanted.every((token: any) => haystack.includes(token));
          })
          .slice(0, DEV_SEARCH_MATCH_LIMIT);
        if (matches.length === 0) {
          lines.push(`No tools match "${query}".`);
        } else {
          lines.push(`Matching tools (${matches.length}):`);
          for (const schema of matches) {
            // split 恒返回至少一个元素,[0] 运行时必定义;?? 仅用于 noUncheckedIndexedAccess。
            const desc = (String(schema.description || '').split('\n')[0] ?? '').slice(0, DEV_SEARCH_DESC_CHARS);
            lines.push(`- ${schema.name}: ${desc}`);
          }
          lines.push('Unlock with dev_tool_search({"toolNames": ["<exact name>"]}).');
        }
      } catch (error) {
        lines.push(`catalog search unavailable: ${String((error as Error)?.message ?? String(error))}`);
      }
      return { text: lines.join('\n') };
    },
  };
}

/**
 * skill_search：按关键词搜索可用技能（仅摘要，替代 ~9KB 目录注入）。
 * skillsOf 返回宿主 skills 服务（调用期解析）。
 */
export function createSkillSearch({ skillsOf }: any): any {
  const tokens = (text: any) => (text || '').toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean);
  return {
    name: 'skill_search',
    description: 'Search the available skills by keyword and return matching skill names with short descriptions. This session keeps NO skill catalog in the prompt — if a task looks like it matches a skill (document conversion, image processing, game reviews, markdown, PDF, spreadsheets, …), call skill_search FIRST to find it, then skill_load to activate it. Do NOT assume skill names from memory.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'search keywords (e.g. "pdf", "obsidian", "game review")' } },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_a: any, value: any) => [{ type: 'text', text: value.text }],
    },
    async execute(args: any, exec: any) {
      const wanted = tokens(args?.query);
      try {
        const skills = skillsOf();
        if (skills === void 0 || typeof skills.list !== 'function') {
          return { text: 'skill_search unavailable: skills service is not mounted.' };
        }
        const agent = exec?.agent;
        const lookup = {
          scope: agent,
          cwd: agent?.session?.header?.cwd,
          signal: exec?.signal,
        };
        const all = await skills.list(lookup);
        const matches = (Array.isArray(all) ? all : []).filter((skill: any) => {
          if (wanted.length === 0) return true;
          const haystack = tokens(`${skill?.name ?? ''} ${skill?.description ?? ''} ${skill?.whenToUse ?? ''}`).join(' ');
          return wanted.every((token: any) => haystack.includes(token));
        });
        const head = matches.slice(0, SKILL_SEARCH_MATCH_LIMIT);
        const lines = head.map((skill: any) => {
          const desc = String(skill?.description || '').split('\n')[0] ?? '';
          return `- ${skill?.name}: ${desc}`;
        });
        if (lines.length === 0) return { text: `No skills match "${args?.query}". Use skill_search with other keywords.` };
        const extra = matches.length > SKILL_SEARCH_MATCH_LIMIT ? `\n…(${matches.length - SKILL_SEARCH_MATCH_LIMIT} more)` : '';
        return { text: `Matching skills (${matches.length}):\n${lines.join('\n')}${extra}\n\nLoad one with skill_load (exact name).` };
      } catch (error) {
        return { text: `skill_search unavailable: ${String((error as Error)?.message ?? String(error))}` };
      }
    },
  };
}

/**
 * skill_load：按精确名加载单个技能的完整说明，经 agent.inject 作为
 * source.kind='skill-invocation' 的下一条上下文消息注入（用户主动技能手势
 * 同款来源，绝不被默认抑制集剥离）。
 */
export function createSkillLoad({ skillsOf }: any): any {
  return {
    name: 'skill_load',
    description: 'Load the full instructions of ONE skill by its exact name (from skill_search results) and inject them for the next request. Call this before acting on a task that matches the skill.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'exact skill name (kebab-case, from skill_search)' } },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_a: any, value: any) => [{ type: 'text', text: value.text }],
    },
    async execute(args: any, exec: any) {
      try {
        const agent = exec?.agent;
        if (agent === void 0) return { text: 'skill_load requires an agent context.' };
        const skills = skillsOf();
        if (skills === void 0 || typeof skills.get !== 'function') {
          return { text: 'skill_load unavailable: skills service is not mounted.' };
        }
        const name = typeof args?.name === 'string' ? args.name.trim() : '';
        if (name.length === 0) return { text: 'skill_load requires a skill name.' };
        const skill = await skills.get(name, {
          scope: agent,
          cwd: agent.session?.header?.cwd,
          signal: exec?.signal,
        });
        if (skill === void 0) {
          return { text: `No skill named "${name}". Run skill_search to list available skills.` };
        }
        const body = extractSkillBody(skill);
        if (body.length === 0) {
          return { text: `Skill "${name}" has no loadable body.` };
        }
        if (typeof agent.inject !== 'function') {
          return { text: `Skill "${name}" found, but injection is unavailable in this agent.` };
        }
        agent.inject({
          id: `skill-load-${name}-${Date.now()}`,
          role: 'user',
          content: [{ type: 'text', text: body }],
          source: { kind: 'skill-invocation', name, form: 'instructions' },
        });
        return { text: `Skill "${name}" loaded; its instructions will be injected for the next request.` };
      } catch (error) {
        return { text: `skill_load failed: ${String((error as Error)?.message ?? String(error))}` };
      }
    },
  };
}

/** 提取已加载技能定义的模型可见正文（与参考实现一致）。 */
export function extractSkillBody(skill: any): string {
  const content = skill?.content ?? skill?.instructions ?? skill?.body;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join('\n');
  }
  return '';
}


/**
 * 扫描一段持久会话日志，推导 { promoted } 阶段。
 * 晋升是持久信号（与 dsh-anchored-standard 一致）：首次 promoteOn 事件后
 * 恒为已晋升，resume/reload 不丢状态，compaction 不重置。
 */
export function scanPhase(events: any, promoteEvents: any): any {
  let promoted = false;
  if (Array.isArray(events)) {
    for (const event of events) {
      if (promoteEvents.includes(event?.type)) {
        promoted = true;
        break;
      }
    }
  }
  return { promoted };
}

/** 增量喂入一个持久事件（仅更新已存在条目；冷会话由 scanPhase 全量推导）。 */
export function observePhase(state: any, sessionId: any, event: any): void {
  const entry = state.get(sessionId);
  if (entry === void 0) return;
  if (entry.promoted) return;
  const promoteEvents = Array.isArray(entry.promoteEvents)
    ? entry.promoteEvents
    : (PROMOTE_EVENTS as any)[entry.promoteOn] ?? [];
  if (promoteEvents.includes(event?.type)) {
    state.set(sessionId, { ...entry, promoted: true });
  }
}

/** 首轮输出预算：未晋升 → 封顶；已晋升 → 若仍带着封顶值则剥离。
 * 剥离条件是"值等于当前配置的 cap 或本会话曾写入过的任何旧 cap":
 * 用户在晋升前后改过 cap 的话,header 里残留的是旧值,只比对当前值
 * 会永远剥不掉,会话将永久带着过期封顶。 */
export function applyBootstrapBudget(config: any, promoted: any, maxTokens: any, previousCaps: any[] = []): any {
  if (!promoted) return { ...config, maxTokens };
  if ([maxTokens, ...previousCaps].includes(config?.maxTokens)) {
    const { maxTokens: _drop, ...rest } = config;
    return rest;
  }
  return config;
}

// ── host 插件 ────────────────────────────────────────────────────────────

/** 把配置 namespace 注册进宿主 settings 体系（dsh-settings 0.1.0-rc.7+）。
 * 设置页 describe() 只枚举 settings.register 注册过的 namespace；本插件
 * 的卡片读写不经过宿主 settings 文档，注册只为让卡片出现在设置页。
 * options.base 必传当前生效配置快照：宿主 resolve = schema(mergeLayers(base,
 * section))，schema 无默认值时 base 缺失会让 describe() 的 value 为
 * undefined，而设置页 wire 校验要求 value 非空（invalid_type: nonoptional），
 * 一项失败会拖垮整个设置页。本插件的 any() schema 完全依赖 base。
 * fail-safe（schema 库/服务缺失静默跳过）+ 幂等（重复注册忽略）。
 * 导出以便测试注入 Schema stub。 */
export function registerSettingsNamespace(ctx: any, ns: any, schemaLib: any, buildSchema: any, options: any): boolean {
  if (schemaLib === null || schemaLib === undefined) return false;
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.inject !== 'function') return false;
  try {
    ctx.inject(['settings'], (settingsCtx: any) => {
      try {
        settingsCtx.settings.register(ns, buildSchema(schemaLib), options);
      } catch (error) {
        const message = String((error as Error)?.message ?? String(error));
        if (!message.includes('already registered')) throw error;
      }
    });
    return true;
  } catch (error) {
    try { ctx.logger?.warn?.(`adaptive-perf: settings namespace registration skipped: ${(error as Error)?.message ?? String(error)}`); } catch {}
    return false;
  }
}

export async function apply(ctx: any, config: any, options: any = {}): Promise<void> {
  // fail-safe：初始化失败只记录，绝不让本插件拖垮 harness（host 层挂载时
  // entry 异常会导致进程启动失败）。
  try {
    const systemPrompt = ctx.get('systemPrompt');
    const tools = ctx.get('tools');
    if (systemPrompt === void 0 || tools === void 0) {
      ctx.logger?.warn?.('adaptive-perf: systemPrompt/tools service unavailable; plugin inactive');
      return;
    }
    const agentPresets = ctx.get('agentPresets');
    if (agentPresets === void 0) {
      ctx.logger?.warn?.('adaptive-perf: agentPresets service unavailable (no agent presets composed); plugin inactive');
      return;
    }
    const agentsService = ctx.get('agents');

    const patchConfig = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {};
    /** 当前生效配置（热更新；后续 store 创建后以 config.json 权威合并结果覆盖）。 */
    let cfg = normalizeConfig(patchConfig);

    /** 真实 Minimal 工具对模块（0.5.0）。加载失败 = null = 降级旧行为。
     *  options.realPairModules 仅供测试注入。 */
    let realPairModules = options.realPairModules === void 0
      ? (cfg.bootstrap.enabled && cfg.bootstrap.realPair ? await loadRealPairModules() : null)
      : options.realPairModules;
    /** 是否已尝试加载过真实工具对模块（避免配置热更新时反复重试）。 */
    let realPairModulesTried = options.realPairModules !== void 0 || (cfg.bootstrap.enabled && cfg.bootstrap.realPair);
    if (cfg.bootstrap.enabled && cfg.bootstrap.realPair && realPairModules === null) {
      try {
        ctx.logger?.warn?.('adaptive-perf: real Minimal tool pair modules unavailable (optional @deepseek-ai deps missing?); falling back to catalog-only bootstrap');
      } catch {}
    }

    /**
     * 配置热更新把 realPair 从关闭切到开启时补加载官方模块（初始未启用时
     * 不加载）。加载成功后对已接管会话补挂。
     */
    function ensureRealPairModules() {
      if (realPairModulesTried || cfg.bootstrap.enabled === false || cfg.bootstrap.realPair === false) return;
      realPairModulesTried = true;
      loadRealPairModules().then((mods) => {
        if (mods === null) return;
        realPairModules = mods;
        info('real Minimal tool pair modules loaded; mounting for live agents');
        for (const a of agents.values()) {
          syncRealPair(a);
          applyMinimalPrompt(a);
          syncBootstrap(a);
        }
      }).catch(() => {});
    }

    /** agentId -> 会话自适应状态。 */
    const agents = new Map<any, any>();

    const warn = (message: any) => { try { ctx.logger?.warn?.(`adaptive-perf: ${message}`); } catch {} };
    const info = (message: any) => { try { ctx.logger?.info?.(`adaptive-perf: ${message}`); } catch {} };

    /** preset lookup 失败的全局告警上限：pre-step 每条消息都会探测未接管会话,
     *  宿主服务长期故障时不能每条消息刷一条 warn。 */
    let presetLookupWarnings = 0;
    const warnPresetLookup = (agentId: any, error: any) => {
      if (presetLookupWarnings >= MAX_PRESET_LOOKUP_WARNINGS) return;
      presetLookupWarnings++;
      warn(`preset lookup failed for agent ${agentId}: ${(error as Error)?.message ?? String(error)}`);
    };

    /**
     * 该会话是否为目标 preset。已接管会话直接返回 true（进入 agents 的前提
     * 就是接管时通过了目标判定，而 preset 由 agent.ctx 的 standing mount 决定、
     * 与会话绑定、生命周期内不变）——pre-step 每条消息都会调用本函数，不应
     * 重复走 composedPreset。未接管会话实时判断，让热更新新增 preset 后的
     * sweep 能发现新目标。
     */
    function isTarget(agent: any) {
      if (!cfg.enabled) return false;
      const state = agent !== null && typeof agent === 'object' ? agents.get(agent.id) : void 0;
      if (state !== void 0) return true;
      try {
        const presetId = agentPresets.composedPreset(agent.ctx);
        return presetId !== void 0 && cfg.presets.includes(presetId);
      } catch (error) {
        warnPresetLookup(agent?.id, error);
        return false;
      }
    }

    /** 计算某族当前应隐藏的工具名（与该 agent 实际可见目录取交集）。 */
    function familyDeny(a: any, family: any) {
      if (!Array.isArray(family.tools)) return [];
      return family.tools.filter((n: any) => typeof n === 'string' && a.visibleNames.has(n));
    }

    /** 应用/更新运行时上下文抑制。总开关关闭时一并释放。 */
    function applySuppression(a: any) {
      const want = cfg.enabled && cfg.suppressRuntimeContext;
      if (want && a.suppressDisposer === null) {
        try {
          a.suppressDisposer = a.agent.ctx.systemPrompt.suppressRuntimeContext();
          info(`agent ${a.agent.id}: runtime context suppressed`);
        } catch (error) {
          warn(`suppressRuntimeContext failed for agent ${a.agent.id}: ${(error as Error)?.message ?? String(error)}`);
        }
      } else if (!want && a.suppressDisposer !== null) {
        quietDispose(() => a.suppressDisposer());
        a.suppressDisposer = null;
      }
    }

    /** 应用/更新极简提示词层（persona 阴影 + 全局引导段屏蔽 +
     *  真实工具对替换后的 tool 引导段阴影）。 */
    function applyMinimalPrompt(a: any) {
      disposeAll(a.promptDisposers);
      a.promptDisposers = [];
      if (!cfg.enabled || !cfg.minimalPrompt.enabled) return;
      const sp = a.agent.ctx.systemPrompt;
      try {
        if (cfg.minimalPrompt.suppressSections) {
          for (const [name, order] of SECTION_SHADOWS) {
            a.promptDisposers.push(sp.section({ name, order, text: '' }));
          }
        }
        if (a.realPairActive) {
          for (const [name, order] of TOOL_GUIDANCE_SHADOWS) {
            a.promptDisposers.push(sp.section({ name, order, text: '' }));
          }
        }
        const persona = cfg.minimalPrompt.persona.trim();
        if (persona.length > 0) {
          a.promptDisposers.push(sp.section({ name: PERSONA_SECTION_NAME, order: PERSONA_SECTION_ORDER, text: persona }));
        }
        info(`agent ${a.agent.id}: minimal prompt layer active`);
      } catch (error) {
        warn(`minimalPrompt failed for agent ${a.agent.id}: ${(error as Error)?.message ?? String(error)}`);
      }
    }

    /** 应用/更新工具族限制（lean 模式）。总开关关闭、族被禁用、已升级、
     *  已从配置删除的族一律放行。 */
    function applyFamilies(a: any) {
      if (!cfg.enabled || !cfg.leanByDefault) {
        for (const [id, disposer] of a.familyDisposers) {
          quietDispose(disposer);
          a.familyDisposers.delete(id);
        }
        return;
      }
      // 1) 清理不再需要的限制（族被禁用 / 已升级 / 配置里已不存在）。
      for (const [id, disposer] of a.familyDisposers) {
        const family = cfg.families[id];
        if (family === void 0 || family.enabled === false || a.escalated.has(id)) {
          quietDispose(disposer);
          a.familyDisposers.delete(id);
        }
      }
      // 2) 补齐需要的新限制。
      for (const [id, family] of Object.entries(cfg.families as Record<string, any>)) {
        if (a.familyDisposers.has(id)) continue;
        if (family.enabled === false || a.escalated.has(id)) continue;
        const deny = familyDeny(a, family);
        if (deny.length === 0) continue;
        try {
          const disposer = a.agent.ctx.tools.restrict({ deny });
          a.familyDisposers.set(id, disposer);
        } catch (error) {
          warn(`restrict failed for agent ${a.agent.id} family "${id}": ${(error as Error)?.message ?? String(error)}`);
        }
      }
    }

    /** 当前隐藏的工具名（活跃限制族的 deny 并集 + bootstrap 阶段 restrict
     *  的 deny 并集，供失败信号匹配）。bootstrap restrict 必须计入：默认
     *  配置 leanByDefault=false 时它是工具隐藏的唯一来源，不计入则
     *  escalateOnUnknownTool 在 bootstrap 阶段永远空转。 */
    function hiddenNames(a: any) {
      const out = new Set();
      for (const [id, family] of Object.entries(cfg.families as Record<string, any>)) {
        if (!a.familyDisposers.has(id)) continue;
        for (const n of familyDeny(a, family)) out.add(n);
      }
      if (a.bootstrapDisposer !== null) {
        const keep = bootstrapKeepSet(a);
        if (keep !== null) {
          for (const n of a.visibleNames) {
            if (!keep.has(n)) out.add(n);
          }
        }
      }
      return out;
    }

    /** 放行一个工具族（会话内单调：只升不降）。 */
    function escalate(a: any, familyId: any, trigger: any) {
      if (a.escalated.has(familyId)) return;
      a.escalated.add(familyId);
      const disposer = a.familyDisposers.get(familyId);
      if (disposer !== void 0) {
        quietDispose(disposer);
        a.familyDisposers.delete(familyId);
      }
      // 族 restrict 释放后还须重算 bootstrap deny:两层 restrict 取交集,
      // 不重算的话升级信号对 bootstrap 阶段的会话完全无效。幂等由
      // bootstrapKey 保证(keep 变化才会重挂)。
      syncBootstrap(a);
      info(`agent ${a.agent.id}: escalated family "${familyId}" (${trigger})`);
    }

    /** 从持久事件恢复 dev_tool_search 已解锁的工具（resume-safe）。 */
    function loadUnlockedFromEvents(a: any) {
      const events = a.agent.session && Array.isArray(a.agent.session.events) ? a.agent.session.events : [];
      for (const event of events) {
        if (event === null || typeof event !== 'object' || event.type !== 'tool/call') continue;
        if (event.data === null || typeof event.data !== 'object' || event.data.name !== 'dev_tool_search') continue;
        let args = event.data.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { continue; }
        }
        if (args === null || typeof args !== 'object' || Array.isArray(args)) continue;
        if (Array.isArray(args.toolNames)) {
          for (const name of args.toolNames) {
            if (typeof name === 'string' && name.length > 0) a.unlocked.add(name);
          }
        }
      }
    }

    /**
     * 挂载/卸载真实 Minimal 工具对（0.5.0）：把官方 minimal preset 同款插件
     * （持久 PTY bash + str_replace_editor 及其依赖的 terminals/本地 fs）
     * 挂进 agent 作用域。scoped registration 按名阴影 standard 的 sandboxed
     * bash，且自身层注册不受 restrict 影响（view() 对 own layer 豁免）——
     * 首轮目录因此是"真实工具对 + 被 deny 的其他继承工具"。
     * 依赖模块缺失（realPairModules === null）或 Windows（PTY 仅 linux/darwin）
     * 时静默降级：不挂载，退回旧行为（仅收窄目录）。
     */
    function syncRealPair(a: any) {
      const active = cfg.enabled && cfg.bootstrap.enabled && cfg.bootstrap.realPair
        && realPairModules !== null && process.platform !== 'win32';
      // 幂等键:onUpdate 对每个活跃会话都会调用本函数,若无条件销毁重建,
      // 改任何无关开关都会杀掉持久 PTY bash 的工作目录/环境变量/后台进程。
      // 期望态未变化时直接跳过(与 syncBootstrap 的 bootstrapKey 同一模式)。
      const cwd = a.agent.session?.header?.cwd ?? null;
      const key = active ? 'on:' + String(cwd) : 'off';
      if (a.realPairKey === key) return;
      disposeAll(a.realPairDisposers);
      a.realPairDisposers = [];
      if (active) {
        const mounts = realPairMounts(realPairModules, cwd);
        a.realPairDisposers = mountRealPair(a.agent, mounts, warn);
        if (a.realPairDisposers.length > 0) {
          info(`agent ${a.agent.id}: real Minimal tool pair mounted (${mounts.length} plugins)`);
        }
      }
      a.realPairActive = a.realPairDisposers.length > 0;
      a.realPairKey = key;
    }


    /**
     * 给目标 agent 注册 on-demand 发现工具（dsh-anchored-standard 的 resident
     * discovery pattern）：晋升后常驻 bootstrap.discoveryTools 列出的工具——
     * dev_tool_search（搜索完整目录并按名解锁，解锁结果下一请求生效，写入
     * a.unlocked 后 syncBootstrap 重算 deny 集）+ skill_search / skill_load
     * （常驻上下文抑制的替代品：按需发现/加载技能）。
     * 已存在的同名工具（preset 自带）不重复注册。
     */
    function syncDiscoveryTools(a: any, enabled: any) {
      const want = enabled ? cfg.bootstrap.discoveryTools : [];
      for (const [name, disposer] of a.toolDisposers) {
        if (!want.includes(name)) {
          quietDispose(disposer);
          a.toolDisposers.delete(name);
        }
      }
      if (!enabled) return;
      const scopedTools = a.agent.ctx && a.agent.ctx.tools;
      if (scopedTools === void 0 || typeof scopedTools.register !== 'function') return;
      for (const name of want) {
        if (a.toolDisposers.has(name)) continue;
        if (a.visibleNames.has(name)) continue; // preset/宿主已提供同名工具
        const def = discoveryToolDef(a, name);
        if (def === null) continue;
        try {
          const disposer = scopedTools.register(def);
          if (typeof disposer === 'function') a.toolDisposers.set(name, disposer);
        } catch (error) {
          warn(`register ${name} failed for agent ${a.agent.id}: ${(error as Error)?.message ?? String(error)}`);
        }
      }
    }

    /** 构造一个发现工具定义；未知名称返回 null。 */
    function discoveryToolDef(a: any, name: any) {
      if (name === 'dev_tool_search') {
        return createDevToolSearch({
          schemasOf: (exec: any) => {
            const agent = exec !== null && typeof exec === 'object' ? exec.agent : void 0;
            if (agent === void 0) return [];
            // 限制前快照的完整目录（含 description）：宿主 schemas() 对
            // inherited 面应用 restrict,拿它当语料/校验源会让被隐藏工具
            // 永远搜不到、解不了锁。
            const state = agents.get(agent.id);
            if (state !== void 0) return state.catalog;
            return tools.schemas(agent);
          },
          onUnlock: async (names: any, exec: any) => {
            const agent = exec !== null && typeof exec === 'object' ? exec.agent : void 0;
            const state = agent === void 0 ? void 0 : agents.get(agent.id);
            if (state === void 0) return;
            for (const name of names) state.unlocked.add(name);
            syncBootstrap(state);
          },
          catalogHint: 'This session starts with a minimal resident set: bash, str_replace_editor, skill_search, skill_load. Everything else is unlocked on demand through this tool.',
        });
      }
      if (name === 'skill_search') {
        return createSkillSearch({ skillsOf: () => ctx.get('skills') });
      }
      if (name === 'skill_load') {
        return createSkillLoad({ skillsOf: () => ctx.get('skills') });
      }
      return null;
    }

    /** 完整接管一个 agent（幂等）。preset 在这里判定一次并缓存进状态，
     *  之后 isTarget 对已接管会话走 O(1) 缓存路径。 */
    function handleAgent(agent: any) {
      if (agents.has(agent.id)) return;
      if (!cfg.enabled) return;
      let presetId: any;
      try {
        presetId = agentPresets.composedPreset(agent.ctx);
      } catch (error) {
        warnPresetLookup(agent?.id, error);
        return;
      }
      if (presetId === void 0 || !cfg.presets.includes(presetId)) return;
      const a: any = {
        agent,
        presetId,
        suppressDisposer: null,
        promptDisposers: [],
        familyDisposers: new Map(),
        bootstrapDisposer: null,
        bootstrapKey: null,
        escalated: new Set(),
        visibleNames: new Set(),
        catalog: [],
        unlocked: new Set(),
        bootstrapCaps: [],
        realPairKey: null as any,
        toolDisposers: new Map(),
        realPairDisposers: [],
        realPairActive: false,
      };
      // 记录当前可见目录（限制前）；仅记录真实存在的工具，后续 restrict 与
      // 实际目录取交集，preset 升级改名/删除工具不会让本插件崩溃。
      // catalog 同时保留 description：宿主 schemas() 返回 restrict 后的可见集，
      // dev_tool_search 的搜索语料与解锁校验必须用限制前的完整快照，否则被
      // 隐藏的工具永远无法被发现和解锁。
      try {
        for (const schema of tools.schemas(agent)) {
          if (schema !== null && typeof schema === 'object' && typeof schema.name === 'string') {
            a.visibleNames.add(schema.name);
            a.catalog.push({
              name: schema.name,
              description: typeof schema.description === 'string' ? schema.description : '',
            });
          }
        }
      } catch (error) {
        warn(`schemas lookup failed for agent ${agent.id}: ${(error as Error)?.message ?? String(error)}`);
      }
      loadUnlockedFromEvents(a);
      agents.set(agent.id, a);
      applySuppression(a);
      syncRealPair(a);
      applyMinimalPrompt(a);
      applyFamilies(a);
      syncBootstrap(a);
      info(`agent ${agent.id}: adaptive-perf active (preset ${String(presetId)})`);
    }

    /** 释放一个 agent 的全部副作用。 */
    function releaseAgent(agentId: any) {
      const a = agents.get(agentId);
      agents.delete(agentId);
      bootstrapState.delete(agentId);
      if (a === void 0) return;
      if (a.suppressDisposer !== null) {
        quietDispose(() => a.suppressDisposer());
      }
      disposeAll(a.promptDisposers);
      a.promptDisposers = [];
      disposeAll(a.realPairDisposers);
      a.realPairDisposers = [];
      if (a.bootstrapDisposer !== null) {
        quietDispose(() => a.bootstrapDisposer());
      }
      disposeAll(a.toolDisposers.values());
      a.toolDisposers.clear();
      disposeAll(a.familyDisposers.values());
    }

    // ── 事件监听（注册在 host 根作用域，与 dsh-agent-presets 同款用法）──
    ctx.on('agent/created', ({ agent }: any) => {
      handleAgent(agent);
    });
    ctx.on('agent/disposed', ({ agent }: any) => {
      releaseAgent(agent.id);
    });

    // 关键词信号：用户消息进入收件箱（早于回合处理与请求装配）。
    // 监听器无条件注册，事件时按实时 cfg 判断，热更新开关即时生效。
    ctx.on('agent/inbox/inserted', ({ agent, message }: any) => {
      if (!cfg.enabled || !cfg.escalateOnKeyword) return;
      const a = agents.get(agent.id);
      if (a === void 0) return;
      const text = extractUserText(message);
      if (text.length === 0) return;
      for (const [id, family] of Object.entries(cfg.families as Record<string, any>)) {
        if (a.escalated.has(id) || family.enabled === false) continue;
        if (matchKeywords(text, family.keywords, cfg.keywordMatchMode)) escalate(a, id, 'keyword');
      }
    });

    // 失败信号：PTC 程序调用隐藏工具报错（文本含工具名）时放行对应族。
    ctx.on('tools/result', (exec: any, result: any) => {
      if (!cfg.enabled || !cfg.escalateOnUnknownTool) return;
      const agent = exec !== null && typeof exec === 'object' ? exec.agent : void 0;
      if (agent === void 0) return;
      const a = agents.get(agent.id);
      if (a === void 0) return;
      if (result === null || typeof result !== 'object' || result.isError !== true) return;
      const text = collectFailureText(result);
      if (text.length === 0) return;
      const hidden = hiddenNames(a);
      if (hidden.size === 0) return;
      // 可按族放行的工具名（启用族的全集）：命中它的失败走 escalate——
      // 放行整族（README 的承诺语义）；禁用族的工具与族外工具走按名解锁。
      const escalatable = new Set<string>();
      for (const family of Object.values(cfg.families as Record<string, any>)) {
        if (family.enabled === false) continue;
        for (const n of family.tools) escalatable.add(n);
      }
      let needResync = false;
      for (const [id, family] of Object.entries(cfg.families as Record<string, any>)) {
        if (a.escalated.has(id) || family.enabled === false) continue;
        for (const n of family.tools) {
          if (hidden.has(n) && text.includes(n)) {
            escalate(a, id, 'unknown-tool');
            break;
          }
        }
      }
      // bootstrap 阶段的隐藏范围远大于族并集（首轮只保留工具对 + run_code），
      // 文本命中的隐藏工具若不属于任何可按族放行的工具，按名解锁（与晋升后
      // dev_tool_search 的解锁同一通道，下一请求生效），否则 PTC 程序对该
      // 工具的调用永远失败。
      for (const n of hidden) {
        if (typeof n !== 'string' || escalatable.has(n) || a.unlocked.has(n)) continue;
        if (!text.includes(n)) continue;
        a.unlocked.add(n);
        needResync = true;
        info(`agent ${a.agent.id}: unlocked "${n}" (unknown-tool signal)`);
      }
      if (needResync) syncBootstrap(a);
    });

    // ── 首轮锚定（bootstrap，参照 dsh-anchored-standard 的实测结论）─────
    // 阶段状态：sessionId -> { promoted, promoteEvents }。冷会话在
    // handleAgent 时全量扫描持久日志（resume 安全），此后 session/event 增量
    // 更新。晋升是持久信号（compaction 不重置）。子代理（delegationDepth > 0）
    // 恒为已晋升。所有 waterfall 用 prepend 注册，保证本插件是"最外层"
    // 变换（剥离是最后一道）。
    const bootstrapState = new Map<any, any>();
    let bootstrapWarned = false;
    const warnBootstrapOnce = (message: any) => {
      if (bootstrapWarned) return;
      bootstrapWarned = true;
      warn(message);
    };

    function bootstrapPhaseOf(agent: any) {
      const session = agent !== null && typeof agent === 'object' ? agent.session : void 0;
      if (session === void 0 || typeof session.id !== 'string') return { promoted: true };
      // 子代理首轮即可用工具（与参考实现一致）。
      if ((session.header?.delegationDepth ?? 0) > 0) return { promoted: true };
      let entry = bootstrapState.get(session.id);
      if (entry === void 0) {
        entry = {
          ...scanPhase(session.events, (PROMOTE_EVENTS as any)[cfg.bootstrap.promoteOn]),
          promoteOn: cfg.bootstrap.promoteOn,
        };
        bootstrapState.set(session.id, entry);
      }
      return entry;
    }

    /** bootstrap 是否对该会话生效（总开关 + 目标 preset + 无会话时放行）。 */
    function bootstrapActiveFor(agent: any) {
      if (!cfg.enabled || !cfg.bootstrap.enabled) return false;
      if (agent === void 0) return true;
      return isTarget(agent);
    }

    /**
     * bootstrap 阶段的保留工具集（0.7.0：首轮锚定、晋升后 resident 目录）：
     *  - 未晋升：bootstrap 工具对 + PTC 的直接调用工具（run_code）；
     *  - 已晋升：bootstrap 工具对 + 常驻发现工具（dev_tool_search /
     *    skill_search / skill_load）+ dev_tool_search 已解锁工具
     *    （dsh-anchored-standard 的 resident catalog：晋升时一次性倒出
     *    完整 Standard 目录会把轨迹拉回 standard-like——晋升后回退问题，
     *    因此重型工具保持一次 dev_tool_search 即可取用）。
     *
     * 注意：不能靠过滤 system-prompt/assemble 的 assembly.tools 来实现——
     * PTC 模式下 assembly.tools 只有 [run_code]，Minimal 工具对不在其中，
     * 过滤会触发降级（实测首轮模型仍看到 15 个工具）。正确做法是
     * tools.restrict（与族限制同一机制）：它同时驱动 API 目录和 PTC 的
     * SDK 参考段，且天然保留 run_code（不在 deny 里）。
     */
    function bootstrapKeepSet(a: any) {
      if (!cfg.enabled || !cfg.bootstrap.enabled) return null;
      const session = a.agent.session;
      if (session === void 0) return null; // 无会话信息时保持既有行为（测试/未知场景）
      const phase = bootstrapPhaseOf(a.agent);
      const keep = new Set(cfg.bootstrap.tools);
      if (a.visibleNames.has('run_code')) keep.add('run_code');
      // 已升级族覆盖的工具并入 keep:族 restrict 虽已释放,但宿主对多层
      // restrict 取交集,bootstrap deny 若仍含这些名字,放行信号等于无效。
      for (const familyId of a.escalated) {
        const family = cfg.families?.[familyId];
        if (family === void 0) continue;
        for (const name of familyDeny(a, family)) keep.add(name);
      }
      if (phase.promoted) {
        for (const name of cfg.bootstrap.discoveryTools) keep.add(name);
      }
      // 解锁集在晋升前后都并入:晋升后来自 dev_tool_search 的按需解锁;
      // bootstrap 阶段来自失败信号的按名解锁(escalateOnUnknownTool 对
      // 不属于任何族的隐藏工具——如 coreTools 的 read/write——按名放行,
      // 否则 PTC 程序对这些工具的调用永远 UNKNOWN_TOOL)。
      for (const name of a.unlocked) keep.add(name);
      return keep;
    }

    /** 按当前阶段同步 bootstrap 的临时 restrict（幂等；仅阶段/配置变化时重挂）。 */
    function syncBootstrap(a: any) {
      const phase = bootstrapPhaseOf(a.agent);
      const keep = bootstrapKeepSet(a);
      // discovery 工具只在晋升后的 resident 阶段注册；bootstrap 阶段隐藏。
      syncDiscoveryTools(a, keep !== null && phase.promoted);
      const key = keep === null ? null : [...keep].sort().join(',');
      if (key === a.bootstrapKey) return;
      if (a.bootstrapDisposer !== null) {
        quietDispose(() => a.bootstrapDisposer());
        a.bootstrapDisposer = null;
        a.bootstrapKey = null;
      }
      if (keep === null) return;
      const deny = [...a.visibleNames].filter((name) => !keep.has(name));
      if (deny.length === 0) return;
      try {
        a.bootstrapDisposer = a.agent.ctx.tools.restrict({ deny });
        a.bootstrapKey = key;
        info(`agent ${a.agent.id}: bootstrap restrict deny=${deny.length} keep=[${[...keep].join(',')}]`);
      } catch (error) {
        warn(`bootstrap restrict failed for agent ${a.agent.id}: ${String((error as Error)?.message ?? String(error))}`);
      }
    }

    // 持久事件增量喂入：晋升信号 / compaction 纪元；阶段变化时同步 bootstrap 限制。
    ctx.on('session/event', (session: any, event: any) => {
      if (session === null || typeof session !== 'object' || typeof session.id !== 'string') return;
      const before = bootstrapState.get(session.id);
      observePhase(bootstrapState, session.id, event);
      // agents 以 agent.id 为键，此处以 session.id 取——DSH 中一个 agent 绑定
      // 一个会话，两者 id 同源恒等（回归测试即按此构造）。防御性兜底：若未来
      // 二者分离，按 agent.session.id 兜底查找，晋升信号不至于静默丢配。
      const a = agents.get(session.id)
        ?? [...agents.values()].find((st) => st.agent?.session?.id === session.id);
      if (a !== void 0) {
        const after = bootstrapState.get(session.id);
        if (before === void 0 || after === void 0 || before.promoted !== after.promoted) {
          syncBootstrap(a);
        }
      }
    });

    /** suppressedContextSources 的 Set 缓存（按内容键）：pre-step 每条消息
     *  都要用，不应每次重建。内容键同时覆盖 cfg 对象整体替换与数组原地变更。 */
    let suppressedSetCache: { key: string; set: Set<string> } | null = null;
    function suppressedContextSet() {
      const sources = cfg.bootstrap.suppressedContextSources;
      const key = Array.isArray(sources) ? sources.join('\u0000') : String(sources);
      if (suppressedSetCache === null || suppressedSetCache.key !== key) {
        suppressedSetCache = { key, set: new Set(Array.isArray(sources) ? sources : []) };
      }
      return suppressedSetCache.set;
    }

    // 上下文剥离（首轮锚定的注入部分）。prepend + 根作用域注册保证是
    // 最后一道变换（后注册的注入者无法再补回）。
    // 剥离条件：bootstrap 启用且（未晋升——首轮剥离，或常驻抑制开启——
    // suppressInjectedContext，0.7.0 默认开启：晋升后注入保持剥离，由常驻
    // 发现工具承担功能可见性）。bootstrap 关闭时注入上下文永不剥离——否则
    // 该组合下既剥离注入、又不注册任何发现工具，功能可见性无人承担。
    ctx.on('agent/pre-step', async ({ agent }: any, next: any) => {
      const decision = await next();
      if (decision === null || typeof decision !== 'object' || decision.kind === 'reject') return decision;
      try {
        if (!cfg.enabled || !isTarget(agent)) return decision;
        const phase = bootstrapPhaseOf(agent);
        const suppressed = suppressedContextSet();
        if (suppressed.size === 0) return decision;
        const stripActive = cfg.bootstrap.enabled && (!phase.promoted || cfg.suppressInjectedContext);
        if (!stripActive || !Array.isArray(decision.messages)) return decision;
        const kept = stripSuppressedMessages(decision.messages, suppressed);
        return kept === decision.messages ? decision : { ...decision, messages: kept };
      } catch (error) {
        // 过滤失败绝不吞掉用户的上下文：原样放行。
        warnBootstrapOnce(`bootstrap context filter failed, keeping injected context: ${String((error as Error)?.message ?? String(error))}`);
        return decision;
      }
    }, { prepend: true });

    // 可选：请求 #1 输出预算封顶（晋升后剥离，避免封顶沿 header 种子延续）。
    // 监听器恒注册、回调内按实时配置分支:安装时 maxTokens=0 之后热更新成
    // >0 也要生效(条件注册会让它静默失效);N→0 则必须从请求里剥掉字段
    // 而不是注入 0(宿主只把 void 0 视为缺省,显式 0 会原样进适配器)。
    ctx.on('agent/request', async ({ agent }: any, next: any) => {
      const resolved = await next();
      try {
        if (!bootstrapActiveFor(agent)) return resolved;
        const phase = bootstrapPhaseOf(agent);
        const state = agents.get(agent.id);
        const cap = cfg.bootstrap.maxTokens;
        if (!phase.promoted) {
          if (cap <= 0) return applyBootstrapBudget(resolved, true, cap);
          if (state !== void 0 && state.bootstrapCaps[state.bootstrapCaps.length - 1] !== cap) {
            state.bootstrapCaps.push(cap);
          }
          return applyBootstrapBudget(resolved, false, cap);
        }
        // 晋升后剥离本插件曾写入过的任何 cap(含热更新前的旧值)。
        return applyBootstrapBudget(resolved, true, cap, state !== void 0 ? state.bootstrapCaps : []);
      } catch (error) {
        warnBootstrapOnce(`bootstrap budget filter failed: ${String((error as Error)?.message ?? String(error))}`);
        return resolved;
      }
    }, { prepend: true });

    // 已运行会话补挂（插件热重载/重装时）。
    if (agentsService !== void 0 && typeof agentsService.list === 'function') {
      try {
        for (const agent of agentsService.list()) handleAgent(agent);
      } catch (error) {
        warn(`existing agent sweep failed: ${(error as Error)?.message ?? String(error)}`);
      }
    }

    // 配置存储：patch config 为低优先级，config.json（设置页 UI）权威。
    // onUpdate 把 UI 保存的改动热更新进 cfg，并对所有已接管会话重算。
    const store = createConfigStore({
      name: 'adaptive-perf',
      defaults: DEFAULT_CONFIG,
      patchConfig,
      validate: validateConfig,
      warn,
      onUpdate: (merged) => {
        const prevPromoteOn = cfg.bootstrap.promoteOn;
        cfg = normalizeConfig({ ...patchConfig, ...merged });
        if (cfg.bootstrap.promoteOn !== prevPromoteOn) {
          // 旧 phase 条目缓存了按旧 promoteOn 解析的触发事件集,增量观察会
          // 继续沿用;清空后由 bootstrapPhaseOf 按新配置从持久日志全量重建
          // (scanPhase 推导,已晋升会话不受影响——晋升是持久信号)。
          bootstrapState.clear();
          info(`bootstrap.promoteOn changed to "${cfg.bootstrap.promoteOn}"; bootstrap phase cache rebuilt`);
        }
        info('config hot-updated; recomputing restrictions for live agents');
        // realPair 从关闭切到开启：补加载官方模块（首次尝试失败不反复重试）。
        ensureRealPairModules();
        // 补挂此前创建的会话（例如插件从 disabled 切换为 enabled，或新增了
        // 目标 preset）：新符合条件的 agent 立即接管（handleAgent 已应用全部
        // 层，下面的重算只针对此前已接管的 agent，避免同一 onUpdate 内重复）。
        const existing = new Set(agents.keys());
        if (agentsService !== void 0 && typeof agentsService.list === 'function') {
          try {
            for (const agent of agentsService.list()) handleAgent(agent);
          } catch (error) {
            warn(`config-update agent sweep failed: ${(error as Error)?.message ?? String(error)}`);
          }
        }
        for (const agentId of existing) {
          const a = agents.get(agentId);
          if (a === void 0) continue;
          applySuppression(a);
          syncRealPair(a);
          applyMinimalPrompt(a);
          applyFamilies(a);
          syncBootstrap(a);
        }
      },
    });
    cfg = normalizeConfig(store.effective());

    // 远程配置服务（设置页 UI 读写；typert 不可用时跳过）
    if (PluginConfigGateway !== null) {
      ctx.plugin(PluginConfigGateway, { store, serviceKey: 'adaptivePerfConfig' });
    }

    // 注册进宿主 settings 体系（可见性）：设置页用 settings.describe() 枚举
    // registrations，未注册的 namespace 即使卡片带正确的 key 也不渲染。
    // 卡片的实际读写仍走上面的 config gateway（config.json 权威、热更新）。
    // 配置为多层嵌套结构（families/bootstrap/minimalPrompt…），schema 用 any
    // 透传——describe 元数据只服务于可见性，卡片不读取它。any() 无默认值，
    // 必须传 base（当前生效配置快照），否则 describe() 的 value 为 undefined，
    // 设置页 wire 校验（nonoptional）会整体失败。
    // namespace 必须匹配宿主 settings 的 ^[a-z][a-z0-9-]*$——驼峰会被
    // register() 抛 TypeError、inject 回调失败被静默吞掉，设置页遂不渲染卡片。
    registerSettingsNamespace(ctx, 'adaptive-perf-config', Schema, (z: any) => z.any(), { base: cfg });

    // 卸载清理：释放全部会话副作用与监听。
    ctx.effect(() => () => {
      for (const agentId of [...agents.keys()]) releaseAgent(agentId);
    });
  } catch (error) {
    try { ctx.logger?.error?.(`adaptive-perf: init failed (harness continues without adaptive performance): ${(error as Error)?.message ?? String(error)}`); } catch {}
  }
}
