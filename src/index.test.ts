import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createPluginLogger, type JsonPostRequest, type ProviderConnection } from "@viateai/sdk";
import { readCredentials } from "./account.js";
import { outputTokenLimit, parseCatalog } from "./catalog.js";
import { buildUpstreamBody, chatExchange } from "./chat.js";
import { GATEWAY, INFER_PATH } from "./constants.js";
import { ProviderError } from "./errors.js";
import {
  chatCompletions,
  keepalive,
  listModels,
  normalizeCredentials,
  pollOAuth,
  startOAuth,
  subscription,
} from "./index.js";
import { discoverRuntime } from "./runtime.js";
import { prepareQwenworkInfer } from "./wasm.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const row = (key: string, fields: Record<string, unknown> = {}) => ({
  key,
  enable: true,
  source: "system",
  format: "openai/chat-completions",
  ...fields,
});

describe("catalog", () => {
  it("keeps enabled hosted models and maps the standard tier to the server key", () => {
    const catalog = parseCatalog({
      data: {
        schema_version: 2,
        catalog: [
          row("flash"),
          row("qwork-auto"),
          row("pro", { is_reasoning: true, is_vl: true, max_output_tokens: 16384 }),
          row("fresh", { i18n: { display_name: { zh: "新模型" } }, is_vl: true, is_reasoning: true, format: "anthropic/messages" }),
          row("disabled", { enable: false }),
          row("hidden", { visible: false }),
          row("custom", { source: "custom" }),
          row("image", { format: "image/generate" }),
        ],
      },
    });
    assert.deepEqual([...catalog.keys()], ["qwork-auto", "qwork-advanced", "fresh"]);
    assert.equal(catalog.get("qwork-auto")?.key, "flash");
    assert.equal(catalog.get("qwork-advanced")?.key, "pro");
    assert.equal(catalog.get("qwork-advanced")?.maxOutputTokens, 16384);
    assert.equal(catalog.get("fresh")?.name, "新模型");
    assert.equal(outputTokenLimit({ maxOutputTokens: 393_216 }), 131_072);
    assert.throws(() => parseCatalog({ schema_version: 3, catalog: [] }), /格式/);
  });
});

describe("request body", () => {
  it("sends the tier key and clamps output", () => {
    const selected = parseCatalog({
      schema_version: 2,
      catalog: [row("flash", { is_reasoning: true, is_vl: true })],
    }).get("qwork-auto");
    assert.ok(selected);
    const body = buildUpstreamBody({
      model: "qwork-auto",
      messages: [{ role: "user", content: "你好" }],
      max_tokens: 100_000,
    }, selected);
    assert.equal(record(body.model_config)?.key, "flash");
    assert.equal(record(body.parameters)?.max_tokens, 32_768);
    assert.equal(record(record(body.business))?.product, "qoder_work");
    assert.equal(record(body.chat_context)?.text, "你好");
  });

  it("rejects a tool result that does not match a call", () => {
    const selected = { id: "lite", key: "lite", name: "经济", reasoning: true, vision: true };
    assert.throws(
      () => buildUpstreamBody({ messages: [{ role: "tool", tool_call_id: "missing", content: "x" }] }, selected),
      (error: unknown) => error instanceof ProviderError && error.status === 400,
    );
  });
});

describe("oauth", () => {
  it("polls until the browser authorization returns tokens", async () => {
    const started = await startOAuth();
    assert.equal(started.type, "device_code");
    if (started.type !== "device_code") return;
    assert.equal(started.userCode, "无需验证码");
    assert.match(started.verificationUrl, /^https:\/\/gateway\.qwenwork\.cn\/device\/selectAccounts\?/);
    let polls = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      polls += 1;
      if (url.includes("/deviceToken/poll") && polls === 1) return new Response("{}", { status: 404 });
      if (url.includes("/deviceToken/poll")) {
        return Response.json({ token: "access-1", refresh_token: "refresh-1", expires_in: 3600, nonce: started.session && record(started.session)?.nonce });
      }
      if (url.includes("/account-context")) {
        return Response.json({ user: { id: "user-1", email: "ada@example.com", name: "Ada" }, plan: { name: "个人版" } });
      }
      return new Response("unexpected", { status: 500 });
    };
    const pending = await pollOAuth({ connectionId: "c1", credentials: undefined, session: started.session });
    assert.equal(pending.type, "pending");
    const done = await pollOAuth({ connectionId: "c1", credentials: undefined, session: started.session });
    assert.equal(done.type, "complete");
    if (done.type !== "complete") return;
    assert.equal(done.displayLabel, "ada@example.com");
    const credentials = readCredentials(done.credentials);
    assert.equal(credentials.access, "access-1");
    assert.equal(credentials.refresh, "refresh-1");
    assert.equal(credentials.uid, "user-1");
    assert.equal(credentials.plan, "个人版");
  });

  it("rejects an authorization response bound to another login", async () => {
    const started = await startOAuth();
    globalThis.fetch = async () => Response.json({ token: "access-1", refresh_token: "refresh-1", nonce: "other" });
    const result = await pollOAuth({ connectionId: "c1", credentials: undefined, session: started.session });
    assert.equal(result.type, "failed");
  });
});

