import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Resolve the bin/ directory inside the installed @microsoft/mxc-sdk package.
 * Returns the arch-specific subdirectory (x64 or arm64) if available.
 */
function resolveSdkBinDir(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const sdkPkgPath = require.resolve("@microsoft/mxc-sdk/package.json");
    const sdkRoot = path.dirname(sdkPkgPath);
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const archBin = path.join(sdkRoot, "bin", arch);
    if (fs.existsSync(archBin)) {
      return archBin;
    }
    // Fallback to flat bin/ if no arch subdirectory
    const flatBin = path.join(sdkRoot, "bin");
    if (fs.existsSync(flatBin)) {
      return flatBin;
    }
  } catch {
    // SDK not installed; skip.
  }
  return null;
}

function buildSearchPaths(binary: string, sdkBinDir: string | null): string[] {
  const paths: string[] = [];
  if (sdkBinDir) {
    paths.push(path.join(sdkBinDir, binary));
  }
  paths.push(binary); // bare name; PATH lookup
  paths.push(path.join(os.homedir(), ".mxc", binary));
  return paths;
}

/** Well-known search paths for wxc-exec on Windows. */
function wxcSearchPaths(): string[] {
  return buildSearchPaths("wxc-exec.exe", resolveSdkBinDir());
}

/** Well-known search paths for MXC's Linux executor. */
function linuxExecutorSearchPaths(): string[] {
  const sdkBin = resolveSdkBinDir();
  const paths = buildSearchPaths("lxc-exec", sdkBin);
  paths.push("/usr/local/bin/lxc-exec");
  return paths;
}

/** Well-known search paths for mxc-exec-mac on macOS. */
function macSearchPaths(): string[] {
  return buildSearchPaths("mxc-exec-mac", resolveSdkBinDir());
}

function findOnPath(binary: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  const sep = os.platform() === "win32" ? ";" : ":";
  for (const dir of pathEnv.split(sep)) {
    if (!dir.trim() || !path.isAbsolute(dir)) {
      continue;
    }
    const candidate = path.join(dir, binary);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function findBinary(searchPaths: string[]): string | null {
  for (const p of searchPaths) {
    // If it's a bare name, search PATH
    if (!path.isAbsolute(p) && !p.includes(path.sep)) {
      const found = findOnPath(p);
      if (found) {
        return found;
      }
    } else if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Resolves the MXC executor binary path.
 * @param configOverride Optional user-configured path override.
 * @returns Absolute path to the binary.
 * @throws If the binary cannot be found.
 */
export function resolveMxcBinaryPath(configOverride?: string): string {
  if (configOverride) {
    if (!fs.existsSync(configOverride)) {
      throw new Error(`MXC binary not found at configured path: ${configOverride}`);
    }
    return configOverride;
  }

  const platform = os.platform();
  let searchPaths: string[];
  let binaryName: string;
  if (platform === "linux") {
    searchPaths = linuxExecutorSearchPaths();
    binaryName = "lxc-exec";
  } else if (platform === "darwin") {
    searchPaths = macSearchPaths();
    binaryName = "mxc-exec-mac";
  } else {
    searchPaths = wxcSearchPaths();
    binaryName = "wxc-exec.exe";
  }
  const found = findBinary(searchPaths);

  if (!found) {
    throw new Error(
      `MXC executor "${binaryName}" not found. Install @microsoft/mxc-sdk or set mxcBinaryPath in config.`,
    );
  }
  return found;
}
