## ADDED Requirements

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
