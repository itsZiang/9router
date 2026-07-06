/**
 * Firecrawl Web Fetch Executor
 *
 * Fetches content from a URL using the Firecrawl scrape API.
 * POST https://api.firecrawl.dev/v1/scrape
 *
 * Free tier: 500 fetches/month, no credit card required.
 * Docs: https://docs.firecrawl.dev/api-reference/endpoint/scrape
 */

import { sanitizeErrorMessage, buildErrorBody } from "../utils/error";
const FIRECRAWL_API_BASE = "https://api.firecrawl.dev/v1";
const FIRECRAWL_TIMEOUT_MS = 30_000;
function mapFormat(format) {
  switch (format) {
    case "html":
      return "html";
    case "links":
      return "links";
    case "screenshot":
      return "screenshot";
    case "markdown":
    default:
      return "markdown";
  }
}
/**
 * Execute a Firecrawl scrape request.
 */
export async function firecrawlFetch(opts) {
  const {
    url,
    format,
    depth,
    waitForSelector,
    includeMetadata,
    credentials
  } = opts;
  if (!credentials.apiKey) {
    const body = buildErrorBody(401, "Firecrawl API key required");
    return {
      success: false,
      status: 401,
      error: body.error.message
    };
  }
  const formats = [mapFormat(format)];
  const requestBody = {
    url,
    formats
  };

  // NOTE: Firecrawl returns metadata (title, description, og:title, etc.)
  // automatically in response.data.metadata — no special request params needed.
  // Sending the `includeTags` parameter with non-CSS-selector values like
  // "og:title" or "description" causes Firecrawl's parser to crash (HTTP 500).
  // The `includeMetadata` flag only controls whether we surface metadata
  // in our response (see response parsing below).

  if (depth > 0) {
    requestBody.maxDepth = depth;
  }
  if (waitForSelector) {
    requestBody.waitFor = waitForSelector;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FIRECRAWL_TIMEOUT_MS);
  try {
    const response = await fetch(`${FIRECRAWL_API_BASE}/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credentials.apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    if (!response.ok) {
      const rawError = await response.text().catch(() => `HTTP ${response.status}`);
      const msg = sanitizeErrorMessage(`Firecrawl error ${response.status}: ${rawError}`);
      const body = buildErrorBody(response.status, msg);
      return {
        success: false,
        status: response.status,
        error: body.error.message
      };
    }
    const data = await response.json();
    const scraped = data.data ?? {};
    const content = format === "html" ? String(scraped.html ?? "") : format === "links" ? JSON.stringify(scraped.links ?? []) : String(scraped.markdown ?? scraped.content ?? "");
    const rawLinks = scraped.links;
    const links = Array.isArray(rawLinks) ? rawLinks.map(l => String(l)) : [];
    const rawMeta = scraped.metadata;
    const metadata = includeMetadata ? {
      title: rawMeta?.title != null ? String(rawMeta.title) : null,
      description: rawMeta?.description != null ? String(rawMeta.description) : null
    } : null;
    const screenshotUrl = format === "screenshot" ? scraped.screenshot != null ? String(scraped.screenshot) : null : null;
    return {
      success: true,
      data: {
        provider: "firecrawl",
        url,
        content,
        links,
        metadata,
        screenshot_url: screenshotUrl
      }
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      const body = buildErrorBody(504, "Firecrawl request timed out");
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