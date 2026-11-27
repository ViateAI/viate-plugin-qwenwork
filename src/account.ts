import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ACCOUNT_PATH, CLIENT_ID, GATEWAY, REDIRECT_URI, REFRESH_PATH, clientHeaders, type ClientRuntime } from "./constants.js";
import { ProviderError, upstreamError } from "./errors.js";

export type QwenWorkCredentials = {
  access: string;
  refresh: string;
  uid: string;
  machineId: string;
  expiresAt?: string;
  email?: string;
  name?: string;
  organizationId?: string;
  plan?: string;
};

export type LoginFlow = {
  verifier: string;
  challenge: string;
  nonce: string;
  machineId: string;
};

const isoTime = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return Date.parse(value) || 0;
  return 0;
};

function expiry(data: Record<string, unknown>, prefix = "", now = Date.now()): number {
  const absolute = isoTime(data[`${prefix}expires_at`]);
  const relative = data[`${prefix}expires_in`];
  return absolute || (typeof relative === "number" && Number.isFinite(relative) && relative > 0 ? now + relative * 1000 : 0);
}

export function startLogin(): LoginFlow & { url: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const nonce = randomUUID();
  const machineId = randomUUID();
  const query = new URLSearchParams({
    challenge,
    challenge_method: "S256",
    nonce,
    machine_id: machineId,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
  });
  return { verifier, challenge, nonce, machineId, url: `${GATEWAY}/device/selectAccounts?${query}` };
}

export function readLoginFlow(session: unknown): LoginFlow | undefined {
  if (!session || typeof session !== "object") return undefined;
  const record = session as Record<string, unknown>;
  const verifier = stringValue(record.verifier);
  const challenge = stringValue(record.challenge);
  const nonce = stringValue(record.nonce);
  const machineId = stringValue(record.machineId);
  if (!verifier || !challenge || !nonce || !machineId) return undefined;
  return { verifier, challenge, nonce, machineId };
}

export async function pollLogin(
  flow: LoginFlow,
  runtime: Pick<ClientRuntime, "version" | "releaseVersion">,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const query = new URLSearchParams({
    nonce: flow.nonce,
    verifier: flow.verifier,
    challenge_method: "S256",
  });
  const response = await fetchImpl(`${GATEWAY}/api/v1/deviceToken/poll?${query}`, {
    method: "GET",
    headers: clientHeaders(runtime),
    signal,
    redirect: "error",
  });
  if (response.status === 404) return null;
  const data = await jsonData(response);
  if (!data?.token) return null;
  if (typeof data.token !== "string") {
    throw new ProviderError("授权响应与本次登录不匹配，请重新授权", 401, "authentication_error");
  }
  if (data.nonce !== undefined && data.nonce !== flow.nonce) {
    throw new ProviderError("授权响应与本次登录不匹配，请重新授权", 401, "authentication_error");
  }
  if (data.code_challenge !== undefined && data.code_challenge !== flow.challenge) {
    throw new ProviderError("授权响应与本次登录不匹配，请重新授权", 401, "authentication_error");
  }
  return data;
}

export async function getAccount(
  access: string,
  runtime: Pick<ClientRuntime, "version" | "releaseVersion">,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(GATEWAY + ACCOUNT_PATH, {
    headers: { ...clientHeaders(runtime), authorization: `Bearer ${access}` },
    signal,
    redirect: "error",
  });
  const data = await jsonData(response);
  if (!data) throw new ProviderError("千问办公返回了无效账号信息");
  return data;
}

export function authFromTokens(
  tokens: Record<string, unknown>,
  previous: Partial<QwenWorkCredentials>,
  now = Date.now(),
): QwenWorkCredentials {
  const access = stringValue(tokens.device_token) ?? stringValue(tokens.token) ?? stringValue(tokens.access_token);
  const refresh = stringValue(tokens.refresh_token) ?? previous.refresh;
  if (!access || !refresh) {
    throw new ProviderError("授权响应缺少访问令牌或刷新令牌", 401, "authentication_error");
  }
  const accessExpires = expiry(tokens, "", now);
  const refreshExpires = expiry(tokens, "refresh_token_", now);
  const dates = [accessExpires, refreshExpires].filter((value) => value > 0);
  const uid = previous.uid ?? "";
  const machineId = previous.machineId ?? "";
  if (!uid || !machineId) {
    throw new ProviderError("授权信息不完整，请重新授权", 401, "authentication_error");
  }
  const expiresAt = dates.length ? new Date(Math.min(...dates)).toISOString() : previous.expiresAt;
  return {
    access,
    refresh,
    uid,
    machineId,
    ...(expiresAt ? { expiresAt } : {}),
    ...(previous.email ? { email: previous.email } : {}),
    ...(previous.name ? { name: previous.name } : {}),
    ...(previous.organizationId ? { organizationId: previous.organizationId } : {}),
    ...(previous.plan ? { plan: previous.plan } : {}),
  };
}

