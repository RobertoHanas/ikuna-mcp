import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { mergeCodexConfig, mergeJsonConfig, runSetup } from "../bin/setup.mjs";

function capture() {
  let value = "";
  return {
    output: { write(chunk) { value += chunk; } },
    value() { return value; },
  };
}

async function installedClients() {
  const homeDirectory = await mkdtemp(join(tmpdir(), "ikuna-mcp-setup-"));
  await mkdir(join(homeDirectory, ".codex"), { recursive: true });
  await mkdir(join(homeDirectory, "Library", "Application Support", "Claude"), { recursive: true });
  return {
    homeDirectory,
    codexConfig: join(homeDirectory, ".codex", "config.toml"),
    claudeConfig: join(homeDirectory, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
  };
}

test("JSON merge preserves unrelated server bytes and is idempotent", () => {
  const original = `{
  "theme": "dark",
  "mcpServers": {
    "alpha": { "command": "alpha", "args": ["--one"] },
    "beta": {
      "command": "/custom/beta",
      "env": { "TOKEN": "kept" }
    },
    "gamma": {"command":"gamma"}
  }
}
`;
  const snippets = [
    '"alpha": { "command": "alpha", "args": ["--one"] }',
    '"beta": {\n      "command": "/custom/beta",\n      "env": { "TOKEN": "kept" }\n    }',
    '"gamma": {"command":"gamma"}',
  ];
  const updated = mergeJsonConfig(original);
  for (const snippet of snippets) assert.ok(updated.includes(snippet));
  assert.deepEqual(JSON.parse(updated).mcpServers.ikuna, { command: "npx", args: ["-y", "ikuna-mcp"] });
  assert.equal(mergeJsonConfig(updated), updated);
});

test("Codex merge repairs owned values without changing unrelated TOML", () => {
  const original = `# user comment
[features]
search = true

[mcp_servers.ikuna]
command = "/stale/Ikuna.app/Contents/bin/ikuna-mcp"
args = []
enabled = true # user-owned

[mcp_servers.other]
command = "other"
`;
  const updated = mergeCodexConfig(original);
  assert.ok(updated.includes("# user comment\n[features]\nsearch = true"));
  assert.ok(updated.includes("enabled = true # user-owned"));
  assert.ok(updated.includes('[mcp_servers.other]\ncommand = "other"'));
  assert.ok(updated.includes('command = "npx"'));
  assert.ok(updated.includes('args = ["-y", "ikuna-mcp"]'));
  assert.ok(updated.includes("startup_timeout_sec = 30"));
  assert.equal(mergeCodexConfig(updated), updated);
});

test("clean setup configures detected clients without backups and reruns idempotently", async () => {
  const { homeDirectory, codexConfig, claudeConfig } = await installedClients();
  const first = capture();
  const verify = async () => ({ ok: true, message: "Handshake OK: Ikuna ready, 16 tools, 5 prompts." });
  assert.equal(await runSetup({ homeDirectory, verify, output: first.output }), 0);
  assert.match(first.value(), /claude-desktop — added ikuna-mcp/u);
  assert.match(first.value(), /codex — added ikuna-mcp/u);
  assert.match(await readFile(codexConfig, "utf8"), /startup_timeout_sec = 30/u);
  assert.deepEqual(JSON.parse(await readFile(claudeConfig, "utf8")).mcpServers.ikuna, {
    command: "npx",
    args: ["-y", "ikuna-mcp"],
  });
  assert.equal((await readdir(join(homeDirectory, ".codex"))).filter((name) => name.includes(".bak-")).length, 0);

  const second = capture();
  assert.equal(await runSetup({ homeDirectory, verify, output: second.output }), 0);
  assert.match(second.value(), /claude-desktop — already correct/u);
  assert.match(second.value(), /codex — already correct/u);
  assert.equal((await readdir(join(homeDirectory, ".codex"))).filter((name) => name.includes(".bak-")).length, 0);
});

test("repair restores Codex timeout and recovers corrupt JSON while preserving it as a backup", async () => {
  const { homeDirectory, codexConfig, claudeConfig } = await installedClients();
  const verify = async () => ({ ok: true, message: "Handshake OK." });
  await runSetup({ homeDirectory, verify, output: capture().output });

  const codexWithoutTimeout = (await readFile(codexConfig, "utf8"))
    .replace("startup_timeout_sec = 30\n", "");
  await writeFile(codexConfig, codexWithoutTimeout);
  await writeFile(`${claudeConfig}.bak-20260916T120000Z`, JSON.stringify({
    mcpServers: { other: { command: "/kept/server" } },
  }, null, 2));
  await writeFile(claudeConfig, "{ corrupt JSON\n");

  const repaired = capture();
  assert.equal(await runSetup({ homeDirectory, verify, output: repaired.output }), 0);
  assert.match(await readFile(codexConfig, "utf8"), /startup_timeout_sec = 30/u);
  const repairedClaude = JSON.parse(await readFile(claudeConfig, "utf8"));
  assert.deepEqual(repairedClaude.mcpServers.ikuna, {
    command: "npx",
    args: ["-y", "ikuna-mcp"],
  });
  assert.deepEqual(repairedClaude.mcpServers.other, { command: "/kept/server" });
  assert.match(repaired.value(), /repaired unreadable configuration/u);
  assert.match(repaired.value(), /from .*\.bak-20260916T120000Z/u);
  const claudeFiles = await readdir(join(homeDirectory, "Library", "Application Support", "Claude"));
  const backups = claudeFiles.filter((name) => name.startsWith("claude_desktop_config.json.bak-"));
  const backupContents = await Promise.all(backups.map((name) => (
    readFile(join(homeDirectory, "Library", "Application Support", "Claude", name), "utf8")
  )));
  assert.ok(backupContents.includes("{ corrupt JSON\n"));
});

test("setup retains only the three newest backups", async () => {
  const { homeDirectory, codexConfig } = await installedClients();
  const verify = async () => ({ ok: true, message: "Handshake OK." });
  await runSetup({ homeDirectory, onlyClient: "codex", verify, output: capture().output });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const damaged = (await readFile(codexConfig, "utf8")).replace("startup_timeout_sec = 30", `startup_timeout_sec = ${attempt}`);
    await writeFile(codexConfig, damaged);
    await runSetup({ homeDirectory, onlyClient: "codex", verify, output: capture().output });
  }
  const backups = (await readdir(join(homeDirectory, ".codex")))
    .filter((name) => name.startsWith("config.toml.bak-"));
  assert.equal(backups.length, 3);
});

test("setup writes config but exits one when live verification fails", async () => {
  const { homeDirectory, codexConfig } = await installedClients();
  const captured = capture();
  const code = await runSetup({
    homeDirectory,
    verify: async () => ({ ok: false, message: "Ikuna is installed but not running. Open Ikuna and retry." }),
    output: captured.output,
  });
  assert.equal(code, 1);
  assert.match(await readFile(codexConfig, "utf8"), /ikuna-mcp/u);
  assert.match(captured.value(), /Open Ikuna/u);
  assert.match(captured.value(), /Summary: 2 configured/u);
});

test("scoped setup reports exit two when the requested client is not installed", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "ikuna-mcp-empty-"));
  const captured = capture();
  const code = await runSetup({
    homeDirectory,
    onlyClient: "cursor",
    verify: async () => ({ ok: true, message: "Handshake OK." }),
    output: captured.output,
  });
  assert.equal(code, 2);
  assert.match(captured.value(), /cursor — not installed/u);
  assert.match(captured.value(), /no supported MCP clients were detected/u);
});
