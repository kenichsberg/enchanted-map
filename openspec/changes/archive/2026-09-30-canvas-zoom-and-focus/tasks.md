## 1. Focused view

- [x] 1.1 Accept an optional focus on `flowView`, returning a view rooted at that node
- [x] 1.2 Compute the reachable set from the focused node, including nodes also reachable
      from elsewhere in the flow
- [x] 1.3 Carry the ordered path from the flow's entry point to the focused node
- [x] 1.4 Preserve truncation, cycle, provenance and staleness marks for the nodes kept
- [x] 1.5 Terminate correctly when the focused node lies on a cycle

## 2. Focused view tests

- [x] 2.1 Test the focused view is rooted at the chosen node and omits unreachable nodes
- [x] 2.2 Test focusing the entry point yields the unfocused view
- [x] 2.3 Test the path back is present and ordered from the entry point
- [x] 2.4 Test a node reachable from two places is included when either is focused
- [x] 2.5 Test a depth-truncated node stays marked truncated when focused, rather than
      reading as a node that calls nothing
- [x] 2.6 Test the focused view is still plain and serialisable, with no surface attached

## 3. Zoom and pan

- [x] 3.1 Implement zoom and pan by manipulating the SVG `viewBox`, not a CSS transform, so
      labels re-rasterise and hit-testing stays in graph coordinates
- [x] 3.2 Zoom toward the pointer on wheel or pinch; pan on drag
- [x] 3.3 Fit the flow to the viewport on first render of a flow
- [x] 3.4 Add fit and reset controls
- [x] 3.5 Add keyboard equivalents for zoom in, zoom out, fit and reset
- [x] 3.6 Keep the current zoom and pan when an update arrives over the event stream
- [x] 3.7 Re-fit when the focus changes, since that is a new question rather than an update

## 4. Focus in the canvas

- [x] 4.1 Add a focus control on a node, distinct from the existing click-to-jump so one
      does not steal the other
- [x] 4.2 Request the focused view from the sidecar and render it
- [x] 4.3 Render a breadcrumb of the path back, with the entry point reachable from it
- [x] 4.4 Make focus and leaving focus reachable from the keyboard
- [x] 4.5 Extend the `view` method to take a focus parameter

## 5. Render tests

- [x] 5.1 Test through the render module that a focused view draws only its own nodes
- [x] 5.2 Test the breadcrumb is emitted with the path back
- [x] 5.3 Test the initial `viewBox` fits the whole flow rather than cropping it
- [x] 5.4 Confirm zoom state appears in no view object and no stored file

## 6. Verification

- [x] 6.1 Render `CVDLINK/stratification` from `StratificationOrchestrator.run` at depth 3
      in a browser and confirm the flow is legible on open
- [x] 6.2 Focus one pipeline step and confirm the canvas narrows to it, with a way back
- [x] 6.3 Confirm a live re-analysis does not move the viewport while zoomed in
- [x] 6.4 Run the full suite and the Neovim checks

## 7. Refinements from first real use

- [x] 7.1 Default to a legible zoom (1:1) rather than fitting the whole flow, which on a
      large map scales the labels below readability
- [x] 7.2 Zoom by sizing the SVG element and letting the container scroll natively, so the
      viewer gets real scrollbars and a sense of position
- [x] 7.3 Scroll to the root on first render so the entry point is where the eye starts
- [x] 7.4 Replace the crosshair focus mark with a pin, which reads as a control rather than
      as decoration
- [x] 7.5 Show a spinner while a view is being fetched, since re-analysis takes seconds and
      silence reads as failure
