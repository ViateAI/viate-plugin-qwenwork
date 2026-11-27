import {
  definePlugin,
  modelList,
  type CredentialsWrite,
  type HttpExchange,
  type JsonGetRequest,
  type JsonPostRequest,
  type KeepaliveInput,
  type KeepaliveResult,
  type ModelList,
  type OAuthPollInput,
  type OAuthPollResult,
  type OAuthStartResult,
  type PluginContext,
  type ProviderConnection,
  type SubscriptionInput,
  type SubscriptionResult,
  type SubscriptionUsage,
  type ViatePlugin,
} from "@viateai/sdk";
import {
  displayLabel,
  finishLogin,
  getAccount,
  pollLogin,
  readCredentials,
  readLoginFlow,
  renewAuth,
  startLogin,
  type QwenWorkCredentials,
} from "./account.js";
import { FALLBACK_CATALOG, fetchCatalog, parseCatalog, type CatalogModel } from "./catalog.js";
import { chatExchange } from "./chat.js";
import { ADAPTER_CONTEXT_WINDOW, FALLBACK_RELEASE, FALLBACK_VERSION, PROVIDER_ID, type ClientRuntime } from "./constants.js";
import { ProviderError, isAbortError } from "./errors.js";
import { discoverRuntime } from "./runtime.js";
import { prepareQwenworkInfer } from "./wasm.js";

const REFRESH_SKEW_MS = 5 * 60 * 1000;
const SUBSCRIPTION_DUE_MS = 10 * 60 * 1000;
const catalogs = new Map<string, Map<string, CatalogModel>>();

export const plugin: ViatePlugin = definePlugin({
  id: PROVIDER_ID,
  register(ctx: PluginContext) {
    const handler = {
      id: PROVIDER_ID,
      authMethods: [
        { id: "device", label: "浏览器授权", type: "oauth" },
        {
          id: "import",
          label: "导入登录态",
          type: "credentials",
          fields: [{
            key: "bundle",
            label: "登录 JSON",
            kind: "textarea",
            required: true,
            description: "包含 access、refresh、uid、machineId。来自本插件导出的登录态，不是桌面 App 的本地文件。",
          }],
        },
      ],
      normalizeCredentials,
      startOAuth,
      pollOAuth,
      keepalive,
      subscription,
      listModels,
      chatCompletions,
    };
    ctx.registerProvider(handler);
  },
});

export default plugin;

export function normalizeCredentials(input: unknown): CredentialsWrite {
  const credentials = readCredentials(input);
  return { credentials, displayLabel: displayLabel(credentials) };
}

export async function startOAuth(): Promise<OAuthStartResult> {
  const flow = startLogin();
  return {
    type: "device_code",
    userCode: "无需验证码",
    verificationUrl: flow.url,
    expiresInMs: 5 * 60 * 1000,
    intervalMs: 1_500,
    session: { verifier: flow.verifier, challenge: flow.challenge, nonce: flow.nonce, machineId: flow.machineId },
  };
}

export async function pollOAuth(input: OAuthPollInput): Promise<OAuthPollResult> {
  const flow = readLoginFlow(input.session);
  if (!flow) return { type: "failed", error: "登录会话已丢失，请重新授权" };
  try {
    const runtime = headerRuntime();
    const tokens = await pollLogin(flow, runtime);
    if (!tokens) return { type: "pending" };
    const credentials = await finishLogin(flow, tokens, runtime);
    return { type: "complete", credentials, displayLabel: displayLabel(credentials) };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { type: "failed", error: error instanceof Error ? error.message : "千问办公授权失败" };
  }
}

