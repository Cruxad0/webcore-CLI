# Hubitat webCoRE condition format

## Version reference

The provided dashboard screenshot shows **webCoRE `v0.3.114.20220203`**, **HE `v0.3.114.20240115_HE`**, and **September 19, 2025**. The source revision for this reference is `49e94d948dd71dc63593bb37ef601bc1f70c8428`, from that date.

Before drafting conditions, call `webcore_status`: `webcore_version` comes from the connected instance's `coreVersion`, and `webcore_he_version` from `heVersion`. `plugin_version` identifies this CLI/MCP plugin. The screenshot and bundled reference do not establish a live hub's version. For missing or different values, inspect that hub's language DB and piston before selecting a format. Matching labels identify the version family; use live definitions for the connected installation.

`webcore_lookup_language` returns this reference as `condition_reference` alongside the live database. Examples contain placeholders and are fragments, not complete deployable pistons.

## Live language change check

Language lookup, preparation and application fetch the live DB again and return `language_compatibility`. The check compares core version, HE version, `dbVersion` and a SHA-256 hash of the full canonical DB with the preceding known local observation. Timestamps and response metadata are excluded. An HE installation can change language definitions while retaining the same version labels.

Inspect `reference_requires_review`, `review_reasons`, `changed_fields` and `last_detected_change`. If a change is detected, read the intended live piston's native conditions and the current comparison/operand definitions before using examples from this guide. A change in unrelated definitions does not establish that condition syntax changed; inspect the evidence. Pending warnings remain for this pinned source revision across later unchanged checks. They are not cleared by restarting the server or bumping the plugin version. Updating this reference to a newly reviewed source revision establishes a new reference assessment.

The first observation only establishes a comparison baseline. `compatibility_verified` is always false: neither a matching version label nor an unchanged hash verifies that this dated guide describes the connected engine. Unknown versions or unavailable local tracking produce a review warning. Live definitions remain authoritative. This check is advisory and does not automatically rewrite the guide, install software, or bypass the existing validation/apply safeguards.

## Native structure

Use compact JSON keys throughout the existing body: `s` statements, `v` variable declarations, `r` restrictions and `o` options. An `if` has conditions in `c`, its true branch in `s`, and its else branch in `e`. A nested group uses `t: "group"`, `c`, `o` (for example `and` or `or`) and boolean `n` for negation. Preserve the existing grouping and policies.

| Condition key | Meaning |
| --- | --- |
| `t` | `condition` for comparison nodes, including trigger comparisons |
| `lo`, `co` | Typed left operand and exact comparison identifier |
| `ro`, `ro2` | First/second typed right operands, when required |
| `to`, `to2` | Duration or time-offset operands, when required |
| `sm` | Subscription choice, commonly `auto`; preserve intent |
| `ts`, `fs` | Statements for true/false results |
| `z` | Description/comment |

The engine derives fields such as `$` IDs, `ct` classification, condition `s` subscription markers and `w` warnings. Do not invent these fields to force trigger behavior. Their meaning depends on their location; root/statement `s` is a statement array.

## Example: switch is on

Replace the placeholder with a webCoRE-authorized device that actually has the `switch` attribute and the `on` value:

```json
{
  "t": "condition",
  "lo": { "t": "p", "d": ["WEB_CORE_AUTHORIZED_DEVICE_ID"], "a": "switch", "g": "any" },
  "co": "is",
  "ro": { "t": "c", "vt": "string", "c": "on" },
  "sm": "auto",
  "ts": [],
  "fs": []
}
```

`lo.t: "p"` selects a physical attribute, `d` identifies devices, and `a` identifies the attribute. Constants use `t: "c"`, `vt` for the type and `c` for the value. A variable operand uses `t: "x"` and `x` for its name. Numeric constants use numeric values and the type required by the live attribute/comparison.

For a change event, use the live `changes_to` comparison identifier while retaining `t: "condition"`. For the live `stays` timed trigger, supply its right operand and a duration such as `"to": { "t": "c", "vt": "m", "c": 5 }`. State checks and event comparisons have different behavior even though the node shape is shared.

Read identifiers and operand requirements from `db.comparisons.conditions` and `db.comparisons.triggers`; their `p`/`t` metadata describes right-operand/time requirements. For numeric comparisons, the baseline includes `is_greater_than`; do not invent `gt`, `comparison`, `left`, `right`, or `t: "trigger"` replacements. Preserve existing sequence/timing operands such as `wd` and `wt` when editing a followed-by group.

Prepare the exact native body, review the diff, then use the guarded apply operation. Report success only after its fresh identity/body verification; this reference does not bypass those checks.

## Pinned upstream sources

- [Dashboard condition/operand editor](https://github.com/imnotbob/webCoRE/blob/49e94d948dd71dc63593bb37ef601bc1f70c8428/dashboard/js/modules/piston.module.js)
- [HE version banner and comparison database](https://github.com/imnotbob/webCoRE/blob/49e94d948dd71dc63593bb37ef601bc1f70c8428/smartapps/ady624/webcore.src/webcore.groovy)
- [Piston evaluation and subscriptions](https://github.com/imnotbob/webCoRE/blob/49e94d948dd71dc63593bb37ef601bc1f70c8428/smartapps/ady624/webcore-piston.src/webcore-piston.groovy)
