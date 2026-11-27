const QUOTA = /quota[_ .-]*(?:exceed|exhaust)|insufficient[_ .-]*(?:quota|balance|credit)|credit[s]?[_ .-]*(?:exhaust|insufficient)|额度(?:已)?(?:用尽|耗尽|不足)|积分(?:已)?(?:耗尽|用完|不足)/i;
const AUTH = /invalid[_ .-]*(?:grant|token)|(?:refresh[_ .-]*token).*(?:invalid|expired|revoked)|unauthorized|登录.*(?:失效|过期)/i;

export class ProviderError extends Error {
  readonly status: number;
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, status = 502, code = "upstream_error") {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

export function redact(value: unknown): string {
  return String(value ?? "")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted JWT]")
    .slice(0, 500);
}

function asObject(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return { message: value };
    }
  }
  return value;
}

export function upstreamError(value: unknown, httpStatus = 200): ProviderError | null {
  let current = asObject(value);
  let outerStatus = httpStatus;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    const record = current as Record<string, unknown>;
    if (Array.isArray(record.choices)) return null;
    if (Number(record.statusCodeValue) >= 400) outerStatus = Number(record.statusCodeValue);
    if (record.body !== undefined) {
      current = asObject(record.body);
      continue;
    }
    if (record.error !== undefined) {
      current = asObject(record.error);
      continue;
    }
    const code = record.code ?? record.errorCode ?? record.status_code;
    const message = record.message ?? record.msg ?? record.errorMessage ?? record.error_message ?? "";
    const text = `${code ?? ""} ${message}`;
    if (outerStatus === 429 || Number(code) === 429 || QUOTA.test(text)) {
      return new ProviderError(redact(message || "千问办公积分已用尽或请求受限"), 429, "insufficient_quota");
    }
    if (outerStatus === 401 || Number(code) === 401 || AUTH.test(text)) {
      return new ProviderError(redact(message || "千问办公登录已失效，请重新授权"), 401, "authentication_error");
    }
    if (outerStatus >= 400 || Number(code) >= 400 || (code !== undefined && !["ok", "0", "200", "success", "SUCCESS"].includes(String(code)))) {
      const status = [400, 403, 408, 409, 422, 425, 500, 502, 503, 504].includes(outerStatus)
        ? outerStatus
        : Number(code) >= 400 && Number(code) < 600
          ? Number(code)
          : 502;
      return new ProviderError(redact(message || code || "千问办公请求失败"), status);
    }
    if (outerStatus >= 400) return new ProviderError(redact(message || "千问办公请求失败"), outerStatus);
    return null;
  }
  return outerStatus >= 400 ? new ProviderError("千问办公请求失败", outerStatus) : null;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
