import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createStdoutSchemaNormalizer, normalizeToolListMessage } from "../bin/ikuna-mcp.mjs";

const cliPath = fileURLToPath(new URL("../bin/ikuna-mcp.mjs", import.meta.url));

// A tools/list result shaped like the one Ikuna's scoped read tools publish:
// a `confirmed` property, `additionalProperties: false`, and no `required` key.
function readToolsListResult() {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      tools: [
        {
          name: "get_activity_range",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: { confirmed: { type: "boolean", default: false } },
          },
        },
        {
          name: "get_sessions",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              limit: { type: "integer" },
              confirmed: { type: "boolean", default: false },
            },
          },
        },
      ],
    },
  };
}

async function fixture({ running = true, installed = true, staleInstalledPath = false, helper = true, discoveryDelayMs = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ikuna-mcp-test-"));
  const appPath = join(root, "Ikuna.app");
  const helperPath = join(appPath, "Contents", "bin", "ikuna-mcp");
  const installedPath = staleInstalledPath ? join(root, "Deleted Ikuna.app") : appPath;
  const osascriptPath = join(root, "osascript");
  await mkdir(join(appPath, "Contents", "bin"), { recursive: true });

  const discovery = discoveryDelayMs > 0
    ? `#!/usr/bin/env node\nsetTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify({ runningPaths: [appPath], installedPath: appPath }))}), ${discoveryDelayMs});\n`
    : `#!/bin/sh\nprintf '%s' '${JSON.stringify({ runningPaths: running ? [appPath] : [], installedPath: installed ? installedPath : null })}'\n`;
  await writeFile(osascriptPath, discovery, { mode: 0o755 });

  if (helper) {
    await writeFile(helperPath, "#!/bin/sh\nwhile IFS= read -r line; do printf '%s\\n' \"$line\"; done\n", { mode: 0o755 });
    await chmod(helperPath, 0o755);
  }
  return { root, appPath, osascriptPath };
}

function runCli({ input = "", args = [], env = {} } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 7_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) reject(new Error("ikuna-mcp test subprocess exceeded 7000 ms"));
      else resolveRun({ code, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function waitForChild(child, timeoutMs = 3_000) {
  return new Promise((resolveExit, reject) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) reject(new Error(`child did not exit within ${timeoutMs} ms`));
      else resolveExit({ code, signal });
    });
  });
}

test("advertises read-tool confirmation fields as optional in tools/list", () => {
  const message = readToolsListResult();
  assert.equal(normalizeToolListMessage(message), true);

  for (const tool of message.result.tools) {
    assert.deepEqual(
      tool.inputSchema.required,
      [],
      `${tool.name} must advertise an explicit empty required array`,
    );
    assert.equal(
      "default" in tool.inputSchema.properties.confirmed,
      false,
      `${tool.name} must drop the confirmed default`,
    );
  }
});

test("leaves mutation confirmation requirements intact", () => {
  const message = {
    result: {
      tools: [
        {
          name: "start_focus_session",
          inputSchema: {
            type: "object",
            required: ["target", "confirmed"],
            properties: { target: { type: "string" }, confirmed: { type: "boolean" } },
          },
        },
      ],
    },
  };

  assert.equal(normalizeToolListMessage(message), false);
  assert.deepEqual(message.result.tools[0].inputSchema.required, ["target", "confirmed"]);
});

test("leaves already-correct schemas and non-tools messages untouched", () => {
  const correct = {
    result: {
      tools: [
        {
          name: "get_recent_activity",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", required: [], properties: { confirmed: { type: "boolean" } } },
        },
      ],
    },
  };
  assert.equal(normalizeToolListMessage(correct), false);
  assert.equal(normalizeToolListMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }), false);
  assert.equal(normalizeToolListMessage({ result: { ok: true } }), false);
});

test("repairs a tools/list response split across stdout chunks and forwards other lines", () => {
  let output = "";
  const normalizer = createStdoutSchemaNormalizer((text) => { output += text; });
  const responseLine = JSON.stringify(readToolsListResult());

  normalizer.push('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  normalizer.push(responseLine.slice(0, 24));
  normalizer.push(`${responseLine.slice(24)}\nnot json\n`);
  normalizer.flush();

  const lines = output.split("\n");
  assert.equal(lines[0], '{"jsonrpc":"2.0","id":1,"method":"initialize"}');
  const repaired = JSON.parse(lines[1]);
  for (const tool of repaired.result.tools) {
    assert.deepEqual(tool.inputSchema.required, []);
    assert.equal("default" in tool.inputSchema.properties.confirmed, false);
  }
  assert.equal(lines[2], "not json");
});

test("proxies stdin and stdout through the bundled native helper", async () => {
  const { osascriptPath } = await fixture();
  const request = '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n';
  const result = await runCli({ input: request, env: { IKUNA_MCP_TEST_OSASCRIPT: osascriptPath } });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, request);
  assert.equal(result.stderr, "");
});

test("runs through the symlink shape used by an npm .bin entry", async () => {
  const { root, osascriptPath } = await fixture();
  const linkedCliPath = join(root, "ikuna-mcp");
  await symlink(cliPath, linkedCliPath);
  const request = '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n';
  const result = await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [linkedCliPath], {
      env: { ...process.env, NODE_ENV: "test", IKUNA_MCP_TEST_OSASCRIPT: osascriptPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 3_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveRun({ code, stdout, stderr });
    });
    child.stdin.end(request);
  });

  assert.deepEqual(result, { code: 0, stdout: request, stderr: "" });
});

