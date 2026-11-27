import { readFileSync, statSync } from "node:fs";
import { FALLBACK_VERSION } from "./constants.js";

// wasm-bindgen glue for the official qoder auth component.
// Adapted from XuePengJu/dsh-our-free-model (MIT). The wasm binary is not MIT.

type Glue = {
  exports: WasmExports;
  heap: () => Uint8Array;
  view: () => DataView;
  readString: (ptr: number, len: number) => string;
  writeString: (text: string) => number;
  lastLength: () => number;
  heapObject: (index: number) => unknown;
  pushObject: (value: unknown) => number;
  takeObject: (index: number) => unknown;
  callPointer: (invoke: (stack: number) => void) => number;
};

type WasmExports = {
  memory: WebAssembly.Memory;
  __wbindgen_export2: (length: number, align: number) => number;
  __wbindgen_add_to_stack_pointer: (delta: number) => number;
  __wbindgen_export: (index: number) => void;
  __wbindgen_export4: (ptr: number, len: number, align: number) => void;
  generate_runtime_auth_fields: (stack: number, ptr: number, len: number) => void;
  qodercontext_new: (
    stack: number,
    machine: number,
    machineLen: number,
    version: number,
    versionLen: number,
    info: number,
    infoLen: number,
    meta: number,
    metaLen: number,
  ) => void;
  qodercontext_prepareInferRequest: (
    stack: number,
    context: number,
    host: number,
    hostLen: number,
    body: number,
    bodyLen: number,
    key: number,
    keyLen: number,
    source: number,
    sourceLen: number,
  ) => void;
  requestresult_headers: (result: number) => number;
  requestresult_url: (stack: number, result: number) => void;
  requestresult_body: (stack: number, result: number) => void;
  __wbg_requestresult_free: (result: number, flags: number) => void;
  __wbg_qodercontext_free: (context: number, flags: number) => void;
};

const glues = new Map<string, Promise<Glue>>();

export type InferRequest = {
  wasmPath: string;
  cosyVersion?: string;
  uid: string;
  name: string;
  email: string;
  accessToken: string;
  machineId: string;
  organizationId: string;
  dataPolicyAgreed: boolean;
  body: string;
  modelKey: string;
  endpoint: string;
  source?: string;
};

export async function prepareQwenworkInfer(options: InferRequest): Promise<{ url: string; headers: Record<string, string>; body: string }> {
  const glue = await loadGlue(options.wasmPath);
  const user = {
    uid: options.uid,
    aid: "",
    name: options.name,
    email: options.email,
    yx_uid: "",
    access_token: options.accessToken,
    security_oauth_token: options.accessToken,
    refresh_token: "",
    organization_id: options.organizationId || "",
    organization_name: "",
    organization_tags: [] as string[],
    user_type: options.organizationId ? "enterprise" : "personal",
    data_policy_agreed: options.dataPolicyAgreed === true,
  };
  const material = JSON.parse(callString(glue, "generate_runtime_auth_fields", JSON.stringify(user))) as {
    encrypt_user_info?: unknown;
    key?: unknown;
  };
  if (typeof material.encrypt_user_info !== "string" || typeof material.key !== "string") {
    throw new Error("签名组件返回的身份材料不完整");
  }
  const userInfoJson = JSON.stringify({ ...user, ...material });
  const metadata = JSON.stringify({
    client_type: "6",
    business_product: "qoder_work",
    business_type: "agent",
    scene: "qwork",
  });
  const context = glue.callPointer((stack) => {
    const machine = glue.writeString(options.machineId || "ofm-qwenwork");
    const machineLen = glue.lastLength();
    const version = glue.writeString(options.cosyVersion || FALLBACK_VERSION);
    const versionLen = glue.lastLength();
    const info = glue.writeString(userInfoJson);
    const infoLen = glue.lastLength();
    const meta = glue.writeString(metadata);
    const metaLen = glue.lastLength();
    glue.exports.qodercontext_new(stack, machine, machineLen, version, versionLen, info, infoLen, meta, metaLen);
  });
  let result = 0;
  try {
    const source = options.source ?? "system";
    result = glue.callPointer((stack) => {
      const host = glue.writeString(options.endpoint);
      const hostLen = glue.lastLength();
      const body = glue.writeString(options.body);
      const bodyLen = glue.lastLength();
      const key = glue.writeString(options.modelKey);
      const keyLen = glue.lastLength();
      const src = glue.writeString(source);
      const srcLen = glue.lastLength();
      glue.exports.qodercontext_prepareInferRequest(stack, context, host, hostLen, body, bodyLen, key, keyLen, src, srcLen);
    });
    const headerMap = glue.takeObject(glue.exports.requestresult_headers(result));
    const headers: Record<string, string> = {};
    if (headerMap instanceof Map) {
      for (const [name, value] of headerMap) headers[String(name)] = String(value);
    }
    return {
      url: readResultString(glue, result, (stack, ptr) => glue.exports.requestresult_url(stack, ptr)),
      headers,
      body: readResultString(glue, result, (stack, ptr) => glue.exports.requestresult_body(stack, ptr)),
    };
  } finally {
    try {
      if (result) glue.exports.__wbg_requestresult_free(result, 0);
      glue.exports.__wbg_qodercontext_free(context, 0);
    } catch {
      // The request was already built or already failed; freeing is best-effort.
    }
  }
}

