## MODIFIED Requirements

### Requirement: Browser canvas

The sidecar SHALL serve a browser canvas that renders a flow spatially, with nodes as
functions and conditions on edges. The canvas MUST reflect the same view object the editor
consumes.

An edge whose call site is an argument of another call MUST be rendered as subordinate to
the call it feeds, and MUST be distinguishable from a call made at statement level. Where
nesting is deeper than the canvas presents directly, the canvas MAY collapse the nested
portion behind a marker, but MUST NOT discard it from the underlying view.

The canvas SHALL let the viewer zoom and pan, and SHALL fit the whole flow to the viewport
when a flow is first rendered. Zoom and pan MUST be reachable without a pointing device.
Neither is part of the view: they MUST NOT be stored, sent to the sidecar, or able to affect
whether a flow reports stale.

The canvas SHALL let the viewer focus a node, rendering the focused view of it, and MUST
offer a way back to the flow's entry point.

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

#### Scenario: A large flow is legible on first render
- **WHEN** a flow too large to draw at full size is opened
- **THEN** it is fitted to the viewport rather than scaled until its labels are unreadable

#### Scenario: The viewer can zoom and pan
- **WHEN** the viewer zooms in and pans
- **THEN** the rendering follows, and node labels stay sharp rather than being scaled as an image

#### Scenario: Zoom is reachable from the keyboard
- **WHEN** the viewer uses the keyboard alone
- **THEN** zooming in, zooming out, fitting and resetting are all available

#### Scenario: A live update does not move the viewport
- **WHEN** the flow is re-analyzed while the viewer is zoomed into part of it
- **THEN** the rendering updates and the current zoom and pan are kept

#### Scenario: Focusing a node narrows the canvas
- **WHEN** the viewer focuses a node
- **THEN** the canvas renders that node and what it reaches, and indicates where in the flow
  the focus sits

#### Scenario: The viewer can leave a focus
- **WHEN** a focus is active
- **THEN** the viewer can return to the flow's entry point

#### Scenario: Zoom never reaches stored state
- **WHEN** the viewer zooms, pans or focuses
- **THEN** no stored flow file changes and the flow's staleness is unaffected
