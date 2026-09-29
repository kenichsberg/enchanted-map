## Why

AI agents generate code faster than a developer can read it linearly, so understanding
drifts behind the codebase. Text diffs show *what characters changed*; they do not show
what happened to control flow — which entry points now reach which functions, under which
conditions. We need a durable, high-level map of how code actually flows, so understanding
can be re-established structurally instead of line by line.

This change builds the deterministic foundation of that map: a persistent, entry-point-rooted
flow graph derived from a language server and tree-sitter, viewable in Neovim and a browser.
It deliberately excludes AI curation. The purpose is to establish how much can be known
*for certain* before anything probabilistic is layered on top.

Feasibility was verified against Python before writing this proposal (see Impact).

## What Changes

- **Flow as the unit of everything.** A flow is one declared entry point plus its curated,
  reachable call tree. Flows are the unit of viewing, storage, staleness, and acceptance.
- **A headless analyzer sidecar** that spawns and owns its own language server processes.
  It does not borrow Neovim's LSP clients, so the same analyzer runs under Neovim, a
  browser, or CI.
- **Deterministic fact extraction (L1)**: symbols, call edges, call-site ranges, dispatch
  candidates, and branch conditions. Branch context comes from joining LSP call-site ranges
  onto the tree-sitter ancestor chain — LSP supplies edges, tree-sitter supplies edge labels.
- **Holes are first-class.** Where the analyzer cannot resolve a call (dynamic dispatch,
  duck typing, callbacks), it records an explicit `unresolved` entry with its candidate set
  rather than silently omitting the edge. The hole list is the designed input to a future
  agent layer.
- **Persistent, committed flow files**, one per flow, under `.enchanted/flows/<flow>.yaml`.
  One file per flow keeps merge conflicts scoped to genuine disagreements.
- **Content-hashed staleness.** Every stored entry records the hash of the inputs it depended
  on. Staleness is detected and displayed *locally* — per node, not as a global banner — so a
  partially stale map stays usable.
- **Views as lenses over one map**: whole-flow, diff-against-a-ref, staleness, and provenance.
  Views are surface-independent; all surfaces consume the same view output.
- **Three surfaces**: a Neovim plugin (declare entry points, open a flow, jump to
  `file:line`), a browser canvas (spatial graph, click-to-jump back into Neovim), and a
  CI check that reports staleness without curating.
- **Python only.** Scope is limited to one language to prove the model. TypeScript and Rust
  are deliberately out of scope.
- **No AI.** The L1→L2 seam is designed and the judgment slots exist in the file format, but
  nothing fills them in this change. Human-authored names and clusters may occupy those slots.

## Capabilities

### New Capabilities
- `flow-analysis`: Deterministic extraction of symbols, call edges, branch context, dispatch
  candidates, and unresolved holes from a Python codebase via language server plus
  tree-sitter. Covers language-server lifecycle, content-hash caching, and bounded
  incremental re-analysis.
- `flow-map`: The persistent flow model — entry-point declaration, on-disk format, node
  identity across revisions, dependency hashing, staleness detection, and per-flow acceptance.
- `flow-views`: Surface-independent lenses over a stored map: whole-flow, diff against a git
  ref, staleness, and edge provenance.
- `map-surfaces`: The Neovim plugin, the browser canvas, the transport between them, and the
  CI staleness check.

### Modified Capabilities

None. `openspec/specs/` is empty; this is the first change in the project.

## Impact

**New system.** Greenfield repository with no existing code.

**Verified dependencies** (probed directly, not assumed):
- `basedpyright` is **required** over `pyright`. Both advertise and implement
  `callHierarchyProvider`, but `textDocument/implementation` returns results only under
  basedpyright (`pyright` returns `None`). Dispatch candidate resolution is the primitive
  the "actual function" goal depends on, so this determines the language server choice.
- `tree-sitter` with the Python grammar, for branch context and symbol ranges.
- Neovim with a Lua plugin; no LSP configuration is required of the user, since the sidecar
  owns its servers. (The target machine currently has an empty Neovim config.)

**Verified feasibility.** On a 15-line Python sample, `prepareCallHierarchy` +
`callHierarchy/outgoingCalls` returned correct edges with exact call-site line numbers,
sufficient to join against tree-sitter branch nodes. The same sample reproduces the central
limitation: a call through a declared base type resolves to the base method and its outgoing
call list is empty, so the concrete implementation is never reached. This is the motivating
hole, and it is why holes are a first-class output rather than an error condition.

**Known limitation accepted in this change.** Python is the weakest of the three target
languages for static resolution. Proving the foundation here means the confidence and
provenance model is forced to be honest from the start, and porting to TypeScript and Rust
should only raise resolution rates.

**Out of scope, enabled later**: agent curation of holes, memoized judgments, TypeScript
and Rust support, cross-language flows, framework-specific entry-point auto-detection,
and CI-proposed curation.
