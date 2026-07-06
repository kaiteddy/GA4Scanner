#!/usr/bin/env node

/**
 * Garage Assistant 4 MCP Server
 * Controls GA4 (FileMaker on Parallels/Windows) via screenshot + mouse/keyboard
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { screenshot, screenshotTool } from "./tools/screenshot.js";
import { click, clickTool, doubleClick, doubleClickTool, rightClick, rightClickTool } from "./tools/mouse.js";
import { typeText, typeTextTool, pressKey, pressKeyTool } from "./tools/keyboard.js";
import { scroll, scrollTool } from "./tools/scroll.js";
import { getWindowInfo, getWindowInfoTool } from "./tools/window.js";
import { waitTool, waitMs } from "./tools/wait.js";
import { focusWindowTool, focusWindow } from "./tools/focus.js";
import { pasteFieldTool, pasteField } from "./tools/paste.js";

const server = new Server(
  { name: "garage-assistant-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const ALL_TOOLS = [
  screenshotTool,
  clickTool,
  doubleClickTool,
  rightClickTool,
  typeTextTool,
  pressKeyTool,
  scrollTool,
  getWindowInfoTool,
  waitTool,
  focusWindowTool,
  pasteFieldTool,
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALL_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "screenshot":
        return await screenshot();
      case "click":
        return await click(args as any);
      case "double_click":
        return await doubleClick(args as any);
      case "right_click":
        return await rightClick(args as any);
      case "type_text":
        return await typeText(args as any);
      case "press_key":
        return await pressKey(args as any);
      case "scroll":
        return await scroll(args as any);
      case "get_window_info":
        return await getWindowInfo();
      case "wait":
        return await waitMs(args as any);
      case "focus_window":
        return await focusWindow();
      case "paste_field":
        return await pasteField(args as any);
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[GA4 MCP] Server started");
}

main().catch((err) => {
  console.error("[GA4 MCP] Fatal:", err);
  process.exit(1);
});
