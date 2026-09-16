#!/usr/bin/env node

import { constants as fsConstants, readFileSync, realpathSync } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const BUNDLE_ID = "com.brnsft.ikuna.macos";
const HELPER_RELATIVE_PATH = "Contents/bin/ikuna-mcp";
const DEFAULT_DISCOVERY_TIMEOUT_MS = 2_000;
const MAX_DISCOVERY_OUTPUT_BYTES = 64 * 1024;
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const START_FIRST = "Ikuna is not running. Start Ikuna first, then run npx -y ikuna-mcp again.";
const INSTALL_URL = "https://www.brnsft.com/ikuna";
const HELP = `Usage: ikuna-mcp [--app-path /path/to/Ikuna.app]

Bridge MCP stdio to the signed helper embedded in a running Ikuna app.

Options:
  --app-path PATH  Select a particular running Ikuna.app bundle
  --help, -h       Show this help
  --version, -v    Show the package version
`;

class CliError extends Error {}

function parseArguments(argv) {
  let appPath;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      return { action: "help" };
    } else if (argument === "--version" || argument === "-v") {
      return { action: "version" };
    } else if (argument === "--app-path") {
      appPath = argv[index + 1];
      if (!appPath) throw new CliError("--app-path requires a path to Ikuna.app.");
      index += 1;
    } else if (argument.startsWith("--app-path=")) {
      appPath = argument.slice("--app-path=".length);
      if (!appPath) throw new CliError("--app-path requires a path to Ikuna.app.");
    } else {
      throw new CliError(`Unknown argument: ${argument}. Run ikuna-mcp --help for usage.`);
    }
  }

  return { action: "bridge", appPath };
}

function discoveryScript() {
  return `ObjC.import("AppKit");
const applications = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("${BUNDLE_ID}");
const paths = [];
for (let index = 0; index < applications.count; index += 1) {
  const bundleURL = applications.objectAtIndex(index).bundleURL;
  if (bundleURL) paths.push(ObjC.unwrap(bundleURL.path));
}
const installedURL = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier("${BUNDLE_ID}");
const installedPath = installedURL ? ObjC.unwrap(installedURL.path) : null;
JSON.stringify({ runningPaths: paths, installedPath });`;
}

function discoverApp({
  executable = process.env.NODE_ENV === "test" && process.env.IKUNA_MCP_TEST_OSASCRIPT
    ? process.env.IKUNA_MCP_TEST_OSASCRIPT
    : "/usr/bin/osascript",
  timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
} = {}) {
  return new Promise((resolveDiscovery, reject) => {
    const child = spawn(executable, ["-l", "JavaScript", "-e", discoveryScript()], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let oversized = false;

    const append = (current, chunk) => {
      if (current.length + chunk.length > MAX_DISCOVERY_OUTPUT_BYTES) {
        oversized = true;
        child.kill("SIGKILL");
        return current;
      }
      return Buffer.concat([current, chunk]);
    };

    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timeout.unref();

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new CliError(`Could not check whether Ikuna is running: ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new CliError(`Timed out while checking for Ikuna after ${timeoutMs} ms. ${START_FIRST}`));
        return;
      }
      if (oversized) {
        reject(new CliError("Could not check whether Ikuna is running: discovery output was too large."));
        return;
      }
      if (code !== 0) {
        const detail = stderr.toString("utf8").trim();
        reject(new CliError(`Could not check whether Ikuna is running${detail ? `: ${detail}` : "."}`));
        return;
      }
      try {
        const discovery = JSON.parse(stdout.toString("utf8"));
        if (!discovery || !Array.isArray(discovery.runningPaths)
            || !discovery.runningPaths.every((path) => typeof path === "string" && path.length > 0)
            || (discovery.installedPath !== null
              && (typeof discovery.installedPath !== "string" || discovery.installedPath.length === 0))) {
          throw new Error("expected runningPaths and installedPath");
        }
        resolveDiscovery(discovery);
      } catch (error) {
        reject(new CliError(`Could not check whether Ikuna is running: invalid discovery response (${error.message}).`));
      }
    });
  });
}

async function canonicalPath(path) {
  const absolutePath = resolve(path);
  try {
    return await realpath(absolutePath);
  } catch {
    return absolutePath;
  }
}

async function isInstalledApp(path) {
  if (!path.toLowerCase().endsWith(".app")) return false;
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function selectRunningApp({ runningPaths, installedPath }, requestedPath) {
  if (runningPaths.length === 0) {
    if (installedPath && await isInstalledApp(installedPath)) {
      throw new CliError("Ikuna is installed but not running. Open Ikuna, then run npx -y ikuna-mcp again.");
    }
    throw new CliError(`Ikuna is not installed. Install Ikuna from ${INSTALL_URL}, open it, then run npx -y ikuna-mcp again.`);
  }

  const canonicalRunningPaths = [...new Set(await Promise.all(runningPaths.map(canonicalPath)))];
  if (canonicalRunningPaths.length > 1) {
    throw new CliError("Multiple copies of Ikuna are running. Quit extra copies of Ikuna, then retry.");
  }
  if (!requestedPath) {
    return canonicalRunningPaths[0];
  }

  const canonicalRequestedPath = await canonicalPath(requestedPath);
  if (!canonicalRunningPaths.includes(canonicalRequestedPath)) {
    throw new CliError(`Ikuna is not running from ${resolve(requestedPath)}. Start that copy of Ikuna first.`);
  }
  return canonicalRequestedPath;
}

function forwardSignals(child) {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map();
  const escalationTimers = new Set();
  for (const signal of signals) {
    const handler = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 1_000);
        timer.unref();
        escalationTimers.add(timer);
      }
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    for (const timer of escalationTimers) clearTimeout(timer);
  };
}

function runHelper(helperPath) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(helperPath, [], { stdio: "inherit" });
    const removeSignalHandlers = forwardSignals(child);

    child.once("error", (error) => {
      removeSignalHandlers();
      reject(new CliError(`Could not start Ikuna's MCP bridge: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      removeSignalHandlers();
      if (code !== null) {
        resolveExit(code);
        return;
      }
      const signalNumbers = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
      resolveExit(128 + (signalNumbers[signal] || 1));
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  const parsedArguments = parseArguments(argv);
  if (parsedArguments.action === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (parsedArguments.action === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (process.platform !== "darwin") {
    throw new CliError("ikuna-mcp requires macOS and the Ikuna app.");
  }

  const requestedAppPath = parsedArguments.appPath || process.env.IKUNA_APP_PATH;
  const discovery = await discoverApp();
  const appPath = await selectRunningApp(discovery, requestedAppPath);
  const helperPath = resolve(appPath, HELPER_RELATIVE_PATH);

  try {
    await access(helperPath, fsConstants.X_OK);
  } catch {
    throw new CliError(`Ikuna is running, but its MCP bridge is missing or not executable at ${helperPath}. Reinstall or update Ikuna.`);
  }

  return runHelper(helperPath);
}

function resolvedEntryPath(path) {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

const isEntryPoint = process.argv[1]
  && resolvedEntryPath(fileURLToPath(import.meta.url)) === resolvedEntryPath(process.argv[1]);
if (isEntryPoint) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`[ikuna-mcp] ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
