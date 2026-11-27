import { randomUUID } from "node:crypto";
import { parseOpenAIChatUsage, type HttpExchange, type JsonPostRequest } from "@viateai/sdk";
import type { QwenWorkCredentials } from "./account.js";
import { ADAPTER_CONTEXT_WINDOW, GATEWAY, INFER_PATH, clientHeaders, type ClientRuntime } from "./constants.js";
import { outputTokenLimit, resolveModel, type CatalogModel } from "./catalog.js";
import { ProviderError, isAbortError, redact, upstreamError } from "./errors.js";
import type { InferRequest } from "./wasm.js";

const STREAM_DONE = Symbol("stream done");
const PARAMETER_KEYS = ["temperature", "top_p", "stop", "seed", "response_format", "tool_choice", "parallel_tool_calls"] as const;

type ChatMessage = {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
};

export function buildUpstreamBody(body: Record<string, unknown>, selected: CatalogModel): Record<string, unknown> {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new ProviderError("messages 必须是非空数组", 400, "invalid_request_error");
  }
  const ids = new Set<string>();
  const messages = body.messages.map((item) => copyMessage(item, ids));
  const tools = body.tools ?? [];
  if (!Array.isArray(tools) || tools.some((tool) => !isFunctionTool(tool))) {
    throw new ProviderError("仅接收 OpenAI function 格式的工具定义", 400, "invalid_request_error");
  }
  const outputLimit = outputTokenLimit(selected);
  const requested = body.max_completion_tokens ?? body.max_tokens ?? outputLimit;
  if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 1) {
    throw new ProviderError("max_tokens 必须是正整数", 400, "invalid_request_error");
  }
  const parameters: Record<string, unknown> = { max_tokens: Math.min(requested, outputLimit) };
  for (const key of PARAMETER_KEYS) {
    if (body[key] !== undefined) parameters[key] = body[key];
  }
  const lastUser = messages.findLast((message) => message.role === "user");
  const text = messageText(lastUser?.content);
  const system = messages
    .filter((message) => message.role === "system" && typeof message.content === "string")
    .map((message) => message.content)
    .join("\n\n");
  const reasoning = selected.reasoning && body.reasoning_effort !== undefined && body.reasoning_effort !== "none" && body.reasoning_effort !== "off";
  const requestId = randomUUID();
  return {
    request_id: requestId,
    request_set_id: requestId,
    chat_record_id: requestId,
    session_id: randomUUID(),
    stream: true,
    chat_task: "FREE_INPUT",
    chat_context: {
      text,
      features: [],
      extra: { context: [], modelConfig: { key: selected.key, is_reasoning: reasoning }, originalContent: text },
      chatPrompt: "",
      imageUrls: null,
    },
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    agent_id: "agent_common",
    task_id: "common",
    session_type: "qoder_work",
    aliyun_user_type: "",
    model_config: {
      key: selected.key,
      display_name: selected.name,
      model: "",
      format: "openai",
      is_vl: selected.vision,
      is_reasoning: reasoning,
      api_key: "",
      url: "",
      source: "system",
      max_input_tokens: ADAPTER_CONTEXT_WINDOW,
    },
    system,
    messages,
    tools,
    parameters,
    ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}),
    ...(body.parallel_tool_calls !== undefined ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
    business: { product: "qoder_work", type: "agent", version: "1", feature_switches: {} },
  };
}