test("handles help and version locally without app discovery", async () => {
  const badDiscovery = join(tmpdir(), "ikuna-mcp-discovery-must-not-run");
  const help = await runCli({ args: ["--help"], env: { IKUNA_MCP_TEST_OSASCRIPT: badDiscovery } });
  const version = await runCli({ args: ["--version"], env: { IKUNA_MCP_TEST_OSASCRIPT: badDiscovery } });

  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: ikuna-mcp/u);
  assert.equal(help.stderr, "");
  assert.equal(version.code, 0);
  const packageVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
  assert.equal(version.stdout, `${packageVersion}\n`);
  assert.equal(version.stderr, "");
});

test("rejects unknown arguments instead of passing them to the stdio helper", async () => {
  const result = await runCli({ args: ["--unknown"] });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unknown argument: --unknown/u);
});

test("tells the user to open Ikuna when it is installed but not running", async () => {
  const { osascriptPath } = await fixture({ running: false });
  const startedAt = Date.now();
  const result = await runCli({ env: { IKUNA_MCP_TEST_OSASCRIPT: osascriptPath } });

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /installed but not running/u);
  assert.match(result.stderr, /Open Ikuna/u);
  assert.ok(Date.now() - startedAt < 1_500);
});

test("links to the product page when Ikuna is not installed", async () => {
  const { osascriptPath } = await fixture({ running: false, installed: false });
  const result = await runCli({ env: { IKUNA_MCP_TEST_OSASCRIPT: osascriptPath } });

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Ikuna is not installed/u);
  assert.match(result.stderr, /https:\/\/www\.brnsft\.com\/ikuna/u);
});

test("treats a stale LaunchServices app path as not installed", async () => {
  const { osascriptPath } = await fixture({ running: false, staleInstalledPath: true });
  const result = await runCli({ env: { IKUNA_MCP_TEST_OSASCRIPT: osascriptPath } });

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Ikuna is not installed/u);
  assert.match(result.stderr, /https:\/\/www\.brnsft\.com\/ikuna/u);
});

test("requires an explicitly selected app bundle to be running", async () => {
  const { root, osascriptPath } = await fixture();
  const requestedPath = join(root, "Other Ikuna.app");
  const result = await runCli({
    args: ["--app-path", requestedPath],
    env: { IKUNA_MCP_TEST_OSASCRIPT: osascriptPath },
  });

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Start that copy of Ikuna first/u);
});

test("rejects multiple running copies even when an app path is selected", async () => {
  const { root, appPath, osascriptPath } = await fixture();
  const secondAppPath = join(root, "Second Ikuna.app");
  await writeFile(osascriptPath, `#!/bin/sh
printf '%s' '${JSON.stringify({ runningPaths: [appPath, secondAppPath], installedPath: appPath })}'
`, { mode: 0o755 });
  const result = await runCli({ env: { IKUNA_MCP_TEST_OSASCRIPT: osascriptPath } });

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Multiple copies of Ikuna are running/u);
  assert.match(result.stderr, /Quit extra copies of Ikuna/u);

  const selectedResult = await runCli({
    args: ["--app-path", appPath],
    env: { IKUNA_MCP_TEST_OSASCRIPT: osascriptPath },
  });
  assert.equal(selectedResult.code, 1);
  assert.equal(selectedResult.stdout, "");
  assert.match(selectedResult.stderr, /Quit extra copies of Ikuna/u);
});

test("reports a missing native helper without writing to stdout", async () => {
  const { osascriptPath } = await fixture({ helper: false });
  const result = await runCli({ env: { IKUNA_MCP_TEST_OSASCRIPT: osascriptPath } });

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /missing or not executable/u);
});

test("kills a stuck app discovery process at the bounded timeout", async () => {
  const { osascriptPath } = await fixture({ discoveryDelayMs: 5_000 });
  const startedAt = Date.now();
  const result = await runCli({ env: { IKUNA_MCP_TEST_OSASCRIPT: osascriptPath } });

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Timed out while checking for Ikuna/u);
  assert.ok(Date.now() - startedAt < 3_500);
});

test("forwards termination signals to the native helper", async () => {
  const { root, appPath, osascriptPath } = await fixture();
  const markerPath = join(root, "helper-state");
  const helperPath = join(appPath, "Contents", "bin", "ikuna-mcp");
  await writeFile(helperPath, `#!/bin/sh
printf started > "$IKUNA_TEST_MARKER"
trap 'printf terminated > "$IKUNA_TEST_MARKER"; exit 0' TERM INT HUP
while IFS= read -r line; do printf '%s\\n' "$line"; done
`, { mode: 0o755 });

  const child = spawn(process.execPath, [cliPath], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      IKUNA_MCP_TEST_OSASCRIPT: osascriptPath,
      IKUNA_TEST_MARKER: markerPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if (await readFile(markerPath, "utf8") === "started") break;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.equal(await readFile(markerPath, "utf8"), "started");

  child.kill("SIGTERM");
  const exit = await waitForChild(child);
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(await readFile(markerPath, "utf8"), "terminated");
});

test("kills a native helper that ignores a forwarded termination signal", async () => {
  const { root, appPath, osascriptPath } = await fixture();
  const markerPath = join(root, "helper-started");
  const helperPath = join(appPath, "Contents", "bin", "ikuna-mcp");
  await writeFile(helperPath, `#!/bin/sh
printf started > "$IKUNA_TEST_MARKER"
trap '' TERM
while IFS= read -r line; do :; done
`, { mode: 0o755 });

  const child = spawn(process.execPath, [cliPath], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      IKUNA_MCP_TEST_OSASCRIPT: osascriptPath,
      IKUNA_TEST_MARKER: markerPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if (await readFile(markerPath, "utf8") === "started") break;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }

  const startedAt = Date.now();
  child.kill("SIGTERM");
  const exit = await waitForChild(child);
  assert.deepEqual(exit, { code: 137, signal: null });
  assert.ok(Date.now() - startedAt < 2_000);
});
