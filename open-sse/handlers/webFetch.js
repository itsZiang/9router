/**
 * Web Fetch Handler
 *
 * Handles POST /v1/web/fetch requests.
 * Dispatches to a web-fetch provider executor (Firecrawl, Jina Reader, or Tavily).
 *
 * Request format:
 * {
 *   "url": "https://example.com",
 *   "provider": "firecrawl" | "jina-reader" | "tavily-search",  // optional
 *   "format": "markdown" | "html" | "links" | "screenshot",
 *   "depth": 0 | 1 | 2,
 *   "wait_for_selector": "main",
 *   "include_metadata": true
 * }
 */

import { buildErrorBody, sanitizeErrorMessage } from "../utils/error";
import { firecrawlFetch } from "../executors/firecrawl-fetch";
import { jinaReaderFetch } from "../executors/jina-reader-fetch";
import { tavilyFetch } from "../executors/tavily-fetch";
const WEB_FETCH_PROVIDERS = ["firecrawl", "jina-reader", "tavily-search"];
/**
 * Execute a web fetch request against the specified (or auto-selected) provider.
 *
 * @param req - Validated web fetch request body
 * @param credentials - Provider API credentials (apiKey)
 * @param resolvedProvider - Provider ID to use; if omitted auto-selects based on available creds
 */
export async function handleWebFetch(req, credentials, resolvedProvider) {
  const provider = resolvedProvider ?? req.provider ?? "firecrawl";
  const format = req.format ?? "markdown";
  const includeMetadata = req.include_metadata ?? false;
  try {
    switch (provider) {
      case "firecrawl":
        return await firecrawlFetch({
          url: req.url,
          format,
          depth: req.depth ?? 0,
          waitForSelector: req.wait_for_selector,
          includeMetadata,
          credentials
        });
      case "jina-reader":
        return await jinaReaderFetch({
          url: req.url,
          format,
          includeMetadata,
          credentials
        });
      case "tavily-search":
        return await tavilyFetch({
          url: req.url,
          format,
          includeMetadata,
          credentials
        });
      default:
        {
          const _exhaustive = provider;
          return {
            success: false,
            status: 400,
            error: `Unknown web fetch provider: ${_exhaustive}`
          };
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? sanitizeErrorMessage(err.message) : sanitizeErrorMessage(String(err));
    const body = buildErrorBody(502, msg);
    return {
      success: false,
      status: 502,
      error: body.error.message
    };
  }
}