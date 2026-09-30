## Context

The analyzer decides whether to expand a symbol by asking whether its path escapes the
project root. That test was written against typeshed, which basedpyright ships inside its own
`node_modules`, well outside any project. It answers correctly there and incorrectly for a
virtualenv, which is the ordinary Python arrangement.

Measured on a real repository:

```
CVDLINK/data_exporter     12 source files    ~1,200 under .venv
CVDLINK/stratification    68 source files    ~9,400 under .venv
```

Nothing else in the pipeline needs to change. Holes, provenance, ordering and nesting all
operate on edges; this is purely the question of which nodes get expanded.

## Goals / Non-Goals

**Goals:**

- Stop traversing into dependencies that happen to live inside the project directory.
- Keep such calls visible, so the map does not lie about what the code does.
- Label vendored locations so that two developers produce byte-identical stored flows.
- Let a project correct the default list, since no fixed list fits every layout.

**Non-Goals:**

- Reading `.gitignore`, `pyrightconfig.json` excludes, or any other existing configuration.
  Inferring intent from those is a larger problem with worse failure modes.
- Distinguishing a vendored dependency from the standard library anywhere a reader can see.
- Excluding first-party code. This change decides what is *third party*, not what is
  uninteresting; pruning by interest is the agent layer's job.

## Decisions

### D1. Vendored is a segment match, not a prefix match

A path is vendored when any of its segments equals a marker:

```
.venv/lib/python3.13/site-packages/pandas/core/frame.py
 ^^^^                ^^^^^^^^^^^^^
 both match
```

*Why segments:* a prefix test misses `libs/vendor/...` and a substring test wrongly catches
`my_venv_helpers.py`. Segment equality is the rule that matches how these directories are
actually named.

*Alternative rejected:* glob patterns. More expressive, and the expressiveness is the problem
— a glob that silently matches source is much harder to notice than a wrong directory name.

### D2. A vendored symbol is external, not a new kind

It reuses `external`, `<ext>/` labelling, the `external` list on facts, and the view's
existing handling.

*Why:* the model already has "recorded, never expanded". Introducing a parallel concept would
force every consumer — view, canvas, editor listing, identity reconciliation — to learn a
second case that behaves identically. The distinction matters to whoever configures the
markers, not to whoever reads the map.

### D3. The label strips up to and including the last marker

```
.venv/lib/python3.13/site-packages/pandas/core/frame.py  ->  <ext>/pandas/core/frame.py
node_modules/basedpyright/dist/.../builtins.pyi          ->  <ext>/basedpyright/dist/.../builtins.pyi
```

*Why the last marker and not the first:* nesting is normal — `site-packages` sits under
`.venv`. Taking the last one yields the dependency's own path, which is the useful part.

*Why it matters beyond tidiness:* flow files are committed. `python3.13` in a stored path
means a colleague on 3.12 gets a spurious diff on every vendored node. Stripping the marker
removes the interpreter version along with the machine.

### D4. Configuration replaces or extends explicitly

```yaml
vendor:
  extend: [thirdparty]     # added to the defaults
  replace: [.venv]         # used instead of the defaults
```

*Why both, and why named:* a single list is ambiguous — a reader cannot tell whether it adds
to or overrides the defaults, and either guess surprises someone. Naming the intent costs one
word and removes the question.

*Alternative rejected:* a bare list meaning "replace". It is the more dangerous default:
someone adding one project-specific directory silently loses `.venv` and `node_modules`.

### D5. `isExternal` and `externalLabel` stop being static

They currently take only a path. They become instance methods, or take the marker set
explicitly, so the extractor can apply project configuration.

*Cost, stated plainly:* both are called directly from existing tests. This is the one
mechanical ripple in the change, and it is a signature change rather than a behavioural one.

### D6. The default list is deliberately short

`.venv`, `venv`, `env`, `site-packages`, `node_modules`, `__pycache__`, `.tox`, `.nox`,
`vendor`.

*Why not longer:* every entry is a directory name that could plausibly hold first-party code,
and a marker that hides real code is a worse failure than one that lets a dependency through.
`env` and `vendor` are the two genuinely arguable entries; both are included because they are
common in practice, and both are removable per project via `replace`.

## Risks / Trade-offs

- **A marker hides first-party code** → The failure is visible rather than silent: the symbol
  still appears as a node, it simply stops expanding, and it carries an `<ext>/` label that
  looks obviously wrong for project code. A user who sees their own module labelled `<ext>/`
  knows immediately what happened, and `replace` fixes it.

- **`vendor` and `env` are plausible source directory names** → Accepted, per D6, and
  mitigated by the visibility above. If this proves annoying in practice, dropping them from
  the defaults is a one-line change that breaks nothing.

- **Stored flows change for any project with a vendored dependency** → Nodes that were
  expanded become unexpanded, so edges disappear and hashes move. That is a real diff, and
  the correct one: those edges should never have been there. Existing flows will be reported
  stale on the next check, which is the honest signal.

- **Symlinked vendor directories** → A dependency reached through a symlink canonicalises to
  wherever it really lives, which may have no marker segment at all. It would then be treated
  as project code. Out of scope here, and worth knowing about before someone reports it.

## Migration Plan

1. Marker matching and the label, with the default list, as pure functions with unit tests.
2. Wire configuration through `ProjectConfig` into the extractor.
3. Verify against `CVDLINK/data_exporter`, where the fault was found: the flow should reach
   its own modules and stop at the venv boundary.

Rollback is removing the marker list; nothing persists that cannot be regenerated.

## Measured on CVDLINK

Verified read-only against the repository where the fault was found (no `.enchanted/` was
written into it; the fact cache was redirected outside). `stratification`, entry point
`run_states.main`, depth 3:

```
                  ms   nodes  internal  external  edges
  before        4616      49        10        39    119
  after         1023      46         5        41    116
```

Files that were being counted as the project's own source, and are not:

```
.venv/lib/python3.13/site-packages/bios/base.py
.venv/lib/python3.13/site-packages/pydantic/errors.py
.venv/lib/python3.13/site-packages/pydantic/main.py
.venv/lib/python3.13/site-packages/pydantic_core/_pydantic_core.pyi
```

What remains is exactly `run_states.py` and `tools/data_io.py`.

Three things this settles:

- **The node reduction is modest; the correctness fix is not.** 49 to 46 nodes looks minor,
  but those four paths would have been written into a committed flow file complete with
  `python3.13` — a spurious diff for any colleague on a different patch release — and tracked
  by identity and staleness as though they were first-party code.
- **Analysis is ~4.5x faster** (4.6s to 1.0s), consistently across depths 3, 5 and 8.
- **The map is now stable under depth.** Before, node count drifted 49 to 50 between depths 3
  and 5; after, it is flat at 46 through depth 8. Traversal stops at the dependency boundary
  rather than wandering further into pydantic with each increment.

The default marker set was sufficient for both subprojects; neither needed `extend`.

## Open Questions

- Should a vendored node's label keep the distribution name only (`<ext>/pandas`) rather than
  the full path within the package? Fewer distinct nodes for the same library, but a loss of
  precision when two modules of one package are both called.
- Should the depth bound count a vendored node at all? It terminates traversal either way, so
  including it in `truncated` versus `external` is a reporting choice the view already
  distinguishes — but it has not been looked at with a real dependency-heavy flow.
- Does a monorepo want vendor markers declared once at the top rather than per subproject?
  `CVDLINK` has two subprojects each with their own `.venv`, and the current model roots a
  flow at one subproject, so the question does not arise yet — but it will.