export async function chatExchange(
  request: JsonPostRequest,
  credentials: QwenWorkCredentials,
  runtime: ClientRuntime,
  catalog: Map<string, CatalogModel> | undefined,
  signer: (options: InferRequest) => Promise<{ url: string; headers: Record<string, string>; body: string }>,
  fetchImpl: typeof fetch = fetch,
): Promise<HttpExchange> {
  const body = record(request.body);
  if (!body) throw new ProviderError("请求体必须是 JSON 对象", 400, "invalid_request_error");
  const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
  const selected = resolveModel(requestedModel, catalog);
  if (!selected) throw new ProviderError("请选择插件列出的千问办公模型", 400, "invalid_request_error");
  const upstreamBody = buildUpstreamBody(body, selected);
  const prepared = await signer({
    wasmPath: runtime.wasmPath,
    cosyVersion: runtime.version,
    uid: credentials.uid,
    name: credentials.name ?? "",
    email: credentials.email ?? "",
    accessToken: credentials.access,
    machineId: credentials.machineId,
    organizationId: credentials.organizationId ?? "",
    dataPolicyAgreed: false,
    body: JSON.stringify(upstreamBody),
    modelKey: selected.key,
    endpoint: GATEWAY,
  });
  const target = new URL(prepared.url, GATEWAY);
  if (target.origin !== GATEWAY || target.username || target.password || target.pathname !== INFER_PATH) {
    return errorExchange(new ProviderError("签名组件返回了非预期的推理地址，已拒绝发送", 502));
  }
  const headers = new Headers({
    ...clientHeaders(runtime),
    accept: "text/event-stream",
    "content-type": "application/json",
    "x-request-id": randomUUID(),
    "x-model-key": selected.key,
    "x-model-source": "system",
    "cosy-machineid": credentials.machineId,
    "cosy-machinetoken": credentials.machineId,
    "cosy-version": runtime.version,
    "cosy-clienttype": "6",
    "cosy-business-product": "qoder_work",
    "cosy-business-type": "agent",
    "cosy-scene": "qwork",
    "cosy-machineos": `${process.arch}_${process.platform}`,
    "cosy-machinetype": "5",
    "cosy-data-policy": "disagree",
    "login-version": "v2",
  });
  for (const [name, value] of Object.entries(prepared.headers)) headers.set(name, value);
  const cancellation = new AbortController();
  const requestSignal = request.signal
    ? AbortSignal.any([request.signal, cancellation.signal, AbortSignal.timeout(10 * 60 * 1000)])
    : AbortSignal.any([cancellation.signal, AbortSignal.timeout(10 * 60 * 1000)]);
  let upstream: Response;
  try {
    upstream = await fetchImpl(target.href, {
      method: "POST",
      headers,
      body: prepared.body,
      signal: requestSignal,
      redirect: "error",
    });
  } catch (error) {
    if (isAbortError(error) || request.signal?.aborted) throw error;
    throw new ProviderError("千问办公连接失败", 502);
  }
  if (!upstream.ok) {
    const text = await upstream.text();
    const error = upstreamError(text.slice(0, 10_000), upstream.status) ?? new ProviderError(`千问办公返回 HTTP ${upstream.status}`, upstream.status);
    return errorExchange(hideToken(error, credentials.access));
  }
  const stream = body.stream === true;
  try {
    const response = await asEventStream(upstream);
    const iterator = chunks(response, selected.id, requestSignal);
    const prelude: Record<string, unknown>[] = [];
    let meaningful = false;
    while (!meaningful) {
      const next = await iterator.next();
      if (next.done) throw new ProviderError("千问办公没有返回模型内容");
      prelude.push(next.value);
      meaningful = hasVisibleDelta(next.value);
      if (prelude.length > 32) {
        await iterator.return(undefined);
        throw new ProviderError("千问办公返回了过多无内容事件");
      }
    }
    const all = (async function* (): AsyncGenerator<Record<string, unknown>> {
      yield* prelude;
      yield* iterator;
    })();
    const first = await all.next();
    if (first.done || !first.value) throw new ProviderError("千问办公没有返回模型内容");
    if (!stream) {
      const completion = await collect(all, first.value, selected.id);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: textStream(JSON.stringify(completion)),
        parseUsage: parseOpenAIChatUsage,
        upstreamModel: selected.key,
      };
    }
    let pending: Record<string, unknown> | undefined = first.value;
    return {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      parseUsage: parseOpenAIChatUsage,
      upstreamModel: selected.key,
      body: new ReadableStream({
        async pull(controller) {
          try {
            const next = pending ? { value: pending, done: false as const } : await all.next();
            pending = undefined;
            if (next.done) {
              controller.enqueue(encode("data: [DONE]\n\n"));
              controller.close();
              return;
            }
            controller.enqueue(encode(`data: ${JSON.stringify(next.value)}\n\n`));
          } catch (error) {
            if (requestSignal.aborted) {
              controller.error(requestSignal.reason);
              return;
            }
            const safe = error instanceof ProviderError ? hideToken(error, credentials.access) : new ProviderError("千问办公连接中断，响应未完成");
            controller.enqueue(encode(`data: ${JSON.stringify({ error: { message: safe.message, type: safe.code, code: safe.code } })}\n\n`));
            controller.close();
          }
        },
        cancel(reason) {
          cancellation.abort(reason instanceof Error ? reason : new Error("client cancelled"));
          void all.return(undefined);
        },
      }),
    };
  } catch (error) {
    if (isAbortError(error) || request.signal?.aborted) throw error;
    if (error instanceof ProviderError) return errorExchange(hideToken(error, credentials.access));
    return errorExchange(new ProviderError("千问办公连接失败"));
  }
}

