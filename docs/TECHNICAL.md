# Technical reference

For installation and everyday prompts, start with the [README](../README.md).


## webCoRE version and condition reference

The bundled reference records the supplied dashboard banner: **webCoRE `v0.3.114.20220203` / HE `v0.3.114.20240115_HE` — September 19, 2025**. CLI/MCP status and diagnostics expose the connected hub's `webcore_version` and `webcore_he_version` separately from `plugin_version`. Missing live versions are `null`, rather than assumed from this banner.

[Condition-format quick reference](../skills/webcore-automation/references/hubitat-condition-format.md) documents the native compact keys, typed operands, grouping, state conditions and trigger comparisons with examples and pinned upstream sources from that date. `webcore_lookup_language` includes a machine-readable `condition_reference` alongside its live DB. ChatGPT is instructed to check the live versions and definitions before drafting conditions; a reference example must be adapted to the actual authorized devices and existing piston.

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

## Dashboard reliability

HE's dashboard load endpoint uses a per-session change-detection protocol. Within its polling window, unchanged data can produce only `{ "now": ... }`, rather than another full instance/piston list. A parseable HTTP 200 response therefore does not by itself prove that a dashboard snapshot or piston list was received.

The CLI/MCP client uses its own dashboard session and keeps a private in-memory snapshot for that exact client/configuration. Each lookup still contacts the hub. A valid timestamp-only reply confirms that session's prior snapshot is unchanged; it never means zero pistons or missing versions. `snapshot_source` distinguishes `hub_snapshot` from `hub_confirmed_unchanged`. Concurrent dashboard reads are serialized, and the MCP client is reused only while its local configuration remains identical. There are at most two dashboard session slots per client, avoiding a new hub cache entry for each tool call. Other endpoints retain their existing behavior.

A timestamp-only response without a matching snapshot triggers one read in the second session slot, then fails with `DASHBOARD_SNAPSHOT_UNAVAILABLE` if unresolved. Unknown responses fail with `DASHBOARD_RESPONSE_INVALID`. Network/authentication/invalid-response failures discard the snapshot; there is no offline fallback. Diagnostics separate `transport_ok` from dashboard `ok`, and malformed or duplicate piston records fail with `PISTON_LIST_MALFORMED` instead of a partial or zero count. If `ERR_INVALID_TOKEN` is reported, run setup locally to authenticate again; never share the endpoint or password in chat.

`status` and `diagnose` also report the running `plugin_version`, so you can confirm that the installed MCP server has received an update. Diagnostics include the upload limits. Reload the MCP/plugin connection after upgrading and confirm its reported version before retrying a previously failing draft.

## MCP connection

The plugin includes a stdio MCP server. Configure a compatible MCP client to launch Node with the server script from the plugin's root folder:

```sh
node server/index.js
```

The included `mcp.json` uses `${PLUGIN_ROOT}/server/index.js` so the path resolves relative to the installed plugin. Complete CLI setup first on the same computer and user account where the MCP server will run; the server reads that local config.

## Numbered piston selection

The MCP list tool supports `scope: "all"`, `"active"`, or `"paused"`. It returns server-numbered `entries`, a ready-to-display `display_list`, and an immutable `list_id`. The assistant must preserve that numbering. When you say “analyze #7”, it opens #7 from the original list with `webcore_select_piston` using that list's ID and the expected piston name. Refreshing the list, changing active states, or switching scopes does not change what the original #7 meant.

The tool verifies the fetched piston's exact ID and name before returning its definition. Direct `webcore_get_piston` calls now require both `id` and `expected_name`. A mismatch returns a structured error and stops analysis. The assistant must announce the selected name only after `identity_verified` is true.

Numbered lists are kept in the MCP server's memory for up to 24 hours, with at most 32 lists retained. If the server restarts or a list expires, the assistant must use the original exact ID and name if both are known, or show a new list and ask you to choose again. It cannot silently apply an old number to a new list. These list snapshots contain no credentials and are never included in release archives.

## Available operations and safety

```sh
node server/cli.js pull PISTON_ID
node server/cli.js activity PISTON_ID
node server/cli.js prepare PISTON_ID proposed.json
node server/cli.js apply PISTON_ID proposed.json --expected-hash REMOTE_HASH_FROM_PREPARE --expected-body-hash PROPOSED_BODY_HASH_FROM_PREPARE --expected-proposed-hash PROPOSED_HASH_FROM_PREPARE --confirm-apply
node server/cli.js verify PISTON_ID proposed.json --expected-name 'Exact piston name'
node server/cli.js test PISTON_ID --authorize-live-test
node server/cli.js create 'New Piston' --confirm-create
```

Preparation validates device IDs, commands, attributes, and command parameters against the current webCoRE-authorized device inventory and language database. Applying re-reads the remote piston and refuses if its hash has changed since preparation. The webCoRE dashboard does not provide an atomic compare-and-set write, so another editor could still save in the small interval between the final check and write.

