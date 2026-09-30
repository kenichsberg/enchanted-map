# Flow Views

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

An edge's rendered condition label SHALL be built from its guards of category `branch` and
`loop`. A guard of category `context` MUST NOT appear in that label, because its body always
runs and presenting it as a condition asserts a choice that does not exist.

Edges MUST be presented in source order. An edge whose call site is an argument of another
call MUST be presented as subordinate to that call rather than as a sibling of it, and MUST
be identifiable as evaluated before the call it feeds. The number of nodes MUST NOT increase
as a result of nesting.

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

#### Scenario: Edges are emitted in source order
- **WHEN** a caller's calls were reported grouped by callee
- **THEN** the view emits that caller's edges in the order they appear in the source

#### Scenario: An argument call is subordinate, not a sibling
- **WHEN** a call is an argument of another call from the same caller
- **THEN** the view presents it beneath the call it feeds, and does not present the two as
  independent children of the caller

#### Scenario: Nesting adds no nodes
- **WHEN** a flow contains calls nested in argument positions
- **THEN** the view's node count is the same as it would be if the calls were at statement
  level

#### Scenario: Several arguments of one call are ordered
- **WHEN** two calls are arguments of the same call
- **THEN** both are presented beneath it, in source order relative to one another

#### Scenario: A flow with no nesting is unaffected
- **WHEN** every call in a flow is at statement level
- **THEN** the view presents them as siblings in source order, with no subordination

#### Scenario: A context guard does not appear as a condition
- **WHEN** a call is guarded only by a `with` block
- **THEN** its edge's condition label is empty

#### Scenario: A selecting guard survives an enclosing context guard
- **WHEN** a call is inside a `with` block and inside an `if` within it
- **THEN** the label carries the `if` condition alone

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

### Requirement: A view may be focused on a node

A view MAY be requested focused on a node of the flow. A focused view SHALL be rooted at that
node and contain the nodes and edges reachable from it, and MUST carry the ordered path from
the flow's entry point to the focused node so a surface can offer a way back.

A focused view MUST preserve the markings the unfocused view carries for the nodes it
contains, including truncation by the depth bound, cycles, provenance and staleness. Focus
selects what is shown; it MUST NOT change what any of it means.

#### Scenario: A focused view is rooted at the chosen node
- **WHEN** a view is requested focused on a node
- **THEN** that node is the view's root, and the view contains the nodes it reaches

#### Scenario: Unreachable nodes are absent
- **WHEN** a flow contains a node not reachable from the focused node
- **THEN** that node and its edges are absent from the focused view

#### Scenario: The path back is carried
- **WHEN** a view is focused on a node several levels below the entry point
- **THEN** the view carries the ordered path from the entry point to that node

#### Scenario: Focusing the entry point changes nothing
- **WHEN** a view is focused on the flow's own entry point
- **THEN** it contains the same nodes and edges as the unfocused view

#### Scenario: A shared node is included
- **WHEN** a node reachable from the focused node is also reachable from elsewhere in the flow
- **THEN** it is present in the focused view

#### Scenario: Truncation survives focus
- **WHEN** a node whose expansion was cut by the depth bound is focused
- **THEN** it is marked as truncated rather than presented as a node that calls nothing

#### Scenario: A cycle survives focus
- **WHEN** a focused subtree contains a recursive path
- **THEN** the repeated node is marked as a cycle, as it is in the unfocused view

#### Scenario: A focused view is still surface-independent
- **WHEN** a focused view is produced
- **THEN** it is a plain serialisable object, produced without any surface attached