function copyMessage(item: unknown, ids: Set<string>): ChatMessage {
  const message = record(item);
  const role = typeof message?.role === "string" ? message.role : "";
  if (!message || !["system", "developer", "user", "assistant", "tool"].includes(role)) {
    throw new ProviderError("不支持的消息类型", 400, "invalid_request_error");
  }
  const copy: ChatMessage = { ...message, role: role === "developer" ? "system" : role };
  if (copy.role === "assistant" && copy.tool_calls !== undefined) {
    if (!Array.isArray(copy.tool_calls)) throw new ProviderError("tool_calls 必须是数组", 400, "invalid_request_error");
    for (const call of copy.tool_calls) {
      const tool = record(call);
      const id = typeof tool?.id === "string" ? tool.id : "";
      const name = typeof record(tool?.function)?.name === "string" ? record(tool?.function)?.name : "";
      if (!id || !name) throw new ProviderError("工具调用缺少 id 或名称", 400, "invalid_request_error");
      ids.add(id);
    }
  }
  if (copy.role === "tool") {
    const toolCallId = typeof copy.tool_call_id === "string" ? copy.tool_call_id : "";
    if (!toolCallId || !ids.has(toolCallId)) {
      throw new ProviderError("工具结果缺少匹配的 tool_call_id", 400, "invalid_request_error");
    }
  }
  return copy;
}

function isFunctionTool(tool: unknown): boolean {
  const recordTool = record(tool);
  const fn = record(recordTool?.function);
  return recordTool?.type === "function" && typeof fn?.name === "string" && fn.name.length > 0;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    const item = record(part);
    return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n");
}

async function asEventStream(upstream: Response): Promise<Response> {
  if ((upstream.headers.get("content-type") ?? "").includes("application/json")) {
    const value = await upstream.json().catch(() => {
      throw new ProviderError("千问办公返回了无效 JSON");
    });
    const error = upstreamError(value);
    if (error) throw error;
    let completion: unknown = value;
    for (let depth = 0; depth < 4 && record(completion)?.body !== undefined; depth += 1) {
      const body = record(completion)?.body;
      completion = typeof body === "string" ? JSON.parse(body) as unknown : body;
    }
    const choices = record(completion)?.choices;
    if (!Array.isArray(choices)) throw new ProviderError("千问办公返回了无效的模型响应");
    const chunk = {
      ...record(completion),
      object: "chat.completion.chunk",
      choices: choices.map((choice) => {
        const item = record(choice) ?? {};
        return { ...item, delta: item.message ?? item.delta, message: undefined };
      }),
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  }
  return upstream;
}

function decodeFrame(raw: string): Record<string, unknown> | null | typeof STREAM_DONE {
  if (raw === "[DONE]") return STREAM_DONE;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new ProviderError("千问办公返回了无效的流式 JSON");
  }
  const error = upstreamError(value);
  if (error) throw error;
  for (let depth = 0; depth < 6; depth += 1) {
    const wrapped = record(value);
    if (!wrapped || !("body" in wrapped)) break;
    value = wrapped.body;
    if (typeof value === "string") {
      if (!value.trim()) return null;
      if (value.trim() === "[DONE]") return STREAM_DONE;
      try {
        value = JSON.parse(value) as unknown;
      } catch {
        throw new ProviderError("千问办公返回了无效的响应信封");
      }
    }
  }
  const recordValue = record(value);
  if (!recordValue || Object.keys(recordValue).length === 0) return null;
  if (!Array.isArray(recordValue.choices) && !recordValue.usage) throw new ProviderError("千问办公响应缺少 choices 或 usage");
  return recordValue;
}

