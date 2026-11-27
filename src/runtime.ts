import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLED_RELEASE,
  BUNDLED_VERSION,
  BUNDLED_WASM_SHA256,
  FALLBACK_RELEASE,
  FALLBACK_VERSION,
  type ClientRuntime,
} from "./constants.js";

const bundledWasm = fileURLToPath(new URL("../vendor/qoder-auth-wasm/qoder_auth_wasm_bg.wasm", import.meta.url));

export function runtimeCandidates(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = os.homedir()): string[] {
  const roots: string[] = [];
  if (env.QWENWORK_APP_PATH) roots.push(env.QWENWORK_APP_PATH);
  if (platform === "darwin") {
    roots.push("/Applications/QwenWorkCN.app/Contents/Resources", path.join(home, "Applications/QwenWorkCN.app/Contents/Resources"));
  }
  if (platform === "linux") {
    roots.push("/opt/QwenWorkCN/resources", "/opt/apps/QwenWorkCN/resources", path.join(home, ".local/share/qwenworkcn/resources"));
  }
  const files = roots.flatMap((root) => {
    const resources = root.endsWith(".app") ? path.join(root, "Contents/Resources") : root.endsWith(`${path.sep}resources`) || root.endsWith("/resources") ? root : path.join(root, "resources");
    const direct = root.endsWith(".app") ? resources : root;
    return [direct, resources].map((directory) => path.join(directory, "qoder-auth-wasm/qoder_auth_wasm_bg.wasm"));
  });
  return [...new Set([env.QWENWORK_WASM_PATH, bundledWasm, ...files].filter((item): item is string => Boolean(item)))];
}

export function discoverRuntime(env: NodeJS.ProcessEnv = process.env): ClientRuntime {
  const explicit = env.QWENWORK_WASM_PATH;
  for (const wasmPath of runtimeCandidates(env)) {
    try {
      const stat = fs.statSync(wasmPath);
      if (!stat.isFile() || stat.size < 8 || stat.size > 8 * 1024 * 1024) continue;
      const bytes = fs.readFileSync(wasmPath);
      if (bytes.subarray(0, 4).toString("hex") !== "0061736d") continue;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const known = sha256 === BUNDLED_WASM_SHA256;
      const version = env.QWENWORK_CLIENT_VERSION || (known ? BUNDLED_VERSION : FALLBACK_VERSION);
      const releaseVersion = env.QWENWORK_RELEASE_VERSION || (known ? BUNDLED_RELEASE : FALLBACK_RELEASE);
      if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) || !/^[\w.+-]+$/.test(releaseVersion)) {
        throw new Error("无效的客户端版本信息");
      }
      return { wasmPath: path.resolve(wasmPath), version, releaseVersion };
    } catch (error) {
      if (explicit && explicit === wasmPath) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`无法加载指定的千问办公签名组件：${detail}`);
      }
    }
  }
  throw new Error("未找到千问办公签名组件。插件自带的 vendor 副本缺失时，可设置 QWENWORK_WASM_PATH 指向官方 App 的 qoder_auth_wasm_bg.wasm。");
}
