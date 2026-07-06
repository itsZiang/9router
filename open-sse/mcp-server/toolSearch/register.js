import { toolSearchInput } from "../schemas/toolSearch";
import { handleToolSearch } from "./handler";
export function registerToolSearchTool(server, withScopeEnforcement) {
  server.registerTool("omniroute_tool_search", {
    description: "Search MCP tools by keyword; returns compact one-line TS signatures for token-efficient discovery.",
    inputSchema: toolSearchInput
  }, withScopeEnforcement("omniroute_tool_search", args => {
    const parsed = toolSearchInput.parse(args ?? {});
    const result = handleToolSearch(parsed);
    return Promise.resolve({
      content: [{
        type: "text",
        text: JSON.stringify(result, null, 2)
      }]
    });
  }));
}