# webCoRE CLI

Use this local command-line tool and MCP plugin to inspect and maintain pistons in a Hubitat webCoRE installation. It discovers the devices webCoRE has authorized, their capabilities and state, and command argument details. It can pull, validate, compare, and update pistons, and retrieve activity logs.

This package is for Hubitat-hosted webCoRE. It does not connect to standalone webCoRE. A local Hubitat endpoint is preferred. Hubitat Cloud is supported only as an explicitly confirmed fallback.

## webCoRE version and condition reference

The bundled reference records the supplied dashboard banner: **webCoRE `v0.3.114.20220203` / HE `v0.3.114.20240115_HE` — September 19, 2025**. CLI/MCP status and diagnostics expose the connected hub's `webcore_version` and `webcore_he_version` separately from `plugin_version`. Missing live versions are `null`, rather than assumed from this banner.

[Condition-format quick reference](skills/webcore-automation/references/hubitat-condition-format.md) documents the native compact keys, typed operands, grouping, state conditions and trigger comparisons with examples and pinned upstream sources from that date. `webcore_lookup_language` includes a machine-readable `condition_reference` alongside its live DB. ChatGPT is instructed to check the live versions and definitions before drafting conditions; a reference example must be adapted to the actual authorized devices and existing piston.

### Automatic language change detection (v0.4.4)

Every language lookup, preparation and apply fetches current definitions from your hub. The plugin compares the live core version, HE version, `dbVersion`, and a SHA-256 hash of the language DB with the previous known local observation. The hash ignores object-key ordering and response timestamps; definition changes are detected even when HE version labels stay the same. It checks your connected installation on demand, without polling GitHub or installing updates.

Ask ChatGPT to run `webcore_lookup_language`, or inspect the same result from the plugin folder:

```sh
node server/cli.js language --debug
```

Lookup, prepare and apply return a `language_compatibility` report:

| Field | Meaning |
| --- | --- |
| `live` | Fresh core/HE versions, DB version and language hash; unavailable versions are `null` |
| `observation_status` | `first_observation`, `unchanged`, `changed`, or `tracking_unavailable` |
| `changed_fields` | Differences from the preceding known local versions/hash |
| `reference_requires_review`, `review_reasons` | A detected change, reference mismatch, unavailable versions, or tracking error requires inspecting the live format |
| `last_detected_change` | The retained previous/current evidence for a detected change |
| `tracking.saved`, `tracking.error_code` | Whether the comparison state was saved locally |
| `compatibility_verified` | Always `false`; version/hash agreement does not certify the dated format reference |

The first call creates a baseline, rather than proving that the guide matches your hub. A detected change flags the condition reference for review and instructs ChatGPT to inspect your intended live piston and the current definitions. Warnings remain across later unchanged calls, server restarts and plugin version bumps for the same pinned reference. A hash change may affect commands or functions without changing condition syntax. These are advisory warnings; normal device validation, remote-hash checks and saved-body verification still govern an approved apply. The bundled guide is updated only through a deliberate source review and plugin release.

Tracking is stored separately from credentials in `~/.config/webcore-toolkit/language-state/` (or the equivalent user config location; `XDG_CONFIG_HOME` is respected). Directories use mode `0700` and state files mode `0600` on systems supporting those permissions. File names are hashes of the connection location. Stored content contains only versions, hashes, timestamps, and review flags; it excludes endpoint URLs, access/session tokens, passwords, raw definitions, devices and pistons. Lookup/prepare/apply always use freshly fetched definitions, even if local tracking cannot be saved. Corrupt state produces `LANGUAGE_TRACKING_INVALID` rather than silently resetting the baseline. Do not include local config files in a release archive.

CLI and MCP processes share a brief exclusive tracking lock. `LANGUAGE_TRACKING_BUSY` means a comparison could not acquire it; retry after the other operation ends. If a process was interrupted while writing and left a `.lock` file, stop the plugin and CLI processes before removing only that leftover lock from the language-state folder. Preserve the `.json` observation file. `LANGUAGE_TRACKING_IO` indicates a local directory/file access problem; fix that access and retry. These errors flag tracking as unavailable and do not replace a valid live DB with cached definitions.

