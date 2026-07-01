/**
 * Base class for provider-specific response iterators.
 * Separates raw byte parsing from the monolithic SSE transform stream.
 *
 * Subclasses implement _parseBuffer to turn buffered bytes into normalized
 * chunk objects.  The normalized shape is always OpenAI
 * chat.completion.chunk (or { done: true } for the sentinel).
 */
export class BaseResponseIterator {
  constructor({ model, provider } = {}) {
    this.model = model;
    this.provider = provider;
    this._buffer = "";
    this._decoder = new TextDecoder("utf-8", { fatal: false });
    this.done = false;
  }

  /**
   * Parse a raw byte chunk. May be called multiple times as the stream arrives.
   * @param {Uint8Array} rawBytes
   * @returns {Array<Object>|null} normalized chunks or null if no complete chunk yet
   */
  parseChunk(rawBytes) {
    const text = this._decoder.decode(rawBytes, { stream: true });
    this._buffer += text;
    return this._parseBuffer();
  }

  /**
   * Flush any remaining bytes at the end of the stream.
   * @returns {Array<Object>|null}
   */
  flush() {
    const remaining = this._decoder.decode();
    if (remaining) {
      this._buffer += remaining;
    }
    return this._parseBuffer(true);
  }

  /**
   * Subclasses MUST override this.
   *
   * @protected
   * @param {boolean} isFlush
   * @returns {Array<Object>|null}
   */
  _parseBuffer(isFlush = false) {
    // default: consume everything and return nothing
    this._buffer = "";
    return null;
  }
}

export default BaseResponseIterator;
