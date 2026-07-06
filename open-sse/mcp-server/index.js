/**
 * OmniRoute MCP Server — barrel export.
 */
export { createMcpServer, startMcpStdio } from "./server";
export { logToolCall, getRecentAuditEntries, getAuditStats, queryAuditEntries } from "./audit";
export { resolveMcpHeartbeatPath, readMcpHeartbeat, isMcpHeartbeatOnline, isProcessAlive } from "./runtimeHeartbeat";
export { handleMcpSSE, handleMcpStreamableHTTP, getMcpHttpStatus, shutdownMcpHttp, isMcpHttpActive } from "./httpTransport";
export * from "./schemas/index";