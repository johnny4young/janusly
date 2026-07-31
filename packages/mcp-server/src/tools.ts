/**
 * Stable compatibility barrel for the MCP tool catalog and API dispatcher.
 * Internal descriptor, validation, risk, and route-translation ownership lives
 * under `./tooling/`.
 */

export { listTools, mcpWritesEnabled, tools } from "./tooling/catalog";
export { dispatchTool, toolErrorResult } from "./tooling/dispatch";
