import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// Regression test for a Temporal Dead Zone (TDZ) bug in handleChatCore
// where saveRequestDetail(..., response: { content: translatedResponse?.choices... })
// was placed BEFORE the `let translatedResponse = ...` declaration.
// This caused: ReferenceError: Cannot access 'q' before initialization
describe("chatCore TDZ regression", () => {
  it("saveRequestDetail call site must appear after translatedResponse declaration", () => {
    const filePath = path.resolve("open-sse/handlers/chatCore.js");
    const source = fs.readFileSync(filePath, "utf-8");

    // Find the declaration position
    const declarationMatch = source.indexOf("let translatedResponse = needsTranslation(responsePayloadFormat");
    expect(declarationMatch).toBeGreaterThan(-1);

    // Find the saveRequestDetail position (in non-streaming success path)
    const saveDetailMatch = source.indexOf('saveRequestDetail(buildRequestDetail({');
    expect(saveDetailMatch).toBeGreaterThan(-1);

    // Also verify the content property accesses `translatedResponse`
    const detailBlockStart = saveDetailMatch;
    const detailBlockEnd = source.indexOf(']}, { endpoint:', saveDetailMatch);
    const detailBlock = source.slice(detailBlockStart, detailBlockEnd);
    expect(detailBlock).toContain("translatedResponse");

    // CRITICAL: saveRequestDetail must be AFTER the let translatedResponse declaration
    expect(saveDetailMatch).toBeGreaterThan(declarationMatch);
  });
});
