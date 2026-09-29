## Context

Greenfield repository. No existing code, no existing specs.

The proposal establishes a persistent, entry-point-rooted flow map derived deterministically
from a language server and tree-sitter, surfaced in Neovim, a browser, and CI. This document
covers how that is built, and records the decisions taken before implementation.

Two findings from a pre-proposal spike constrain the design and are treated as established
fact throughout:

- `callHierarchy/outgoingCalls` works on Python and returns `fromRanges` with exact
  call-site line numbers. Those ranges are the join key onto tree-sitter nodes.
- A call through a declared base type resolves to the base method, whose outgoing call list
  is empty. The concrete implementation is never reached. `textDocument/implementation`
  returns the candidate set under `basedpyright` and `None` under `pyright`.

The second finding is the shape of the whole problem: the deterministic layer can produce
the call spine and a candidate set, but not the resolution. The architecture is organised
around making that boundary explicit rather than hiding it.

## Goals / Non-Goals

**Goals:**

- Establish the deterministic ceiling: everything knowable without probabilistic inference.
- Make unresolved calls a first-class, structured output, not a silent omission.
- Persist flows so the map is an asset that accrues value across sessions and commits.
- Keep staleness local and legible, so a partially stale map remains usable.
- Keep the analyzer free of any Neovim dependency, so the same code runs under CI.
- Design the L1 to L2 seam precisely enough that an agent layer can be added without
  reworking storage or analysis.

**Non-Goals:**

- Any AI or probabilistic inference. Judgment slots exist in the format; nothing fills them.
- TypeScript and Rust support. Python only.
- Cross-language or FFI flow tracing.
- Framework-specific entry-point auto-detection. Entry points are declared.
- Whole-repository call graphs. Flows are rooted and bounded.
- Data-flow or value tracking beyond the constructor-evidence heuristic below.

## Decisions

### D1. The sidecar owns its language servers

A headless sidecar process spawns and manages `basedpyright` over stdio. Neovim's own LSP
clients are not used.

*Why:* CI has no Neovim, and the CI staleness check is in scope. Borrowing Neovim's clients
would make the analyzer unrunnable headless and would couple the core to one editor.
Independently, the target machine has an empty Neovim config, so there are no warm clients
to borrow.

*Alternative rejected:* using `vim.lsp` clients via the plugin. Cheaper in memory (one server
process instead of two) but forfeits CI, forfeits a future VSCode surface, and makes analysis
depend on the user's LSP configuration being correct.

*Cost accepted:* a second `basedpyright` process alongside the editor's, if the user has one.

### D2. `basedpyright`, not `pyright`

*Why:* `textDocument/implementation` is the dispatch-candidate primitive. It is the only
deterministic source for the candidate set that a later agent layer will choose from. The
spike showed `pyright` returns `None` and `basedpyright` returns the implementations.

*Alternative rejected:* `jedi-language-server` / `pylsp`. Not evaluated in the spike; may be
worth revisiting if basedpyright proves slow on large repositories, but the dispatch
capability is the deciding factor and basedpyright demonstrably has it.

### D3. LSP supplies edges; tree-sitter supplies edge labels

Call edges come from `prepareCallHierarchy` plus `callHierarchy/outgoingCalls`. For each
returned `fromRange`, the analyzer locates the corresponding node in the tree-sitter tree
and walks *up* the ancestor chain, collecting guarding constructs (`if`, `elif`, `else`,
`match`/`case`, `for`, `while`, `try`/`except`, `with`) into an ordered condition list.

*Why:* LSP will never report branch context, and tree-sitter cannot resolve cross-file
calls. Each tool is used only for what it is actually good at. The spike confirmed the join
key exists and is exact.

*Alternative rejected:* deriving edges from tree-sitter alone with a name-resolution
heuristic. Cheaper to start, but reinvents import resolution and scoping badly.

### D4. Conditions render on the edge, not as nodes

A branch is an annotation on a call edge. Nodes are functions and only functions. Nested
conditions concatenate into a single conjoined label.

*Why:* graph size stays independent of how branchy the code is, which is what protects the
"high level" goal. A decision-node model adds a node per conditional and inflates exactly
the branchy code that most needs summarising.

*Alternatives rejected:* decision nodes (faithful but inflates the graph); condition bands
(most readable per function, but has no sound layout when conditions nest or two branches
call the same target); collapsed-by-default labels (cleanest at rest, but hides the reason
a path is taken, which is the primary question the map exists to answer).

### D5. Holes are records, not absences

