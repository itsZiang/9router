/**
 * MCP/A2A Audit Types — Interfaces for audit log entries.
 *
 * These types define the format of audit log entries stored in the
 * `mcp_tool_audit` and `a2a_task_events` tables.
 *
 * Security: Input data is never stored in clear text. Only SHA-256 hashes
 * of input and truncated output summaries are persisted.
 */

// ============ MCP Audit Entry ============

// ============ A2A Task Event ============

// ============ Routing Decision Log ============

// ============ Audit Helpers ============

/**
 * Create a SHA-256 hash of input data for audit logging.
 * This ensures we never store raw prompts/data in audit logs.
 */
export async function hashInput(input) {
  const data = JSON.stringify(input);
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(data));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Truncate output to a summary string for audit logging.
 */
export function summarizeOutput(output, maxLength = 200) {
  if (output === null || output === undefined) return "(null)";
  const str = typeof output === "string" ? output : JSON.stringify(output);
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + "…";
}