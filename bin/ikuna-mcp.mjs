#!/usr/bin/env node

import { constants as fsConstants, readFileSync, realpathSync } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { knownClientIDs, runSetup } from "./setup.mjs";

const BUNDLE_ID = "com.brnsft.ikuna.macos";
const HELPER_RELATIVE_PATH = "Contents/bin/ikuna-mcp";
const DEFAULT_DISCOVERY_TIMEOUT_MS = 2_000;
const MAX_DISCOVERY_OUTPUT_BYTES = 64 * 1024;
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const START_FIRST = "Ikuna is not running. Start Ikuna first, then run npx -y ikuna-mcp again.";
const INSTALL_URL = "https://www.brnsft.com/ikuna";
const HELP = `Usage: ikuna-mcp [--app-path /path/to/Ikuna.app]
       ikuna-mcp setup [--repair] [--client CLIENT] [--app-path PATH]

Bridge MCP stdio to the signed helper embedded in a running Ikuna app.

Setup:
  setup            Detect local MCP clients, merge Ikuna config, and verify
  --repair         Explicitly repair missing, stale, or corrupt Ikuna config
  --client CLIENT  Limit setup to: ${knownClientIDs().join(", ")}

Options:
  --app-path PATH  Select a particular running Ikuna.app bundle
  --help, -h       Show this help
  --version, -v    Show the package version
`;

class CliError extends Error {}

function parseArguments(argv) {
  const action = argv[0] === "setup" ? "setup" : "bridge";
  const argumentsToParse = action === "setup" ? argv.slice(1) : argv;
  let appPath;
  let client;
  let repair = false;

  for (let index = 0; index < argumentsToParse.length; index += 1) {
    const argument = argumentsToParse[index];
    if (argument === "--help" || argument === "-h") {
      return { action: "help" };
    } else if (argument === "--version" || argument === "-v") {
      return { action: "version" };
    } else if (argument === "--app-path") {
      appPath = argumentsToParse[index + 1];
      if (!appPath) throw new CliError("--app-path requires a path to Ikuna.app.");
      index += 1;
    } else if (argument.startsWith("--app-path=")) {
      appPath = argument.slice("--app-path=".length);
      if (!appPath) throw new CliError("--app-path requires a path to Ikuna.app.");
    } else if (action === "setup" && argument === "--repair") {
      repair = true;
    } else if (action === "setup" && argument === "--client") {
      client = argumentsToParse[index + 1];
      if (!client) throw new CliError("--client requires a client name.");
      index += 1;
    } else if (action === "setup" && argument.startsWith("--client=")) {
      client = argument.slice("--client=".length);
      if (!client) throw new CliError("--client requires a client name.");
    } else {
      throw new CliError(`Unknown argument: ${argument}. Run ikuna-mcp --help for usage.`);
    }
  }

  if (client && !knownClientIDs().includes(client)) {
    throw new CliError(`Unknown client '${client}'. Expected one of: ${knownClientIDs().join(", ")}.`);
  }
  return { action, appPath, client, repair };
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

const CONFIRMED_FIELD = "confirmed";

// Ikuna builds every scoped read tool with a `confirmed` property but omits the
// JSON Schema `required` key when the required list is empty. A strict MCP
// client reads "properties present, no required" as "every property is
// required" and rejects a valid read call (for example get_activity_range with
// no confirmed) before it reaches Ikuna. Repair the advertised schema so the
// optional confirmation field stays optional. Returns true when it changed the
// message in place.
export function normalizeToolListMessage(message) {
  const tools = message && message.result && message.result.tools;
  if (!Array.isArray(tools)) return false;

  let changed = false;
  for (const tool of tools) {
    // Mutations deliberately require confirmed. The native app marks read tools
    // with this MCP annotation, so only normalize the legacy read surface.
    if (tool?.annotations?.readOnlyHint !== true) continue;
    const schema = tool && tool.inputSchema;
    if (!schema || typeof schema !== "object") continue;
    const properties = schema.properties;
    if (!properties || typeof properties !== "object") continue;

    if (!Array.isArray(schema.required)) {
      schema.required = [];
      changed = true;
    } else if (schema.required.includes(CONFIRMED_FIELD)) {
      schema.required = schema.required.filter((name) => name !== CONFIRMED_FIELD);
      changed = true;
    }

    const confirmed = properties[CONFIRMED_FIELD];
    if (confirmed && typeof confirmed === "object" && "default" in confirmed) {
      delete confirmed.default;
      changed = true;
    }
  }
  return changed;
}

// Ikuna speaks newline-delimited JSON-RPC on stdout. This reads the stream line
// by line, repairs any tools/list result, and forwards every other byte
// untouched. Any line that is not JSON we can parse is passed through verbatim.
export function createStdoutSchemaNormalizer(write) {
  let buffer = "";

  const handleLine = (line) => {
    let output = line;
    if (line.length > 0) {
      try {
        const message = JSON.parse(line);
        if (message && typeof message === "object" && normalizeToolListMessage(message)) {
          output = JSON.stringify(message);
        }
      } catch {
        // Not parseable JSON; forward the original bytes untouched.
      }
    }
    write(`${output}\n`);
  };

  return {
    push(chunk) {
      buffer += chunk;
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        handleLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
      }
    },
    flush() {
      if (buffer.length > 0) {
        write(buffer);
        buffer = "";
      }
    },
  };
}

