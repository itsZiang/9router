/**
 * encoderComparison.ts — pure A/B aggregator for the studio.
 * Scans the same arrays SmartCrusher would compact and reports JSON vs GCF vs TOON
 * sizes (bytes + tokens). countTokens is injected by the caller (open-sse must not
 * import the app-side tiktoken counter). Fail-open: if TOON is unavailable on any
 * array, toonAvailable=false and TOON is not eligible as winner.
 */
import { encodeTabularBlock, wrapTabular } from "./tabular";
import { encodeToonBlock, wrapToon } from "./toon";
import { collectCompactableArrays } from "./smartcrusher";
const ZERO = {
  bytes: 0,
  tokens: 0
};
function add(a, text, countTokens) {
  return {
    bytes: a.bytes + Buffer.byteLength(text, "utf8"),
    tokens: a.tokens + countTokens(text)
  };
}
function pickWinner(json, gcf, toon, toonAvailable) {
  const candidates = [["gcf", gcf], ["json", json]];
  if (toonAvailable) candidates.push(["toon", toon]);
  candidates.sort((a, b) => a[1].tokens - b[1].tokens || a[1].bytes - b[1].bytes);
  return candidates[0][0];
}
export function summarizeEncoderCandidates(messages, minRows, countTokens) {
  const arrays = collectCompactableArrays(messages, minRows);
  let json = {
      ...ZERO
    },
    gcf = {
      ...ZERO
    },
    toon = {
      ...ZERO
    };
  let toonAvailable = arrays.length > 0;
  for (const arr of arrays) {
    json = add(json, JSON.stringify(arr), countTokens);
    gcf = add(gcf, wrapTabular(encodeTabularBlock(arr)), countTokens);
    const toonInner = encodeToonBlock(arr);
    if (toonInner === null) toonAvailable = false;else toon = add(toon, wrapToon(toonInner), countTokens);
  }
  return {
    arraysCompared: arrays.length,
    json,
    gcf,
    toon: toonAvailable ? toon : {
      ...ZERO
    },
    toonAvailable,
    winner: pickWinner(json, gcf, toon, toonAvailable)
  };
}