export async function keepalive(input: KeepaliveInput): Promise<KeepaliveResult> {
  let credentials: QwenWorkCredentials;
  try {
    credentials = readCredentials(input.credentials);
  } catch (error) {
    const message = error instanceof Error ? error.message : "登录态无效";
    input.log.warn({ status: "needs_reauth", error: message }, "token refresh failed");
    return { status: "needs_reauth", error: message };
  }
  const dueMs = millisecondsUntilRefresh(credentials.expiresAt);
  if (input.reason !== "request" && dueMs > 0) return { status: "ok", nextDueMs: dueMs };
  try {
    const refreshed = await renewAuth(credentials, headerRuntime(), fetch, input.signal);
    return {
      status: "ok",
      credentials: refreshed,
      displayLabel: displayLabel(refreshed),
      nextDueMs: millisecondsUntilRefresh(refreshed.expiresAt),
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    const status = error instanceof ProviderError && (error.status === 401 || error.status === 403) ? "needs_reauth" : "failed";
    const message = error instanceof Error ? error.message : "刷新登录态失败";
    input.log.warn({ status, error: message }, "token refresh failed");
    return { status, error: message, ...(status === "failed" ? { nextDueMs: 60_000 } : {}) };
  }
}

export async function subscription(input: SubscriptionInput): Promise<SubscriptionResult> {
  let credentials: QwenWorkCredentials;
  try {
    credentials = readCredentials(input.credentials);
  } catch (error) {
    const message = error instanceof Error ? error.message : "登录态无效";
    input.log.warn({ status: "needs_reauth", error: message }, "subscription refresh failed");
    return { status: "needs_reauth", error: message };
  }
  try {
    const context = await getAccount(credentials.access, headerRuntime(), fetch, input.signal);
    const quota = record(context.quota);
    const remaining = typeof quota?.remaining === "number" && Number.isFinite(quota.remaining) ? quota.remaining : null;
    if (remaining === null) {
      return { status: "ok", plan: planName(context, credentials), usages: [], nextDueMs: SUBSCRIPTION_DUE_MS };
    }
    const total = typeof quota?.total === "number" && Number.isFinite(quota.total) ? quota.total : null;
    const used = typeof quota?.used === "number" && Number.isFinite(quota.used) ? quota.used : null;
    const usage: SubscriptionUsage = {
      type: "credits",
      label: "办公积分",
      unit: "requests",
      used,
      limit: total,
      remaining,
    };
    return { status: "ok", plan: planName(context, credentials), usages: [usage], nextDueMs: SUBSCRIPTION_DUE_MS };
  } catch (error) {
    if (isAbortError(error)) throw error;
    const status = error instanceof ProviderError && (error.status === 401 || error.status === 403) ? "needs_reauth" : "failed";
    const message = error instanceof Error ? error.message : "读取积分失败";
    input.log.warn({ status, error: message }, "subscription refresh failed");
    return { status, error: message, ...(status === "failed" ? { nextDueMs: SUBSCRIPTION_DUE_MS } : {}) };
  }
}

export async function listModels(request: JsonGetRequest, connection: ProviderConnection): Promise<ModelList> {
  const credentials = readCredentials(connection.credentials);
  let catalog = FALLBACK_CATALOG;
  try {
    catalog = await fetchCatalog(credentials.access, headerRuntime(), fetch, request.signal);
    catalogs.set(connection.connectionId, catalog);
  } catch (error) {
    if (isAbortError(error) || request.signal?.aborted) throw error;
    const cached = catalogs.get(connection.connectionId);
    if (cached) catalog = cached;
  }
  return modelList([...catalog.values()].map((item) => ({
    id: item.id,
    name: item.name,
    owned_by: PROVIDER_ID,
    context_length: ADAPTER_CONTEXT_WINDOW,
  })));
}

export async function chatCompletions(request: JsonPostRequest, connection: ProviderConnection): Promise<HttpExchange> {
  const credentials = readCredentials(connection.credentials);
  return chatExchange(
    request,
    credentials,
    discoverRuntime(),
    catalogs.get(connection.connectionId),
    prepareQwenworkInfer,
  );
}

export { parseCatalog };

function headerRuntime(): Pick<ClientRuntime, "version" | "releaseVersion"> {
  try {
    return discoverRuntime();
  } catch {
    return { version: FALLBACK_VERSION, releaseVersion: FALLBACK_RELEASE };
  }
}

function millisecondsUntilRefresh(expiresAt: string | undefined): number {
  if (!expiresAt) return 0;
  return Math.max(0, Date.parse(expiresAt) - Date.now() - REFRESH_SKEW_MS);
}

function planName(context: Record<string, unknown>, credentials: QwenWorkCredentials): string {
  return stringValue(record(context.plan)?.name) ?? credentials.plan ?? "千问办公";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
