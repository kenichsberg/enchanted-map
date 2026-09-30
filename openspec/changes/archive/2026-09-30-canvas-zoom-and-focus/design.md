## Context

The canvas scales its layout to the viewport width, which works at the fixture's ten nodes
and fails at a hundred. Measured on `CVDLINK/stratification`, entry point
`StratificationOrchestrator.run`:

```
depth 1:   23 symbols ·  34 edges
depth 2:   97 symbols · 165 edges
depth 3:  178 symbols · 369 edges
```

Depth 3 is the configured default, so the first thing anyone sees on a real codebase is the
unreadable case.

## Goals / Non-Goals

**Goals:**

- Make a large flow navigable without changing what it contains.
- Make it smaller in a principled way: show what one node reaches.
- Keep focus available to every surface, not only the browser.
- Keep zoom out of anything that is stored, compared, or hashed.

**Non-Goals:**

- Changing the layout algorithm. Zoom and focus make the existing layout usable; a better
  layout is a separate question.
- Exposing focus in the editor listing. The view will support it; whether the listing offers
  it is a surface decision that can be made later without changing the view.
- Persisting zoom or focus. Both are where a viewer is looking right now.
- Minimaps, edge bundling, or automatic clustering.

## Decisions

### D1. Focus is a parameter of the view, not a mode of the canvas

`flowView(flow, report, { focus })` returns a view whose `root` is the focused node and whose
nodes and edges are those reachable from it.

*Why:* every surface hits the same wall. Implementing focus in the canvas would leave the
editor listing to reinvent it, and would break the rule that all surfaces consume the same
object — the rule that currently makes it impossible for the browser and the editor to
disagree about a flow.

*Consequence worth stating:* CI could assert on a focused view. That is not a goal, but it
falls out, and it is the tell that the seam is in the right place.

### D2. A focused view carries the path back

The view includes the chain of nodes from the flow's real entry point to the focused node.

*Why:* focus without a way back is a trapdoor. The surface needs the path to render a
breadcrumb, and the path is a view-layer fact — it comes from the graph, not from the
viewer's click history, so it survives a reload and is identical on every surface.

*Alternative rejected:* the surface remembering how the user got there. It diverges from the
graph as soon as the flow is re-analyzed, and each surface would keep its own version.

### D3. Focus shows what the node reaches, including shared nodes

A node reachable both from the focused node and from elsewhere is included.

*Why:* the question focus answers is "what does this do", and a helper called from two places
is part of what it does. Excluding shared nodes would answer a different and stranger
question — "what does this do exclusively" — which is rarely what a reader wants.

### D4. Focus preserves truncation and cycle marks

A node whose expansion was cut by the depth bound still reads as truncated when focused.

*Why:* focusing a frontier node otherwise shows a subtree of one node and reads as "this
calls nothing", which is a false statement about the code rather than about the analysis.
The distinction already exists in the view; focus must not flatten it.

### D5. Zoom manipulates the SVG viewBox

Not a CSS transform on the container.

*Why:* the viewBox keeps text crisp at any scale, because the browser re-rasterises rather
than scaling a bitmap. It also keeps hit-testing in graph coordinates, so a click at 4x lands
on the node under the pointer without a coordinate conversion.

### D6. Zoom is per-viewer and never leaves the browser

It is not in the view object, not sent to the sidecar, and not stored.

*Why:* anything stored is compared and hashed. A zoom level that reached a flow file would
make a flow report stale because someone scrolled, which is the fastest way to teach a user
that staleness reports are noise.

### D7. Fit on first render; keep the view on live update

A newly opened flow is fitted to the viewport. An update arriving over the event stream
keeps the current zoom and pan.

*Why:* fitting on first render is what makes the default case legible. Re-fitting on every
push would yank the viewport out from under someone reading a specific corner while a
re-analysis lands.

*Open case:* a focus change is not an update — it is a new question — so it re-fits.

### D8. Keyboard parity with the pointer

Zoom in, zoom out, fit, reset and focus all reachable from the keyboard.

*Why:* a wheel-only zoom is unusable without a mouse, and the canvas already has
keyboard-reachable nodes for jump-to-source, so it would be inconsistent as well as
inaccessible.

## Risks / Trade-offs

- **Focus on a truncated frontier node reads as a leaf** → D4 requires the mark to survive.
  The test is a focused view of a node at the depth bound, asserting it is marked truncated
  rather than presented as having no calls.

- **A focused view can still be large** → Focusing the entry point of a 178-node flow returns
  all 178. Focus is a reader's tool, not a bound; the depth setting remains the bound. Worth
  saying because "focus" can imply "smaller" unconditionally, and it does not.

- **Zoom and the collapse threshold interact** → The canvas collapses argument nesting deeper
  than two levels behind a marker. At high zoom a reader may reasonably expect to see what
  was collapsed. This change does not couple them, and that may prove wrong.

- **Layout is recomputed per render** → Zoom does not need it, but focus does. At 178 nodes
  the layout is cheap; at several thousand it may not be. Not a concern at present scale, and
  a reason not to let this change grow into a layout rewrite.

## Migration Plan

1. Focused view in the view layer, asserted on view objects with no surface attached.
2. Zoom, pan and fit on the canvas, tested through the render module where structural, and
   by hand in a browser where visual.
3. The focus control and breadcrumb.
4. Verify on `CVDLINK/stratification` at depth 3, the case that prompted this.

Rollback is per step: focus and zoom are independent, and either can ship without the other.

## Open Questions

- Should focus change the depth bound? Focusing a node three levels down currently shows
  what was already traversed, so the subtree is shallow by construction. Re-analyzing from
  the focused node instead would show more, but it makes focus an analysis operation rather
  than a view operation, which is a much bigger change.
- Should the breadcrumb show every intermediate node, or elide the middle on a long path?
- Does the editor listing want focus, given a list can already be scrolled and searched? The
  view will support it; nothing yet says the listing should.
- Should zoom level be shown numerically? It matters for reporting a rendering problem, and
  not otherwise.
