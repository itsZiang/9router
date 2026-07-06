import { BaseExecutor } from "./base";
import { sleep } from "../utils/sleep";
import { isJsonObject, normalizeKieTaskState } from "../utils/kieTask";
function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/$/, "");
}
export class KieExecutor extends BaseExecutor {
  constructor() {
    super("kie", {
      baseUrl: "https://api.kie.ai"
    });
  }
  getTaskCreateUrl(baseUrl, endpoint = "/api/v1/jobs/createTask") {
    return `${normalizeBaseUrl(baseUrl)}${endpoint}`;
  }
  getTaskStatusUrl(baseUrl) {
    return `${normalizeBaseUrl(baseUrl)}/api/v1/jobs/recordInfo`;
  }
  async createTask({
    baseUrl,
    token,
    payload,
    endpoint
  }) {
    const res = await fetch(this.getTaskCreateUrl(baseUrl, endpoint), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const error = await res.text();
      throw Object.assign(new Error(error || `Kie createTask failed with status ${res.status}`), {
        status: res.status
      });
    }
    const data = await res.json();
    return isJsonObject(data) ? data : {};
  }
  async pollTask({
    statusUrl,
    taskId,
    token,
    timeoutMs,
    pollIntervalMs
  }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pollUrl = new URL(statusUrl);
      pollUrl.searchParams.set("taskId", String(taskId));
      const res = await fetch(pollUrl.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (!res.ok) {
        const error = await res.text();
        throw Object.assign(new Error(error || `Kie poll failed with status ${res.status}`), {
          status: res.status
        });
      }
      const data = await res.json();
      const recordData = isJsonObject(data) ? data : {};
      const state = normalizeKieTaskState(recordData);
      if (state !== "pending") {
        return {
          data: recordData,
          state
        };
      }
      await sleep(pollIntervalMs);
    }
    throw Object.assign(new Error("Kie task timed out"), {
      status: 504
    });
  }
}
export const kieExecutor = new KieExecutor();