async function loadGlue(wasmPath: string): Promise<Glue> {
  const info = statSync(wasmPath);
  const key = `${wasmPath}:${info.size}:${info.mtimeMs}`;
  const cached = glues.get(key);
  if (cached) return cached;
  glues.clear();
  const pending = createGlue(wasmPath);
  glues.set(key, pending);
  pending.catch(() => {
    if (glues.get(key) === pending) glues.delete(key);
  });
  return pending;
}

async function createGlue(wasmPath: string): Promise<Glue> {
  const bytes = readFileSync(wasmPath);
  const module = await WebAssembly.compile(bytes);
  let exports: WasmExports | undefined;
  let cachedHeap: Uint8Array | null = null;
  let cachedView: DataView | null = null;
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
  const encoder = new TextEncoder();
  const heap = (): Uint8Array => {
    const memory = liveExports().memory;
    if (cachedHeap === null || cachedHeap.byteLength === 0) cachedHeap = new Uint8Array(memory.buffer);
    return cachedHeap;
  };
  const view = (): DataView => {
    const memory = liveExports().memory;
    if (cachedView === null || cachedView.buffer !== memory.buffer) cachedView = new DataView(memory.buffer);
    return cachedView;
  };
  const readString = (ptr: number, len: number): string => decoder.decode(heap().subarray(ptr >>> 0, (ptr >>> 0) + len));
  const objects: unknown[] = new Array(1024).fill(undefined);
  objects.push(undefined, null, true, false);
  let firstFree = objects.length;
  const heapObject = (index: number): unknown => objects[index];
  const pushObject = (value: unknown): number => {
    if (firstFree === objects.length) objects.push(objects.length + 1);
    const index = firstFree;
    firstFree = objects[index] as number;
    objects[index] = value;
    return index;
  };
  const takeObject = (index: number): unknown => {
    const value = heapObject(index);
    if (index >= 1028) {
      objects[index] = firstFree;
      firstFree = index;
    }
    return value;
  };
  let lastLength = 0;
  const writeString = (text: string): number => {
    const encoded = encoder.encode(text);
    const ptr = liveExports().__wbindgen_export2(encoded.length, 1) >>> 0;
    heap().subarray(ptr, ptr + encoded.length).set(encoded);
    lastLength = encoded.length;
    return ptr;
  };
  const callPointer = (invoke: (stack: number) => void): number => {
    const stack = liveExports().__wbindgen_add_to_stack_pointer(-16);
    try {
      invoke(stack);
      const data = view();
      const ptr = data.getInt32(stack + 0, true);
      const isError = data.getInt32(stack + 8, true);
      if (isError) throw takeObject(data.getInt32(stack + 4, true));
      return ptr;
    } finally {
      liveExports().__wbindgen_add_to_stack_pointer(16);
    }
  };
  const guard = (fn: (...args: number[]) => void, args: number[]): void => {
    try {
      fn(...args);
    } catch (error) {
      liveExports().__wbindgen_export(pushObject(error));
    }
  };
  const imports: Record<string, (...args: number[]) => unknown> = {
    __wbindgen_object_drop_ref: (index) => takeObject(index),
    __wbindgen_object_clone_ref: (index) => pushObject(heapObject(index)),
    __wbindgen_cast_0000000000000001: (ptr, len) => pushObject(heap().subarray(ptr >>> 0, (ptr >>> 0) + len)),
    __wbindgen_cast_0000000000000002: (ptr, len) => pushObject(readString(ptr, len)),
    __wbg_set_08463b1df38a7e29: (mapIndex, keyIndex, valueIndex) => {
      const map = heapObject(mapIndex);
      if (!(map instanceof Map)) throw new Error("签名组件写入了非 Map 对象");
      return pushObject(map.set(heapObject(keyIndex), heapObject(valueIndex)));
    },
    __wbg_getRandomValues_d49329ff89a07af1: (...args) => guard((ptr, len) => {
      globalThis.crypto.getRandomValues(heap().subarray(ptr >>> 0, (ptr >>> 0) + len));
    }, args),
    __wbg_getRandomValues_c44a50d8cfdaebeb: (...args) => guard((target, values) => {
      const buffer = heapObject(target);
      const source = heapObject(values);
      if (!(buffer instanceof Crypto) || !(source instanceof Uint8Array)) throw new Error("签名组件随机数参数无效");
      buffer.getRandomValues(source);
    }, args),
    __wbg_randomFillSync_6c25eac9869eb53c: (...args) => guard((target, values) => {
      const buffer = heapObject(target);
      const source = takeObject(values);
      if (!buffer || typeof buffer !== "object" || !("randomFillSync" in buffer) || typeof buffer.randomFillSync !== "function" || !(source instanceof Uint8Array)) {
        throw new Error("签名组件随机数参数无效");
      }
      buffer.randomFillSync(source);
    }, args),
    __wbg_new_99cabae501c0a8a0: () => pushObject(new Map()),
    __wbg_now_88621c9c9a4f3ffc: () => Date.now(),
    __wbg_crypto_38df2bab126b63dc: (index) => objectMember(heapObject(index), "crypto"),
    __wbg_msCrypto_bd5a034af96bcba6: (index) => objectMember(heapObject(index), "msCrypto"),
    __wbg_process_44c7a14e11e9f69e: (index) => objectMember(heapObject(index), "process"),
    __wbg_versions_276b2795b1c6a219: (index) => objectMember(heapObject(index), "versions"),
    __wbg_node_84ea875411254db1: (index) => objectMember(heapObject(index), "node"),
    __wbg_require_b4edbdcf3e2a1ef0: (...args) => guard(() => {
      pushObject(module);
    }, args),
    __wbg_call_d578befcc3145dee: (...args) => guard((fnIndex, selfIndex, argIndex) => {
      const target = heapObject(fnIndex);
      if (typeof target !== "function") throw new Error("签名组件调用了非函数");
      pushObject(target.call(heapObject(selfIndex), heapObject(argIndex)));
    }, args),
    __wbg_new_with_length_9cedd08484b73942: (length) => pushObject(new Uint8Array(length >>> 0)),
    __wbg_length_0c32cb8543c8e4c8: (index) => {
      const value = heapObject(index);
      if (!value || typeof value !== "object" || !("length" in value) || typeof value.length !== "number") return 0;
      return value.length;
    },
    __wbg_prototypesetcall_3e05eb9545565046: (ptr, len, index) => {
      const source = heapObject(index);
      if (!(source instanceof Uint8Array)) throw new Error("签名组件拷贝了非字节数组");
      Uint8Array.prototype.set.call(heap().subarray(ptr >>> 0, (ptr >>> 0) + len), source);
    },
    __wbg_subarray_0f98d3fb634508ad: (index, start, end) => {
      const value = heapObject(index);
      if (!(value instanceof Uint8Array)) throw new Error("签名组件切片了非字节数组");
      return pushObject(value.subarray(start >>> 0, end >>> 0));
    },
    __wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f: () => pushObject(globalThis),
    __wbg_static_accessor_SELF_24f78b6d23f286ea: () => {
      const value = Reflect.get(globalThis, "self");
      return value === undefined ? 0 : pushObject(value);
    },
    __wbg_static_accessor_GLOBAL_f2e0f995a21329ff: () => pushObject(globalThis),
    __wbg_static_accessor_WINDOW_59fd959c540fe405: () => {
      const value = Reflect.get(globalThis, "window");
      return value === undefined ? 0 : pushObject(value);
    },
    __wbg___wbindgen_throw_81fc77679af83bc6: (ptr, len) => {
      throw new Error(readString(ptr, len));
    },
    __wbg_Error_2e59b1b37a9a34c3: (ptr, len) => pushObject(new Error(readString(ptr, len))),
    __wbg___wbindgen_is_object_40c5a80572e8f9d3: (index) => {
      const value = heapObject(index);
      return typeof value === "object" && value !== null ? 1 : 0;
    },
    __wbg___wbindgen_is_string_b29b5c5a8065ba1a: (index) => (typeof heapObject(index) === "string" ? 1 : 0),
    __wbg___wbindgen_is_function_49868bde5eb1e745: (index) => (typeof heapObject(index) === "function" ? 1 : 0),
    __wbg___wbindgen_is_undefined_c0cca72b82b86f4d: (index) => (heapObject(index) === undefined ? 1 : 0),
  };
  for (const item of WebAssembly.Module.imports(module)) {
    if (item.module !== "./qoder_auth_wasm_bg.js" || !imports[item.name]) {
      throw new Error("千问办公签名组件 ABI 已变化，请更新插件；未发出模型请求");
    }
  }
  const required = [
    "generate_runtime_auth_fields",
    "qodercontext_new",
    "qodercontext_prepareInferRequest",
    "requestresult_headers",
    "requestresult_url",
    "requestresult_body",
    "__wbg_requestresult_free",
    "__wbg_qodercontext_free",
    "__wbindgen_export4",
  ];
  const names = new Set(WebAssembly.Module.exports(module).map((item) => item.name));
  if (required.some((name) => !names.has(name))) throw new Error("千问办公签名组件缺少必要导出，请更新插件");
  const instance = await WebAssembly.instantiate(module, { "./qoder_auth_wasm_bg.js": imports });
  exports = instance.exports as unknown as WasmExports;
  return {
    exports,
    heap,
    view,
    readString,
    writeString,
    lastLength: () => lastLength,
    heapObject,
    pushObject,
    takeObject,
    callPointer,
  };

  function liveExports(): WasmExports {
    if (!exports) throw new Error("签名组件尚未实例化");
    return exports;
  }

  function objectMember(value: unknown, key: string): number {
    if (!value || typeof value !== "object" || !(key in value)) return pushObject(undefined);
    return pushObject(Reflect.get(value, key));
  }
}

