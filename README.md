# dsh-model-meta-autofill

DSH 插件：为**自定义供应商**（`llm-pi-ai` 设置区）里配置的模型自动预填元数据——上下文长度（contextWindow）、输出上限（maxTokens）、显示名（name）与输入模态（input）——数据来源为 [models.dev](https://models.dev/)（Model Metadata Registry）。

在「Models」页从自定义网关发现（interrogation）出来的模型、或手工录入的模型，通常只有 id。本插件把目录里已知的元数据填回该模型的配置项，让界面可直接查看、也让上游据此做容量调度；**已由你手动设置过的字段一律不被覆盖**。

## 工作原理

1. **离线索引**：构建时把 models.dev 目录归一化去重后打进包内（`lib/data/models.dev.json`），离线立即可用。
2. **实时刷新（可选，默认开）**：启动时（及可选定时）拉取最新目录（models.dev/api.json）并合并到索引之上；每个数据源独立失败隔离，失败不影响其余源与离线索引。
3. **设置写入**：插件监听 `llm-pi-ai` 设置区的变化（模型被采纳/编辑），对「有缺的模型」生成补丁，通过设置管线的 `update` 写入——这就是「自动预填」。
   - 只填**缺失**字段，绝不覆盖你设置过的值；
   - 只处理**存在于你自己设置层**的 provider 路由（组合 base 里仅有的 provider 不会被物化进用户文档）；
   - `models` 列表有改动时整表重述（设置合并对数组是整表替换语义，避免部分列表悄悄丢模型）；
   - 写出的文档是幂等的：填完之后没有缺失项，因此不会循环写。
4. **Host 服务**：`ctx.modelMeta` 向其他插件暴露索引与纯函数助手（`lookup / stats / refresh / buildSectionPatch`）。

> 说明：`fillReasoning`（推理属性）为保留开关，默认关闭——各供应商对推理模式的 wire 拼写不同，目录数据没有可移植的通用表达，宁可不动。

## 安装

插件是**宿主侧（host）**插件，需装入运行 dsh web 的 profile（当前会话为 `~/.dsh/profiles/web`）。

```bash
# 1) 构建产物
pnpm build            # 生成 lib/（含打包的 lib/data/*.json）

# 2) 打包或本地安装到 profile
npm pack              # 产出 tarball
dsh plugin --profile web add dsh-model-meta-autofill@<tarball路径或 npm 包名>
```

`cordis.patch.yml`（`dsh.bundle.patch`）会在安装时自动插入一行配置到 profile 的补丁层：

```yaml
- insert:
    - id: model-meta-autofill
      name: 'dsh-model-meta-autofill'
      config:
        sources: [models.dev]
        refreshOnStart: true
        refreshIntervalMs: 0
        timeoutMs: 15000
        autoApply: true
        dryRun: false
        fillName: true
        fillInput: true
        fillReasoning: false
```

重启 dsh web（或对应管理面重载插件）后生效。首次运行时若 `llm-pi-ai` 已存在带模型的 provider，初始扫描会立即补填一次。

## Web 界面操作（插件自带）

插件同时带一个**客户端 half**（`dsh.client` 声明，走壳的 `/plugins` 动态加载协议，零改壳代码），样式沿用设置页的设计语言（720px 栏宽、border-l2 细线卡片、胶囊按钮、`--dsw-alias-*` 令牌）。重启后，设置页出现「**模型元数据**」分区：

- 顶部工具栏（靠前位置）：**「全部覆盖」**主按钮——一次把所有已匹配模型换成 models.dev 的值；旁边是**「显示名称携带厂商名」**开关（决定填充的显示名是否写成 `xAI: Grok 4.5` 这种厂商前缀形式；选择会记住），以及「刷新」与模型/匹配计数；
- 每个自定义供应商一张卡片，**点头部可折叠/展开**，带「N 个模型 / 已匹配 M」标签；
- 卡片内每个模型一行：模型 id（等宽字体）· 当前配置 · models.dev 目录值（随开关实时预览显示名）·「填充」按钮；
- 目录没有该模型 → 按钮置灰显示「无匹配」；填充未匹配会明确提示「models.dev 没有匹配到：<id>」；写入失败显示宿主返回的具体原因（含孤儿锁提示）。


同一能力也开放为 HTTP 端点（本机回环，可直接 curl / 浏览器 console 调用）：

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/model-meta-autofill/api/status` | GET | 插件状态（源、索引条数） |
| `/model-meta-autofill/api/models` | GET | 全部供应商 + 模型的匹配状态与目录值 |
| `/model-meta-autofill/api/apply` | POST | `{provider, modelId, overwrite?, nameStyle?}` 单模型换用目录值；返回 `{ok:true, applied}` 或 `{ok:false, reason:'no-match'\|...}` |
| `/model-meta-autofill/api/apply-all` | POST | `{nameStyle?}` 全部覆盖（一个补丁覆盖所有已匹配模型）；返回 `{ok, filled, missed}` |

## 思考等级（推理强度）声明

自定义供应商走 llm-pi-ai 适配器，支持完整的推理等级链路（off/minimal/low/medium/high/xhigh/max），但**手写的模型没有推理元数据**，模型选择器里就不会出现强度选项。本分区补上这个声明环节：

1. **wire 协议**：每个供应商卡片里选 compat.thinkingFormat（openai / deepseek / openrouter / together / zai / qwen / string-thinking / ant-ling）——这是等级翻译成的 wire 参数格式，取决于你的网关方言；
2. **每个模型的等级**：展开模型行，勾选要开放的等级、填每级的 wire 值（预填值按所选协议自动给出；「填入建议」用 models.dev 的 reasoning_options 档位建议一键生成草稿），点「应用等级」写入 reasoningEfforts；也可以「声明非推理」（reasoningEfforts: false）；
3. 声明写入后，**输入框右下角的模型选择器自动出现强度选项**（与 DeepSeek 官方路径同款交互），选择经 thinkingLevelMap 翻译成 wire 值发给网关。

> wire 值是否正确取决于网关：声明环节把推荐值预填了，但网关若不认某个参数，行为由网关决定（多数忽略）。


## 配置

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关 |
| `sources` | string[] | `[models.dev]` | 要合并的目录源：`models.dev`（Model Metadata Registry，https://models.dev/api.json）、PublicProviderConf 的 `dist/{name}.json` 的 `name`（如 `aihubmix`，需先 `pnpm gen:data <name>` 生成快照），或直接给 `http(s)://` URL。后面的源对同一模型优先生效 |
| `refreshOnStart` | boolean | `true` | 启动时拉取一次实时目录 |
| `refreshIntervalMs` | number | `0` | >0 时按此间隔定时刷新（毫秒） |
| `timeoutMs` | number | `15000` | 单次拉取超时 |
| `autoApply` | boolean | `true` | 是否把补丁写入设置区（关掉则插件只提供 `ctx.modelMeta` 查询） |
| `dryRun` | boolean | `false` | 试运行：只记录将补填的条目，不写设置（配合日志观察） |
| `fillName` | boolean | `true` | 补显示名 |
| `fillInput` | boolean | `true` | 补输入模态（`text`，视觉模型再加 `image`） |
| `fillReasoning` | boolean | `false` | 保留；当前恒为 false |

## 数据源

默认且唯一的打包上游是 **models.dev**（[Model Metadata Registry](https://models.dev/)，API 为 https://models.dev/api.json）——按厂商聚合的标准模型元数据目录：`limit.context/output` 一律为数字、字段口径统一（`modalities.input/output`、`reasoning`、知识截止日期、成本），覆盖包含最新型号的全量模型（对当前工作区的自定义模型 100% 命中）。如需 PublicProviderConf 网关拼写兜底，可用 `pnpm gen:data aihubmix` 生成快照并把 `aihubmix` 加进 `sources`。

- 更新打包数据（在插件工作区）：

```bash
pnpm gen:data      # 拉取默认源并规整为 src/data/{source}.json（归一化逻辑即插件自身）
pnpm build         # 重新打包
```

- 容量字段兼容两类写法：纯数字（`1048576`）与带后缀字符串（`128K`/`1M`/`256k`，按 1024 进制换算）；同一 base id 的多供应商记录自动去重并保留信息最全的一条。
- 插件对模型 id 的别名做了兼容：精确 id、小写、`provider/` 前缀剥除、`~` 变体，均可命中。
- 目录中未出现的（新发布/小众）模型不会被猜测——「能查到多少填多少」。

## 开发

```bash
pnpm typecheck            # tsc -p tsconfig.json（src + tests）
pnpm test                 # node 内置测试器 + tsx：dataset / enrich / 集成（真实 SettingsProvider）
pnpm build                # tsc -p tsconfig.build.json + scripts/copy-data.mjs → lib/
```

集成测试（`tests/integration/settings-autofill.spec.ts`）用内存版 `SettingsProvider`（与 dsh 设置实现的加载/持久化接口一致）验证：初始扫描补填、事后采纳补填、用户值保留、幂等终止、dry-run 零写入、base-only provider 不被物化。

## 局限

- 目标设置区固定为 `llm-pi-ai`（自定义供应商）。模型发现（`discoverModels`）仍归 llm-pi-ai 自身所有，本插件不做发现。
- 只填目录里有据可查的字段；目录条目缺容量时不下发任何猜测值。
- 补丁按「缺失才填」生成，用户的既有值（含 `modelOverrides`）始终优先。

## License

MIT
