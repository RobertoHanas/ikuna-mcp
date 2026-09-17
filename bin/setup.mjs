import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const SETUP_GUIDE_URL = "https://ikuna.app/guides/connect-ai-client-mcp";

const CLIENTS = [
  {
    id: "claude-desktop",
    displayName: "Claude Desktop",
    format: "json",
    configPath: (home) => join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    markers: (home) => [
      join(home, "Library", "Application Support", "Claude"),
      "/Applications/Claude.app",
      join(home, "Applications", "Claude.app"),
    ],
    restart: "Restart Claude Desktop.",
  },
  {
    id: "codex",
    displayName: "Codex",
    format: "toml",
    configPath: (home) => join(home, ".codex", "config.toml"),
    markers: (home) => [join(home, ".codex"), "/Applications/Codex.app", join(home, "Applications", "Codex.app")],
    restart: "Codex picks it up on the next session.",
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    format: "json",
    configPath: (home) => join(home, ".claude.json"),
    markers: (home) => [join(home, ".claude"), join(home, ".claude.json")],
    restart: "Restart Claude Code.",
  },
  {
    id: "cursor",
    displayName: "Cursor",
    format: "json",
    configPath: (home) => join(home, ".cursor", "mcp.json"),
    markers: (home) => [join(home, ".cursor"), "/Applications/Cursor.app", join(home, "Applications", "Cursor.app")],
    restart: "Restart Cursor.",
  },
];

const JSON_IKUNA_ENTRY = { command: "npx", args: ["-y", "ikuna-mcp"] };
const TOML_IKUNA_LINES = [
  "[mcp_servers.ikuna]",
  "command = \"npx\"",
  "args = [\"-y\", \"ikuna-mcp\"]",
  "startup_timeout_sec = 30",
];

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function knownClientIDs() {
  return CLIENTS.map((client) => client.id);
}

export async function detectClients({ homeDirectory = homedir(), onlyClient } = {}) {
  const selected = onlyClient ? CLIENTS.filter((client) => client.id === onlyClient) : CLIENTS;
  if (onlyClient && selected.length === 0) {
    throw new Error(`Unknown client '${onlyClient}'. Expected one of: ${knownClientIDs().join(", ")}.`);
  }
  return Promise.all(selected.map(async (client) => {
    const configPath = client.configPath(homeDirectory);
    const markers = client.markers(homeDirectory).filter((path) => (
      homeDirectory === homedir() || path === homeDirectory || path.startsWith(`${homeDirectory}/`)
    ));
    const installed = (await pathExists(configPath))
      || (await Promise.all(markers.map(pathExists))).some(Boolean);
    let readability = "missing";
    if (await pathExists(configPath)) {
      try {
        const contents = await readFile(configPath, "utf8");
        if (client.format === "json") validateJsonConfig(contents);
        else validateCodexConfig(contents);
        readability = "readable";
      } catch {
        readability = "unreadable";
      }
    }
    return { ...client, configPath, installed, readability };
  }));
}

function skipWhitespace(text, index) {
  while (index < text.length && /\s/u.test(text[index])) index += 1;
  return index;
}

function scanString(text, start) {
  if (text[start] !== "\"") throw new Error("Expected JSON string");
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === "\"") return index + 1;
  }
  throw new Error("Unterminated JSON string");
}

function scanValue(text, start) {
  const first = text[start];
  if (first === "\"") return scanString(text, start);
  if (first === "{" || first === "[") {
    const closing = first === "{" ? "}" : "]";
    let depth = 1;
    let index = start + 1;
    while (index < text.length) {
      if (text[index] === "\"") index = scanString(text, index);
      else {
        if (text[index] === first) depth += 1;
        else if (text[index] === closing) depth -= 1;
        index += 1;
        if (depth === 0) return index;
      }
    }
    throw new Error("Unterminated JSON container");
  }
  let index = start;
  while (index < text.length && !/[\s,}\]]/u.test(text[index])) index += 1;
  return index;
}

function objectShape(text, objectStart) {
  if (text[objectStart] !== "{") throw new Error("Expected JSON object");
  const members = [];
  let index = skipWhitespace(text, objectStart + 1);
  while (index < text.length && text[index] !== "}") {
    const propertyStart = index;
    const keyEnd = scanString(text, index);
    const key = JSON.parse(text.slice(index, keyEnd));
    index = skipWhitespace(text, keyEnd);
    if (text[index] !== ":") throw new Error("Expected JSON colon");
    const valueStart = skipWhitespace(text, index + 1);
    const valueEnd = scanValue(text, valueStart);
    members.push({ key, propertyStart, valueStart, valueEnd });
    index = skipWhitespace(text, valueEnd);
    if (text[index] === ",") index = skipWhitespace(text, index + 1);
    else if (text[index] !== "}") throw new Error("Expected JSON comma or object end");
  }
  if (text[index] !== "}") throw new Error("Unterminated JSON object");
  return { members, closingBrace: index };
}

function lineIndentAt(text, index) {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return text.slice(lineStart, index).match(/^\s*/u)?.[0] ?? "";
}

