# Flow Analysis

### Requirement: Headless language server lifecycle

The analyzer SHALL spawn and own its own `basedpyright` language server process over stdio.
It MUST NOT depend on a Neovim LSP client, an editor session, or user LSP configuration, so
that identical analysis runs under an editor, a browser, or CI.

#### Scenario: Analysis runs with no editor present
- **WHEN** the analyzer is invoked from a shell with no Neovim process running
- **THEN** it spawns `basedpyright`, completes analysis, and returns facts

#### Scenario: Server is shut down with the analyzer
- **WHEN** the analyzer process exits for any reason
- **THEN** the language server process it spawned is terminated, leaving no orphan

#### Scenario: Missing language server is reported clearly
- **WHEN** `basedpyright` cannot be located or fails to start
- **THEN** the analyzer reports the failure with the resolved command it attempted, and does
  not fall back to a server lacking `implementationProvider`

### Requirement: Call edge extraction

The analyzer SHALL derive call edges using `textDocument/prepareCallHierarchy` followed by
`callHierarchy/outgoingCalls`. Each edge MUST record the caller symbol, the callee symbol,
the callee's source location, and the call-site range reported in `fromRanges`.

Each call site MUST additionally record its ordinal among the call sites of the same caller,
assigned in ascending source position, and its kind. A call site invoked from statement
level in the caller's body is a `call`. A call site lexically contained in another call's
argument list is an `argument`, and MUST record the call site it is an argument of.

Recording an ordinal and a kind MUST NOT change which symbols a traversal reaches, nor the
depth at which they are reached.

#### Scenario: Outgoing calls are recorded with call sites
- **WHEN** a function calls two other functions at distinct source lines
- **THEN** two edges are recorded, each carrying the source line of its own call site

#### Scenario: One caller invokes the same callee twice
- **WHEN** a function calls the same callee at two distinct call sites
- **THEN** both call sites are retained and are individually addressable

#### Scenario: Call sites are ordered by source position
- **WHEN** a caller contains several calls, and the language server reports them grouped by
  callee rather than by position
- **THEN** each call site's ordinal reflects its order in the source, independently of the
  order the language server reported them in

#### Scenario: A call in an argument position is recorded as such
- **WHEN** a call appears inside the argument list of another call
- **THEN** it is recorded as an `argument` edge naming the call site it feeds, and the
  consuming call is recorded as a `call`

#### Scenario: A call at statement level is not an argument
- **WHEN** a call appears as a statement in the caller's body
- **THEN** it is recorded as a `call` and names no enclosing call site

#### Scenario: Several calls in one argument list
- **WHEN** two calls appear as separate arguments of the same call
- **THEN** both are recorded as `argument` edges naming the same enclosing call site, and
  they are ordered relative to each other by their ordinals

#### Scenario: Nesting does not change what is reached
- **WHEN** a flow containing nested calls is analyzed
- **THEN** the set of symbols reached, and the depth at which each is reached, are the same
  as when the ordinal and kind are disregarded

### Requirement: Branch condition extraction

For each call edge, the analyzer SHALL locate the call-site range within the tree-sitter
parse tree and walk the ancestor chain to collect guarding constructs. The resulting ordered
condition list MUST be attached to the edge, not to either node.

#### Scenario: Call guarded by a conditional
- **WHEN** a call appears inside an `if` block
- **THEN** the edge carries that condition, and the graph gains no additional node

#### Scenario: Call guarded by an else branch
- **WHEN** a call appears inside the `else` of the same conditional
- **THEN** the edge carries the negated condition, distinguishable from the `if` branch

#### Scenario: Nested guards
- **WHEN** a call is nested inside two guarding constructs
- **THEN** the edge carries both conditions as an ordered conjunction

#### Scenario: Unguarded call
- **WHEN** a call appears at the top level of a function body
- **THEN** the edge carries an empty condition list

### Requirement: Dispatch candidate discovery

Where a call resolves to a method on a base or declared type, the analyzer SHALL query
`textDocument/implementation` and record the returned locations as the candidate set for
that call site.

#### Scenario: Base method with one concrete implementation
- **WHEN** a call resolves to a method whose type has exactly one subtype implementation
- **THEN** both the declared method and the concrete implementation are recorded as candidates

#### Scenario: No candidates returned
- **WHEN** `textDocument/implementation` returns no results for a call site
- **THEN** the call is NOT recorded as a hole, because an ordinary call to a single
  concrete target is resolved, not unresolved

### Requirement: Symbols outside the project are recorded but not expanded

Where a call resolves to a file that is not part of the project's own source, the analyzer
SHALL record the symbol so the call remains visible, MUST NOT traverse into it, and MUST
label it with a location that is independent of the machine and the toolchain the analysis
ran on.

A file is not part of the project's own source when its path escapes the project root, or
when any segment of its path within the root matches a configured vendor marker. A vendored
file inside the root MUST be treated exactly as one outside it; the two MUST NOT be
distinguishable in a flow.