function runHelper(helperPath) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(helperPath, [], { stdio: ["inherit", "pipe", "inherit"] });
    const normalizer = createStdoutSchemaNormalizer((text) => process.stdout.write(text));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => normalizer.push(chunk));
    child.stdout.on("end", () => normalizer.flush());
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

function verifyHelper(helperPath) {
  return new Promise((resolveVerification) => {
    const child = spawn(helperPath, [], {
      env: { ...process.env, IKUNA_MCP_CLIENT_ID: "diagnostic" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const responses = new Map();
    let stderr = "";
    let settled = false;
    const lines = createInterface({ input: child.stdout });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      if (!result.ok && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      resolveVerification(result);
    };
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      finish({ ok: false, message: "Verification timed out. Open Ikuna and retry." });
    }, 10_000);
    timeout.unref();

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
    child.once("error", (error) => finish({ ok: false, message: `Could not start the Ikuna helper: ${error.message}` }));
    child.once("close", (code) => {
      if (!settled && responses.size < 4) {
        finish({ ok: false, message: `The Ikuna helper closed before verification completed${stderr.trim() ? `: ${stderr.trim()}` : ` (exit ${code})`}.` });
      }
    });
    lines.on("line", (line) => {
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        finish({ ok: false, message: "The Ikuna helper returned invalid JSON during verification." });
        return;
      }
      if (response.id !== undefined) responses.set(response.id, response);
      if (![1, 2, 3, 4].every((id) => responses.has(id))) return;
      const initialization = responses.get(1);
      const tools = responses.get(2);
      const prompts = responses.get(3);
      const health = responses.get(4);
      const healthResult = health?.result;
      const payload = healthResult?.structuredContent
        ?? (() => {
          try { return JSON.parse(healthResult?.content?.find((item) => item.type === "text")?.text ?? "null"); }
          catch { return undefined; }
        })();
      if (initialization?.error || initialization?.result?.protocolVersion !== "2025-11-25"
          || tools?.error || !Array.isArray(tools?.result?.tools)
          || prompts?.error || !Array.isArray(prompts?.result?.prompts) || health?.error
          || healthResult?.isError === true || payload?.appReachable !== true || payload?.status !== "ready") {
        finish({ ok: false, message: "Handshake failed. Review AI Connections permissions, open Ikuna, and retry." });
        return;
      }
      const toolCount = tools.result?.tools?.length ?? 0;
      const promptCount = prompts.result?.prompts?.length ?? 0;
      finish({ ok: true, message: `Handshake OK: Ikuna ready, ${toolCount} tools, ${promptCount} prompts.` });
    });

    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "ikuna-setup", version: VERSION } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "prompts/list", params: {} },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "health", arguments: {} } },
    ];
    child.stdin.end(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);
  });
}

async function verifySetup(requestedAppPath) {
  let discovery;
  try {
    discovery = await discoverApp();
  } catch (error) {
    return { ok: false, message: `${error.message} Manual step: open Ikuna and retry.` };
  }
  let appPath;
  try {
    appPath = await selectRunningApp(discovery, requestedAppPath);
  } catch (error) {
    return { ok: false, message: `${error.message} Configuration was saved; open Ikuna and rerun setup.` };
  }
  const helperPath = resolve(appPath, HELPER_RELATIVE_PATH);
  try {
    await access(helperPath, fsConstants.X_OK);
  } catch {
    return { ok: false, message: `Ikuna's MCP helper is missing at ${helperPath}. Update or reinstall Ikuna, then retry.` };
  }
  return verifyHelper(helperPath);
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

  if (parsedArguments.action === "setup") {
    return runSetup({
      onlyClient: parsedArguments.client,
      verify: () => verifySetup(parsedArguments.appPath || process.env.IKUNA_APP_PATH),
    });
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
