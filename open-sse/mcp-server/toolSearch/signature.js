/**
 * zodToTsSignature — converts a Zod v4 object schema into a compact one-line
 * TypeScript function signature string. Never throws.
 *
 * Example output: `omniroute_tool_search(args: { query: string; limit?: number })`
 */

function unwrap(field) {
  const t = field.type ?? field._def?.type;
  if (t === "optional" || t === "default" || t === "nullable") {
    const inner = field._def?.innerType;
    if (inner && typeof inner === "object") return unwrap(inner);
  }
  return field;
}
function isOptional(field) {
  const t = field.type ?? field._def?.type;
  return t === "optional";
}
function zodTypeToTs(field, depth = 0) {
  const core = unwrap(field);
  const t = core.type ?? core._def?.type;
  if (t === "string") return "string";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  if (t === "enum") {
    const entries = core._def?.entries;
    if (entries && typeof entries === "object") {
      const vals = Object.keys(entries);
      return vals.map(v => `'${v}'`).join(" | ");
    }
    return "string";
  }
  if (t === "array") {
    const element = core._def?.element;
    if (element && typeof element === "object") {
      return `${zodTypeToTs(element, depth)}[]`;
    }
    return "unknown[]";
  }
  if (t === "object" && depth < 2) {
    const shape = core.shape ?? core._def?.shape;
    if (shape && typeof shape === "object") {
      const fields = Object.entries(shape).map(([k, v]) => {
        const opt = isOptional(v) ? "?" : "";
        return `${k}${opt}: ${zodTypeToTs(v, depth + 1)}`;
      }).join("; ");
      return `{ ${fields} }`;
    }
  }
  return "unknown";
}

/**
 * Converts `name` + optional Zod object schema into a one-line TS signature.
 * Falls back to `name(args: object)` on introspection errors.
 */
export function zodToTsSignature(name, inputSchema) {
  if (!inputSchema) return `${name}()`;
  try {
    const schema = inputSchema;
    const t = schema.type ?? schema._def?.type;
    if (t !== "object") return `${name}()`;
    const shape = schema.shape ?? schema._def?.shape;
    if (!shape || typeof shape !== "object" || Object.keys(shape).length === 0) {
      return `${name}()`;
    }
    const fields = Object.entries(shape).map(([k, v]) => {
      const opt = isOptional(v) ? "?" : "";
      return `${k}${opt}: ${zodTypeToTs(v)}`;
    }).join("; ");
    return `${name}(args: { ${fields} })`;
  } catch {
    return `${name}(args: object)`;
  }
}