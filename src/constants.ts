export const PROVIDER_ID = "qwenwork";
export const GATEWAY = "https://gateway.qwenwork.cn";
export const CLIENT_ID = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb";
export const REDIRECT_URI = "qwenwork-cn://";
export const ACCOUNT_PATH = "/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing";
export const REFRESH_PATH = "/api/v1/deviceToken/refresh";
export const CATALOG_PATH = "/api/desktop/chat-modes";
export const INFER_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation";

// This wasm SHA is the official signer. The MIT adapters that were checked
// against it advertise desktop 2.1.0, which is what we send unless overridden.
export const BUNDLED_WASM_SHA256 = "15dad38f7d9744dabfdc8a892ebad80d2c8157779f4e33882123ab3c954f04d3";
export const BUNDLED_VERSION = "2.1.0";
export const BUNDLED_RELEASE = "2.1.0-26111906";
export const FALLBACK_VERSION = "2.1.0";
export const FALLBACK_RELEASE = "2.1.0-26111906";

export const ADAPTER_CONTEXT_WINDOW = 1_000_000;
export const MAX_ADAPTER_OUTPUT_TOKENS = 131_072;
export const DESKTOP_OUTPUT_TOKENS = 32_768;

export type ClientRuntime = {
  wasmPath: string;
  version: string;
  releaseVersion: string;
};

export function clientHeaders(runtime: Pick<ClientRuntime, "version" | "releaseVersion">): Record<string, string> {
  const version = runtime.version || FALLBACK_VERSION;
  const release = runtime.releaseVersion || FALLBACK_RELEASE;
  return {
    accept: "application/json",
    "user-agent": `QwenWork/${version}`,
    "x-qwenwork-version": version,
    "x-qwenwork-release-version": release,
    "x-qwenwork-build": release.split("-").at(-1) ?? release,
    "x-qwenwork-platform": process.platform,
    "x-qwenwork-arch": process.arch,
    "x-qwenwork-channel": "stable",
    "x-qwenwork-app-mode": "standard",
  };
}
