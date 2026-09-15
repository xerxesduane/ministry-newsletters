// Single source of truth for the version reported over MCP and by `epistle --version`.
// Kept as a literal rather than read from package.json, which is not present once installed
// in some bundling setups and would need a runtime file read either way.

export const VERSION = '0.2.0'