When a call cannot be resolved to a single concrete target, the analyzer emits an
`unresolved` record carrying the call site, the reason, and the candidate set from
`textDocument/implementation`. The edge to the declared target is still recorded, marked
with reduced confidence.

*Why:* an omitted edge is indistinguishable from "no such call" and quietly makes the map
wrong. A record is auditable, is what the provenance lens renders, and is the designed
input queue for a future agent layer.

### D6. Constructor-evidence heuristic before any inference

The spike showed `outgoingCalls` reports constructor calls as edges: `SMSSender()` appears
as an edge from `login`. Where exactly one concrete implementation is constructed within the
enclosing flow and passed to the call site, the analyzer may resolve the dispatch
deterministically and mark the edge as heuristically resolved.

*Why:* it is free, it uses data already fetched, and it removes the easy majority of holes
before anything more expensive is considered. Deliberately conservative: ambiguity leaves
the hole open rather than guessing.

*Scope limit:* single-hop, single-candidate only. No general data-flow analysis.

### D7. Node identity: exact matches only, otherwise invalidate

```
file moved         git rename detection                        exact
symbol renamed     gone symbol + new symbol, same file,        exact
                   identical IMPLEMENTATION body hash
                   (signature excluded)
anything else      invalidate and re-derive
```

Identity and staleness hash different things, and conflating them is a real trap: the
symbol's name lives in its signature, so hashing the whole definition for identity makes
every rename look like a delete plus an add -- defeating the rule above entirely. Identity
therefore hashes the body block alone, while staleness hashes the full definition, so a
renamed function is correctly reported as *the same node, changed*.

*Why:* the cases being protected against are "a small change looks like a big one", which is
overwhelmingly renames and moves. Both have exact, cheap detections with no thresholds to
tune. A genuine restructure *should* invalidate broadly; it is a big change and earns a big
review.

*Alternative deferred:* similarity scoring over the call neighbourhood, and agent-assisted
matching of leftovers. Both are the right eventual answer; neither is built until the
residual noise is observed against real examples.

### D8. Storage: one committed file per flow, derived facts cached separately

```
.enchanted/flows/<flow>.yaml     committed   curation, accept stamps, dependency hashes
.enchanted/cache/                gitignored  derived facts, keyed by content hash
```

*Why:* the flow is the unit of review, so it is the unit of storage. One file per flow scopes
merge conflicts to genuine disagreements about the same flow; a monolithic map file would
conflict on every parallel change. Facts are regenerable from source and must never be
reviewed, so they are not committed.

### D9. Staleness from dependency hashes, reported per node

Every stored entry records a hash of the inputs it depended on, not of the whole file.
Staleness is computed per entry and rendered against the specific node or edge affected.

*Why:* a whole-file hash makes an unrelated log line invalidate everything, and the map
churns until it is ignored. A global "may be out of date" banner gives the user no way to
tell which half to trust. Locality is what makes graceful degradation real rather than
aspirational.

*Forward-looking:* this is also the memoization key for the future agent layer, where
stability comes from cache hits rather than from model determinism. Scoping the dependency
sets correctly now is what makes that work later.

### D10. Acceptance is per flow

A flow carries an accept stamp recording the commit at which a human accepted it. This is
the only confidence distinction in the model; there is no separate pinning mechanism.

*Why:* per-judgment acceptance is too fine-grained to keep up with AI-rate churn;
whole-map acceptance is a rubber stamp. Per-flow matches the unit the user actually
reviews, and it subsumes pinning at no extra conceptual cost.

### D11. TypeScript on Node for the sidecar

*Why:* `basedpyright` ships as an npm package, so Node is already a hard dependency of the
system. Adding a second runtime buys nothing. One runtime then serves the LSP client, the
tree-sitter parse (via WASM, avoiding native build pain across platforms), the HTTP and
WebSocket server, and the browser bundle.

*Alternative rejected:* Rust. A single static binary is a materially better distribution
story for a Neovim plugin, and tree-sitter is native there. But Node is required regardless
because of basedpyright, so the binary would not actually reduce the dependency footprint.
Revisit only if the sidecar becomes performance-bound.

*Alternative rejected:* Python. Matches the target language, but the sidecar would have to
resolve its own interpreter and dependencies against whatever virtualenv the analysed
project uses. Avoidable coupling.

### D12. Transport

```
nvim  ──stdio JSON-RPC──▶  sidecar  ◀──WebSocket──  browser
                              │
                              └── HTTP: static bundle + view snapshots
```

