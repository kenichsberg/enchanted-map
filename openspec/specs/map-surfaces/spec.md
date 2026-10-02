# Map Surfaces

### Requirement: Neovim owns the sidecar lifetime

The Neovim plugin SHALL spawn the analyzer sidecar and terminate it when the editor session
ends. Communication between plugin and sidecar MUST use a process channel established at
spawn, requiring no port configuration by the user.

#### Scenario: Sidecar starts on demand
- **WHEN** the user first requests a flow in a session
- **THEN** the plugin spawns the sidecar and the request completes

#### Scenario: Sidecar exits with the editor
- **WHEN** the Neovim session ends
- **THEN** the sidecar process terminates and leaves no orphan

#### Scenario: Sidecar crash is reported
- **WHEN** the sidecar exits unexpectedly
- **THEN** the plugin reports the failure and permits a retry without restarting Neovim

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

### Requirement: Jump to source

Selecting a node SHALL move the cursor to that node's source location. This MUST work from
the editor surface and from the browser surface.

#### Scenario: Jump from the editor
- **WHEN** the user selects a node in the editor flow view
- **THEN** the editor opens that file and places the cursor at the node's line

#### Scenario: Jump from the browser
- **WHEN** the user clicks a node in the browser canvas
- **THEN** the connected Neovim instance opens that file and places the cursor at the line

#### Scenario: Location no longer exists
- **WHEN** a node's recorded location is no longer valid
- **THEN** the jump is refused with an explanation, and the editor state is unchanged

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

### Requirement: CI staleness check

The system SHALL provide a command that reports flow staleness without an editor and without
performing curation. The command MUST signal its result through its exit status.

#### Scenario: Check reports stale flows
- **WHEN** the check runs against a revision where stored flows have drifted
- **THEN** it lists each affected flow with its stale entries and exits with a non-zero status

#### Scenario: Check passes on a current map
- **WHEN** every stored flow is current
- **THEN** the check exits zero and reports no staleness

#### Scenario: Check never writes curation
- **WHEN** the check runs
- **THEN** no stored flow file is modified

### Requirement: An agent surface for curation

The sidecar SHALL expose its curation capability to an external agent over the Model Context
Protocol, alongside the editor, browser and CI surfaces. The system MUST NOT implement an
agent loop, hold a model credential, or depend on a particular model.

The agent surface MUST consume and produce the same flows and views the other surfaces do, so
a judgment recorded through it is immediately visible to them.

#### Scenario: An agent can enumerate and resolve
- **WHEN** an agent connects and asks for a flow's holes, then resolves one
- **THEN** the judgment is recorded in that flow

#### Scenario: A judgment is visible to the other surfaces
- **WHEN** a judgment is recorded through the agent surface
- **THEN** the editor listing and the browser canvas show the resolved edge without further
  action

#### Scenario: No credential is required of this system
- **WHEN** the agent surface runs
- **THEN** it holds no model credential and makes no request to a model provider

#### Scenario: The agent surface is optional
- **WHEN** no agent is connected
- **THEN** the editor, browser and CI surfaces work exactly as before
