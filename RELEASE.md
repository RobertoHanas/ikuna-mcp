# Publishing Ikuna MCP

The npm bridge and the app are released independently. The npm package contains only the launcher, public README, and registry metadata; the installed app supplies its signed native helper.

## Validate the release

From this directory:

```sh
npm test
npm pack --dry-run
```

Confirm the tarball includes the executable, its runtime source, `package.json`, `README.md`, and `server.json`. It must not include app binaries, tests, machine paths, credentials, or the rest of the macOS repository.

Keep these fields aligned for every release:

- `package.json`: `version`, `mcpName`
- `server.json`: `version`, `name`, `packages[0].version`, `packages[0].identifier`

The registry name is `io.github.RobertoHanas/ikuna-mcp`, matching the repository owner's GitHub namespace. The npm package name is `ikuna-mcp`. If the name cannot be claimed, update both manifests and every installation snippet before publishing.

With Ikuna open, exercise a local packed install with a read-only MCP client: initialize, tools/list, health, EOF. Verify both modern and legacy sessions remain independent. Also test the fixture-backed failure paths: an installed but closed app must say to open Ikuna, while a missing installation must link to `https://www.brnsft.com/ikuna`. Both must fail promptly with empty stdout. Do not quit a user's active app just to run these tests.

## Publish npm first

```sh
npm login --registry=https://registry.npmjs.org
npm publish --access public --registry=https://registry.npmjs.org
npm view ikuna-mcp version mcpName --registry=https://registry.npmjs.org
```

Complete npm's account and two-factor authentication prompts interactively. Never commit tokens. Verify `npx -y ikuna-mcp --help` from outside this repository, then run the read-only live check through the published package.

## Publish the MCP Registry listing

Install the official `mcp-publisher` CLI using the [Registry quickstart](https://modelcontextprotocol.io/registry/quickstart). In this package directory:

```sh
mcp-publisher login github
mcp-publisher publish
```

Authenticate as the GitHub owner of the `io.github.RobertoHanas` namespace. The Registry checks the published npm package's `mcpName`; npm publication must succeed first. See the official [package ownership rules](https://modelcontextprotocol.io/registry/package-types) and [authentication guide](https://modelcontextprotocol.io/registry/authentication).

Verify the entry:

```sh
curl --fail --get 'https://registry.modelcontextprotocol.io/v0.1/servers' \
  --data-urlencode 'search=io.github.RobertoHanas/ikuna-mcp'
```

Confirm the response has the exact name and release version, the npm stdio package, `npx` runtime, and the copyable client configuration under publisher-provided metadata. Registry clients may render their own installation instructions; the npm README is the linked source for the complete JSON and Codex snippets.

Record the published versions and verification result in project knowledge. Do not mark the install issue complete until both npm and the Registry listing are live.