#### Scenario: A call into the standard library
- **WHEN** a function in the project calls a standard library function
- **THEN** the call and its target are recorded, and the target's own calls are not followed

#### Scenario: External symbols are distinguishable
- **WHEN** a flow contains both project and external symbols
- **THEN** each external symbol is marked as such, and a consumer can list them separately
  from symbols truncated by the depth bound

#### Scenario: External locations are portable
- **WHEN** a flow containing external symbols is stored
- **THEN** the stored file contains no absolute or installation-specific path, so the same
  analysis on another checkout produces the same bytes

#### Scenario: A dependency installed inside the project directory
- **WHEN** a call resolves into a virtualenv beneath the project root
- **THEN** the call and its target are recorded, and the target's own calls are not followed

#### Scenario: A vendored path segment matches, not a prefix or substring
- **WHEN** the project contains a file whose name merely contains a marker as a substring,
  such as `my_venv_helpers.py`, and another file beneath a directory named exactly `.venv`
- **THEN** only the file beneath the marker directory is treated as vendored

#### Scenario: A vendored location loses its toolchain version
- **WHEN** a vendored file's path includes an interpreter-specific directory, as
  `.venv/lib/python3.13/site-packages/` does
- **THEN** its recorded location contains neither the interpreter version nor any segment
  above the vendor marker, so two developers on different patch releases store the same bytes

#### Scenario: Nested vendor markers resolve to the dependency's own path
- **WHEN** a vendored path contains more than one marker segment, such as `site-packages`
  beneath `.venv`
- **THEN** the location is taken from the last marker, yielding the dependency's own path

#### Scenario: Vendored symbols are not expanded even when reachable early
- **WHEN** an entry point calls a vendored function directly, within the depth bound
- **THEN** that function's own calls are absent from the flow, and it is reported as external
  rather than as truncated by depth

### Requirement: Unresolved calls are recorded as holes

When a call cannot be resolved to a single concrete target, the analyzer SHALL emit an
`unresolved` record containing the call site, a machine-readable reason, and the candidate
set. The edge to the declared target MUST still be recorded, marked with reduced confidence.
Unresolved calls MUST NOT be silently omitted from the graph.

#### Scenario: Dispatch through a declared base type
- **WHEN** a call reaches a base method whose outgoing call list is empty while concrete
  implementations exist
- **THEN** an unresolved record is emitted with those implementations as candidates, and the
  edge to the base method is retained with reduced confidence

#### Scenario: Holes are enumerable
- **WHEN** analysis of a flow completes
- **THEN** all unresolved records for that flow can be listed as a single collection

### Requirement: Constructor-evidence resolution

Where exactly one concrete implementation from a call site's candidate set is constructed as
an argument of the call that reaches the dispatching function, the analyzer SHALL resolve the
dispatch to that implementation and mark the edge with heuristic provenance. Where evidence
is absent or ambiguous, the hole MUST remain open.

The analyzer MUST NOT treat a constructor as evidence merely because it shares a source line
with the call into the dispatching function.

#### Scenario: Single concrete type constructed and passed
- **WHEN** one implementation is constructed and passed directly to the function containing
  the dispatching call site
- **THEN** the edge resolves to that implementation and is marked as heuristically resolved

#### Scenario: Two candidate types constructed in the same flow
- **WHEN** two different implementations are constructed within the flow
- **THEN** no heuristic resolution is made and the hole remains open

#### Scenario: Heuristic edges are distinguishable
- **WHEN** a consumer inspects a heuristically resolved edge
- **THEN** its provenance is distinct from an edge resolved directly by the language server

#### Scenario: A constructor sharing a line but not an argument position is not evidence
- **WHEN** a candidate implementation is constructed on the same source line as the call into
  the dispatching function, but is not an argument of it
- **THEN** it is not treated as evidence, and the hole remains open unless other evidence
  resolves it

### Requirement: Content-hash fact caching

Derived facts SHALL be cached keyed on source content hash, and MUST be stored outside
version control. Re-analysis of unchanged content MUST be served from cache without
contacting the language server.

#### Scenario: Unchanged file is not re-analyzed
- **WHEN** analysis runs twice with no source change between runs
- **THEN** the second run issues no call-hierarchy requests for the unchanged symbols

#### Scenario: Cache is not committed
- **WHEN** the cache directory is populated
- **THEN** it is excluded from version control

### Requirement: Bounded incremental re-analysis

Re-analysis SHALL be scoped to changed symbols and their bounded neighbourhood. The analyzer
MUST NOT build a whole-repository call graph.

#### Scenario: One function body changes
- **WHEN** a single function is edited and analysis re-runs
- **THEN** only that symbol and its bounded neighbourhood are re-analyzed

#### Scenario: Traversal respects the depth bound
- **WHEN** a flow is analyzed with a configured maximum depth
- **THEN** traversal stops at that depth and the truncation is recorded in the output