Neovim spawns the sidecar and owns its lifetime. The browser connects to the sidecar
directly. Jump-to-source travels browser → sidecar → Neovim over the same channels.

*Why:* Neovim owning the process means no orphaned daemons and no port discovery problem on
the editor side. A single server in the sidecar keeps both surfaces on identical view output.

### D13. Views are surface-independent

The lens layer (whole-flow, diff against a git ref, staleness, provenance) produces a
serialisable view object. Neovim, the browser, and CI all consume the same object.

*Why:* it prevents the browser from becoming privileged and quietly accumulating logic that
CI then cannot run. It is also what lets the Neovim surface render a fast list view of the
same diff the browser draws spatially.

## Risks / Trade-offs

- **Call-hierarchy latency on real repositories** → Depth is bounded, analysis is rooted at
  entry points rather than repo-wide, facts are content-hash cached, and re-analysis is
  scoped to changed symbols and their neighbourhoods.

  *Measured during implementation:* this risk was mis-attributed. Runtime is flat across
  depths 2-5; the cost is language-server startup and workspace indexing, not traversal.
  Mitigation is therefore the long-lived sidecar (one server per session), not a lower
  depth. See Open Questions for the figures.

- **Python resolves worse than the other target languages** → Accepted deliberately. Proving
  the foundation against the weakest case forces the confidence and provenance model to be
  honest. Porting to TypeScript and Rust should only raise resolution rates. The risk is
  morale: the first maps may look sparse.

- **Curation cannot keep pace with AI generation** → The map degrades, and a map users do not
  trust is worse than none. Mitigated by D9: staleness is local and visible, so a half-stale
  map is still usable for the half that is fresh. This is the central bet of the design and
  should be evaluated explicitly after first real use.

- **A large refactor invalidates everything at once** (D7) → Accepted. Large changes deserve
  large reviews. Revisit only if observed in practice to be noisy.

- **Two `basedpyright` processes** (D1) → Accepted memory cost, in exchange for CI and editor
  independence.

- **Committed flow files create merge conflicts** → Scoped by D8 to same-flow edits. YAML
  graph conflicts are still unpleasant when they occur; keeping per-flow files small and
  stably ordered is a mitigation, not a cure.

- **Entry points must be declared by hand** → Friction on first use, and a flow nobody
  declared is invisible. Accepted for this change; auto-detection is a later convenience.

## Migration Plan

Greenfield; there is nothing to migrate. Rollout order is chosen so each stage is
independently verifiable:

1. Sidecar with LSP client and fact extraction, exercised by a CLI dump. No editor, no browser.
2. Flow model, storage, hashing, staleness. Verified against a repository with real churn.
3. Views. Verified by asserting on view objects, with no surface attached.
4. Surfaces: Neovim jump-to-source first, then the browser canvas, then the CI check.

Rollback is deletion of `.enchanted/`; nothing else in a host repository is modified.

## Open Questions

- ~~What default depth makes a flow useful without becoming a hairball?~~ **Measured during
  implementation.** Depth sweep against real CPython stdlib (`json.dumps`, `argparse`):

  ```
  source     depth   ms   nodes  edges  guarded  holes
  json         2    484     7      8      2       0
  json         3    460    11     13      6       0
  json         5    434    17     37     30       0
  argparse     2  12139    35     39     26       3
  argparse     3  11290    46     67     39       3
  argparse     5  12233    55     81     43       3
  ```

  Depth 3 is retained as the default: 11-46 nodes is readable, and node growth is modest
  rather than exponential because the external-symbol boundary does most of the pruning.

  The sweep also corrects an assumption in the risks section: **depth is not the cost
  driver.** Runtime is flat across depths and dominated by language-server startup and
  workspace indexing (argparse's ~11s is basedpyright indexing the whole stdlib tree). This
  strengthens the case for the long-lived sidecar, which pays that cost once per session
  rather than once per invocation, and means a per-invocation CLI is the slow path.
- Should a flow store the full resolved graph, or only the curation plus enough hashes to
  re-derive it? Storing the graph makes diffing cheap and the file self-contained but large
  and conflict-prone. Deferred until the file format is exercised at real scale.
- How are recursive and mutually recursive calls represented in a rooted tree view? Cycles
  are certain to appear; the view layer needs a rule before the browser canvas is built.
- Does the constructor-evidence heuristic (D6) produce false resolutions often enough to
  warrant marking it visually distinct from LSP-verified edges? Provisionally yes, treated
  as a distinct provenance tier.
