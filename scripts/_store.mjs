// ESM shim over scripts/_store.cjs. See the comment at the top of
// _store.cjs for why the actual logic lives in a CommonJS file: Node's ESM
// loader can `import` a CommonJS module's `module.exports` via default
// interop, but a CommonJS `require()` cannot load an ESM file synchronously,
// so CommonJS has to be the one canonical implementation and this file just
// re-exports it for the ESM call sites.
import store from "./_store.cjs";

export const runsRoot = store.runsRoot;
export const sessionDir = store.sessionDir;
export const indexPath = store.indexPath;
