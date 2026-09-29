## ADDED Requirements

### Requirement: Views are surface-independent

Each view SHALL produce a serialisable object containing everything needed to render it. A
view MUST NOT depend on Neovim, a browser, or any rendering library, and all surfaces MUST
consume the same object for a given view.

#### Scenario: Same view drives multiple surfaces
- **WHEN** a view is produced for a flow
- **THEN** the identical object can be rendered by the editor surface, the browser surface,
  and the CI surface without surface-specific recomputation

#### Scenario: View is produced without a surface
- **WHEN** a view is requested in a process with no editor and no browser attached
- **THEN** the view object is produced successfully

### Requirement: Whole-flow view

The whole-flow view SHALL present the entry point and its bounded call tree, with nodes
representing functions only. Branch conditions MUST be carried on edges. The number of nodes
MUST NOT increase as a result of branching.

#### Scenario: Branch appears on the edge
- **WHEN** a flow contains a call guarded by a conditional
- **THEN** the condition appears as an attribute of the edge, and no node represents the
  conditional itself

#### Scenario: Nested conditions are presented as one label
- **WHEN** a call is guarded by nested conditions
- **THEN** the edge presents them as a single conjoined label

#### Scenario: Truncation is visible
- **WHEN** traversal stopped at the configured depth bound
- **THEN** the view marks the truncated frontier rather than presenting it as a leaf

#### Scenario: Cycles are marked
- **WHEN** the flow contains a recursive path
- **THEN** the repeated node is marked as a cycle rather than expanded

### Requirement: Diff view against a revision

The diff view SHALL compare a stored flow against a specified revision and report added
nodes, removed nodes, added edges, removed edges, and edges whose conditions changed.

#### Scenario: A new call is introduced
- **WHEN** a function gains a call that the compared revision did not contain
- **THEN** the view reports the new edge and its target node

#### Scenario: A branch condition changes
- **WHEN** an existing call's guarding condition is modified
- **THEN** the view reports the edge as condition-changed rather than as removed and re-added

#### Scenario: Reachability grows
- **WHEN** a change causes the entry point to reach functions it previously did not
- **THEN** the view reports those nodes as newly reachable from this entry point

#### Scenario: Flow is unchanged
- **WHEN** no change affects the flow
- **THEN** the diff view reports an empty delta

### Requirement: Staleness view

The staleness view SHALL report stale entries attributed to the specific nodes and edges
they affect. It MUST NOT reduce staleness to a single flow-level flag.

#### Scenario: Stale entries are localised
- **WHEN** a flow has stale entries affecting two nodes
- **THEN** the view attributes staleness to those two nodes and marks no others

#### Scenario: Current flow reports clean
- **WHEN** every entry's dependency hash matches
- **THEN** the staleness view reports no stale entries

### Requirement: Provenance view

Every edge SHALL carry a provenance tier, and the provenance view MUST make tiers
distinguishable. The tiers in this change are language-server-verified, heuristically
resolved, and declared-target-unresolved.

#### Scenario: Tiers are distinguishable
- **WHEN** a flow contains edges of more than one tier
- **THEN** each edge's tier is reported and the tiers are distinguishable from one another

#### Scenario: Unresolved dispatch is visible
- **WHEN** an edge points at a declared target whose concrete implementation is unresolved
- **THEN** the view marks the edge as unresolved and exposes its candidate set

#### Scenario: Holes are reachable from the view
- **WHEN** a flow contains unresolved call sites
- **THEN** the view exposes them as an enumerable collection
