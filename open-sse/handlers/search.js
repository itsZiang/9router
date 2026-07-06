/**
 * Search Handler
 *
 * Handles POST /v1/search requests.
 * Routes to 11 search providers with automatic failover:
 *   serper-search, brave-search, perplexity-search, exa-search, tavily-search,
 *   google-pse-search, linkup-search, searchapi-search, youcom-search, searxng-search, ollama-search, zai-search
 *
 * Request format:
 * {
 *   "query": "search query",
 *   "provider": "serper-search" | "brave-search" | ... // optional, auto-selects cheapest
 *   "max_results": 5,
 *   "search_type": "web" | "news"
 * }
 */

import { getSearchProvider } from "../config/searchRegistry";
import { freeWebSearch } from "../services/freeWebSearch";
import { saveCallLog } from "@/lib/usageDb";
import { safeOutboundFetch } from "../stubs/shared/network/safeOutboundFetch";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { sanitizeErrorMessage } from "../utils/error";

// ── Types ────────────────────────────────────────────────────────────────

// ── Constants ────────────────────────────────────────────────────────────

const GLOBAL_TIMEOUT_MS = 15_000;

// Non-retriable HTTP status codes — fail immediately, don't try alternate
const NON_RETRIABLE = new Set([400, 401, 403, 404]);

// ── Input Sanitization ──────────────────────────────────────────────────

// Control characters that should never appear in search queries
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
function sanitizeQuery(query) {
  if (CONTROL_CHAR_RE.test(query)) {
    return {
      clean: "",
      error: "Query contains invalid control characters"
    };
  }
  const clean = query.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (clean.length === 0) {
    return {
      clean: "",
      error: "Query is empty after normalization"
    };
  }
  return {
    clean
  };
}

// ── Response Normalizers ────────────────────────────────────────────────

