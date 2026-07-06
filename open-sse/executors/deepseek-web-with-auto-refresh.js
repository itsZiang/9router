import { DeepSeekWebExecutor, acquireAccessToken, extractUserToken, tokenCache } from "./deepseek-web";
export class DeepSeekWebWithAutoRefreshExecutor extends DeepSeekWebExecutor {
  refreshConfig;
  lastRefreshTime = 0;
  refreshTimer = null;
  sessionValid = false;
  retryCount = 0;
  maxRetries = 2;
  currentUserToken = "";
  constructor(config = {}) {
    super();
    this.refreshConfig = {
      sessionRefreshInterval: 50 * 60 * 1000,
      maxRefreshRetries: 3,
      autoRefresh: true,
      ...config
    };
  }
  async execute(input) {
    this.retryCount = 0;
    const creds = input.credentials;
    this.setCurrentUserToken(extractUserToken(creds));
    return this.executeWithRetry(input);
  }
  isSessionValid() {
    return this.sessionValid;
  }
  getTimeSinceRefresh() {
    return Date.now() - this.lastRefreshTime;
  }
  async refreshSession() {
    await this.doRefreshSession();
  }
  destroy() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
  startAutoRefresh() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(async () => {
      if (!this.currentUserToken) {
        this.sessionValid = false;
        return;
      }
      try {
        await this.doRefreshSession();
      } catch (error) {
        console.error("[DeepSeek-WEB-AUTO-REFRESH] Auto-refresh failed:", error);
      }
    }, this.refreshConfig.sessionRefreshInterval);
    if (typeof this.refreshTimer === "object" && "unref" in this.refreshTimer) {
      this.refreshTimer.unref?.();
    }
  }
  setCurrentUserToken(userToken) {
    if (!userToken) {
      return;
    }
    if (this.currentUserToken === userToken) {
      return;
    }
    this.currentUserToken = userToken;
    this.sessionValid = false;
    if (this.refreshConfig.autoRefresh) {
      this.startAutoRefresh();
    }
  }
  async doRefreshSession() {
    if (!this.currentUserToken) {
      this.sessionValid = false;
      throw new Error("No userToken available for session refresh");
    }
    const {
      maxRefreshRetries
    } = this.refreshConfig;
    for (let attempt = 0; attempt < maxRefreshRetries; attempt++) {
      try {
        tokenCache.delete(this.currentUserToken);
        const accessToken = await acquireAccessToken(this.currentUserToken);
        if (accessToken) {
          this.lastRefreshTime = Date.now();
          this.sessionValid = true;
          return;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("invalid") || msg.includes("expired")) {
          this.sessionValid = false;
          throw new Error("Token expired — get a new userToken from DeepSeek localStorage");
        }
        if (attempt >= maxRefreshRetries - 1) throw error;
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    }
    throw new Error("Failed to refresh session after max retries");
  }
  executeBase(input) {
    return super.execute(input);
  }
  async executeWithRetry(input) {
    try {
      return await this.executeBase(input);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const isUnauthorized = msg.includes("401") || msg.includes("Unauthorized") || msg.includes("expired");
      if (isUnauthorized && this.retryCount < this.maxRetries) {
        this.retryCount++;
        try {
          await this.doRefreshSession();
          return await this.executeBase(input);
        } catch (refreshError) {
          console.error(`[DeepSeek-WEB] Session refresh failed (attempt ${this.retryCount}/${this.maxRetries}):`, refreshError);
        }
      }
      if (msg.includes("429") || msg.includes("Rate limit")) {
        console.warn("[DeepSeek-WEB] Rate limited:", msg);
      }
      throw error;
    }
  }
}
export const deepseekWebWithAutoRefreshExecutor = new DeepSeekWebWithAutoRefreshExecutor();