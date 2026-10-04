# webCoRE CLI

Use ChatGPT or the terminal to list Hubitat webCoRE pistons, inspect authorized devices, read logs, and prepare reviewed automation changes.

**[Download the latest release](https://github.com/Cruxad0/webcore-CLI/releases/latest).** Under **Assets**, choose the versioned plugin ZIP, such as `webcore-cli-v0.4.6.zip`. The optional `SHA256SUMS` file verifies the download. GitHub's **Source code** archives are repository snapshots.

## What you need

- Hubitat with webCoRE installed and OAuth access enabled.
- A computer that can reach the hub, usually on the same network or through a VPN.
- Node.js **24 or newer**. There are no npm packages to install.
- The local webCoRE execute URL and dashboard security password.

This plugin supports Hubitat-hosted webCoRE.

## Set up

### 1. Install Node.js and unzip the plugin

Get Node.js from the [official download page](https://nodejs.org/en/download/). Open a new Terminal or PowerShell window after installation:

```sh
node --version
```

Extract the plugin ZIP into a folder named `webcore-cli`.

### 2. Find your local endpoint

In Hubitat, go to **Apps → webCoRE → choose any piston → Test run piston**. Copy the **local execute URL** shown there. It looks like:

```text
http://<hub-ip>[:port]/apps/api/<app-id>/execute/:<piston-id>:?access_token=<token>
```

Copy the whole URL. It contains a secret token; enter it only in the local setup prompt.

**Cloud fallback:** `cloud.hubitat.com` routes through Hubitat Cloud rather than staying local. Use it only if local access is unavailable and you accept the setup warning.

### 3. Run setup from the plugin folder

For example, if you extracted it into Downloads:

```sh
cd ~/Downloads/webcore-cli
node server/cli.js setup
```

On Windows PowerShell, use `cd $HOME\Downloads\webcore-cli` first.

Answer **yes** to Hubitat, then enter the endpoint and password at the hidden prompts. The password is the **webCoRE dashboard security password**, sometimes called its PIN. Find or set it at **Apps → webCoRE → Settings → Security**. It is separate from your Hubitat login password.

Check the connection:

```sh
node server/cli.js status
node server/cli.js diagnose
```

### 4. Connect the plugin to your chat

Enable **webCoRE CLI** in a client that supports its local MCP server. The included `mcp.json` tells the client how to start it. Run it on the same computer and user account used for setup.

Your chat must have access to the plugin's tools; downloading the ZIP alone does not connect ChatGPT to your hub. See the [MCP connection details](docs/TECHNICAL.md#mcp-connection) if configuring a client manually.

## Ask ChatGPT

Start with **“Use webCoRE CLI”** in a connected chat. For example:

> Use webCoRE CLI to generate a numbered list of all my pistons, with their active/paused status and total count.

> Use webCoRE CLI to show my authorized devices, including capabilities, attributes, current state, supported commands, and command arguments.

Authorized devices are those selected for this webCoRE instance. They may be a subset of your Hubitat devices.

| Goal | Example prompt |
| --- | --- |
| Active pistons | Use webCoRE CLI to list my active pistons. |
| Inspect a device | Use webCoRE CLI to inspect “Kitchen Light” and show its commands and current state. |
| Analyze a piston | Analyze #7 from the list you just showed me. Recommend improvements without changing it. |
| Draft a change | Draft a change to my hallway piston so lights turn off five minutes after motion stops. Ask for missing details and show the validated diff before applying. |
| Read logs | Show recent activity for “Dryer Notification” and explain any errors. |
| Diagnose an error | Use webCoRE CLI to check the plugin/webCoRE versions and run read-only diagnostics. |

Replace example names with your own. Numbered follow-ups use the original list; a new list can have different numbering.

## Changes and checks

The plugin validates a draft against live devices and commands, shows its diff, and requires approval before applying. It checks for edits made since preparation and reads back the stored body before reporting success.

Saved code verification does **not** prove that devices worked. Running a piston requires separate authorization because it can operate real devices. There are no delete or force-save tools.

If an upload is accepted but unverified, ask the plugin to check it against the **original approved draft** without uploading again. See [read-back recovery](docs/TECHNICAL.md#read-back-recovery-v045).

## Troubleshooting

| Problem | What to do |
| --- | --- |
| “Cannot find module …/server/cli.js” | Open the extracted plugin folder before running commands. It must contain `server/cli.js`. |
| Setup or authentication fails | Run `node server/cli.js setup --debug`. Check the endpoint and webCoRE dashboard password. |
| `ERR_INVALID_TOKEN` | Run setup again locally to renew the dashboard session. |
| Missing pistons or inconsistent counts | Run `node server/cli.js diagnose`. An unavailable list is an error, not proof of zero pistons. |
| Hub unreachable | Check the local address, network or VPN. Cloud access is an explicitly confirmed fallback. |
| Chat cannot use the tools | Check the plugin/MCP connection. A prompt cannot grant local access by itself. |

After upgrading, reload the plugin connection and check the version with `status`. Debug and diagnostic output omit credentials; keep endpoint URLs, passwords and config files out of chats and public reports.

Credentials stay in your local user config: `~/.config/webcore-toolkit/config.json` on macOS/Linux, or `%USERPROFILE%\.config\webcore-toolkit\config.json` on Windows. Run `node server/cli.js logout` to remove them.

## More detail

- [Technical reference](docs/TECHNICAL.md): terminal commands, dashboard responses, language tracking, validation and upload recovery.
- [Condition-format reference](skills/webcore-automation/references/hubitat-condition-format.md): core `v0.3.114.20220203` / HE `v0.3.114.20240115_HE`, dated September 19, 2025. The plugin checks live versions and definitions; this reference is a baseline.
- Development checks: `npm test` and `npm run check`. Automated tests use mock hubs.
