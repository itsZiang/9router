// LiteLLM-style provider abstraction: separates provider-specific request/response
// concerns from the executor's transport loop. Kept minimal for soft migration;
// specialized executors continue to subclass BaseExecutor directly.

/**
 * @typedef {Object} ProviderEnvironment
 * @property {string} [apiKey]
 * @property {string} [apiBase]
 * @property {Object} [headers]
 * @property {string} [model]
 * @property {Array} [messages]
 * @property {Object} [optionalParams]
 *
 * @typedef {Object} EnvironmentValidation
 * @property {boolean} ok
 * @property {string} [message]
 *
 * @typedef {Object} UrlContext
 * @property {string} [apiBase]
 * @property {string} [apiKey]
 * @property {string} model
 * @property {Object} optionalParams
 * @property {boolean} stream
 * @property {Object} credentials
 * @property {number} [urlIndex]
 * @property {string[]} [baseUrls]
 *
 * @typedef {Object} HeaderContext
 * @property {Object} credentials
 * @property {boolean} stream
 * @property {Object} [requestData]
 *
 * @typedef {Object} SignContext
 * @property {Object} headers
 * @property {Object} requestData
 * @property {string} [apiKey]
 *
 * @typedef {Object} TransformRequestContext
 * @property {string} model
 * @property {Array} [messages]
 * @property {Object} optionalParams
 * @property {boolean} stream
 * @property {Object} credentials
 * @property {Object} body - Original pre-transform request body (backward compat)
 *
 * @typedef {Object} TransformResponseContext
 * @property {string} model
 * @property {Response|Object} rawResponse
 * @property {boolean} stream
 * @property {Object} credentials
 *
 * @typedef {Object} IteratorContext
 * @property {Response} rawResponse
 * @property {string} model
 * @property {boolean} stream
 *
 * @typedef {Object} ErrorContext
 * @property {Response} response
 * @property {string} bodyText
 *
 * @typedef {Object} ParsedError
 * @property {number} status
 * @property {string} message
 * @property {number} [resetsAtMs]
 */

export class BaseProviderConfig {
  /**
   * @param {string} provider - Provider id
   * @param {Object} config - Provider registry transport config
   */
  constructor(provider, config) {
    this.provider = provider;
    this.config = config || {};
  }

  /**
   * Validate that required environment pieces are present before building a request.
   * @param {ProviderEnvironment} env
   * @returns {EnvironmentValidation}
   */
  validateEnvironment({ apiKey, apiBase, headers, model, messages, optionalParams }) {
    return { ok: true };
  }

  /**
   * Build the upstream request URL.
   * @param {UrlContext} ctx
   * @returns {string}
   */
  buildUrl({ apiBase, apiKey, model, optionalParams, stream, credentials }) {
    throw new Error(`buildUrl not implemented for provider ${this.provider}`);
  }

  /**
   * Build base headers (without auth signing).
   * @param {HeaderContext} ctx
   * @returns {Object<string,string>}
   */
  buildHeaders({ credentials, stream }) {
    throw new Error(`buildHeaders not implemented for provider ${this.provider}`);
  }

  /**
   * Apply authentication / request signing on top of base headers.
   * Default is identity; subclasses may add signatures, AWS sigv4, etc.
   * @param {SignContext} ctx
   * @returns {Object<string,string>}
   */
  signRequest({ headers, requestData, apiKey }) {
    return headers;
  }

  /**
   * Transform the request body into the provider's native format.
   * @param {TransformRequestContext} ctx
   * @returns {Object}
   */
  transformRequest({ model, messages, optionalParams, stream, credentials, body }) {
    return body;
  }

  /**
   * Transform a non-streaming provider response into the normalized format.
   * @param {TransformResponseContext} ctx
   * @returns {Object}
   */
  transformResponse({ model, rawResponse, stream, credentials }) {
    return rawResponse;
  }

  /**
   * Return an async iterator for streaming responses.
   * @param {IteratorContext} ctx
   * @returns {AsyncIterable|null}
   */
  getResponseIterator({ rawResponse, model, stream }) {
    return null;
  }

  /**
   * Parse an upstream error response into a normalized shape.
   * @param {ErrorContext} ctx
   * @returns {ParsedError}
   */
  parseError({ response, bodyText }) {
    return {
      status: response?.status,
      message: bodyText || `HTTP ${response?.status}`
    };
  }
}

export default BaseProviderConfig;
