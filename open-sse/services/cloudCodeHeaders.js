export function getRuntimePlatform() {
  return typeof process !== "undefined" && typeof process.platform === "string" ? process.platform : "unknown";
}
export function getRuntimeArch() {
  return typeof process !== "undefined" && typeof process.arch === "string" ? process.arch : "unknown";
}
export function getRuntimeNodeVersion() {
  return typeof process !== "undefined" && process.versions?.node ? process.versions.node : "unknown";
}
export function normalizeCloudCodePlatform(platform = getRuntimePlatform()) {
  switch (platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    default:
      return platform || "unknown";
  }
}
export function normalizeCloudCodeArch(arch = getRuntimeArch()) {
  switch (arch) {
    case "ia32":
      return "x86";
    default:
      return arch || "unknown";
  }
}
export function getCloudCodeNodeApiClientHeader(nodeVersion = getRuntimeNodeVersion()) {
  return `gl-node/${nodeVersion.replace(/^v/, "")}`;
}