export const AG_TOOL_SUFFIX = "_ide";
const AG_DEFAULT_TOOL_NAMES = ["browser_subagent", "command_status", "find_by_name", "generate_image", "grep_search", "list_dir", "list_resources", "multi_replace_file_content", "notify_user", "read_resource", "read_terminal", "read_url_content", "replace_file_content", "run_command", "search_web", "send_command_input", "task_boundary", "view_content_chunk", "view_file", "write_to_file"];
const AG_DECOY_TOOL_NAMES = [...AG_DEFAULT_TOOL_NAMES, "mcp_sequential_thinking_sequentialthinking"];
export const AG_DEFAULT_TOOLS = new Set(AG_DEFAULT_TOOL_NAMES);
export const AG_DECOY_TOOLS = AG_DECOY_TOOL_NAMES.map(name => Object.freeze({
  name,
  description: "This tool is currently unavailable.",
  parameters: {
    type: "OBJECT",
    properties: {},
    required: []
  }
}));
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function toToolName(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Recursively strip `enumDescriptions` from a JSON schema.
 *
 * VSCode Copilot emits `enumDescriptions` inside tool parameter schemas, but the
 * Antigravity API rejects any request carrying that field with HTTP 400. Walk the
 * schema's `properties` and `items` so the field is removed at every nesting level
 * before the declaration is sent upstream.
 */
export function stripEnumDescriptions(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) {
    return schema.map(entry => stripEnumDescriptions(entry));
  }
  const result = {
    ...schema
  };
  delete result.enumDescriptions;
  const properties = asRecord(result.properties);
  if (properties) {
    const nextProperties = {};
    for (const key of Object.keys(properties)) {
      nextProperties[key] = stripEnumDescriptions(properties[key]);
    }
    result.properties = nextProperties;
  }
  if (result.items !== undefined) {
    result.items = stripEnumDescriptions(result.items);
  }
  return result;
}
export function shouldCloakAntigravityTool(toolName) {
  return toolName.length > 0 && !AG_DEFAULT_TOOLS.has(toolName) && !toolName.endsWith(AG_TOOL_SUFFIX);
}
export function getCloakedAntigravityToolName(toolName) {
  return shouldCloakAntigravityTool(toolName) ? `${toolName}${AG_TOOL_SUFFIX}` : toolName;
}
export function cloakAntigravityToolPayload(body) {
  const request = asRecord(body.request);
  if (!request) {
    return {
      body,
      toolNameMap: null
    };
  }
  const existingToolNameMap = body._toolNameMap instanceof Map ? body._toolNameMap : null;
  const toolNameMap = existingToolNameMap ? new Map(existingToolNameMap) : new Map();
  let changed = false;
  const nextRequest = {
    ...request
  };
  if (Array.isArray(request.tools)) {
    const preservedTools = [];
    const cloakedDeclarations = [];
    for (const toolValue of request.tools) {
      const tool = asRecord(toolValue);
      if (!tool || !Array.isArray(tool.functionDeclarations)) {
        preservedTools.push(toolValue);
        continue;
      }
      for (const declarationValue of tool.functionDeclarations) {
        const declaration = asRecord(declarationValue);
        if (!declaration) continue;

        // VSCode Copilot sends `enumDescriptions` in tool parameter schemas, but the
        // Antigravity API rejects requests carrying that field with HTTP 400. Strip it
        // recursively before the declaration is forwarded upstream.
        const stripped = declaration.parameters !== undefined ? {
          ...declaration,
          parameters: stripEnumDescriptions(declaration.parameters)
        } : declaration;
        if (stripped !== declaration) {
          changed = true;
        }
        const rawName = toToolName(stripped.name);
        if (!rawName) {
          cloakedDeclarations.push({
            ...stripped
          });
          continue;
        }
        const cloakedName = getCloakedAntigravityToolName(rawName);
        if (cloakedName !== rawName) {
          changed = true;
          toolNameMap.set(cloakedName, toolNameMap.get(rawName) ?? rawName);
        }
        cloakedDeclarations.push({
          ...stripped,
          name: cloakedName
        });
      }
    }
    if (cloakedDeclarations.length > 0) {
      const declaredNames = new Set(cloakedDeclarations.map(declaration => toToolName(declaration.name)).filter(name => name.length > 0));
      const decoys = AG_DECOY_TOOLS.filter(declaration => !declaredNames.has(declaration.name));
      nextRequest.tools = [...preservedTools, {
        functionDeclarations: [...cloakedDeclarations, ...decoys]
      }];
      changed = true;
    }
  }
  if (Array.isArray(request.contents)) {
    let contentsChanged = false;
    const nextContents = request.contents.map(contentValue => {
      const content = asRecord(contentValue);
      if (!content || !Array.isArray(content.parts)) return contentValue;
      let partChanged = false;
      const nextParts = content.parts.map(partValue => {
        const part = asRecord(partValue);
        if (!part) return partValue;
        const nextPart = {
          ...part
        };
        const functionCall = asRecord(part.functionCall);
        if (functionCall) {
          const rawName = toToolName(functionCall.name);
          const cloakedName = getCloakedAntigravityToolName(rawName);
          if (cloakedName !== rawName) {
            nextPart.functionCall = {
              ...functionCall,
              name: cloakedName
            };
            toolNameMap.set(cloakedName, toolNameMap.get(rawName) ?? rawName);
            partChanged = true;
          }
        }
        const functionResponse = asRecord(part.functionResponse);
        if (functionResponse) {
          const rawName = toToolName(functionResponse.name);
          const cloakedName = getCloakedAntigravityToolName(rawName);
          if (cloakedName !== rawName) {
            nextPart.functionResponse = {
              ...functionResponse,
              name: cloakedName
            };
            toolNameMap.set(cloakedName, toolNameMap.get(rawName) ?? rawName);
            partChanged = true;
          }
        }
        return partChanged ? nextPart : partValue;
      });
      if (!partChanged) return contentValue;
      contentsChanged = true;
      return {
        ...content,
        parts: nextParts
      };
    });
    if (contentsChanged) {
      nextRequest.contents = nextContents;
      changed = true;
    }
  }
  if (!changed) {
    return {
      body,
      toolNameMap: toolNameMap.size > 0 ? toolNameMap : null
    };
  }
  return {
    body: {
      ...body,
      request: nextRequest
    },
    toolNameMap: toolNameMap.size > 0 ? toolNameMap : null
  };
}