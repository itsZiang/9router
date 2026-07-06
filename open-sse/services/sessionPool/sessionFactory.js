/**
 * SessionFactory — Creates initialized Session instances
 *
 * For zero-auth providers (Pollinations, Puter): just assigns a fingerprint.
 * For cookie-based providers (ChatGPT Web, DeepSeek Web): would launch
 * headless Playwright, solve Turnstile, and extract cookies.
 *
 * Currently only zero-auth is implemented. Cookie-based provider support
 * is planned for Phase 3.
 */

import { FingerprintRotator } from "./fingerprintRotator";
import { Session } from "./session";
export class SessionFactory {
  rotator = new FingerprintRotator();
  constructor(config) {
    this.config = config;
  }

  /**
   * Create a new session with the next available fingerprint.
   * For zero-auth providers, this is a lightweight operation
   * (just picks a fingerprint). For cookie-based providers this
   * would involve Playwright browser automation.
   */
  createSession() {
    // Round-robin so each session in a warm pool gets a distinct fingerprint
    // (a pool of look-alike sessions defeats the purpose). The rotator still
    // exposes random() for callers that want unpredictability over time.
    const fingerprint = this.rotator.next();
    return new Session(fingerprint, this.config.cooldownBase, this.config.cooldownMax, this.config.cooldownJitter);
  }

  /** Reset the fingerprint rotator (e.g., after config change) */
  resetRotator() {
    this.rotator.reset();
  }

  /** Number of available fingerprint profiles */
  get profileCount() {
    return this.rotator.count;
  }

  /** Build headers from session fingerprint */
  buildHeaders(session, extra) {
    return session.buildHeaders(extra);
  }
}