Native constant/expression operands also need executable `exp` metadata. The shared CLI/MCP validator rejects missing trees, parser error markers, and malformed nodes in command parameters, comparison/timing operands, and variable initializers before upload. Errors identify JSON paths without including expression text or message values. Direct time/date/datetime constants use `c` instead. Preserve verified native trees; the plugin does not compile expression text or fully duplicate webCoRE's parser. See the [native expression examples](../skills/webcore-automation/references/hubitat-condition-format.md#native-expression-operands-and-notifications). Structural validation and stored-body verification do not establish notification delivery.

CLI and MCP applies use the same validator and upload helper. A small payload uses a single request only when the complete encoded URL, including credentials and query escaping, fits within 2,048 bytes. Larger payloads use chunks of at most 1,500 characters, reduced further to fit that same URL byte budget. webCoRE accepts at most 99 chunks; an oversized plan is rejected before it starts. Explicit HTTP 414 rejections of staging requests trigger a bounded retry with smaller chunks. The live hash is checked again immediately before `set.end` commits the staged data.

### Upload format and verified success

Prepare/apply accept either the native compact body, a `{ "meta": ..., "piston": ... }` wrapper, or the full pull response containing `data.piston`. The plugin extracts and uploads **only the body**, preserving webCoRE's native `s` statements, `v` variable declarations, `r` restrictions, `o` options, `rn`, `rop`, and `z` description. An optional native `n` requests a rename. Wrapper metadata, logs, traces, and current variable values are not uploaded. Use the body returned by webCoRE; descriptive replacements such as `statements` or `variables` are refused. A body must explicitly contain an `s` array, so an empty object or metadata-only draft cannot clear the logic silently. Preparation returns the exact body diff, `proposed_body_hash`, and section/variable counts.

`ST_SUCCESS` confirms that Hubitat accepted a request; it is insufficient to prove that the intended logic was stored. Apply reads the saved piston again, verifies its ID/name, and compares its normalized body hash with the prepared body. Fingerprint version **2** accounts for root defaults and regenerated `$` node IDs, plus upstream-documented classifications (`ct`), subscription markers (`s`), and warning arrays (`w`) only in recognized native logic positions and supported metadata forms. Actual statement arrays, commands, conditions, operands, literal objects, subscription methods, task policies, variables, restrictions, options and comments must match. Other unexpected changes fail verification instead of being silently ignored.

Only a matching read-back returns `applied: true` and `verified: true`. Use `verification.build`, `verification.active`, and `verification.body_summary` when describing the result; these come from the fresh read, rather than the upload acknowledgement. Unsupported build/active metadata is reported as `null`.

### Read-back recovery (v0.4.5)

An accepted upload is verified with up to three **read-only** checks: one immediately, then after 250 ms and 750 ms. This accommodates transient read failures or a first response that still contains the previous body. The upload is never repeated by these checks. A different piston identity stops immediately. Success requires the intended normalized body hash and exact identity; matching section/variable counts alone is insufficient.

Results and errors include `readback_attempt_count` and sanitized `readback_attempts` with codes, hashes and counts. Persistent apply mismatches include `differing_paths` (at most 32 structural paths; values are omitted and unknown field names are redacted). This helps distinguish an actual command/operand/option change from a read timing problem. Errors preserve `accepted: true`, `applied: false`, `verified: false`, and `retry_safe: false` until the intended definition is verified.

Keep the original approved draft and preparation output. Pass its `proposed_body_hash` as `--expected-body-hash` and `proposed_hash` as `--expected-proposed-hash` when applying. The body hash binds stored logic; the full payload hash also binds a requested rename and the exact approved upload fields. A changed payload produces `DRAFT_HASH_MISMATCH` before any upload. These flags are optional for compatibility with existing CLI scripts; plugin instructions tell ChatGPT to supply both. Preparation and verification report `body_fingerprint_version: 2`. Hashes from version 1 cannot be reused as version 2 hashes: review/re-prepare the original draft with the updated plugin, or use the original unmodified draft file in read-only verification.

If a later read may resolve an accepted but unverified upload, use the **original intended draft** to check it without saving again:

```sh
node server/cli.js verify PISTON_ID original-proposed.json --expected-name 'Exact piston name' --debug
```

Or provide the `proposed_body_hash` retained from the approved preparation with the same fingerprint version:

```sh
node server/cli.js verify PISTON_ID --expected-name 'Exact piston name' --expected-body-hash ORIGINAL_PROPOSED_BODY_HASH
```

The MCP equivalent is `webcore_verify_piston_update` with `id`, `expected_name`, and `expected_body_hash`. Do not use `stored_body_hash` from a failed read as the expected hash, or pull the current body and prepare that as evidence of the original draft. Those comparisons only show that the current stored definition matches itself.

Read-only verify returns `verified: true` and `persistence_verified: true` only when the intended stored definition matches. It does not claim to have performed an upload. Apply and verify explicitly return `device_execution_verified: false`: verifying saved code does not prove that lamps or other devices worked. Live testing remains a separate, explicitly authorized operation.

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
