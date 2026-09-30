## MODIFIED Requirements

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
