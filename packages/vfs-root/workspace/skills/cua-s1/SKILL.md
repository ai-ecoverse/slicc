---
name: cua-s1
description: |
  Fill a form from a document using the on-device cua-s1-forms model.
  Snapshot with playwright-cli, plan with `cua-s1`, then apply the printed
  playwright-cli lines. The model chooses fill, check, click, or skip. It
  does not type new text and it does not submit unless you allow it.
allowed-tools: bash
---

# cua-s1 — form decisions

`cua-s1` runs Cua's form model (706k parameters, a 3.3 MB graph) on the CPU. For each field it reads the field and the document's `Label: value` lines and picks one action: fill from one of those values, tick, click, or leave it alone.

The first `plan` needs the same wasm runtime as `say` and `hear`:

```bash
ipk add onnxruntime-web
```

## Look, plan, then apply

```bash
playwright-cli snapshot --tab=E9A3F --filename=/tmp/form.txt
cua-s1 plan --snapshot /tmp/form.txt --document /tmp/intake.txt --json > /tmp/plan.json
cua-s1 commands --plan /tmp/plan.json --tab E9A3F
```

Read the plan before you run the lines. `commands` prints `playwright-cli fill`, `check`, and `click`. It does not run them. After they run, snapshot again. Refs die when the page changes.

`elements` is the offline step: it turns the snapshot into the Edit, CheckBox, and Button list. Links, radios, and selects are left out. That is the set the model was trained on.

```bash
cua-s1 elements --snapshot /tmp/form.txt
```

## Confidence and submit

Decisions under `--min-confidence` (default 0.5) are dropped. A click survives only when you pass `--allow-submit`, and only on a button labelled exactly Submit or Submit Form. Leave that flag off until the plan's fills look right.

The document is one `Label: value` pair per line (`Tel: (503) 555-0142`). Other lines are ignored. `--title` overrides the snapshot's `Page Title`.

A screen with no accessibility tree is not this command's input. Use `playwright-cli snapshot` for a tab. `computer text` can feed `kev` a judgment. It does not feed cua-s1 a field list.

Weights default to Hugging Face. `--from /workspace/models/...` points at a directory from `hf download`.
