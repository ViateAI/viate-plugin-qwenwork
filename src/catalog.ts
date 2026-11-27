import { CATALOG_PATH, DESKTOP_OUTPUT_TOKENS, GATEWAY, MAX_ADAPTER_OUTPUT_TOKENS, clientHeaders, type ClientRuntime } from "./constants.js";
import { ProviderError } from "./errors.js";
import { jsonData } from "./account.js";

const CATALOG_TIMEOUT_MS = 6_500;
const MAX_MODELS = 256;
const MODEL_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;
const FORMATS: Record<string, true> = {
  "openai/chat-completions": true,
  "anthropic/messages": true,
};
const TIER_ID: Record<string, string> = {
  flash: "qwork-auto",
  pro: "qwork-advanced",
};
export type CatalogModel = {
  id: string;
  key: string;
  name: string;
  reasoning: boolean;
  vision: boolean;
  maxOutputTokens?: number;
};

const TIER_LABELS: Record<string, string> = {
  "qwork-auto": "千问办公 · 标准",
  "qwork-advanced": "千问办公 · 高级",
  lite: "千问办公 · 经济",
  flagship: "千问办公 · 旗舰",
};

export const FALLBACK_CATALOG = new Map<string, CatalogModel>([
  model("qwork-auto", "flash", "千问办公 · 标准", true),
  model("qwork-advanced", "pro", "千问办公 · 高级", true),
  model("lite", "lite", "千问办公 · 经济", true),
  model("flagship", "flagship", "千问办公 · 旗舰", true),
  model("qwen4-max", "qwen4-max", "Qwen4-Max", true),
  model("qwen3.8-max-preview", "qwen3.8-max-preview", "Qwen3.8-Max", true),
  model("qwen3.8-flash", "qwen3.8-flash", "Qwen3.8-Flash", true),
  model("ling-3.1-flash", "ling-3.1-flash", "Ling-3.1-Flash", false),
  model("deepseek-flash", "deepseek-flash", "DeepSeek-V4.1-Flash", true),
  model("deepseek-v4-pro", "deepseek-v4-pro", "DeepSeek-V4-Pro", false),
  model("glm-5.3", "glm-5.3", "GLM-5.3", false),
  model("glm-5.3-flash", "glm-5.3-flash", "GLM-5.3-Flash", false),
  model("kimi-k3.1-pro", "kimi-k3.1-pro", "Kimi-K3.1-Pro", true),
  model("minimax-m3.1-flash", "minimax-m3.1-flash", "MiniMax-M3.1-Flash", true),
  model("step-5-preview", "step-5-preview", "Step-5-Preview", true),
]);

function model(id: string, key: string, name: string, vision: boolean): [string, CatalogModel] {
  return [id, { id, key, name, reasoning: true, vision }];
}

export function outputTokenLimit(selected: Pick<CatalogModel, "maxOutputTokens">): number {
  return Math.min(selected.maxOutputTokens ?? DESKTOP_OUTPUT_TOKENS, MAX_ADAPTER_OUTPUT_TOKENS);
}

export function parseCatalog(payload: unknown): Map<string, CatalogModel> {
  const root = record(payload);
  const data = root?.catalog === undefined ? record(root?.data) ?? root : root;
  const schema = data?.schema_version ?? data?.schemaVersion;
  const rows = data?.catalog;
  if (schema !== 2 || !Array.isArray(rows) || rows.length > MAX_MODELS) {
    throw new ProviderError("千问办公模型目录格式不受支持", 502);
  }
  const models = new Map<string, CatalogModel>();
  for (const row of rows) {
    const item = record(row);
    const key = typeof item?.key === "string" ? item.key : "";
    if (!MODEL_KEY.test(key) || item?.enable !== true || item.visible === false) continue;
    if (item.source !== "system" || !FORMATS[String(item.format)]) continue;
    const id = TIER_ID[key] ?? key;
    if (models.has(id) && key === id) continue;
    const display = record(record(item.i18n)?.display_name);
    const name = TIER_LABELS[id]
      ?? modelName(display?.zh)
      ?? modelName(display?.en)
      ?? modelName(item.display_name)
      ?? key;
    const maxOutputTokens = positiveTokenCount(item.max_output_tokens) ?? positiveTokenCount(item.maxOutputTokens);
    models.set(id, {
      id,
      key,
      name,
      reasoning: item.is_reasoning === true,
      vision: item.is_vl === true,
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    });
  }
  if (!models.size) throw new ProviderError("千问办公没有返回可用的模型目录", 502);
  return models;
}

export function resolveModel(requested: string, catalog = FALLBACK_CATALOG): CatalogModel | undefined {
  const id = requested.trim();
  const direct = catalog.get(id);
  if (direct) return direct;
  for (const model of catalog.values()) {
    if (model.key === id) return { ...model, id };
  }
  if (!MODEL_KEY.test(id)) return undefined;
  return { id, key: id, name: id, reasoning: true, vision: true };
}

export async function fetchCatalog(
  access: string,
  runtime: Pick<ClientRuntime, "version" | "releaseVersion">,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Map<string, CatalogModel>> {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(CATALOG_TIMEOUT_MS)]) : AbortSignal.timeout(CATALOG_TIMEOUT_MS);
  const response = await fetchImpl(GATEWAY + CATALOG_PATH, {
    method: "GET",
    redirect: "error",
    signal: requestSignal,
    headers: { ...clientHeaders(runtime), authorization: `Bearer ${access}` },
  });
  const data = await jsonData(response);
  return parseCatalog(data);
}

function positiveTokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function modelName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= 128 && !/[\p{Cc}\p{Cf}]/u.test(value)
    ? value.trim()
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