function makeResult(providerId, item, idx, now) {
  const url = item.url || "";
  return {
    title: item.title || "",
    url,
    display_url: url ? url.replace(/^https?:\/\/(www\.)?/, "").split("?")[0] : undefined,
    snippet: item.snippet || "",
    position: idx + 1,
    score: typeof item.score === "number" ? Math.min(1, Math.max(0, item.score)) : null,
    published_at: item.published_at || null,
    favicon_url: item.favicon_url || null,
    content: item.full_text ? {
      format: item.text_format || "text",
      text: item.full_text,
      length: item.full_text.length
    } : null,
    metadata: {
      author: item.author || null,
      language: null,
      source_type: item.source_type || null,
      image_url: item.image_url || null
    },
    citation: {
      provider: providerId,
      retrieved_at: now,
      rank: idx + 1
    },
    provider_raw: null
  };
}
function normalizeSerperResponse(data, _query, searchType) {
  const now = new Date().toISOString();
  const items = searchType === "news" ? data.news : data.organic;
  if (!Array.isArray(items)) return {
    results: [],
    totalResults: null
  };
  const results = items.map((item, idx) => makeResult("serper-search", {
    title: item.title,
    url: item.link,
    snippet: item.snippet || item.description,
    published_at: item.date
  }, idx, now));
  return {
    results,
    totalResults: typeof data.searchParameters?.totalResults === "number" ? data.searchParameters.totalResults : null
  };
}
function normalizeBraveResponse(data, _query, searchType) {
  const now = new Date().toISOString();
  // Brave news endpoint returns { results: [...] } directly,
  // while web endpoint returns { web: { results: [...] } }
  const container = searchType === "news" ? data.news || data : data.web;
  const items = container?.results;
  if (!Array.isArray(items)) return {
    results: [],
    totalResults: null
  };
  const results = items.map((item, idx) => makeResult("brave-search", {
    title: item.title,
    url: item.url,
    snippet: item.description,
    published_at: item.page_age || item.age,
    favicon_url: item.meta_url?.favicon || item.favicon
  }, idx, now));
  return {
    results,
    totalResults: container?.totalCount ?? null
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function parseDomainFilter(domainFilter) {
  if (!domainFilter?.length) return {
    includes: [],
    excludes: []
  };
  const includes = domainFilter.filter(d => !d.startsWith("-"));
  const excludes = domainFilter.filter(d => d.startsWith("-")).map(d => d.slice(1));
  return {
    includes,
    excludes
  };
}
function getProviderSettingString(params, key) {
  const fromOptions = params.providerOptions?.[key];
  if (typeof fromOptions === "string" && fromOptions.trim().length > 0) {
    return fromOptions.trim();
  }
  const fromProviderData = params.providerSpecificData?.[key];
  if (typeof fromProviderData === "string" && fromProviderData.trim().length > 0) {
    return fromProviderData.trim();
  }
  return undefined;
}
function resolveSearchBaseUrl(config, params) {
  const override = getProviderSettingString(params, "baseUrl");
  return (override || config.baseUrl).replace(/\/+$/, "");
}
function toSearchPageNumber(offset, maxResults) {
  if (typeof offset !== "number" || offset <= 0 || maxResults <= 0) return undefined;
  return Math.floor(offset / maxResults) + 1;
}

// ── Provider Request Builders ───────────────────────────────────────────

function buildSerperRequest(config, params) {
  const endpoint = params.searchType === "news" ? "/news" : "/search";
  const body = {
    q: params.query,
    num: params.maxResults
  };
  if (params.country) body.gl = params.country.toLowerCase();
  if (params.language) body.hl = params.language;
  return {
    url: `${config.baseUrl}${endpoint}`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": params.token
      },
      body: JSON.stringify(body)
    }
  };
}
function buildBraveRequest(config, params) {
  const endpoint = params.searchType === "news" ? "/news/search" : "/web/search";
  const qp = new URLSearchParams({
    q: params.query,
    count: String(params.maxResults)
  });
  if (params.country) qp.set("country", params.country);
  if (params.language) qp.set("search_lang", params.language);
  return {
    url: `${config.baseUrl}${endpoint}?${qp}`,
    init: {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": params.token
      }
    }
  };
}
function buildPerplexityRequest(config, params) {
  const body = {
    query: params.query,
    max_results: params.maxResults
  };
  if (params.country) body.country = params.country;
  if (params.language) body.search_language_filter = [params.language];
  if (params.domainFilter?.length) body.search_domain_filter = params.domainFilter;
  return {
    url: config.baseUrl,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.token}`
      },
      body: JSON.stringify(body)
    }
  };
}
function buildExaRequest(config, params) {
  const {
    includes,
    excludes
  } = parseDomainFilter(params.domainFilter);
  const body = {
    query: params.query,
    numResults: params.maxResults,
    type: "auto",
    text: true,
    highlights: true
  };
  if (includes.length) body.includeDomains = includes;
  if (excludes.length) body.excludeDomains = excludes;
  if (params.searchType === "news") body.category = "news";
  return {
    url: config.baseUrl,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": params.token
      },
      body: JSON.stringify(body)
    }
  };
}
function buildTavilyRequest(config, params) {
  const {
    includes,
    excludes
  } = parseDomainFilter(params.domainFilter);
  const body = {
    query: params.query,
    max_results: params.maxResults,
    topic: params.searchType === "news" ? "news" : "general"
  };
  if (includes.length) body.include_domains = includes;
  if (excludes.length) body.exclude_domains = excludes;
  if (params.country) body.country = params.country;
  return {
    url: config.baseUrl,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.token}`
      },
      body: JSON.stringify(body)
    }
  };
}
function buildGooglePseRequest(config, params) {
  const apiKey = params.token;
  const cx = getProviderSettingString(params, "cx");
  if (!apiKey || !cx) {
    throw new Error("Google Programmable Search requires both apiKey and cx");
  }
  const qp = new URLSearchParams({
    key: apiKey,
    cx,
    q: params.query,
    num: String(Math.min(params.maxResults, 10))
  });
  if (params.country) qp.set("gl", params.country.toLowerCase());
  if (params.language) qp.set("hl", params.language);
  if (params.timeRange && params.timeRange !== "any") {
    const dateRestrictMap = {
      day: "d1",
      week: "w1",
      month: "m1",
      year: "y1"
    };
    const dateRestrict = dateRestrictMap[params.timeRange];
    if (dateRestrict) qp.set("dateRestrict", dateRestrict);
  }
  if (typeof params.offset === "number" && params.offset > 0) {
    qp.set("start", String(Math.min(params.offset + 1, 91)));
  }
  return {
    url: `${resolveSearchBaseUrl(config, params)}?${qp}`,
    init: {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    }
  };
}
function buildLinkupRequest(config, params) {
  const apiKey = params.token;
  if (!apiKey) {
    throw new Error("Linkup Search requires an API key");
  }
  const {
    includes,
    excludes
  } = parseDomainFilter(params.domainFilter);
  const requestedDepth = getProviderSettingString(params, "depth");
  const depth = requestedDepth && ["fast", "standard", "deep"].includes(requestedDepth) ? requestedDepth : "standard";
  const body = {
    q: params.query,
    depth,
    outputType: "searchResults",
    maxResults: params.maxResults
  };
  if (includes.length) body.includeDomains = includes;
  if (excludes.length) body.excludeDomains = excludes;
  if (params.timeRange && params.timeRange !== "any") {
    const today = new Date();
    const toDate = today.toISOString().slice(0, 10);
    const from = new Date(today);
    if (params.timeRange === "day") from.setUTCDate(from.getUTCDate() - 1);
    if (params.timeRange === "week") from.setUTCDate(from.getUTCDate() - 7);
    if (params.timeRange === "month") from.setUTCMonth(from.getUTCMonth() - 1);
    if (params.timeRange === "year") from.setUTCFullYear(from.getUTCFullYear() - 1);
    body.fromDate = from.toISOString().slice(0, 10);
    body.toDate = toDate;
  }
  return {
    url: resolveSearchBaseUrl(config, params),
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    }
  };
}
function buildSearchApiRequest(config, params) {
  const apiKey = params.token;
  if (!apiKey) {
    throw new Error("SearchAPI requires an API key");
  }
  const qp = new URLSearchParams({
    engine: params.searchType === "news" ? "google_news" : "google",
    q: params.query,
    api_key: apiKey
  });
  if (params.country) qp.set("gl", params.country.toLowerCase());
  if (params.language) qp.set("hl", params.language);
  const page = toSearchPageNumber(params.offset, params.maxResults);
  if (page) qp.set("page", String(page));
  return {
    url: `${resolveSearchBaseUrl(config, params)}?${qp}`,
    init: {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    }
  };
}
function buildYouComRequest(config, params) {
  const apiKey = params.token;
  if (!apiKey) {
    throw new Error("You.com Search requires an API key");
  }
  const {
    includes,
    excludes
  } = parseDomainFilter(params.domainFilter);
  const qp = new URLSearchParams({
    query: params.query,
    count: String(Math.min(params.maxResults, 100))
  });
  if (params.timeRange && params.timeRange !== "any") {
    qp.set("freshness", params.timeRange);
  }
  if (typeof params.offset === "number" && params.offset > 0 && params.maxResults > 0) {
    qp.set("offset", String(Math.min(Math.floor(params.offset / params.maxResults), 9)));
  }
  if (params.country) qp.set("country", params.country);
  if (params.language) qp.set("language", params.language);
  if (includes.length) qp.set("include_domains", includes.join(","));
  if (excludes.length) qp.set("exclude_domains", excludes.join(","));
  if (params.contentOptions?.full_page) {
    qp.set("livecrawl", params.searchType === "news" ? "news" : "web");
    qp.append("livecrawl_formats", params.contentOptions.format === "markdown" ? "markdown" : "html");
  }
  return {
    url: `${resolveSearchBaseUrl(config, params)}?${qp}`,
    init: {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-API-Key": apiKey
      }
    }
  };
}
function buildSearxngRequest(config, params) {
  const baseUrl = resolveSearchBaseUrl(config, params);
  const url = baseUrl.endsWith("/search") ? baseUrl : `${baseUrl}/search`;
  const qp = new URLSearchParams({
    q: params.query,
    format: "json",
    categories: params.searchType === "news" ? "news" : "general"
  });
  if (params.language) qp.set("language", params.language);
  if (params.timeRange && params.timeRange !== "any") qp.set("time_range", params.timeRange);
  const page = toSearchPageNumber(params.offset, params.maxResults);
  if (page) qp.set("pageno", String(page));
  const headers = {
    Accept: "application/json"
  };
  if (params.token) {
    headers["Authorization"] = `Bearer ${params.token}`;
  }
  return {
    url: `${url}?${qp}`,
    init: {
      method: "GET",
      headers
    }
  };
}
function buildOllamaRequest(config, params) {
  return {
    url: resolveSearchBaseUrl(config, params),
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(params.token ? {
          Authorization: `Bearer ${params.token}`
        } : {})
      },
      body: JSON.stringify({
        query: params.query,
        max_results: params.maxResults
      })
    }
  };
}
function buildRequest(config, params) {
  if (config.id === "serper-search") return buildSerperRequest(config, params);
  if (config.id === "brave-search") return buildBraveRequest(config, params);
  if (config.id === "perplexity-search") return buildPerplexityRequest(config, params);
  if (config.id === "exa-search") return buildExaRequest(config, params);
  if (config.id === "tavily-search") return buildTavilyRequest(config, params);
  if (config.id === "google-pse-search") return buildGooglePseRequest(config, params);
  if (config.id === "linkup-search") return buildLinkupRequest(config, params);
  if (config.id === "searchapi-search") return buildSearchApiRequest(config, params);
  if (config.id === "youcom-search") return buildYouComRequest(config, params);
  if (config.id === "searxng-search") return buildSearxngRequest(config, params);
  if (config.id === "ollama-search") return buildOllamaRequest(config, params);
  // Fallback for future providers: POST with bearer auth
  return {
    url: resolveSearchBaseUrl(config, params),
    init: {
      method: config.method,
      headers: {
        "Content-Type": "application/json",
        ...(params.token ? {
          Authorization: `Bearer ${params.token}`
        } : {})
      },
      body: JSON.stringify({
        query: params.query,
        max_results: params.maxResults,
        search_type: params.searchType
      })
    }
  };
}
function normalizePerplexityResponse(data, _query, _searchType) {
  const now = new Date().toISOString();
  const items = data.results;
  if (!Array.isArray(items)) return {
    results: [],
    totalResults: null
  };
  const results = items.map((item, idx) => makeResult("perplexity-search", {
    title: item.title,
    url: item.url,
    snippet: item.snippet,
    published_at: item.date || item.last_updated
  }, idx, now));
  return {
    results,
    totalResults: results.length
  };
}
function normalizeExaResponse(data, _query, _searchType) {
  const now = new Date().toISOString();
  const items = data.results;
  if (!Array.isArray(items)) return {
    results: [],
    totalResults: null
  };
  const results = items.map((item, idx) => makeResult("exa-search", {
    title: item.title,
    url: item.url,
    snippet: item.highlights?.[0] || item.text?.slice(0, 300) || "",
    score: item.score,
    published_at: item.publishedDate,
    favicon_url: item.favicon,
    author: item.author,
    image_url: item.image,
    full_text: item.text,
    text_format: "text"
  }, idx, now));
  return {
    results,
    totalResults: results.length
  };
}
function normalizeTavilyResponse(data, _query, _searchType) {
  const now = new Date().toISOString();
  const items = data.results;
  if (!Array.isArray(items)) return {
    results: [],
    totalResults: null
  };
  const results = items.map((item, idx) => makeResult("tavily-search", {
    title: item.title,
    url: item.url,
    snippet: item.content || "",
    score: item.score,
    published_at: item.published_date,
    full_text: item.raw_content,
    text_format: "text"
  }, idx, now));
  return {
    results,
    totalResults: results.length
  };
}
function normalizeGooglePseResponse(data, _query, _searchType) {
  const now = new Date().toISOString();
  const items = Array.isArray(data.items) ? data.items : [];
  const results = items.map((item, idx) => makeResult("google-pse-search", {
    title: item.title,
    url: item.link,
    snippet: item.snippet,
    image_url: item.pagemap?.cse_image?.[0]?.src || item.pagemap?.cse_thumbnail?.[0]?.src || item.pagemap?.metatags?.[0]?.["og:image"]
  }, idx, now));
  const totalResultsRaw = data.searchInformation?.totalResults ?? data.queries?.request?.[0]?.totalResults ?? null;
  const totalResults = typeof totalResultsRaw === "string" ? Number(totalResultsRaw) : totalResultsRaw;
  return {
    results,
    totalResults: Number.isFinite(totalResults) ? totalResults : null
  };
}
function normalizeLinkupResponse(data, _query, _searchType) {
  const now = new Date().toISOString();
  const items = Array.isArray(data.results) ? data.results : [];
  const results = items.map((item, idx) => makeResult("linkup-search", {
    title: item.name || item.title,
    url: item.url,
    snippet: item.content || item.snippet || "",
    source_type: item.type || "web",
    image_url: item.image_url || item.imageUrl || null,
    full_text: item.content,
    text_format: "text"
  }, idx, now));
  return {
    results,
    totalResults: results.length
  };
}
function normalizeSearchApiResponse(data, _query, _searchType) {
  const now = new Date().toISOString();
  const items = Array.isArray(data.organic_results) ? data.organic_results : Array.isArray(data.top_stories) ? data.top_stories : [];
  const results = items.map((item, idx) => makeResult("searchapi-search", {
    title: item.title,
    url: item.link,
    snippet: item.snippet || item.description || "",
    published_at: item.date || item.published_at,
    favicon_url: item.favicon,
    author: item.source || null,
    image_url: item.thumbnail || null
  }, idx, now));
  const totalResults = typeof data.search_information?.total_results === "number" ? data.search_information.total_results : typeof data.search_information?.total_results === "string" ? Number(data.search_information.total_results) : null;
  return {
    results,
    totalResults: Number.isFinite(totalResults) ? totalResults : results.length
  };
}
function normalizeYouComResponse(data, _query, searchType) {
  const now = new Date().toISOString();
  const resultsContainer = data?.results && typeof data.results === "object" ? data.results : undefined;
  const section = searchType === "news" ? resultsContainer?.news || [] : resultsContainer?.web || [];
  const items = Array.isArray(section) ? section : [];
  const results = items.map((item, idx) => {
    const firstSnippet = Array.isArray(item.snippets) ? item.snippets.find(value => typeof value === "string") : null;
    const livecrawlText = typeof item.markdown === "string" ? item.markdown : typeof item.html === "string" ? item.html : undefined;
    const livecrawlFormat = typeof item.markdown === "string" ? "markdown" : "html";
    return makeResult("youcom-search", {
      title: item.title,
      url: item.url,
      snippet: typeof firstSnippet === "string" ? firstSnippet : typeof item.description === "string" ? item.description : "",
      published_at: item.page_age,
      favicon_url: item.favicon_url,
      image_url: item.thumbnail_url,
      source_type: searchType,
      full_text: livecrawlText,
      text_format: livecrawlText ? livecrawlFormat : undefined
    }, idx, now);
  });
  return {
    results,
    totalResults: results.length
  };
}
function normalizeSearxngResponse(data, _query, _searchType) {
  const now = new Date().toISOString();
  const items = Array.isArray(data.results) ? data.results : [];
  const results = items.map((item, idx) => makeResult("searxng-search", {
    title: item.title,
    url: item.url,
    snippet: item.content || item.snippet || "",
    published_at: item.publishedDate || item.published_date || null,
    source_type: Array.isArray(item.engines) ? item.engines.join(", ") : item.engine || item.category || null,
    image_url: item.thumbnail || item.img_src || null
  }, idx, now));
  return {
    results,
    totalResults: results.length
  };
}
function normalizeOllamaResponse(data, _query, _searchType) {
  const now = new Date().toISOString();
  const items = Array.isArray(data?.results) ? data.results : [];
  const results = items.map((item, idx) => makeResult("ollama-search", {
    title: item?.title,
    url: item?.url,
    snippet: item?.content || "",
    full_text: item?.content,
    text_format: "text"
  }, idx, now));
  return {
    results,
    totalResults: results.length
  };
}

