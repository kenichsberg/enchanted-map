## Why

Third-party code that lives *inside* the project directory is treated as project code. The
external-symbol boundary tests whether a resolved path escapes the root:

```ts
static isExternal(relPath) { return relPath.startsWith("../") || path.isAbsolute(relPath); }
```

A virtualenv at `<project>/.venv/` does not escape the root, so every symbol under
`site-packages/` reads as first-party and is expanded like any other call. The fixture never
caught this because typeshed sits outside the root, which is the one arrangement the check
handles.

The effect on a real repository is not subtle. `CVDLINK/data_exporter` has 12 source files
and a `.venv` holding roughly 1,200 more; `CVDLINK/stratification` has 68 against about
9,400. A flow rooted at either entry point walks into pandas and numpy internals at the first
call that touches them, and the high-level picture the map exists to give is gone.

This is a gap in the requirement added last change, not a new concern. "Outside the project
root" was the wrong test: a vendored dependency *is* outside the project, it merely sits
inside the directory.

## What Changes

- **Vendored directories are excluded from traversal.** A symbol resolving inside a vendored
  directory is recorded so the call stays visible, but is never expanded — the same treatment
  the standard library already gets.
- **A default set of vendor markers**, covering the common cases without configuration:
  `.venv`, `venv`, `env`, `site-packages`, `node_modules`, `__pycache__`, `.tox`, `.nox`,
  `vendor`. A path is vendored when any of its segments matches.
- **The set is configurable** per project, because no fixed list survives contact with every
  layout. Configuration replaces or extends the defaults explicitly rather than implicitly.
- **Vendored locations are labelled portably**, stripping the path up to and including the
  vendor marker. `.venv/lib/python3.13/site-packages/pandas/core/frame.py` becomes
  `<ext>/pandas/core/frame.py` — free of both the machine and the interpreter version, so two
  developers on different Python patch releases produce identical stored bytes.
- **No new concept in the model.** A vendored symbol is external. It reuses the existing
  `external` flag, the existing `<ext>/` labelling, and the existing view treatment, so
  nothing downstream needs to learn a second kind of not-expanded node.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `flow-analysis`: `Symbols outside the project are recorded but not expanded` broadens from
  "outside the project root" to "not part of the project's own source", covering vendored
  directories inside the root, and specifies the portable label for them.
- `flow-map`: gains a requirement for the project configuration that names vendor
  directories, alongside the existing entry-point configuration.

## Impact

**Affected code:**

- `src/analysis/extract.ts` — `isExternal` and `externalLabel` become configuration-aware.
  Both are currently `static`, and both are called from tests, so the signature change is the
  main mechanical cost.
- `src/flow/config.ts` — `ProjectConfig` gains the vendor setting and its defaults.
- `src/flow/analyze.ts` — passes the configuration through to the extractor.

**Dependencies:** none added.

**Risk:** a marker that is too eager silently hides real code. `vendor` is a plausible
directory name in a first-party tree, and a project may legitimately keep source under a
directory called `env`. The mitigation is that exclusion is visible — a vendored symbol still
appears as a node, so over-exclusion shows up as a node that stops expanding rather than as
something missing.

**Out of scope:** gitignore parsing, `pyrightconfig.json` exclude rules, per-language
conventions beyond the default marker list, and any attempt to distinguish a vendored
dependency from the standard library in the view. Both are third party and both stop
traversal; that is all a reader needs.