describe("stored credentials", () => {
  it("accepts an imported login bundle and refreshes it on demand", async () => {
    const normalized = normalizeCredentials(JSON.stringify({
      access: "access-1",
      refresh: "refresh-1",
      uid: "user-1",
      machineId: "machine-1",
      email: "ada@example.com",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }));
    assert.equal(normalized.displayLabel, "ada@example.com");
    const log = createPluginLogger(() => undefined);
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return Response.json({ token: "access-2", refresh_token: "refresh-2", expires_in: 3600 });
    };
    const skipped = await keepalive({
      connectionId: "c1",
      credentials: normalized.credentials,
      signal: new AbortController().signal,
      reason: "timer",
      log,
    });
    assert.equal(skipped.status, "ok");
    assert.equal(called, false);
    const refreshed = await keepalive({
      connectionId: "c1",
      credentials: normalized.credentials,
      signal: new AbortController().signal,
      reason: "request",
      log,
    });
    assert.equal(refreshed.status, "ok");
    assert.equal(readCredentials(refreshed.credentials).access, "access-2");
    assert.equal(called, true);
  });

  it("reads the credit balance", async () => {
    globalThis.fetch = async () => Response.json({
      user: { id: "user-1" },
      plan: { name: "个人版" },
      quota: { remaining: 12.5, total: 20, used: 7.5 },
    });
    const result = await subscription({
      connectionId: "c1",
      credentials: { access: "access-1", refresh: "refresh-1", uid: "user-1", machineId: "machine-1" },
      signal: new AbortController().signal,
      log: createPluginLogger(() => undefined),
    });
    assert.equal(result.status, "ok");
    assert.equal(result.plan, "个人版");
    assert.equal(result.usages?.[0]?.remaining, 12.5);
    assert.equal(result.usages?.[0]?.limit, 20);
  });
});

describe("chat", () => {
  it("signs with the official component and translates the upstream stream", async () => {
    const runtime = discoverRuntime();
    const seen: { url?: string; machine?: string } = {};
    globalThis.fetch = async (input, init) => {
      seen.url = String(input);
      seen.machine = new Headers(init?.headers).get("cosy-machineid") ?? undefined;
      return new Response([
        'data: {"choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}',
        "",
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    };
    const request: JsonPostRequest = {
      body: { model: "qwork-auto", messages: [{ role: "user", content: "你好" }], stream: false },
      headers: {},
    };
    const exchange = await chatExchange(
      request,
      { access: "access-1", refresh: "refresh-1", uid: "user-1", machineId: "machine-1", name: "Ada", email: "ada@example.com" },
      runtime,
      undefined,
      prepareQwenworkInfer,
    );
    assert.equal(exchange.status, 200);
    assert.equal(exchange.upstreamModel, "flash");
    assert.equal(new URL(seen.url ?? "").origin, GATEWAY);
    assert.equal(new URL(seen.url ?? "").pathname, INFER_PATH);
    assert.equal(seen.machine, "machine-1");
    const completion = JSON.parse(await readBody(exchange.body)) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { total_tokens?: number };
    };
    assert.equal(completion.choices?.[0]?.message?.content, "你好");
    assert.equal(completion.choices?.[0]?.finish_reason, "stop");
    assert.equal(completion.usage?.total_tokens, 4);
  });

  it("refuses a signer that points somewhere other than the official inference path", async () => {
    const exchange = await chatExchange(
      { body: { model: "lite", messages: [{ role: "user", content: "hi" }] }, headers: {} },
      { access: "access-1", refresh: "refresh-1", uid: "user-1", machineId: "machine-1" },
      { wasmPath: "unused", version: "2.1.0", releaseVersion: "2.1.0-26111906" },
      undefined,
      async () => ({ url: "https://example.com/steal", headers: {}, body: "{}" }),
    );
    assert.equal(exchange.status, 502);
    const payload = JSON.parse(await readBody(exchange.body)) as { error?: { message?: string } };
    assert.match(payload.error?.message ?? "", /非预期/);
  });

  it("falls back to the built-in catalog when the account catalog fails", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 503 });
    const connection: ProviderConnection = {
      connectionId: "catalog-fallback",
      providerId: "qwenwork",
      credentials: { access: "access-1", refresh: "refresh-1", uid: "user-1", machineId: "machine-1" },
    };
    const models = await listModels({ headers: {} }, connection);
    assert.ok(models.data.some((model) => model.id === "qwork-auto"));
    assert.ok(models.data.some((model) => model.id === "qwen3.8-flash"));
  });

  it("chatCompletions uses the same signed path", async () => {
    globalThis.fetch = async (input) => {
      assert.equal(new URL(String(input)).pathname, INFER_PATH);
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const exchange = await chatCompletions(
      { body: { model: "qwen3.8-flash", messages: [{ role: "user", content: "ping" }], stream: true }, headers: {} },
      { connectionId: "live-shape", providerId: "qwenwork", credentials: { access: "a", refresh: "r", uid: "u", machineId: "m" } },
    );
    assert.equal(exchange.status, 200);
    assert.equal(exchange.headers["content-type"], "text/event-stream");
    assert.match(await readBody(exchange.body), /"content":"ok"/);
  });
});

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function readBody(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return "";
  return new Response(body).text();
}