## Requirements

- A computer that can reach the Hubitat hub on the local network, or through a VPN.
- Node.js 24 LTS or newer. npm is included with Node.js; this project has no third-party runtime dependencies and does not require `npm install`.
- The webCoRE app installed on Hubitat with OAuth access enabled.
- The Hubitat webCoRE **local execute endpoint** and the webCoRE dashboard security password.

Install Node.js from the official [Node.js downloads page](https://nodejs.org/en/download/). Choose the LTS installer for your operating system (macOS, Windows, or Linux package instructions). On macOS, the official installer is a `.pkg`; on Windows, use the `.msi`. Open a new Terminal (macOS/Linux) or PowerShell (Windows) after installation and check:

```sh
node --version
npm --version
```

The Node version should be 24 or newer. If the command is not found, finish the installer and open a new terminal window.

## Download and open the plugin folder

Get the latest plugin ZIP from [GitHub Releases](https://github.com/Cruxad0/webcore-CLI/releases/latest). Versioned ZIPs and their SHA-256 checksums are also included in this repository's `releases/` folder. Download `webcore-cli-v0.4.4.zip`, then extract it into a folder named `webcore-cli` before running setup.

Download and unzip the plugin release. Open a terminal in the unzipped `webcore-cli` folder. The commands below must be run from that folder, which contains `server/cli.js`. For example, if it is in Downloads:

```sh
cd ~/Downloads/webcore-cli
ls
```

On Windows PowerShell, use `cd $HOME\Downloads\webcore-cli` and `dir`. You should see the `server` folder. Running the Node command from your home folder instead will produce a “Cannot find module” error because the script path is relative to the plugin folder.

## Find the Hubitat webCoRE endpoint

1. Open the Hubitat hub web interface from a device on the same network. You can use the hub's address from your router or the Hubitat mobile app.
2. Go to **Apps → webCoRE**.
3. Choose any piston, then choose **Test run piston**.
4. In the test result, locate the **local execute endpoint** and copy the full URL.
5. Confirm it uses your hub's local address (usually an IP address or local hostname), not `cloud.hubitat.com`.

The local URL commonly looks like:

```text
http://<hub-ip>[:port]/apps/api/<app-id>/execute/:<piston-id>:?access_token=<token>
```

The exact URL shown by Hubitat is authoritative. It contains an OAuth `access_token`; treat the whole URL as a password. Do not post it on the Hubitat forum, paste it into ChatGPT, or put it in a script, screenshot, or issue report.

### Hubitat Cloud fallback

If the hub cannot be reached locally, the test result may also show a URL on `cloud.hubitat.com`. Cloud access is not local: requests pass through Hubitat Cloud. The setup command prints a warning and asks you to confirm before it saves a cloud connection. Only proceed if you accept that. Prefer fixing local network/VPN access where possible.

## Configure the plugin

In Terminal or PowerShell, from the plugin folder:

```sh
node server/cli.js setup
```

Answer **yes** when asked whether webCoRE runs on Hubitat. Paste the full local execute endpoint at the hidden URL prompt. The terminal will not display the URL as you type.

At the password prompt, enter the **webCoRE dashboard security password**. This is sometimes called the webCoRE PIN in its interface and in the connection protocol. It is **not** your Hubitat account password, hub admin password, or web access password. In Hubitat, find or set it under **Apps → webCoRE → Settings → Security** (the dashboard security password option). The terminal hides this value too.

Setup authenticates with Hubitat and webCoRE, then stores the connection details and session token in your local user config folder. It does not add credentials to the plugin files:

- macOS/Linux: `~/.config/webcore-toolkit/config.json`
- Windows: `%USERPROFILE%\.config\webcore-toolkit\config.json`

The file is restricted to the current user on systems that support file permissions. Keep it private. To remove it later, run `node server/cli.js logout` from the plugin folder.

Check the connection and list devices:

```sh
node server/cli.js status
node server/cli.js diagnose
node server/cli.js devices
node server/cli.js pistons
```

The piston command returns an explicit `piston_count` and the records. If webCoRE returns an unrecognized piston-list shape, the CLI reports a retrieval error instead of silently treating it as zero. When the MCP returns an explicit empty list, ChatGPT is instructed to check connection status and fetch the list again before reporting that no pistons exist.

For an unexpected result or CLI/MCP mismatch, use `node server/cli.js diagnose` in the terminal or ask ChatGPT to run the read-only `webcore_diagnose` tool. It checks the dashboard response, piston-list shape/count, and authorized-device inventory; it reports HTTP status, content type, redirects, and sanitized error codes without returning endpoint URLs, tokens, piston names, or device IDs.

`status` and `diagnose` also report the running `plugin_version`, so you can confirm that the installed MCP server has received an update. Diagnostics include the upload limits. Reload the MCP/plugin connection after upgrading and confirm its reported version before retrying a previously failing draft.

## Connect an MCP client

The plugin includes a stdio MCP server. Configure a compatible MCP client to launch Node with the server script from the plugin's root folder:

```sh
node server/index.js
```

The included `mcp.json` uses `${PLUGIN_ROOT}/server/index.js` so the path resolves relative to the installed plugin. Complete CLI setup first on the same computer and user account where the MCP server will run; the server reads that local config.

### Reliable numbered piston selection

The MCP list tool supports `scope: "all"`, `"active"`, or `"paused"`. It returns server-numbered `entries`, a ready-to-display `display_list`, and an immutable `list_id`. The assistant must preserve that numbering. When you say “analyze #7”, it opens #7 from the original list with `webcore_select_piston` using that list's ID and the expected piston name. Refreshing the list, changing active states, or switching scopes does not change what the original #7 meant.

The tool verifies the fetched piston's exact ID and name before returning its definition. Direct `webcore_get_piston` calls now require both `id` and `expected_name`. A mismatch returns a structured error and stops analysis. The assistant must announce the selected name only after `identity_verified` is true.

Numbered lists are kept in the MCP server's memory for up to 24 hours, with at most 32 lists retained. If the server restarts or a list expires, the assistant must use the original exact ID and name if both are known, or show a new list and ask you to choose again. It cannot silently apply an old number to a new list. These list snapshots contain no credentials and are never included in release archives.

## Troubleshooting

### “Cannot find module …/server/cli.js”

The command was run outside the unzipped plugin folder. Change directory into `webcore-cli`, confirm that it contains a `server` folder, then rerun setup.

### “Hubitat returned a non-JSON response”

Run:

```sh
node server/cli.js setup --debug
```

The debug output reports the setup phase, HTTP status, content type, and whether a redirect occurred. It redacts the endpoint, token, and password. Hubitat webCoRE can return a JavaScript callback-wrapped response; the client supports that response format as well as JSON. If the error persists, check that you copied the local execute endpoint from **Test run piston**, the hub is reachable from this computer, and webCoRE OAuth access is enabled. You can share the debug output for help; never share the endpoint or password.

### Authentication fails

Confirm you entered the webCoRE dashboard security password under **Apps → webCoRE → Settings → Security**, not a Hubitat login password. If needed, set a new dashboard password there and retry setup.

### Hub cannot be reached locally

Confirm the computer and hub are on the same LAN or connected through a VPN that routes to the hub. Check the local address shown in the execute endpoint. If local access remains unavailable, you may choose the Hubitat Cloud fallback after reading and accepting the warning.

## Available operations and safety

```sh
node server/cli.js pull PISTON_ID
node server/cli.js activity PISTON_ID
node server/cli.js prepare PISTON_ID proposed.json
node server/cli.js apply PISTON_ID proposed.json --expected-hash HASH_FROM_PREPARE --confirm-apply
node server/cli.js test PISTON_ID --authorize-live-test
node server/cli.js create 'New Piston' --confirm-create
```

Preparation validates device IDs, commands, attributes, and command parameters against the current webCoRE-authorized device inventory and language database. Applying re-reads the remote piston and refuses if its hash has changed since preparation. The webCoRE dashboard does not provide an atomic compare-and-set write, so another editor could still save in the small interval between the final check and write.

CLI and MCP applies use the same validator and upload helper. A small payload uses a single request only when the complete encoded URL, including credentials and query escaping, fits within 2,048 bytes. Larger payloads use chunks of at most 1,500 characters, reduced further to fit that same URL byte budget. webCoRE accepts at most 99 chunks; an oversized plan is rejected before it starts. Explicit HTTP 414 rejections of staging requests trigger a bounded retry with smaller chunks. The live hash is checked again immediately before `set.end` commits the staged data.

### Upload format and verified success

Prepare/apply accept either the native compact body, a `{ "meta": ..., "piston": ... }` wrapper, or the full pull response containing `data.piston`. The plugin extracts and uploads **only the body**, preserving webCoRE's native `s` statements, `v` variable declarations, `r` restrictions, `o` options, `rn`, `rop`, and `z` description. An optional native `n` requests a rename. Wrapper metadata, logs, traces, and current variable values are not uploaded. Use the body returned by webCoRE; descriptive replacements such as `statements` or `variables` are refused. A body must explicitly contain an `s` array, so an empty object or metadata-only draft cannot clear the logic silently. Preparation returns the exact body diff, `proposed_body_hash`, and section/variable counts.

`ST_SUCCESS` confirms that Hubitat accepted a request; it is insufficient to prove that the intended logic was stored. Apply always reads the saved piston again, verifies its ID/name, and compares its normalized body hash with the prepared body. The comparison accounts for root defaults and regenerated `$` node IDs; statements, operands, variables, restrictions, options, and comments must match. Other unexpected changes fail verification instead of being silently ignored.

Only a matching read-back returns `applied: true` and `verified: true`. Use `verification.build`, `verification.active`, and `verification.body_summary` when describing the result; these come from the fresh read, rather than the upload acknowledgement. Unsupported build/active metadata is reported as `null`.

An accepted write that stores different or empty logic returns `PISTON_READBACK_MISMATCH`. A failed read returns `PISTON_READBACK_FAILED`; a malformed body or wrong identity returns `PISTON_READBACK_INVALID`. These errors mark `accepted: true`, `applied: false`, `verified: false`, and `retry_safe: false`. The live piston may already have changed. The plugin does not repeat the write or automatically restore an older body: inspect the stored definition and prepare a new, reviewable change. Error details contain hashes, counts, and request traces, rather than piston content or credentials.

The payload format follows the upstream [Hubitat webCoRE piston setup and get implementation](https://github.com/imnotbob/webCoRE/blob/hubitat-patches/smartapps/ady624/webcore-piston.src/webcore-piston.groovy).

Each apply returns a sanitized `result.upload.request_trace`; failures include `details.request_trace` with request paths, HTTP statuses, and URL byte counts. CLI users can append `--debug` to `prepare` or `apply` to see request paths and statuses in the terminal, without query values or credentials. If final commit confirmation is uncertain, read the live piston before preparing another update; do not automatically replay the write. Run one apply at a time across CLI and MCP processes because webCoRE's staging buffer is shared within a session.

A piston test may run real device actions. Use the live-test flag only after reviewing the piston and authorizing the test. The plugin provides no piston deletion, force-save, or arbitrary direct device-control operation.

## Privacy and secret handling

- Never publish your access-token URL, webCoRE dashboard password, or local config file.
- Do not include credentials in forum screenshots, logs, or bug reports.
- If a token or password is accidentally posted publicly, revoke or rotate it in Hubitat/webCoRE and configure the plugin again.
- The package contains no user credentials. Setup keeps credentials in the local config file.

## Development checks

Run these from the package folder. They use mocked responses and do not contact or change a live Hubitat hub:

```sh
npm test
npm run check
```

The package uses Node's built-in modules only; no `npm install` is needed.