function readResultString(glue: Glue, result: number, invoke: (stack: number, result: number) => void): string {
  let out = "";
  let ptr = 0;
  let len = 0;
  const stack = glue.exports.__wbindgen_add_to_stack_pointer(-16);
  try {
    invoke(stack, result);
    const data = glue.view();
    ptr = data.getInt32(stack + 0, true);
    len = data.getInt32(stack + 4, true);
    out = ptr ? glue.readString(ptr, len) : "";
  } finally {
    glue.exports.__wbindgen_add_to_stack_pointer(16);
    if (ptr) glue.exports.__wbindgen_export4(ptr, len, 1);
  }
  return out;
}

function callString(glue: Glue, name: "generate_runtime_auth_fields", text: string): string {
  const stack = glue.exports.__wbindgen_add_to_stack_pointer(-16);
  let ptr = 0;
  let len = 0;
  try {
    const input = glue.writeString(text);
    const inputLen = glue.lastLength();
    glue.exports[name](stack, input, inputLen);
    const data = glue.view();
    ptr = data.getInt32(stack, true);
    len = data.getInt32(stack + 4, true);
    if (data.getInt32(stack + 12, true)) {
      ptr = 0;
      len = 0;
      throw glue.takeObject(data.getInt32(stack + 8, true));
    }
    return glue.readString(ptr, len);
  } finally {
    glue.exports.__wbindgen_add_to_stack_pointer(16);
    if (ptr) glue.exports.__wbindgen_export4(ptr, len, 1);
  }
}