function insertObjectMember(text, shape, key, value) {
  const parentIndent = lineIndentAt(text, shape.closingBrace);
  const indentUnit = text.includes("\t") ? "\t" : "  ";
  const childIndent = parentIndent + indentUnit;
  const rendered = `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  if (shape.members.length === 0) {
    return `${text.slice(0, shape.closingBrace)}\n${childIndent}${rendered}\n${parentIndent}${text.slice(shape.closingBrace)}`;
  }
  return `${text.slice(0, shape.closingBrace).replace(/\s*$/u, "")}\n${childIndent},${rendered}\n${parentIndent}${text.slice(shape.closingBrace)}`
    .replace(`\n${childIndent},`, `,\n${childIndent}`);
}

export function mergeJsonConfig(contents) {
  const parsed = validateJsonConfig(contents);
  const rootStart = skipWhitespace(contents, 0);
  const root = objectShape(contents, rootStart);
  const serverMembers = root.members.filter((member) => member.key === "mcpServers");
  if (serverMembers.length > 1) throw new Error("The configuration contains duplicate mcpServers keys.");
  const serversMember = serverMembers[0];
  if (!serversMember) {
    return insertObjectMember(contents, root, "mcpServers", { ikuna: JSON_IKUNA_ENTRY });
  }
  if (!parsed.mcpServers || Array.isArray(parsed.mcpServers) || typeof parsed.mcpServers !== "object") {
    throw new Error("mcpServers must be a JSON object.");
  }
  const serversStart = skipWhitespace(contents, serversMember.valueStart);
  const servers = objectShape(contents, serversStart);
  const ikunaMembers = servers.members.filter((member) => member.key === "ikuna");
  if (ikunaMembers.length > 1) throw new Error("mcpServers contains duplicate ikuna keys.");
  const ikunaMember = ikunaMembers[0];
  if (!ikunaMember) return insertObjectMember(contents, servers, "ikuna", JSON_IKUNA_ENTRY);
  const current = JSON.stringify(parsed.mcpServers.ikuna);
  const desired = JSON.stringify(JSON_IKUNA_ENTRY);
  if (current === desired) return contents;
  return `${contents.slice(0, ikunaMember.valueStart)}${desired}${contents.slice(ikunaMember.valueEnd)}`;
}

function validateJsonConfig(contents) {
  const parsed = JSON.parse(contents);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("The configuration root must be a JSON object.");
  }
  if (parsed.mcpServers !== undefined
      && (!parsed.mcpServers || Array.isArray(parsed.mcpServers) || typeof parsed.mcpServers !== "object")) {
    throw new Error("mcpServers must be a JSON object.");
  }
  const root = objectShape(contents, skipWhitespace(contents, 0));
  const serverMembers = root.members.filter((member) => member.key === "mcpServers");
  if (serverMembers.length > 1) throw new Error("The configuration contains duplicate mcpServers keys.");
  if (serverMembers.length === 1) {
    const servers = objectShape(contents, skipWhitespace(contents, serverMembers[0].valueStart));
    if (servers.members.filter((member) => member.key === "ikuna").length > 1) {
      throw new Error("mcpServers contains duplicate ikuna keys.");
    }
  }
  return parsed;
}

function codexSectionRange(contents) {
  const lines = contents.split("\n");
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === "[mcp_servers.ikuna]") starts.push(index);
  }
  if (starts.length > 1) throw new Error("Codex contains more than one [mcp_servers.ikuna] section.");
  if (starts.length === 0) return { lines, start: -1, end: -1 };
  const start = starts[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[.+\]\s*(?:#.*)?$/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { lines, start, end };
}

function validateCodexConfig(contents) {
  codexSectionRange(contents);
  let quoteCount = 0;
  let escaped = false;
  for (const character of contents) {
    if (character === "\"" && !escaped) quoteCount += 1;
    escaped = character === "\\" ? !escaped : false;
  }
  if (quoteCount % 2 !== 0) throw new Error("Codex configuration contains an unterminated string.");
}

export function mergeCodexConfig(contents) {
  validateCodexConfig(contents);
  const { lines, start, end } = codexSectionRange(contents);
  if (start === -1) {
    const separator = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
    return `${contents}${separator}${TOML_IKUNA_LINES.join("\n")}\n`;
  }
  const replacements = new Map([
    ["command", "command = \"npx\""],
    ["args", "args = [\"-y\", \"ikuna-mcp\"]"],
    ["startup_timeout_sec", "startup_timeout_sec = 30"],
  ]);
  const found = new Set();
  const section = lines.slice(start, end).map((line) => {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/u);
    if (!match || !replacements.has(match[1])) return line;
    if (found.has(match[1])) throw new Error(`Codex contains duplicate ${match[1]} values in the Ikuna section.`);
    found.add(match[1]);
    return replacements.get(match[1]);
  });
  for (const key of ["command", "args", "startup_timeout_sec"]) {
    if (!found.has(key)) section.push(replacements.get(key));
  }
  const updatedLines = [...lines.slice(0, start), ...section, ...lines.slice(end)];
  return updatedLines.join("\n");
}

function timestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

async function backupNames(configPath) {
  const directory = dirname(configPath);
  const prefix = `${basename(configPath)}.bak-`;
  try {
    return (await readdir(directory)).filter((name) => name.startsWith(prefix)).sort().reverse();
  } catch {
    return [];
  }
}

async function newestValidBackup(client) {
  const configPath = client.configPath;
  for (const name of await backupNames(configPath)) {
    const path = join(dirname(configPath), name);
    try {
      const contents = await readFile(path, "utf8");
      if (client.format === "json") validateJsonConfig(contents);
      else validateCodexConfig(contents);
      return { path, contents };
    } catch {}
  }
  return undefined;
}

async function backUp(configPath) {
  if (!(await pathExists(configPath))) return undefined;
  const backupBase = `${configPath}.bak-${timestamp()}`;
  let backupPath = backupBase;
  for (let suffix = 2; await pathExists(backupPath); suffix += 1) {
    backupPath = `${backupBase}-${String(suffix).padStart(2, "0")}`;
  }
  await copyFile(configPath, backupPath, fsConstants.COPYFILE_EXCL);
  const names = await backupNames(configPath);
  for (const name of names.slice(3)) await unlink(join(dirname(configPath), name));
  return backupPath;
}

async function atomicWrite(configPath, contents) {
  await mkdir(dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.ikuna-${process.pid}.tmp`;
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, configPath);
}

