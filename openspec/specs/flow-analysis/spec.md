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

#### Scenario: Outgoing calls are recorded with call sites
- **WHEN** a function calls two other functions at distinct source lines
- **THEN** two edges are recorded, each carrying the source line of its own call site

#### Scenario: One caller invokes the same callee twice
- **WHEN** a function calls the same callee at two distinct call sites
- **THEN** both call sites are retained and are individually addressable

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

Where a call resolves to a file outside the project root, the analyzer SHALL record the
symbol so the call remains visible, MUST NOT traverse into it, and MUST label it with a
location that is independent of the machine the analysis ran on.

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

Where exactly one concrete implementation from a call site's candidate set is constructed
within the enclosing flow and reaches that call site in a single hop, the analyzer SHALL
resolve the dispatch to that implementation and mark the edge with heuristic provenance.
Where evidence is absent or ambiguous, the hole MUST remain open.

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
