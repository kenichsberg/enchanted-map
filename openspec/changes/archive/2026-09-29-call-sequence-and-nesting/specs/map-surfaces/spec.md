## MODIFIED Requirements

### Requirement: Browser canvas

The sidecar SHALL serve a browser canvas that renders a flow spatially, with nodes as
functions and conditions on edges. The canvas MUST reflect the same view object the editor
consumes.

An edge whose call site is an argument of another call MUST be rendered as subordinate to
the call it feeds, and MUST be distinguishable from a call made at statement level. Where
nesting is deeper than the canvas presents directly, the canvas MAY collapse the nested
portion behind a marker, but MUST NOT discard it from the underlying view.

#### Scenario: Canvas renders the open flow
- **WHEN** the user opens the canvas for a flow
- **THEN** the flow renders with its nodes, edges, and edge conditions

#### Scenario: Canvas reflects provenance and staleness
- **WHEN** a flow contains edges of differing provenance and some stale entries
- **THEN** the canvas distinguishes the provenance tiers and marks the stale nodes and edges

#### Scenario: Canvas updates on re-analysis
- **WHEN** the flow is re-analyzed while the canvas is open
- **THEN** the canvas updates without a manual page reload

#### Scenario: An argument call renders beneath the call it feeds
- **WHEN** a flow contains a call passed as an argument to another call
- **THEN** the canvas renders it subordinate to that call, not as a sibling of it

#### Scenario: Argument edges are visually distinct from statement-level calls
- **WHEN** a caller makes both a statement-level call and a call in an argument position
- **THEN** the two are distinguishable in the canvas without reading the labels

#### Scenario: Collapsed nesting remains available
- **WHEN** the canvas collapses a deeply nested argument subtree
- **THEN** the collapsed portion is still present in the view object the canvas was given

### Requirement: Flow operations from the editor

The plugin SHALL let the user declare an entry point, open a flow, and accept a flow. When a
flow is opened, the plugin MUST present it using view output rather than computing its own
representation.

A flow listing MUST convey the order in which a caller's calls occur, and MUST indicate when
a call is an argument of another call, since a textual listing has no spatial axis to carry
either.

#### Scenario: Declare an entry point at the cursor
- **WHEN** the user invokes the declare command with the cursor on a function
- **THEN** that symbol is added to project configuration as a named entry point

#### Scenario: Open a flow in the editor
- **WHEN** the user opens a flow
- **THEN** its nodes and edges are listed with conditions shown on edges

#### Scenario: Accept a flow
- **WHEN** the user accepts the open flow
- **THEN** the flow's acceptance stamp is written to its stored file

#### Scenario: The listing conveys call order
- **WHEN** a flow is opened in the editor
- **THEN** each of a caller's calls is listed with its position, in source order

#### Scenario: The listing marks an argument call
- **WHEN** a listed call is an argument of another call
- **THEN** the listing shows it as subordinate to that call