export async function finishLogin(
  flow: LoginFlow,
  tokens: Record<string, unknown>,
  runtime: Pick<ClientRuntime, "version" | "releaseVersion">,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<QwenWorkCredentials> {
  const access = stringValue(tokens.device_token) ?? stringValue(tokens.token) ?? stringValue(tokens.access_token);
  const refresh = stringValue(tokens.refresh_token);
  if (!access || !refresh) {
    throw new ProviderError("授权响应缺少访问令牌或刷新令牌", 401, "authentication_error");
  }
  const context = await getAccount(access, runtime, fetchImpl, signal);
  const user = recordValue(context.user) ?? {};
  const uid = String(user.id ?? user.uid ?? tokens.user_id ?? "");
  if (!uid) throw new ProviderError("千问办公未返回账号标识，未保存本次授权", 502);
  const email = typeof user.email === "string" ? user.email : "";
  const name = String(user.name ?? user.username ?? tokens.user_name ?? "");
  const organizationId = String(user.organization_id ?? user.orgId ?? "");
  const plan = stringValue(recordValue(context.plan)?.name) ?? "";
  const dated = authFromTokens(tokens, { uid, machineId: flow.machineId, email, name, organizationId, plan });
  return dated;
}

export async function renewAuth(
  credentials: QwenWorkCredentials,
  runtime: Pick<ClientRuntime, "version" | "releaseVersion">,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<QwenWorkCredentials> {
  if (!credentials.refresh) {
    throw new ProviderError("缺少刷新令牌，请重新授权", 401, "authentication_error");
  }
  const response = await fetchImpl(GATEWAY + REFRESH_PATH, {
    method: "POST",
    headers: { ...clientHeaders(runtime), "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: credentials.refresh, target: "c" }),
    signal,
    redirect: "error",
  });
  const data = await jsonData(response);
  if (!data) throw new ProviderError("千问办公刷新响应无效", 502);
  return authFromTokens(data, credentials);
}

export function readCredentials(input: unknown): QwenWorkCredentials {
  const source = unwrapCredentials(input);
  const access = firstString(source.access, source.accessToken, source.access_token, source.token, source.device_token);
  const refresh = firstString(source.refresh, source.refreshToken, source.refresh_token);
  const uid = firstString(source.uid, source.userId, source.user_id);
  const machineId = firstString(source.machineId, source.machine_id);
  if (!access || !refresh || !uid || !machineId) {
    throw new ProviderError("千问办公登录态需要 access、refresh、uid、machineId", 400, "invalid_request_error");
  }
  const expiresAt = firstString(source.expiresAt, source.expires_at);
  const email = firstString(source.email);
  const name = firstString(source.name);
  const organizationId = firstString(source.organizationId, source.organization_id);
  const plan = firstString(source.plan);
  return {
    access,
    refresh,
    uid,
    machineId,
    ...(expiresAt ? { expiresAt } : {}),
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    ...(organizationId ? { organizationId } : {}),
    ...(plan ? { plan } : {}),
  };
}

export function displayLabel(credentials: QwenWorkCredentials): string {
  return credentials.email || credentials.name || credentials.uid;
}

function unwrapCredentials(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return {};
    try {
      return recordValue(JSON.parse(trimmed)) ?? {};
    } catch {
      throw new ProviderError("登录 JSON 无法解析", 400, "invalid_request_error");
    }
  }
  const record = recordValue(input) ?? {};
  const bundle = record.bundle;
  if (typeof bundle === "string" && bundle.trim()) return unwrapCredentials(bundle);
  return record;
}

export async function jsonData(response: Response): Promise<Record<string, unknown> | null> {
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) throw new ProviderError("上游 JSON 响应超过限制");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError(`千问办公返回了无法解析的响应（HTTP ${response.status}）`, response.status >= 400 ? response.status : 502);
  }
  const error = upstreamError(value, response.status);
  if (error) throw error;
  for (let depth = 0; depth < 4 && value && typeof value === "object" && "data" in value; depth += 1) {
    value = (value as { data?: unknown }).data;
  }
  return recordValue(value) ?? null;
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
}

function stringValue(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() ? input.trim() : undefined;
}

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return undefined;
}
