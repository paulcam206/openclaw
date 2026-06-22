import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerMxcPlugin } from "./src/plugin.js";

export default definePluginEntry({
  id: "mxc",
  name: "MXC Sandbox Execution",
  description:
    "OS-level sandboxed tool execution via MXC: runs commands in ProcessContainer (Windows), Bubblewrap (Linux via process), or Seatbelt (macOS, experimental) with configurable policy.",
  register: registerMxcPlugin,
});
