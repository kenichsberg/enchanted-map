## Why

A real flow does not fit on a screen. `StratificationOrchestrator.run` in `CVDLINK` reaches
97 symbols at depth 2 and 178 at depth 3; the canvas scales the layout to the viewport, so
every node is drawn too small to read and there is no way to get closer or to look at one
part of it.

The map's whole claim is that it shows code at a level a person can hold in their head. At
178 nodes it currently shows a diagram of the right shape and the wrong size.

Two things are missing, and they solve different halves of the problem. Zoom makes a large
map navigable. Focus makes it smaller: pick a node and see what it reaches, which is how
anyone actually reads a call tree — not by taking in 178 nodes, but by following one.

## What Changes

- **Focus is a view-layer operation, not a canvas feature.** A view may be requested focused
  on a node, and then contains that node as its root and only what it reaches. It also
  carries the path from the flow's real entry point down to the focused node, so a surface
  can offer a way back out.

  This belongs in the view layer because every surface has the same problem. Putting it in
  the canvas would mean the editor listing and any future surface each reinvent it, and
  would break the rule that all surfaces consume the same object.

- **The canvas gains zoom and pan.** Wheel or pinch to zoom toward the pointer, drag to pan,
  and a control to fit the whole flow or reset to 1:1. Keyboard equivalents, because a
  wheel-only zoom is unusable for anyone not using a mouse.
- **The canvas fits the flow on first render** rather than scaling it into illegibility.
- **The canvas offers focus**: a node can be focused, a breadcrumb shows where you are, and
  you can walk back to the entry point.
- **Zoom is not view state.** It is per-viewer presentation and is never stored in a flow
  file, so it cannot make a flow report stale and does not appear in a diff.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `flow-views`: gains the focused view — a view rooted at a chosen node, containing what that
  node reaches, and carrying the path back to the entry point.
- `map-surfaces`: `Browser canvas` gains zoom, pan, fit, and a focus control with a way back.

## Impact

**Affected code:**

- `src/views/index.ts` — `flowView` accepts a focus, computes the reachable set and the path
  from the root.
- `src/sidecar/render.mjs` — the layout already centres on `view.root`, so a focused view
  should largely fall out; zoom and pan are new, operating on the SVG `viewBox`.
- `src/sidecar/canvas.html` — controls and event handling.
- `src/sidecar/server.ts` — the `view` method accepts a focus parameter.

**Risk:** focus and the existing depth bound interact. A node near the frontier may have been
truncated during traversal, so focusing it shows a subtree that stops immediately — correct,
but it will read as "this calls nothing" unless the truncation is visible. The view already
marks truncation, so the requirement is that focus preserves that marking rather than
inventing a leaf.

**Out of scope:** exposing focus in the editor listing (the view layer will support it; which
surfaces offer it is a separate decision), persisting a focus across sessions, minimaps, and
any change to the layout algorithm itself.
