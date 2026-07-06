import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// Regression guard for the "auto-disable key doesn't actually persist" bug.
//
// Root cause: open-sse/handlers/chatCore.js (and the keyHealth / codexFailover
// siblings) imported `updateProviderConnection` from the host-agnostic no-op
// stub `../stubs/lib/db/providers`, where the function is `async () => undefined`.
// The credits-exhausted / banned / deactivated disable branches therefore
// logged "disabling connection" but never wrote isActive:false to the DB, so
// the disabled key kept getting picked on the next request.
//
// Fix: repoint those imports to the real SQLite repo via the @/ alias
// (`@/lib/localDb`), the same shim tokenRefresh.js + usageDb already use.
// This test locks that the disable path does NOT import from the no-op stub.
const DISABLE_PATH_FILES = [
  "open-sse/handlers/chatCore.js",
  "open-sse/handlers/chatCore/keyHealth.js",
  "open-sse/handlers/chatCore/codexFailover.js",
];

describe("disable-path imports real updateProviderConnection (not the no-op stub)", () => {
  for (const rel of DISABLE_PATH_FILES) {
    it(`${rel} imports updateProviderConnection from @/lib/localDb`, () => {
      const src = fs.readFileSync(path.resolve(rel), "utf-8");
      // Must import updateProviderConnection from the real shim.
      expect(src).toMatch(/import\s*\{[^}]*\bupdateProviderConnection\b[^}]*\}\s*from\s*["']@\/lib\/localDb["']/);
      // Must NOT import the providers DB functions from the no-op stub anymore.
      expect(src).not.toMatch(/from\s*["'][^"']*stubs\/lib\/db\/providers["']/);
    });
  }

  it("@/lib/localDb re-exports the real updateProviderConnection / getProviderConnectionById", () => {
    const src = fs.readFileSync(path.resolve("src/lib/localDb.js"), "utf-8");
    expect(src).toMatch(/\bupdateProviderConnection\b/);
    expect(src).toMatch(/\bgetProviderConnectionById\b/);
    expect(src).toMatch(/@\/lib\/db\/index\.js/);
  });

  it("real connectionsRepo.updateProviderConnection merges & persists isActive:false", () => {
    const src = fs.readFileSync(path.resolve("src/lib/db/repos/connectionsRepo.js"), "utf-8");
    // The disable call passes { isActive: false, testStatus: "credits_exhausted" }.
    // The repo must merge arbitrary fields and write isActive (0/1) — verify the
    // merge + isActive coercion exists, which is what makes the disable stick.
    expect(src).toMatch(/isActive:\s*\(isActive === false \|\| isActive === 0\)\s*\?\s*0\s*:\s*1/);
    expect(src).toMatch(/UPDATE SET[\s\S]*isActive=excluded\.isActive/);
  });
});
