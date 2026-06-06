// Stub for ws's optional native accelerators: `bufferutil` and `utf-8-validate`.
//
// These are optionalDependencies of ws that speed up frame masking and UTF-8
// validation via native addons. ws require()s them inside a try/catch and falls
// back to a pure-JS implementation when they are absent (it checks for the
// expected functions, e.g. `bufferUtil.mask`, before using them).
//
// We bundle the whole @xhayper/discord-rpc tree (which pulls in ws) into the
// main process because electron-builder.yml's files allowlist drops node_modules
// from the asar. Native .node binaries can't be inlined into that bundle, and
// rollup turns the unresolved optional require into a stub that THROWS at load
// (the 1.15.1 follow-up crash: `Could not resolve "bufferutil" imported by
// "ws"`). Aliasing both specifiers to this empty module makes ws see no native
// helpers and use its pure-JS path. Grimoire only talks to the local Discord IPC
// socket, so the native speedup is irrelevant here.
module.exports = {};
