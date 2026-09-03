// ESM shim over scripts/_locked-json.cjs, exactly like scripts/_store.mjs is
// a shim over scripts/_store.cjs: the canonical implementation is CommonJS so
// that both `require()` (scripts/wave-exec.js) and `import` (the .mjs
// scripts) share one copy. Read the locking protocol comment in the .cjs.
import locked from "./_locked-json.cjs";

export const acquireLock = locked.acquireLock;
export const withLock = locked.withLock;
export const updateJsonAtomic = locked.updateJsonAtomic;
export const writeFileAtomicSync = locked.writeFileAtomicSync;
export const lockPathFor = locked.lockPathFor;
export const SKIP_WRITE = locked.SKIP_WRITE;
export const DEFAULT_TIMEOUT_MS = locked.DEFAULT_TIMEOUT_MS;
export const DEFAULT_STALE_MS = locked.DEFAULT_STALE_MS;
