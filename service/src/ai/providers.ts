/**
 * 服务商预设（OpenAI 兼容协议）。
 *
 * 只提供 baseUrl / 默认模型 / 申请入口等**元数据**，不内置任何密钥。
 * 「自定义 OpenAI 兼容」用于任何遵循 /chat/completions 协议的服务
 * （Ollama、vLLM、LM Studio、One-API、企业网关等）。
 */

import type { AiProviderConfig } from '../shared/types.js'

export interface ProviderPreset {
  id: string
  /** 中文显示名 */
  name: string
  /** API 根地址（不含 /chat/completions） */
  baseUrl: string
  /** 默认模型 */
  defaultModel: string
  /** 可选模型列表（供 UI 下拉，非穷举） */
  models: string[]
  /** API Key 申请地址（中文说明用） */
  apiKeyUrl: string
  /** 中文备注 */
  note?: string
  /** 是否支持 OpenAI 风格 function calling / tools */
  supportsTools: boolean
  /** 是否支持 OAuth 登录（SDK 风格连接，见 oauth.ts）；null 表示只能用 API Key */
  oauth: { authorizeUrl: string; tokenUrl: string; scopes: string[]; clientIdRequired: true } | null
}

/** 预置服务商列表（中文界面直接展示） */
export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek（深度求索）',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    supportsTools: true,
    oauth: null
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o4-mini'],
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    supportsTools: true,
    // OpenAI 官方支持 OAuth（PKCE + loopback）：需用户自备 client_id
    oauth: {
      authorizeUrl: 'https://auth.openai.com/authorize',
      tokenUrl: 'https://auth.openai.com/oauth/token',
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      clientIdRequired: true
    }
  },
  {
    id: 'moonshot',
    name: 'Moonshot（月之暗面 Kimi）',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-k2-0905-preview'],
    apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
    supportsTools: true,
    oauth: null
  },
  {
    id: 'zhipu',
    name: '智谱 AI（GLM）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash', 'glm-4.5'],
    apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    note: '智谱的 v4 接口兼容 OpenAI 协议。',
    supportsTools: true,
    oauth: null
  },
  {
    id: 'qwen',
    name: '通义千问（阿里云百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen3-max'],
    apiKeyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    note: '使用百炼的「OpenAI 兼容模式」地址。',
    supportsTools: true,
    oauth: null
  },
  {
    id: 'custom',
    name: '自定义 OpenAI 兼容',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5:7b',
    models: [],
    apiKeyUrl: '',
    note: '适用于 Ollama / vLLM / LM Studio / One-API / 企业自建网关等任何 OpenAI 兼容服务。本地服务通常无需 API Key，可留空。',
    supportsTools: true,
    oauth: null
  }
]

/** 按 id 取预设 */
export function getProvider(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

/**
 * 由预设生成一份 AI 配置（不含密钥）。
 * 注意：返回对象的 `apiKey` 为空串，密钥必须由用户单独提交。
 */
export function presetToConfig(id: string, base?: Partial<AiProviderConfig>): AiProviderConfig {
  const preset = getProvider(id)
  return {
    enabled: true,
    providerName: preset?.name ?? base?.providerName ?? '自定义',
    baseUrl: preset?.baseUrl ?? base?.baseUrl ?? '',
    apiKey: '',
    model: preset?.defaultModel ?? base?.model ?? '',
    systemPrompt:
      base?.systemPrompt ?? '你是 TiBrowser 内置的 AI 助手，请用简洁、准确的中文回答用户的问题。',
    cliPermission: base?.cliPermission ?? 'daily'
  }
}
