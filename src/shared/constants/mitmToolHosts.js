/**
 * Per-tool DNS hosts — written to hosts file as 127.0.0.1 when MITM DNS is enabled.
 * Kept in sync with MITM routing; shared by Node (dnsConfig) and dashboard UI.
 */
const TOOL_HOSTS = {
  antigravity: ["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"],
  copilot: ["api.individual.githubcopilot.com"],
  kiro: ["runtime.us-east-1.kiro.dev", "q.us-east-1.amazonaws.com", "codewhisperer.us-east-1.amazonaws.com"],
  cursor: ["api2.cursor.sh"],
  qoder: ["openapi.qoder.sh", "api2.qoder.sh", "center.qoder.sh"],
};

module.exports = { TOOL_HOSTS };