async function configureClient(client) {
  let existing;
  let recoveredFrom;
  if (await pathExists(client.configPath)) {
    existing = await readFile(client.configPath, "utf8");
  }
  let base = existing;
  let repairReason;
  try {
    if (base !== undefined) {
      if (client.format === "json") validateJsonConfig(base);
      else validateCodexConfig(base);
    }
  } catch {
    repairReason = "unreadable configuration";
    const recovered = await newestValidBackup(client);
    base = recovered?.contents ?? (client.format === "json" ? "{}\n" : "");
    recoveredFrom = recovered?.path;
  }
  base ??= client.format === "json" ? "{}\n" : "";
  const updated = client.format === "json" ? mergeJsonConfig(base) : mergeCodexConfig(base);
  if (existing === updated && !repairReason) {
    return { outcome: "already correct", backupPath: undefined };
  }
  const backupPath = await backUp(client.configPath);
  await atomicWrite(client.configPath, updated);
  const outcome = repairReason
    ? `repaired ${repairReason}${recoveredFrom ? ` from ${recoveredFrom}` : " with a minimal valid configuration"}`
    : existing === undefined ? "added ikuna-mcp" : "updated ikuna-mcp";
  return { outcome, backupPath };
}

function displayPath(path, homeDirectory) {
  return path.startsWith(`${homeDirectory}/`) ? `~/${path.slice(homeDirectory.length + 1)}` : path;
}

export async function runSetup({
  onlyClient,
  homeDirectory = process.env.IKUNA_MCP_HOME || homedir(),
  verify,
  output = process.stdout,
} = {}) {
  const clients = await detectClients({ homeDirectory, onlyClient });
  const installed = clients.filter((client) => client.installed);
  if (installed.length === 0) {
    for (const client of clients) output.write(`- ${client.id} — not installed (${displayPath(client.configPath, homeDirectory)})\n`);
    output.write("Summary: no supported MCP clients were detected; no configuration was changed.\n");
    return 2;
  }

  const results = [];
  for (const client of clients) {
    if (!client.installed) {
      output.write(`- ${client.id} — not installed (${displayPath(client.configPath, homeDirectory)})\n`);
      continue;
    }
    try {
      const configured = await configureClient(client);
      results.push({ client, configured });
    } catch (error) {
      results.push({ client, error: error instanceof Error ? error.message : String(error) });
    }
  }

  let verification;
  if (results.some((result) => !result.error)) {
    try {
      verification = await verify();
    } catch (error) {
      verification = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  for (const result of results) {
    const path = displayPath(result.client.configPath, homeDirectory);
    if (result.error) {
      output.write(`✘ ${result.client.id} — detected, no config written at ${path}: ${result.error}. Manual steps: see ${SETUP_GUIDE_URL}.\n`);
      continue;
    }
    const backup = result.configured.backupPath ? ` (backup: ${displayPath(result.configured.backupPath, homeDirectory)})` : "";
    const mark = verification?.ok ? "✔" : "✘";
    output.write(`${mark} ${result.client.id} — ${result.configured.outcome} at ${path}${backup}. ${result.client.restart} ${verification.message}\n`);
  }

  const configuredCount = results.filter((result) => !result.error).length;
  const failedCount = results.length - configuredCount;
  if (configuredCount === 0) {
    output.write(`Summary: no client could be configured; ${failedCount} require manual repair.\n`);
    return 2;
  }
  if (!verification?.ok || failedCount > 0) {
    output.write(`Summary: ${configuredCount} configured, but setup needs ${failedCount + (verification?.ok ? 0 : 1)} manual step(s).\n`);
    return 1;
  }
  output.write(`Summary: ${configuredCount} detected client(s) configured and verified.\n`);
  return 0;
}
