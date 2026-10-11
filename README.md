# dsh-model-meta-autofill

DSH 插件：为**自定义供应商**（`llm-pi-ai` 设置区）里配置的模型自动预填元数据——上下文长度（contextWindow）、输出上限（maxTokens）、显示名（name）与输入模态（input）——数据来源为 [models.dev](https://models.dev/)（Model Metadata Registry）。

在「Models」页从自定义网关发现（interrogation）出来的模型、或手工录入的模型，通常只有 id。本插件把目录里已知的元数据填进去，让界面可直接查看、也让上游据此做容量调度。

两条通路，都**不写设置**：

- **拉取时补全（自动）**：在「Models」页点「获取可用模型」时，插件在发现结果**返回之前**把目录元数据填进每个候选模型，所以你在对话框里采纳的那些行**自带**显示名与容量，不需要事后补填。
- **手动「自动获取」**：在供应商卡片或单个模型行上按一下，把目录值**填进表单**（供应商级填整张卡片的所有行，按模型级只填那一行），随后由卡片自己的「保存」提交。它同样不写设置，所以目录不认识的模型、以及同一卡片里其它未保存的修改都不会被牵连（见「Web 界面操作」）。

## 工作原理

1. **离线索引**：构建时把 models.dev 目录归一化去重后打进包内（`lib/data/models.dev.json`），离线立即可用。
2. **实时刷新（可选，默认开）**：启动时（及可选定时）拉取最新目录（models.dev/api.json）并合并到索引之上；每个数据源独立失败隔离，失败不影响其余源与离线索引。
3. **拉取时补全元数据**：插件**包住** LLM 服务的 `discoverModels`，在它返回候选之后、交给调用方之前，把目录已知的字段填进每个候选：
   - 只填**缺失**字段：网关自己给出的容量与显示名一律保留，只有它没说的才用目录值补上；
   - **把「显示名恰好等于模型 id」当作没填**：很多网关会拿 id 当名字返回（实测某个 mock 网关就是 `name: "deepseek-v4-flash"`），若当成已填，目录里那个可读的名字就永远上不来，卡片上只显示一串 id；
   - 目录**不认识**的模型**原样返回**，绝不猜测；
   - 绝不**新增**网关没有返回的模型：发现回答的是「这个端点提供什么」，本插件只描述这些回答；
   - 只对该插件负责的设置区（`llm-pi-ai`）生效，别的适配器家族的结果原样透传。
4. **Host 服务**：`ctx.modelMeta` 向其他插件暴露索引与纯函数助手（`lookup / stats / refresh / buildSectionPatch`）。

> 说明：`fillReasoning`（推理属性）为保留开关，默认关闭——各供应商对推理模式的 wire 拼写不同，目录数据没有可移植的通用表达，宁可不动。

## 安装

插件是**宿主侧（host）**插件，需装入运行 dsh web 的 profile（例如 `~/.dsh/profiles/web`）。

从 npm 安装（发布版）：

```bash
dsh plugin --profile web add dsh-model-meta-autofill
```

或从源码安装（本地构建）：

```bash
pnpm install          # 开发依赖全部来自 npm 发布版（见「开发」）
pnpm build            # 生成 lib/（含打包的 lib/data/*.json）
pnpm pack             # 产出 tarball
dsh plugin --profile web add dsh-model-meta-autofill@<tarball路径>
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
        fillName: true
        fillInput: true
        fillReasoning: false
```

重启 dsh web（或对应管理面重载插件）后生效。首次运行时若 `llm-pi-ai` 已存在带模型的 provider，初始扫描会立即补填一次。

## Web 界面操作

插件带一个**客户端 half**（`dsh.client` 声明，走壳的 `/plugins` 动态加载协议，零改壳代码），它不占用设置分区，只在模型设置页注入两个同名的**「自动获取」**按钮：

- **供应商级**——位于该卡片**「模型目录」标题行**（`恢复默认模型` 与 `获取可用模型` 之间）。它长得和同一行的 `恢复默认模型` / `获取可用模型` 完全一样（同样的内联文本按钮样式，实测三者的计算样式逐项相同）。按下后把该卡片**所有**模型行的目录值填进各自的输入框：`显示名称` / `上下文窗口` / `最大输出 token 数`，以及 `输入类型` 复选框。整卡一次请求（`?ids=a,b,c`，去重），所以按下按钮只发一个请求。
- **按模型**——位于**展开的模型行**的**「输入类型」那一行**末尾（折叠的行没有这一行，展开后才出现）。它只填**该行**。

**两者都是纯表单填充，自己不写设置**：填完后由该卡片的**「保存」**提交（结果显示「已填入 …，点「保存」写入」）。这个选择直接决定了两件事：

- 目录**不认识**的模型（你自己的私有模型、或目录还没收录的新模型）**完全不受影响**——按钮根本不去碰它们，它们带着你手工填的值原样留着；
- 没有任何外部写入，所以打开中的卡片那条 revision 栅栏**不会**失效：卡片始终可「保存」，**全程不需要关闭或重开**（实测按一次供应商级按钮的过程里，`编辑/关闭` 的点击次数为 0，卡片一直开着，设置文档一模一样）。

模型 id 在**点击时**从该行的输入框读取，所以改了 id 再点，查的就是改后的 id。行处于折叠状态时没有输入框，按钮会先替它展开再填入。目录没有的字段（例如某模型没有 `maxTokens`）**保持原样**，不会被清空。

结果显示在**气泡**里（沿用页面自身 tooltip 的配色与字号，挂在 `body` 上、`position: fixed`），不塞进所在那一行：早先版本把状态文字直接写进「输入类型」行内，会把该行撑成两行、平白改动页面布局。气泡脱离文档流，显示它不会挤动任何东西（实测行高与卡片高度在显示前后完全一致）；成功提示约 3 秒后自动消失，需要看清的拒绝/失败提示约 6.5 秒，新的结果替换旧的而不是叠加。

未保存的「添加供应商」草稿卡片没有持久化路由，因此不会挂按钮；供应商不在你的配置层（只来自组合基础层）时也不会挂按钮。

### 为什么是「填表单」而不是「直接写设置再刷新」

早先的版本直接调设置服务写入，然后**关闭并重开卡片**来显示结果。那条路有两个绕不开的问题：

1. **重开会丢弃该卡片里未保存的内容**。为了不丢的东西还得先替用户按一次「保存」，等于在按钮里替用户做决定。
2. **想让重开变得无感，只能去够 React 的私有内部结构**。实测可行：编辑器的 fiber 挂在 DOM 节点上（`__reactFiber$`），找到它、拿到挂载时那份草稿与 `expectedRevision` 的 `useState` setter，就能直接把新值 dispatch 进去——输入框会当场重绘（`12345` → `424242`，卡片全程开着），把 revision 基线一并刷新后「保存」也依然可用（实测改一笔再保存被接受并落盘）。但这依赖**未公开的 hook 顺序与形状**，宿主或 React 升级会让它**静默**失效，而这个仓库已经被同类的隐式假设坑过两次。

填表单把这两个问题一起消掉了：不写设置，就没有冲突要修；不动卡片，就没有重开要藏。代价是**持久化需要你自己按一次「保存」**——这也让「填什么」和「何时落盘」重新分开，符合本页其它控件的习惯。

填输入框必须走**宿主自己的受控输入通道**：React 会在输入框节点上记录它上次渲染的值，所以直接 `input.value = x` 会让 React 把随后的 change 事件当成空操作，草稿里仍是旧值（界面看着变了、一「保存」就发现没写进去）。因此填入先用 `HTMLInputElement.prototype` 上的原生 setter 清掉这个记录，再派发 `input` 事件；`tests/client-injection.spec.ts` 里的 DOM 桩特意模拟了这套 tracker，所以退回直接赋值会让用例失败（已实测）。

### 为什么用 DOM 注入而不是槽位

模型卡片唯一的**按卡片**扩展席位是 `settings.models.provider-card`，它是 **keyed** 槽位，而一个 keyed 单元**同时只能有一个注册方**：同 key、同 priority（默认 0）的第二次注册会直接抛错（`keyed slot "..." already has an entry for key "..."`），并让该插件的 fiber 变为 FAILED、`apply` 余下部分全部中断。由于 `dsh-better-reasoning-effort` 等插件已经占用了 `llm-pi-ai` 这个单元，注册进去必然失败，且用更低 priority 抢占会让**对方的 UI 静默消失**（keyed 是替换语义，不是叠加）。该卡片没有其它按卡片席位（`settings.models.footer` 是整页 list，`settings.models.sign-in` 是整页 single），编辑器内部更是**完全没有**扩展席位。

因此本 half 改为挂到**已渲染的 DOM** 上，并用 `MutationObserver` 跟随页面的开合与重渲染：

- 以 `[class*="rowCard"]` 等模糊匹配定位锚点（CSS Modules 会哈希前缀、保留后缀，如 `_3nPmjq_rowCard`，所以不能写死完整类名）；
- 供应商级锚点是 `[class*="modelListHead"]`，按钮插在最后一个按钮之前，因此与「获取可用模型」并排；
- 按模型锚点是某个 `[class*="modelEntry"]` 内的 `[class*="modelInputChoices"]`，模型 id 从该行自己的 `aria-label` 以「模型 ID」开头的输入框读出（不复制宿主文案，只读它）；
- 填入时按 `aria-label` 前缀找 `显示名称` / `上下文窗口` / `最大输出` 三个输入框，`输入类型` 则按复选框自己的可见标签（`文本` / `图片`）定位；已经勾选的就**不再点**（受控复选框会被点反），写入的容量按宿主自己的写法拼（十进制，`1M` = 1000K）；
- 卡片标题取自 `[class*="rowHead"]` 内的 `[class*="rowName"]`；标题不一定等于路由 id（如 `WorkBuddy` → `workbuddy`），故先向 `/api/providers` 取映射再回填；
- 每个锚点最多一个按钮（重复扫描不会叠加），并在 `ctx.effect` 的清理里断开 observer、移除全部注入节点，因此卸载/重载/HMR 都不会留下残留；样式表在**每一轮**扫描里重新确认存在（loader 会回收 `style[data-plugin]` 标签，而 `head` 也在 observer 的观察范围内）。

代价是这一层依赖宿主的类名结构与中文标签，宿主改版时需要跟进。

同一能力也开放为 HTTP 端点（本机回环，可直接 curl / 浏览器 console 调用）。两个端点都是**只读**的——它们回答目录值，由调用方决定怎么用：

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/model-meta-autofill/api/providers` | GET | 用户层的供应商路由、卡片标题与其模型行：`{providers:[{provider, displayName, models:[{id, name?, contextWindow?, maxTokens?}]}]}`（供上面那层把标题映射回路由 id，并供整卡填充知道该问哪些模型 id） |
| `/model-meta-autofill/api/catalog` | GET | `?ids=<模型 id>[,<模型 id>…]`，逗号分隔并去重；返回 `{ok: true, models: {<id>: {id, name?, contextWindow?, maxTokens?, input?}}, unknown: [<目录不认识的 id>]}`。目录不认识的 id 落在 `unknown` 里而**不是**错误（这是要转达给用户的事实）；完全没有可用 id 才是 400 |

`nameStyle`（可选，`bare` 默认 / `vendor`）决定显示名是否写成 `xAI: Grok 4.5` 这种厂商前缀形式。目录条目缺字段时该字段**不出现**在回答里，调用方据此保持原值——绝不下发猜测值。

## 配置

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关 |
| `sources` | string[] | `[models.dev]` | 要合并的目录源：`models.dev`（Model Metadata Registry，https://models.dev/api.json）、PublicProviderConf 的 `dist/{name}.json` 的 `name`（如 `aihubmix`，需先 `pnpm gen:data <name>` 生成快照），或直接给 `http(s)://` URL。后面的源对同一模型优先生效 |
| `refreshOnStart` | boolean | `true` | 启动时拉取一次实时目录 |
| `refreshIntervalMs` | number | `0` | >0 时按此间隔定时刷新（毫秒） |
| `timeoutMs` | number | `15000` | 单次拉取超时 |
| `fillName` | boolean | `true` | 补显示名（网关把 id 当名字返回时也补） |
| `fillInput` | boolean | `true` | 补输入模态（`text`，视觉模型再加 `image`） |
| `fillReasoning` | boolean | `false` | 保留；当前恒为 false |

## 数据源

默认且唯一的打包上游是 **models.dev**（[Model Metadata Registry](https://models.dev/)，API 为 https://models.dev/api.json）——按厂商聚合的标准模型元数据目录：`limit.context/output` 一律为数字、字段口径统一（`modalities.input/output`、`reasoning`、知识截止日期、成本），覆盖包含最新型号的全量模型。如需 PublicProviderConf 网关拼写兜底，可用 `pnpm gen:data aihubmix` 生成快照并把 `aihubmix` 加进 `sources`。

- 更新打包数据（在本仓库根目录）：

```bash
pnpm gen:data      # 拉取默认源并规整为 src/data/{source}.json（归一化逻辑即插件自身）
pnpm build         # 重新打包
```

- 容量字段兼容两类写法：纯数字（`1048576`）与带后缀字符串（`128K`/`1M`/`256k`，按 1024 进制换算）；同一 base id 的多供应商记录自动去重并保留信息最全的一条。
- 插件对模型 id 的别名做了兼容：精确 id、小写、`provider/` 前缀剥除、`~` 变体，均可命中。
- 目录中未出现的（新发布/小众）模型不会被猜测——「能查到多少填多少」。

## 开发

所有开发期依赖（`@deepseek-ai/cordis`、`dsh-settings`、`dsh-util-values`、`dsh-host-webserver`、`dsh-credentials` 等）都从 npm 安装的发布版本解析，无需 DeepSeek Harness 源码 checkout。

宿主侧 API 由 Harness 提供，因此 `peerDependencies` 声明了可用的最低版本：

| peer | 最低版本 | 原因 |
| --- | --- | --- |
| `@deepseek-ai/dsh-settings` | `0.1.7-alpha.1` | 该版本起 `ctx.settings` 是 `SettingsForms`（`describe`/`update`/`replace`/`mutate`）。更早的版本走已删除的 `SettingsProvider` seam（`settingsNamespace()` / `settings/updated` / `settings.get()`），本插件不再支持 |
| `@deepseek-ai/dsh-util-values` | `0.1.7-alpha.1` | `deepEqualJson` 已从 `dsh-settings` 迁到这里 |
| `@deepseek-ai/cordis` | `^4.0.0` | `ctx.inject` / `ctx.effect` / `Service` |

```bash
pnpm typecheck            # tsc -p tsconfig.json（src + tests）
pnpm test                 # node 内置测试器 + tsx：dataset / enrich / discovery / discovery-runtime / api / client-bundle / client-injection / 集成
pnpm build                # tsc -p tsconfig.build.json + tsc -p tsconfig.client.json + scripts/copy-data.mjs → lib/
```

集成测试（`tests/integration/settings-autofill.spec.ts`）通过 `@deepseek-ai/dsh-app-boot` 的 `boot()` 起一个真实 profile（真 `ConfigEditor` + 真 `SettingsForms` + **真 `LlmRuntime`**），断言读取的就是生产调用方读的 `ctx.settings.describe()` 与 `ctx.llm`。覆盖：候选被补全、**Remote 路径**（页面真正走的那条）同样被补全、网关已给的值被保留、目录未收录的模型原样返回、不新增模型、别的适配器家族不受影响、失败照实抛出、卸载后不留影子，以及**启动零写入**。

> 为什么这个 fixture 必须用真的 `LlmRuntime`：插件是**包住服务实例的方法**来完成补全的，而手写的替身不会经过 Cordis 的服务解析层。曾经有一版用一个记日志的普通对象做替身，测试全绿，但真机上候选仍是裸 id。

### 浏览器半的脚本约束（`src/client.ts`）

`lib/client.js` 以**传统脚本**（classic script）下发，且 combo 会把多个包拼接成同一个脚本；插件的“同步”也是重新执行该 bundle。传统脚本共用**同一个全局词法环境**，因此顶层 `const`/`let`/`class` 只要出现一次，后续再执行就会在**编译期**抛 `Identifier 'X' has already been declared`。这种失败**不会**在 `<script>` 上触发 `error` 事件，加载看起来仍成功，客户端模块系统于是报：

```
loaded without registering "dsh-model-meta-autofill" via __ModuleLoader__.load
```

规则：**所有声明都必须位于 `require` 工厂函数内部**（官方 tsdown 预设即如此，其 banner/footer 把整个 bundle 包进工厂）。`tests/client-bundle.spec.ts` 会在同一个 realm 中连续执行两次 `lib/client.js`，并静态检查 `src/client.ts` 没有顶层声明、且**没有任何槽位注册调用**，`pnpm test` 即覆盖该约束。

`tests/client-injection.spec.ts` 则用一个最小 DOM 桩执行同一份 `lib/client.js`，断言真正的落点行为：供应商级按钮落在「模型目录」标题行且位于「获取可用模型」之前、按模型按钮只出现在**展开的**模型行上并落在「输入类型」行内、重复扫描不叠加、标题能映射回路由 id、整卡填充只发一个 `?ids=` 请求且按行序去重、空白 id 不进请求也不算「目录未收录」、以及清理时移除全部注入节点。

桩里的 DOM 特意**模拟 React 的受控输入**：每个输入框都装上会同时更新「tracker」的实例级 `value` setter，并在 `input` 事件里只采纳与 tracker 不同的值——所以直接 `input.value = x` 的写法在这个桩里**填不进草稿**。用例因此能断言 `draftValue`（「保存」真正会送出的内容）而不只是界面上的字符，把实现改回直接赋值会让用例失败（已实测）。

用例还锁住三条容易退化的语义：目录**不认识**的模型行在填充前后**逐字段不变**；填充过程**不发任何写设置请求、不按「保存」、不增减 `编辑/关闭` 的点击次数**（也就是卡片全程开着）；以及结果气泡挂在 `body` 上、`position: fixed`，「输入类型」行里**不出现**任何状态文字（否则该行会被撑成两行），同一时刻只有一个气泡、teardown 会把它一起清掉。


## 局限

- 目标设置区固定为 `llm-pi-ai`（自定义供应商）；按钮只出现在该家族的卡片上，拉取补全也只作用于该设置区。
- **本插件不写设置**：拉取补全的元数据随你在对话框里采纳的那些行，由卡片自己的「保存」落盘；两个按钮同理。这是为了让目录不认识的模型和卡片里其它未保存的修改都不受牵连。
- 拉取补全只填**缺失**字段，因此网关已给出的容量与显示名不会被目录值覆盖（唯一例外：显示名恰好等于模型 id 时视为未填）。
- 手动按钮的填充是**覆盖**语义：目录有值的字段一律替换（供应商级作用于该卡片全部模型行，按模型级只作用于该行），因此会覆盖你手工调整过的那些字段。
- 目录条目缺某个字段时，该字段**保持原样**，不会被清空（例如某模型没有 `maxTokens`，那一格就照旧）。
- 目录**未收录**的模型原样保留，只在结果里计数提示，不会被删除或改写。
- 拉取补全依赖 LLM 服务的 `discoverModels` 方法名与调用方式（Remote 适配器经 `this` 调用它）；宿主若改变这一层，补全会静默失效（候选仍是裸 id），`tests/discovery-runtime.spec.ts` 用真 `LlmRuntime` 把这条约束钉住。
- 结果气泡是**固定定位**、跟着按钮出现一会儿就消失的：它不做 focus 管理，只在显示期间带 `role="status"`（失败为 `alert`）。需要留存的信息请以设置文档为准。
- 按钮依赖模型设置页的类名结构（`rowCard` / `rowHead` / `rowName` / `modelListHead` / `modelEntry` / `modelAdvanced` / `modelInputChoices` / `iconButton` / `rowActions`）与 `模型 ID`、`显示名称`、`上下文窗口`、`最大输出`、`文本`、`图片` 这些中文标签；宿主改版若改了它们，按钮会消失或填入落空，需要跟进（`tests/client-injection.spec.ts` 只能锁住本仓库这一侧的行为）。
- 按模型按钮只对**已展开**的行出现（折叠的行没有「输入类型」这一行可挂）；两个按钮在填入前都会先把目标行展开，因此**填充会展开该卡片的相关模型行**。

## License

MIT
