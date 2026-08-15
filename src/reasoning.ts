/**
 * Reasoning-effort declaration helpers: the wire protocols llm-pi-ai can
 * dispatch through (`compat.thinkingFormat`), the selectable level ladder,
 * and the per-format recommended wire values the settings UI pre-fills.
 *
 * @module dsh-model-meta-autofill/reasoning
 */

/** pi-ai's thinking levels, in escalation order (drift-checked upstream). */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** One thinking level's zh label for the settings UI. */
export const LEVEL_LABELS: Readonly<Record<string, string>> = {
  off: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最大',
}

/**
 * The wire protocols pi-ai's reasoning dispatch reads (`compat.thinkingFormat`),
 * each with a human label and the per-level wire value pre-fill writes.
 * 'off' maps to null everywhere ("supported, send nothing"); a level outside
 * a format's native set folds to its closest sibling. Users edit every value.
 */
export const THINKING_FORMATS: readonly {
  id: string
  label: string
  hint: string
  preset: Readonly<Record<string, string>>
}[] = [
  {
    id: 'openai',
    label: 'OpenAI（reasoning_effort）',
    hint: 'Chat Completions / Responses 的 reasoning_effort 参数（minimal/low/medium/high）',
    preset: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek（thinking + reasoning_effort）',
    hint: 'DeepSeek 官方风格的 thinking 开关 + reasoning_effort（low/medium/high）',
    preset: { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter（reasoning.effort）',
    hint: 'OpenRouter 的 reasoning.effort（none/low/medium/high/xhigh）',
    preset: { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' },
  },
  {
    id: 'together',
    label: 'Together（reasoning_effort）',
    hint: 'Together 的 reasoning_effort 字符串（low/medium/high/xhigh）',
    preset: { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' },
  },
  {
    id: 'zai',
    label: 'Z.ai / 智谱（thinking + reasoning_effort）',
    hint: 'zai 格式：thinking 开关 + reasoning_effort 字段，值为网关接受的字符串',
    preset: { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' },
  },
  {
    id: 'qwen',
    label: 'Qwen（enable_thinking 开关）',
    hint: '通义风格的 enable_thinking 布尔开关——只能表达开/关两档',
    preset: {},
  },
  {
    id: 'string-thinking',
    label: '通用字符串（reasoning_effort 自由值）',
    hint: '网关自定的字符串等级：每档填网关实际接受的值',
    preset: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  },
  {
    id: 'ant-ling',
    label: 'AntLing（reasoning_effort）',
    hint: '蚂蚁灵码风格的 reasoning_effort 字符串',
    preset: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  },
]

/** The wire value one level gets under one format's preset (off is always null). */
export function presetWireValue(format: string, level: string): string | null {
  if (level === 'off') return null
  const spec = THINKING_FORMATS.find((f) => f.id === format)
  if (spec === undefined) return level
  // qwen is a pure toggle: every non-off level is the same wire switch.
  if (spec.id === 'qwen') return 'on'
  return spec.preset[level] ?? level
}

/** A catalog effort name translated to pi-ai's ladder ('none' is catalog-speak for off). */
export function normalizeCatalogLevel(value: string): string {
  const lowered = value.trim().toLowerCase()
  if (lowered === 'none') return 'off'
  return THINKING_LEVELS.includes(lowered as (typeof THINKING_LEVELS)[number]) ? lowered : ''
}

/**
 * The default level ladder for one catalog entry: the entry's declared effort
 * ladder (catalog names translated); a reasoning entry without one is a
 * toggle — off plus one thinking level. Non-reasoning entries get nothing.
 */
export function presetLadder(meta: { reasoning?: boolean; reasoningLevels?: readonly string[] } | undefined): string[] {
  if (meta === undefined || meta.reasoning !== true) return []
  const fromCatalog: string[] = []
  for (const raw of meta.reasoningLevels ?? []) {
    const level = normalizeCatalogLevel(raw)
    if (level !== '' && !fromCatalog.includes(level)) fromCatalog.push(level)
  }
  if (fromCatalog.length > 0) {
    if (!fromCatalog.includes('off')) fromCatalog.unshift('off')
    return fromCatalog.sort((a, b) => THINKING_LEVELS.indexOf(a as never) - THINKING_LEVELS.indexOf(b as never))
  }
  return ['off', 'high']
}

/**
 * Validate a reasoningEfforts declaration against pi-ai's rules: known levels
 * only; every level but 'off' names a non-empty wire value; 'off' may stay null.
 * @returns an error message, or undefined when the declaration is serviceable.
 */
export function validateEfforts(efforts: unknown): string | undefined {
  if (efforts === false) return undefined
  if (efforts === null || typeof efforts !== 'object' || Array.isArray(efforts)) {
    return '思考等级应为「等级 → wire 值」的字典，或 false 表示不推理'
  }
  const dict = efforts as Record<string, unknown>
  const keys = Object.keys(dict)
  if (keys.length === 0) return '思考等级字典为空：声明提供的等级，或设为 false'
  for (const key of keys) {
    if (!(THINKING_LEVELS as readonly string[]).includes(key)) {
      return '未知等级 "' + key + '"（可用：' + THINKING_LEVELS.join('/') + '）'
    }
  }
  for (const [key, value] of Object.entries(dict)) {
    if (key === 'off') {
      if (value !== null && typeof value !== 'string') return 'off 的 wire 值必须是字符串或空'
      continue
    }
    if (typeof value !== 'string' || value.length === 0) {
      return '等级 "' + key + '" 需要填写 wire 值（只有 off 可留空）'
    }
  }
  return undefined
}