async function* frames(response: Response, signal: AbortSignal): AsyncGenerator<string> {
  if (!response.body) throw new ProviderError("千问办公返回了空响应");
  const reader = response.body.getReader();
  const stop = (): void => {
    reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", stop, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const read = await reader.read();
      signal.throwIfAborted();
      buffer += read.done ? decoder.decode() : decoder.decode(read.value, { stream: true });
      if (buffer.length > 8 * 1024 * 1024) throw new ProviderError("千问办公单个流事件超过限制");
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = sseData(frame);
        if (data) yield data;
      }
      if (read.done) {
        const data = sseData(buffer);
        if (data) yield data;
        break;
      }
    }
  } finally {
    signal.removeEventListener("abort", stop);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function* chunks(response: Response, model: string, signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  let finished = false;
  let meaningful = false;
  for await (const raw of frames(response, signal)) {
    const chunk = decodeFrame(raw);
    if (chunk === STREAM_DONE) {
      if (!finished) throw new ProviderError("千问办公提前结束响应，未返回完成标记");
      return;
    }
    if (!chunk) continue;
    meaningful = true;
    chunk.model = model;
    for (const choice of arrayRecords(chunk.choices)) {
      if (choice.finish_reason != null) finished = true;
    }
    yield chunk;
  }
  if (!meaningful || !finished) throw new ProviderError("千问办公连接中断，响应未完成");
}

async function collect(
  iterator: AsyncGenerator<Record<string, unknown>>,
  first: Record<string, unknown>,
  model: string,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {
    id: typeof first.id === "string" && first.id ? first.id : `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: typeof first.created === "number" ? first.created : Math.floor(Date.now() / 1000),
    model,
    choices: [],
  };
  const choices = new Map<number, Record<string, unknown>>();
  const add = (chunk: Record<string, unknown>): void => {
    if (chunk.usage) result.usage = chunk.usage;
    for (const part of arrayRecords(chunk.choices)) {
      const index = typeof part.index === "number" ? part.index : 0;
      const existing = choices.get(index) ?? { index, message: { role: "assistant", content: "" }, finish_reason: null };
      choices.set(index, existing);
      const message = record(existing.message) ?? { role: "assistant", content: "" };
      existing.message = message;
      const delta = record(part.delta) ?? record(part.message) ?? {};
      for (const key of ["content", "reasoning_content", "reasoning_text", "refusal"]) {
        if (typeof delta[key] === "string") message[key] = `${typeof message[key] === "string" ? message[key] : ""}${delta[key]}`;
      }
      for (const call of arrayRecords(delta.tool_calls)) {
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls as Record<string, unknown>[] : [];
        message.tool_calls = calls;
        const callIndex = typeof call.index === "number" ? call.index : 0;
        const target = record(calls[callIndex]) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
        calls[callIndex] = target;
        if (typeof call.id === "string" && call.id) target.id = call.id;
        const fn = record(target.function) ?? { name: "", arguments: "" };
        target.function = fn;
        const incoming = record(call.function);
        if (typeof incoming?.name === "string") fn.name = `${fn.name ?? ""}${incoming.name}`;
        if (typeof incoming?.arguments === "string") fn.arguments = `${fn.arguments ?? ""}${incoming.arguments}`;
      }
      if (part.finish_reason != null) existing.finish_reason = part.finish_reason;
    }
  };
  add(first);
  for await (const chunk of iterator) add(chunk);
  result.choices = [...choices.values()].sort((left, right) => Number(left.index) - Number(right.index));
  for (const choice of result.choices as Record<string, unknown>[]) {
    const message = record(choice.message);
    if (Array.isArray(message?.tool_calls)) message.tool_calls = message.tool_calls.filter(Boolean);
  }
  return result;
}

function hasVisibleDelta(chunk: Record<string, unknown>): boolean {
  return arrayRecords(chunk.choices).some((choice) => {
    const delta = record(choice.delta) ?? record(choice.message) ?? {};
    return choice.finish_reason != null
      || Boolean(delta.content)
      || Boolean(delta.reasoning_content)
      || Boolean(delta.reasoning_text)
      || Boolean(delta.refusal)
      || arrayRecords(delta.tool_calls).length > 0;
  });
}

function sseData(frame: string): string {
  return frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n")
    .trim();
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = record(item);
    return row ? [row] : [];
  });
}

function errorExchange(error: ProviderError): HttpExchange {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (error.status === 429) headers["retry-after"] = "60";
  return {
    status: error.status,
    headers,
    body: textStream(JSON.stringify({ error: { message: error.message, type: error.code, code: error.code } })),
  };
}

function hideToken(error: ProviderError, access: string): ProviderError {
  if (!access || !error.message.includes(access)) return error;
  return new ProviderError(error.message.replaceAll(access, "[已隐藏]"), error.status, error.code);
}

function textStream(text: string): ReadableStream<Uint8Array> {
  const bytes = encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
