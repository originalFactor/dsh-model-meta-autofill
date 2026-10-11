# dsh-model-meta-autofill

[![npm version](https://img.shields.io/npm/v/dsh-model-meta-autofill.svg)](https://www.npmjs.com/package/dsh-model-meta-autofill)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)

为 DeepSeek Harness（DSH）的自定义供应商模型补全元数据：上下文窗口、最大输出 token 数、显示名称和输入模态。数据来自 [models.dev](https://models.dev/) Model Metadata Registry。

## 目录

- [功能](#功能)
- [安装](#安装)
- [使用](#使用)
- [配置](#配置)
- [数据源](#数据源)
- [开发](#开发)
- [贡献](#贡献)
- [联系](#联系)
- [限制](#限制)
- [许可证](#许可证)

## 功能

插件只作用于 `llm-pi-ai` 自定义供应商设置区，并且**从不写入设置**：

- **发现时补全**：包住 LLM 的 `discoverModels`，为端点已返回的模型填入目录中已知的缺失字段。
- **手动补全**：在 Models 页面为供应商卡片或单个模型行注入「自动获取」按钮，把值填进当前表单；用户仍需按卡片自己的「保存」。
- **离线优先**：构建时打包目录快照，启动后可选拉取实时目录并合并。每个源独立失败，不影响其它源或离线数据。
- **可复用服务**：通过 `ctx.modelMeta` 提供 `lookup`、`stats`、`refresh` 和 `buildSectionPatch`。

补全遵循以下规则：端点已提供的容量和显示名优先；显示名等于模型 id 时视为空值；目录未知的模型原样返回；不会新增端点未返回的模型；目录缺少的字段不会以空值覆盖表单。

## 安装

### 发布版

插件安装到运行 DSH Web 的 profile（例如 `web`）：

```bash
dsh plugin --profile web add dsh-model-meta-autofill
```

`cordis.patch.yml` 会自动插入默认配置。重启 DSH Web 或重新加载插件后生效。

### 源码版

需要 Node.js 22+ 和 pnpm：

```bash
pnpm install
pnpm build
pnpm pack
dsh plugin --profile web add dsh-model-meta-autofill@<tarball-path>
```

## 使用

### Models 页面

在 `llm-pi-ai` 供应商卡片中：

- 「模型目录」标题行的「自动获取」会批量填充卡片中的模型。
- 展开模型行后，输入类型行末的「自动获取」只填充当前模型。

按钮只改当前表单，不会关闭或重开卡片，也不会点击「保存」。目录未知的模型和目录缺少的字段保持原值；确认内容后按卡片自己的「保存」提交。

### HTTP API

Web profile 提供两个只读端点：

| 端点 | 说明 |
| --- | --- |
| `GET /model-meta-autofill/api/providers` | 返回用户层供应商路由、卡片标题和模型行。 |
| `GET /model-meta-autofill/api/catalog?ids=a,b` | 批量返回目录值；未知 id 放在 `unknown` 中，空 `ids` 返回 `400`。 |

目录响应示例：

```json
{
  "ok": true,
  "models": {
    "gpt-4o": {
      "id": "gpt-4o",
      "name": "GPT-4o",
      "contextWindow": 128000,
      "maxTokens": 16384,
      "input": ["text", "image"]
    }
  },
  "unknown": []
}
```

使用 `nameStyle=vendor` 可将名称写成 `厂商: 模型名`。

## 配置

所有配置项可省略。默认值如下：

| 键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关。 |
| `sources` | string[] | `["models.dev"]` | 按优先级合并的目录源；后面的源覆盖前面的同名模型。支持 `models.dev`、PublicProviderConf dist 名称或 `http(s)` URL。 |
| `refreshOnStart` | boolean | `true` | 启动时拉取实时目录。 |
| `refreshIntervalMs` | number | `0` | 定时刷新间隔；`0` 禁用。 |
| `timeoutMs` | number | `15000` | 单次请求超时（毫秒）。 |
| `fillName` | boolean | `true` | 是否补显示名。 |
| `fillInput` | boolean | `true` | 是否补输入模态。视觉模型会加入 `image`。 |
| `fillReasoning` | boolean | `false` | 预留开关；当前不会写入推理属性。 |

## 数据源

默认源是 `https://models.dev/api.json`。也可以生成并使用 PublicProviderConf 快照：

```bash
pnpm gen:data                 # 生成默认源快照
pnpm gen:data aihubmix        # 生成指定 dist 源快照
pnpm build                    # 复制到 lib/data/ 并构建插件
```

归一化支持数字容量和 `128K`、`1M`、`8GB` 等后缀（按 1024 进制换算），并对大小写、`provider/` 前缀和 `~` 变体做模型 id 别名匹配。没有可用容量的目录条目会被丢弃，不会猜测。

## 开发

开发依赖来自 npm 发布包，不需要检出 DeepSeek Harness 源码：

```bash
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` 覆盖数据归一化、只填缺失字段、发现包装的可逆性、HTTP API、经典脚本客户端和真实设置集成。客户端相关测试需要先运行 `pnpm build`。

主要目录：

| 路径 | 用途 |
| --- | --- |
| `src/` | 插件源码（主机端与浏览器端）。 |
| `src/data/` | 提交到仓库的离线目录快照。 |
| `tests/` | 单元、客户端和设置集成测试。 |
| `lib/` | 构建产物；发布包的全部运行时文件。 |

## 贡献

欢迎提交 issue 和 pull request。提交前请运行 `pnpm typecheck`、`pnpm test` 和 `pnpm build`。

## 联系

请通过 [GitHub Issues](https://github.com/QJAG1024/dsh-model-meta-autofill/issues) 报告问题或提出建议。

## 限制

- 目标设置区固定为 `llm-pi-ai`；其它适配器不会被修改。
- 发现补全依赖宿主提供兼容的 `discoverModels` 方法；宿主接口变化时可能退回为原始候选。
- Web 按钮依赖 Models 页面现有的 CSS 模块锚点和中文 `aria-label`。宿主页面改版后可能需要同步调整客户端选择器。
- 手动按钮采用覆盖语义：目录有值的表单字段会被替换，但仍需用户手动保存。

## 许可证

[MIT](LICENSE)

## 致谢

- [models.dev](https://models.dev/) 提供模型元数据目录。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供宿主插件运行环境。
- README 结构参考 [Best README Template](https://github.com/othneildrew/Best-README-Template)。
