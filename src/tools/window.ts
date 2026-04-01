import { getParallelsWindow, osascript } from "../helpers.js";

export const getWindowInfoTool = {
  name: "get_window_info",
  description:
    "Get the position and size of the Parallels VM window. " +
    "Use this to understand the coordinate space before clicking. " +
    "Coordinates (0,0) start at the top-left of the Parallels window.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

export async function getWindowInfo() {
  try {
    const win = await getParallelsWindow();

    // Also try to get the frontmost app inside Parallels
    let frontApp = "Unknown";
    try {
      // This gets the macOS-level frontmost app
      frontApp = await osascript(
        'tell application "System Events" to get name of first process whose frontmost is true'
      );
    } catch {
      // ignore
    }

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Parallels Window: "${win.name}"`,
            `Position: (${win.x}, ${win.y})`,
            `Size: ${win.width} × ${win.height}`,
            `Screenshot size: 1200 × ~820 pixels`,
            `Coordinate space: (0,0) = top-left of screenshot image, (1200,820) = bottom-right`,
            `macOS frontmost app: ${frontApp}`,
            ``,
            `When clicking, use the pixel coordinates from the screenshot image.`,
            `Example: to click the center, use x=600, y=410`,
          ].join("\n"),
        },
      ],
    };
  } catch (err: any) {
    throw new Error(
      `Could not find Parallels window. Is the VM running? Error: ${err.message}`
    );
  }
}
