/**
 * Jina Reader Web Fetch Executor
 *
 * Fetches content from a URL using the Jina Reader API.
 * GET https://r.jina.ai/{url}
 *
 * Free tier: 1M fetches/month.
 * Docs: https://jina.ai/reader/
 */

import { sanitizeErrorMessage, buildErrorBody } from "../utils/error";
const JINA_READER_BASE = "https://r.jina.ai";
const JINA_TIMEOUT_MS = 30_000;
/**
 * Execute a Jina Reader fetch request.
 * Jina Reader uses a URL-based approach: GET https://r.jina.ai/<url>
 */
export async function jinaReaderFetch(opts) {
  const {
    url,
    format,
    includeMetadata,
    credentials
  } = opts;
  if (!credentials.apiKey) {
    const body = buildErrorBody(401, "Jina Reader API key required");
    return {
      success: false,
      status: 401,
      error: body.error.message
    };
  }
  const headers = {
    Authorization: `Bearer ${credentials.apiKey}`,
    Accept: "application/json",
    "X-Return-Format": format === "html" ? "html" : "markdown"
  };
  if (includeMetadata) {
    headers["X-With-Generated-Alt"] = "true";
  }
  if (format === "links") {
    headers["X-Gather-All-Links-At-The-End"] = "true";
  }
  const encodedUrl = encodeURIComponent(url);
  const requestUrl = `${JINA_READER_BASE}/${encodedUrl}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), JINA_TIMEOUT_MS);
  try {
    const response = await fetch(requestUrl, {
      method: "GET",
      headers,
      signal: controller.signal
    });
    if (!response.ok) {
      const rawError = await response.text().catch(() => `HTTP ${response.status}`);
      const msg = sanitizeErrorMessage(`Jina Reader error ${response.status}: ${rawError}`);
      const body = buildErrorBody(response.status, msg);
      return {
        success: false,
        status: response.status,
        error: body.error.message
      };
    }

    // Jina Reader returns JSON with data.content or plain text
    const contentType = response.headers.get("content-type") ?? "";
    let content = "";
    let links = [];
    let metadata = null;
    if (contentType.includes("application/json")) {
      const json = await response.json();
      const responseData = json.data ?? {};
      content = String(responseData.content ?? responseData.text ?? "");
      if (includeMetadata) {
        metadata = {
          title: responseData.title != null ? String(responseData.title) : null,
          description: responseData.description != null ? String(responseData.description) : null
        };
      }
      if (format === "links") {
        const rawLinks = responseData.links;
        links = Array.isArray(rawLinks) ? rawLinks.map(l => String(l)) : [];
      }
    } else {
      content = await response.text();
    }
    return {
      success: true,
      data: {
        provider: "jina-reader",
        url,
        content,
        links,
        metadata,
        screenshot_url: null
      }
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      const body = buildErrorBody(504, "Jina Reader request timed out");
      return {
        success: false,
        status: 504,
        error: body.error.message
      };
    }
    const msg = err instanceof Error ? sanitizeErrorMessage(err.message) : sanitizeErrorMessage(String(err));
    const body = buildErrorBody(502, msg);
    return {
      success: false,
      status: 502,
      error: body.error.message
    };
  } finally {
    clearTimeout(timeoutId);
  }
}