// @types/node does not expose the WebAssembly namespace under lib ES2024.
declare namespace WebAssembly {
  interface Module {}
  interface Memory {
    buffer: ArrayBuffer;
  }
  interface Instance {
    exports: Record<string, unknown>;
  }
  interface ImportValue {}
  function compile(bytes: BufferSource): Promise<Module>;
  function instantiate(
    module: Module,
    importObject: Record<string, Record<string, (...args: number[]) => unknown>>,
  ): Promise<Instance>;
  namespace Module {
    function imports(module: Module): Array<{ module: string; name: string; kind: string }>;
    function exports(module: Module): Array<{ name: string; kind: string }>;
  }
}
