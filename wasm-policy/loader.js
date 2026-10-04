// Dependency-free loader for the compiled policy-decision WASM module. Works unmodified in Node
// (import from file) and in a browser (fetch + instantiateStreaming) — the same file, no bundler,
// no @assemblyscript/loader, no AssemblyScript-aware marshalling. The ABI is three primitives:
// alloc(len) for a write target, evaluate(ptr, len) to run a decision, getResultPtr()/getResultLen()
// to read it back — raw UTF-8 bytes in and out, documented in assembly/index.ts and README.md.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

// Independent audit finding (mitigated here): a small, deliberately pathological input (~20 KB of
// deeply nested `[[[[...]]]]`) makes the AssemblyScript JSON parser's recursive descent blow the
// WASM call's JS stack — a clean, catchable RangeError in testing, not memory corruption or a
// hang, but nothing upstream of the parser imposed any size limit before that point. A real policy
// decision input is a small, flat-ish object (a handful of fields, a delegation chain a few hops
// deep); this cap is generous for that and stingy for an adversarial payload designed to probe the
// parser's recursion limit.
const MAX_INPUT_BYTES = 64 * 1024;

function abortMessage(instance, msgPtr, filePtr, line, col) {
  // Best-effort: msgPtr/filePtr point at AssemblyScript-internal UTF-16 strings, which this
  // loader deliberately never learns to decode (that's exactly the managed-string complexity the
  // raw-bytes ABI exists to avoid) — so this reports the trap site, not the message text. A trap
  // here means a bug in the module itself (an out-of-bounds read, a failed invariant), not a
  // policy decision; it should never fire in normal operation and a hit is worth filing as a bug.
  return `spendveto-wasm-policy: internal abort at ${line}:${col} (module bug, not a policy denial)`;
}

/**
 * Instantiates the policy module from a WASM binary (Uint8Array/ArrayBuffer/Response, anything
 * WebAssembly.instantiate or instantiateStreaming accepts) and returns a bound evaluator.
 */
export async function loadPolicyWasm(source) {
  let instance;
  const imports = {
    env: {
      abort(msgPtr, filePtr, line, col) {
        throw new Error(abortMessage(instance, msgPtr, filePtr, line, col));
      },
    },
  };

  let result;
  if (typeof Response !== "undefined" && source instanceof Response) {
    result = await WebAssembly.instantiateStreaming(source, imports);
  } else {
    const bytes = source instanceof Uint8Array || source instanceof ArrayBuffer ? source : await source;
    result = await WebAssembly.instantiate(bytes, imports);
  }
  instance = result.instance;
  const { alloc, evaluate, getResultPtr, getResultLen, abiVersion, memory } = instance.exports;

  return {
    abiVersion: abiVersion(),

    /**
     * Pure, synchronous, zero-I/O decision — the whole point of this module. `input` is a plain
     * object matching the schema in README.md (the same shape checkPolicy's deterministic rules
     * consume, with all host-gathered state — freezes, ledger spend, the walked delegation chain —
     * already filled in by the caller). Returns the parsed decision object.
     */
    evaluate(input) {
      const inputBytes = textEncoder.encode(JSON.stringify(input));
      if (inputBytes.byteLength > MAX_INPUT_BYTES) {
        throw new Error(`spendveto-wasm-policy: input is ${inputBytes.byteLength} bytes, over the ${MAX_INPUT_BYTES}-byte limit — a real policy decision input should never be this large`);
      }
      const inPtr = alloc(inputBytes.byteLength);
      // The allocator can grow WASM memory (ArrayBuffer backing store gets detached/replaced on
      // growth), so the Uint8Array view is created fresh, after allocation, over the CURRENT buffer
      // — reusing a view captured before alloc() risks writing into a detached ArrayBuffer.
      new Uint8Array(memory.buffer, inPtr, inputBytes.byteLength).set(inputBytes);

      evaluate(inPtr, inputBytes.byteLength);

      const outPtr = getResultPtr();
      const outLen = getResultLen();
      const outBytes = new Uint8Array(memory.buffer, outPtr, outLen);
      const outJson = textDecoder.decode(outBytes);
      return JSON.parse(outJson);
    },
  };
}

/** Node convenience: load straight from a file path. */
export async function loadPolicyWasmFile(path) {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(path);
  return loadPolicyWasm(bytes);
}