// ── Z.AI Coding Plan Search MCP Execution ───────────────────────────

// Schema for the Z.AI MCP web_search_prime tool result. Z.AI double-encodes
// the results array as a JSON string inside the MCP text content, so we
// safely unwrap it with a typed schema instead of `JSON.parse(parsed)`.
const ZaiSearchItemSchema = z.object({
  title: z.string().optional(),
  link: z.string().optional(),
  content: z.string().optional(),
  publish_date: z.string().optional(),
  icon: z.string().optional(),
  media: z.string().optional()
}).passthrough();
const ZaiSearchResultsSchema = z.array(ZaiSearchItemSchema);

/**
 * Unwrap the double-encoded JSON from a Z.AI MCP web_search_prime response.
 *
 * Quirk: the MCP server returns a text content block whose body is a JSON
 * string. That JSON string, once parsed, is itself another JSON string
 * containing the actual results array. We try a single parse first
 * (in case the upstream behavior ever changes), then a nested parse.
 * Both paths are validated through `ZaiSearchResultsSchema` so any shape
 * regression upstream lands in our error path instead of corrupting results.
 */
function unwrapZaiContent(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }

  // Direct array path (defensive, in case Z.AI stops double-encoding).
  const direct = ZaiSearchResultsSchema.safeParse(parsed);
  if (direct.success) return direct.data;

  // Documented Z.AI behavior: parsed is a JSON string of the results array.
  if (typeof parsed !== "string") return null;
  let inner;
  try {
    inner = JSON.parse(parsed);
  } catch {
    return null;
  }
  const validated = ZaiSearchResultsSchema.safeParse(inner);
  return validated.success ? validated.data : null;
}
async function zaiSearchExecute(params) {
  const baseUrl = resolveSearchBaseUrl(params.config, params.params);
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    fetch: safeOutboundFetch,
    requestInit: {
      headers: {
        Authorization: `Bearer ${params.token}`
      }
    }
  });
  const client = new Client({
    name: "omniroute-search",
    version: "1.0"
  }, {
    capabilities: {}
  });
  const {
    signal
  } = params;
  let abortHandler;
  if (signal) {
    if (signal.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    abortHandler = () => {
      client.close().catch(() => {});
    };
    signal.addEventListener("abort", abortHandler, {
      once: true
    });
  }
  try {
    await client.connect(transport);
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    const args = {
      search_query: params.query
    };
    const {
      includes
    } = parseDomainFilter(params.params.domainFilter);
    if (includes.length > 0) {
      args.search_domain_filter = includes.join(",");
    }
    const toolResult = await client.callTool({
      name: "web_search_prime",
      arguments: args
    });
    const rawContent = Array.isArray(toolResult.content) ? toolResult.content : [];
    const rawText = rawContent.filter(c => c?.type === "text").map(c => typeof c?.text === "string" ? c.text : "").join("\n");
    if (!rawText.trim()) {
      return {
        results: [],
        totalResults: null
      };
    }
    const items = unwrapZaiContent(rawText);
    if (!items) {
      return {
        results: [],
        totalResults: null
      };
    }
    const now = new Date().toISOString();
    const results = items.map((item, idx) => makeResult("zai-search", {
      title: item.title,
      url: item.link,
      snippet: item.content || "",
      published_at: item.publish_date,
      favicon_url: item.icon,
      source_type: item.media
    }, idx, now));
    return {
      results,
      totalResults: results.length
    };
  } finally {
    if (abortHandler && signal) {
      signal.removeEventListener("abort", abortHandler);
    }
    await client.close();
  }
}
async function tryZaiMCPProvider(config, params, token, providerSpecificData, startTime, globalStartTime, log) {
  const {
    query,
    searchType,
    maxResults
  } = params;
  const remainingGlobal = GLOBAL_TIMEOUT_MS - (Date.now() - globalStartTime);
  const timeout = Math.min(config.timeoutMs, Math.max(remainingGlobal, 1000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const normalized = await zaiSearchExecute({
      config,
      query,
      token,
      params: {
        ...params,
        token,
        providerSpecificData
      },
      signal: controller.signal
    });
    clearTimeout(timer);
    const results = normalized.results.slice(0, maxResults);
    const duration = Date.now() - startTime;
    saveCallLog({
      method: config.method,
      path: "/v1/search",
      status: 200,
      model: config.id,
      provider: config.id,
      duration,
      requestType: "search",
      tokens: {
        prompt_tokens: 0,
        completion_tokens: 0
      },
      requestBody: {
        query: query.slice(0, 200),
        search_type: searchType,
        max_results: maxResults
      },
      responseBody: {
        results_count: results.length,
        cached: false
      }
    }).catch(() => {
      /* non-critical — logging must not block search response */
    });
    return {
      success: true,
      data: {
        provider: config.id,
        query,
        results,
        answer: null,
        usage: {
          queries_used: 1,
          search_cost_usd: config.costPerQuery
        },
        metrics: {
          response_time_ms: duration,
          upstream_latency_ms: duration,
          total_results_available: normalized.totalResults
        },
        errors: []
      }
    };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === "AbortError";
    if (log) {
      log.error("SEARCH", `${config.id} MCP ${isTimeout ? "timeout" : "error"}: ${err.message}`);
    }
    saveCallLog({
      method: config.method,
      path: "/v1/search",
      status: isTimeout ? 504 : 502,
      model: config.id,
      provider: config.id,
      duration: Date.now() - startTime,
      requestType: "search",
      error: err.message,
      requestBody: {
        query: query.slice(0, 200),
        search_type: searchType,
        max_results: maxResults
      }
    }).catch(() => {
      /* non-critical — logging must not block search response */
    });
    return {
      success: false,
      status: isTimeout ? 504 : 502,
      error: `Search provider ${isTimeout ? "timeout" : "error"}: ${sanitizeErrorMessage(err.message)}`
    };
  }
}
function normalizeResponse(providerId, data, query, searchType) {
  if (providerId === "serper-search") return normalizeSerperResponse(data, query, searchType);
  if (providerId === "brave-search") return normalizeBraveResponse(data, query, searchType);
  if (providerId === "perplexity-search") return normalizePerplexityResponse(data, query, searchType);
  if (providerId === "exa-search") return normalizeExaResponse(data, query, searchType);
  if (providerId === "tavily-search") return normalizeTavilyResponse(data, query, searchType);
  if (providerId === "google-pse-search") return normalizeGooglePseResponse(data, query, searchType);
  if (providerId === "linkup-search") return normalizeLinkupResponse(data, query, searchType);
  if (providerId === "searchapi-search") return normalizeSearchApiResponse(data, query, searchType);
  if (providerId === "youcom-search") return normalizeYouComResponse(data, query, searchType);
  if (providerId === "searxng-search") return normalizeSearxngResponse(data, query, searchType);
  if (providerId === "ollama-search") return normalizeOllamaResponse(data, query, searchType);
  return {
    results: [],
    totalResults: null
  };
}

// ── Main Handler ────────────────────────────────────────────────────────

export async function handleSearch(options) {
  const {
    query,
    provider: providerId,
    maxResults,
    searchType,
    country,
    language,
    timeRange,
    offset,
    domainFilter,
    contentOptions,
    providerOptions,
    credentials,
    alternateProvider,
    alternateCredentials,
    log
  } = options;
  const startTime = Date.now();

  // 1. Sanitize input
  const {
    clean: cleanQuery,
    error: sanitizeError
  } = sanitizeQuery(query);
  if (sanitizeError) {
    return {
      success: false,
      status: 400,
      error: sanitizeError
    };
  }

  // 2. Use resolved provider from route (no re-resolution)
  const primaryConfig = getSearchProvider(providerId);
  if (!primaryConfig) {
    return {
      success: false,
      status: 400,
      error: `Unknown search provider: ${providerId}`
    };
  }

  // 3. Get alternate config for failover (pre-resolved by route)
  const alternateConfig = alternateProvider ? getSearchProvider(alternateProvider) : null;
  const requestParams = {
    query: cleanQuery,
    searchType,
    maxResults,
    country,
    language,
    timeRange,
    offset,
    domainFilter,
    contentOptions,
    providerOptions
  };

  // 4. Try primary provider
  const result = await tryProvider(primaryConfig, requestParams, credentials, startTime, log);
  if (result.success) return result;

  // 5. Failover to alternate (only for retriable errors and auto-select mode)
  if (alternateConfig && alternateCredentials && !NON_RETRIABLE.has(result.status || 0) && Date.now() - startTime < GLOBAL_TIMEOUT_MS) {
    if (log) {
      log.warn("SEARCH", `${primaryConfig.id} failed (${result.status}), trying ${alternateConfig.id}`);
    }
    const fallbackResult = await tryProvider(alternateConfig, requestParams, alternateCredentials, startTime, log);
    if (fallbackResult.success) return fallbackResult;
  }
  return result;
}

/**
 * Free DuckDuckGo lite provider — no API key, HTML scraping (free-claude-code port).
 * Dedicated path because the lite endpoint returns HTML, not the JSON the generic
 * tryProvider() flow expects. See open-sse/services/freeWebSearch.ts.
 */
async function tryDuckDuckGoFreeProvider(config, params, startTime, globalStartTime, log) {
  const {
    query,
    searchType,
    maxResults
  } = params;
  const remainingGlobal = GLOBAL_TIMEOUT_MS - (Date.now() - globalStartTime);
  const timeout = Math.min(config.timeoutMs, Math.max(remainingGlobal, 1000));
  if (log) {
    log.info?.("SEARCH", `${config.id} | query: "${query.slice(0, 80)}" | type: ${searchType}`);
  }
  const requestBody = {
    query: query.slice(0, 200),
    search_type: searchType,
    max_results: maxResults
  };
  try {
    const freeResults = await freeWebSearch(query, maxResults, timeout);
    const now = new Date().toISOString();
    const results = freeResults.slice(0, maxResults).map((r, idx) => makeResult(config.id, {
      title: r.title,
      url: r.url,
      snippet: r.snippet
    }, idx, now));
    const duration = Date.now() - startTime;
    saveCallLog({
      method: config.method,
      path: "/v1/search",
      status: 200,
      model: config.id,
      provider: config.id,
      duration,
      requestType: "search",
      tokens: {
        prompt_tokens: 0,
        completion_tokens: 0
      },
      requestBody,
      responseBody: {
        results_count: results.length,
        cached: false
      }
    }).catch(() => {
      /* non-critical — logging must not block search response */
    });
    return {
      success: true,
      data: {
        provider: config.id,
        query,
        results,
        answer: null,
        usage: {
          queries_used: 1,
          search_cost_usd: 0
        },
        metrics: {
          response_time_ms: duration,
          upstream_latency_ms: duration,
          total_results_available: results.length
        },
        errors: []
      }
    };
  } catch (err) {
    const duration = Date.now() - startTime;
    const message = sanitizeErrorMessage(err);
    if (log) {
      log.error?.("SEARCH", `${config.id} error: ${message}`);
    }
    saveCallLog({
      method: config.method,
      path: "/v1/search",
      status: 502,
      model: config.id,
      provider: config.id,
      duration,
      requestType: "search",
      error: message.slice(0, 500),
      requestBody
    }).catch(() => {
      /* non-critical */
    });
    return {
      success: false,
      status: 502,
      error: `DuckDuckGo free search failed: ${message}`
    };
  }
}
async function tryProvider(config, params, credentials, globalStartTime, log) {
  const startTime = Date.now();
  const providerSpecificData = credentials?.providerSpecificData && typeof credentials.providerSpecificData === "object" ? credentials.providerSpecificData : undefined;
  const token = credentials.apiKey || credentials.accessToken || undefined;
  if (config.authType !== "none" && !token) {
    return {
      success: false,
      status: 401,
      error: `No credentials for search provider: ${config.id}`
    };
  }
  const {
    query,
    searchType,
    maxResults
  } = params;
  if (config.id === "duckduckgo-free") {
    return tryDuckDuckGoFreeProvider(config, params, startTime, globalStartTime, log);
  }
  if (config.id === "zai-search" && token) {
    return tryZaiMCPProvider(config, params, token, providerSpecificData, startTime, globalStartTime, log);
  }
  let url = "";
  let init = {};
  try {
    ({
      url,
      init
    } = buildRequest(config, {
      ...params,
      token,
      providerSpecificData
    }));
  } catch (err) {
    return {
      success: false,
      status: 400,
      error: err?.message || `Invalid search configuration for provider: ${config.id}`
    };
  }

  // Timeout: min of provider timeout and remaining global timeout
  const remainingGlobal = GLOBAL_TIMEOUT_MS - (Date.now() - globalStartTime);
  const timeout = Math.min(config.timeoutMs, Math.max(remainingGlobal, 1000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  if (log) {
    log.info("SEARCH", `${config.id} | query: "${query.slice(0, 80)}" | type: ${searchType}`);
  }
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) {
      const errorText = await response.text();
      if (log) {
        log.error("SEARCH", `${config.id} error ${response.status}: ${errorText.slice(0, 200)}`);
      }
      saveCallLog({
        method: config.method,
        path: "/v1/search",
        status: response.status,
        model: config.id,
        provider: config.id,
        duration: Date.now() - startTime,
        requestType: "search",
        error: errorText.slice(0, 500),
        requestBody: {
          query: query.slice(0, 200),
          search_type: searchType,
          max_results: maxResults
        }
      }).catch(() => {
        /* non-critical — logging must not block search response */
      });
      return {
        success: false,
        status: response.status,
        error: `Search provider ${config.id} returned ${response.status}`
      };
    }
    const data = await response.json();
    const normalized = normalizeResponse(config.id, data, query, searchType);
    // Enforce max_results — some providers return more than requested
    const results = normalized.results.slice(0, maxResults);
    const totalResults = normalized.totalResults;
    const duration = Date.now() - startTime;
    saveCallLog({
      method: config.method,
      path: "/v1/search",
      status: 200,
      model: config.id,
      provider: config.id,
      duration,
      requestType: "search",
      tokens: {
        prompt_tokens: 0,
        completion_tokens: 0
      },
      requestBody: {
        query: query.slice(0, 200),
        search_type: searchType,
        max_results: maxResults
      },
      responseBody: {
        results_count: results.length,
        cached: false
      }
    }).catch(() => {
      /* non-critical — logging must not block search response */
    });
    return {
      success: true,
      data: {
        provider: config.id,
        query,
        results,
        answer: null,
        usage: {
          queries_used: 1,
          search_cost_usd: config.costPerQuery
        },
        metrics: {
          response_time_ms: duration,
          upstream_latency_ms: duration,
          total_results_available: totalResults
        },
        errors: []
      }
    };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === "AbortError";
    if (log) {
      log.error("SEARCH", `${config.id} ${isTimeout ? "timeout" : "fetch error"}: ${err.message}`);
    }
    saveCallLog({
      method: config.method,
      path: "/v1/search",
      status: isTimeout ? 504 : 502,
      model: config.id,
      provider: config.id,
      duration: Date.now() - startTime,
      requestType: "search",
      error: err.message,
      requestBody: {
        query: query.slice(0, 200),
        search_type: searchType,
        max_results: maxResults
      }
    }).catch(() => {
      /* non-critical — logging must not block search response */
    });
    return {
      success: false,
      status: isTimeout ? 504 : 502,
      error: `Search provider ${isTimeout ? "timeout" : "error"}: ${sanitizeErrorMessage(err.message)}`
    };
  }
}