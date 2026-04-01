import { readFile, unlink } from "fs/promises";
import { exec } from "../helpers.js";

const VM_NAME = "Windows 11 (1)";

export const screenshotTool = {
  name: "screenshot",
  description:
    "Take a screenshot of the Windows VM screen (Garage Assistant 4). " +
    "Captures the VM display directly via Parallels — works even if other Mac windows are on top. " +
    "Always call this before clicking to understand the current UI state. " +
    "IMPORTANT: Coordinates in the returned image map directly to click coordinates.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

export async function screenshot() {
  const tmpPng = `/tmp/ga4_mcp_${Date.now()}.png`;
  const tmpJpg = `/tmp/ga4_mcp_${Date.now()}.jpg`;

  try {
    // Use prlctl capture to grab the VM screen directly — no z-order issues
    await exec("prlctl", ["capture", VM_NAME, "--file", tmpPng]);

    // Convert to JPEG and resize to keep under context limits
    await exec("sips", [
      "-s", "format", "jpeg",
      "-s", "formatOptions", "60",
      "--resampleWidth", "1200",
      tmpPng,
      "--out", tmpJpg,
    ]);

    const imageData = await readFile(tmpJpg);
    const base64 = imageData.toString("base64");

    // Clean up
    await unlink(tmpPng).catch(() => {});
    await unlink(tmpJpg).catch(() => {});

    return {
      content: [
        {
          type: "image",
          data: base64,
          mimeType: "image/jpeg",
        },
      ],
    };
  } catch (err: any) {
    await unlink(tmpPng).catch(() => {});
    await unlink(tmpJpg).catch(() => {});
    throw new Error(`Screenshot failed: ${err.message}`);
  }
}
