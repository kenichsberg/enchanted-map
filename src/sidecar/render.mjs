// Pure rendering for the canvas: view object in, SVG/HTML string out.
//
// Extracted from the page so it can be exercised in Node. Canvas layout was
// shipped three times without anyone being able to run it; a browser is still
// the final check, but the structural claims are testable here.

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/** Longest-path layering from the root, so calls flow downward. */
export function layout(view) {
  const nodes = new Map(view.nodes.map((n) => [n.id, { ...n, depth: 0 }]));
  const outgoing = new Map();
  for (const e of view.edges) {
    if (!outgoing.has(e.from)) outgoing.set(e.from, []);
    outgoing.get(e.from).push(e);
  }
  const seen = new Set();
  const walk = (id, depth) => {
    const n = nodes.get(id);
    if (!n) return;
    if (depth > n.depth) n.depth = depth;
    if (seen.has(id)) return;
    seen.add(id);
    for (const e of outgoing.get(id) ?? []) if (!e.closesCycle) walk(e.to, depth + 1);
    seen.delete(id);
  };
  walk(view.root, 0);

  // An argument's target belongs beside the call it feeds, not in arbitrary
  // alphabetical position: `SMSSender` reads as subordinate to `notify` only
  // if it sits next to it.
  const feeds = new Map();          // argument target id -> consuming target id
  const seqOf = new Map();          // node id -> source ordinal of its first edge
  for (const e of view.edges) {
    if (!seqOf.has(e.to)) seqOf.set(e.to, e.ordinal ?? 0);
    if (e.kind === "argument" && e.enclosingSite) {
      const consuming = view.edges.find((o) => o.id === e.enclosingSite);
      if (consuming) feeds.set(e.to, consuming.to);
    }
  }
  for (const n of nodes.values()) n.isArgument = feeds.has(n.id);

  // An argument call docks INTO the call it feeds, so that only genuine
  // branches leave the caller. It stays free-standing when it has a subtree of
  // its own, or when something else also calls it -- docking would then hide a
  // node other edges point at.
  const hasOutgoing = new Set(view.edges.map((e) => e.from));
  // A symbol also called at statement level must keep its own node; two
  // arguments feeding the same call may both dock.
  const calledDirectly = new Set(
    view.edges.filter((e) => e.kind !== "argument").map((e) => e.to),
  );

  const dockedInto = new Map();   // consuming target id -> [{ node, edge }]
  const dockedIds = new Set();
  for (const e of view.edges) {
    if (e.kind !== "argument" || !e.enclosingSite) continue;
    if (hasOutgoing.has(e.to)) continue;
    if (calledDirectly.has(e.to)) continue;
    const consuming = view.edges.find((o) => o.id === e.enclosingSite);
    const node = consuming && nodes.get(e.to);
    if (!consuming || !node) continue;
    const list = dockedInto.get(consuming.to) ?? [];
    list.push({ node, edge: e });
    dockedInto.set(consuming.to, list);
    dockedIds.add(e.to);
  }
  for (const id of dockedIds) nodes.delete(id);

  const byDepth = new Map();
  for (const n of nodes.values()) {
    if (!byDepth.has(n.depth)) byDepth.set(n.depth, []);
    byDepth.get(n.depth).push(n);
  }
  const W = 210, H = 46, GAPX = 34, GAPY = 78, DOCK_H = 19;
  let maxPerRow = 0;
  for (const row of byDepth.values()) maxPerRow = Math.max(maxPerRow, row.length);
  const width = Math.max(maxPerRow * (W + GAPX) + GAPX, 560);
  for (const [depth, row] of byDepth) {
    // Order by source position, then pull each argument target in behind the
    // call it feeds.
    row.sort((a, b) => (seqOf.get(a.id) ?? 0) - (seqOf.get(b.id) ?? 0) || a.label.localeCompare(b.label));
    const ordered = [];
    for (const n of row) {
      if (n.isArgument) continue;
      ordered.push(n);
      for (const m of row) if (feeds.get(m.id) === n.id) ordered.push(m);
    }
    for (const n of row) if (!ordered.includes(n)) ordered.push(n);
    row.length = 0;
    row.push(...ordered);
    const rowW = row.length * W + (row.length - 1) * GAPX;
    let x = (width - rowW) / 2;
    for (const n of row) {
      const docks = (dockedInto.get(n.id) ?? []).length;
      n.x = x; n.y = GAPY / 2 + depth * (H + GAPY); n.w = W;
      n.h = H + docks * DOCK_H;
      x += W + GAPX;
    }
  }
  const height = (byDepth.size) * (H + GAPY) + GAPY;
  return { nodes, width, height, feeds, dockedInto, dockedIds, DOCK_H, H };
}

export function renderFlow(view) {
  if (!view.nodes.length) return `<p class="empty">This flow has no nodes.</p>`;
  const { nodes, width, height, feeds, dockedInto, dockedIds, DOCK_H, H } = layout(view);
  const COLLAPSE_DEPTH = 2;   // deeper argument nesting is summarised, not drawn
  const collapsed = new Map(); // consuming node id -> count hidden
  const parts = [];
  // The viewBox stays the whole graph; zoom sizes the ELEMENT and the
  // container scrolls natively. Text still re-rasterises rather than scaling
  // as a picture (design D5's reason), and the viewer gets real scrollbars and
  // a sense of where they are, which viewBox panning could not give.
  parts.push(
    `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" ` +
    `data-graph-width="${width}" data-graph-height="${height}" ` +
    `role="img" aria-label="call flow">`
  );
  parts.push(`<defs><marker id="a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="currentColor"/></marker></defs>`);

  for (const e of view.edges) {
    const a = nodes.get(e.from), b = nodes.get(e.to);
    if (!a || !b) continue;
    // A docked argument is drawn inside its consuming node, not as an edge
    // leaving the caller -- that parallel arrow is what made a sub-call look
    // like an alternative branch.
    if (dockedIds.has(e.to)) continue;
    if ((e.nestingDepth ?? 0) > COLLAPSE_DEPTH) {
      const host = view.edges.find((o) => o.id === e.enclosingSite);
      const key = host ? host.to : e.from;
      collapsed.set(key, (collapsed.get(key) ?? 0) + 1);
      continue;   // hidden from the drawing, still present in the view object
    }
    const x1 = a.x + a.w / 2, y1 = a.y + a.h;
    const x2 = b.x + b.w / 2, y2 = b.y;
    const my = (y1 + y2) / 2;
    const d = b.y <= a.y
      ? `M${x1},${y1} C${x1 + 90},${y1 + 40} ${x2 + 90},${y2 - 40} ${x2},${y2}`
      : `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
    const cls = `edge ${e.provenance}${e.stale ? " stale" : ""}${e.kind === "argument" ? " arg" : ""}`;
    const colorVar = e.stale ? "--stale" : e.provenance === "heuristic" ? "--heuristic"
      : e.provenance === "declared-unresolved" ? "--unresolved" : "--verified";
    parts.push(`<path class="${cls}" d="${d}" marker-end="url(#a)" style="color:var(${colorVar})"><title>${esc(e.id)}</title></path>`);
    // Source order, and the value flowing into the call it feeds.
    parts.push(`<text class="seq" x="${x1 + 6}" y="${y1 + 13}">${e.ordinal ?? 0}</text>`);
    if (e.kind === "argument" && e.enclosingSite) {
      const host = view.edges.find((o) => o.id === e.enclosingSite);
      const hostNode = host && nodes.get(host.to);
      if (hostNode) {
        const fx = b.x, fy = b.y + b.h / 2;
        const tx = hostNode.x + hostNode.w, ty = hostNode.y + hostNode.h / 2;
        parts.push(
          `<path class="feeds" d="M${fx},${fy} L${tx},${ty}" marker-end="url(#a)" style="color:var(--muted)">` +
          `<title>evaluated before ${esc(hostNode.label)}, and passed into it</title></path>`
        );
      }
    }
    if (e.conditionLabel) {
      const lx = (x1 + x2) / 2, ly = my;
      const w = Math.min(e.conditionLabel.length * 6.2 + 10, 230);
      parts.push(`<g class="elabel"><rect class="bg" x="${lx - w / 2}" y="${ly - 9}" width="${w}" height="16" rx="4"/>`);
      parts.push(`<text x="${lx}" y="${ly + 3}" text-anchor="middle">${esc(trunc(e.conditionLabel, 36))}<title>${esc(e.conditionLabel)}</title></text></g>`);
    }
  }

  for (const n of nodes.values()) {
    const cls = ["node", n.id === view.root ? "root" : "", n.stale ? "stale" : "",
      n.external ? "external" : "", n.isArgument ? "argument" : ""].filter(Boolean).join(" ");
    const sub = [n.external ? "external" : `${n.file}:${n.line + 1}`, n.truncated ? "truncated" : "", n.cycle ? "cycle" : ""].filter(Boolean).join(" · ");
    parts.push(
      `<g class="${cls}" data-id="${esc(n.id)}" data-file="${esc(n.file)}" ` +
      `data-line="${n.line}" tabindex="0" role="button">`
    );
    parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}"/>`);
    parts.push(`<text x="${n.x + 12}" y="${n.y + 20}">${esc(trunc(n.label, 24))}</text>`);
    parts.push(`<text class="sub" x="${n.x + 12}" y="${n.y + 35}">${esc(trunc(sub, 32))}</text>`);
    // Docked arguments: one row each, inside the node, clickable in their own
    // right so jump-to-source still works for them.
    const docks = dockedInto.get(n.id) ?? [];
    docks.forEach((d, i) => {
      const dy = n.y + H + i * DOCK_H;
      parts.push(`<line class="docksep" x1="${n.x + 1}" y1="${dy}" x2="${n.x + n.w - 1}" y2="${dy}"/>`);
      parts.push(
        `<g class="node dock" data-file="${esc(d.node.file)}" data-line="${d.node.line}" tabindex="0" role="button">`
      );
      parts.push(
        `<text x="${n.x + 12}" y="${dy + 14}">\u25c2 ${esc(trunc(d.node.label, 22))}</text>`
      );
      parts.push(
        `<title>${esc(d.node.qualifiedName)}\n${esc(d.node.file)}:${d.node.line + 1}` +
        `\nargument of ${esc(n.label)}, evaluated first</title></g>`
      );
    });

    // A visible focus control. Focus was a double-click and nothing else,
    // which is a gesture rather than a control: a reader who clicks once gets
    // a jump and concludes focus does not work.
    // Not on the root (nothing to focus to) and not on an external node,
    // which is never expanded, so focusing it would show only itself.
    if (n.id !== view.root && !n.external) {
      const cx = n.x + n.w - 15, cy = n.y + 15;
      parts.push(
        `<g class="focusbtn" data-focus-id="${esc(n.id)}" tabindex="0" role="button" ` +
        `aria-label="Focus ${esc(n.label)}">` +
        `<circle cx="${cx}" cy="${cy}" r="9"/>` +
        // A thumbtack, not a map pin: this pins a node, it does not mark a
        // place. Cap, flared collar, then the needle.
        `<path class="pin" d="M${cx - 4},${cy - 5.5} h8 v2 h-2.2 l1,4 h-5.6 l1,-4 h-2.2 z"/>` +
        `<path class="pinneedle" d="M${cx},${cy + 0.5} L${cx},${cy + 5}"/>` +
        `<title>Pin ${esc(n.label)}: show only what it reaches</title></g>`
      );
    }

    const hidden = collapsed.get(n.id);
    if (hidden) {
      parts.push(`<text class="badge" x="${n.x + n.w - 8}" y="${n.y + n.h - 6}" text-anchor="end">+${hidden} nested</text>`);
    }
    const feedsInto = feeds.get(n.id);
    const note = feedsInto ? `\nargument of ${esc(nodes.get(feedsInto)?.label ?? "")}, evaluated first` : "";
    parts.push(`<title>${esc(n.qualifiedName)}\n${esc(n.file)}:${n.line + 1}${note}${n.staleReasons.length ? "\nstale: " + esc(n.staleReasons.join(", ")) : ""}</title></g>`);

  }
  parts.push(`</svg>`);

  if (view.holes.length) {
    parts.push(`<h2 style="font-size:14px;margin:20px 0 6px">Unresolved dispatch (${view.holes.length})</h2><ul class="list">`);
    for (const h of view.holes) {
      parts.push(`<li><code>${esc(h.declaredTarget)}</code> — ${esc(h.reason)}, ${h.candidates.length} candidates<ul class="list">${h.candidates.map((c) => `<li><code>${esc(c)}</code></li>`).join("")}</ul></li>`);
    }
    parts.push(`</ul>`);
  }
  return parts.join("");
}

export function trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

export function renderDiff(v) {
  if (v.empty) return `<p class="empty">No structural change in <code>${esc(v.flow)}</code>.</p>`;
  const sec = (title, items) => items.length ? `<h2 style="font-size:14px;margin:18px 0 4px">${title} (${items.length})</h2><ul class="list">${items.join("")}</ul>` : "";
  return [
    sec("Newly reachable", v.newlyReachable.map((n) => `<li><code>${esc(n.label)}</code> ${esc(n.file)}:${n.line + 1}</li>`)),
    sec("Removed nodes", v.removedNodes.map((n) => `<li><code>${esc(n.label)}</code></li>`)),
    sec("Added edges", v.addedEdges.map((e) => `<li><code>${esc(e.id)}</code>${e.conditionLabel ? ` [${esc(e.conditionLabel)}]` : ""}</li>`)),
    sec("Removed edges", v.removedEdges.map((e) => `<li><code>${esc(e.id)}</code></li>`)),
    sec("Guard changed", v.conditionChanged.map((c) => `<li><code>${esc(c.edge.id)}</code><br><small>${esc(c.before || "(none)")} → ${esc(c.after || "(none)")}</small></li>`)),
  ].join("");
}

export function renderStale(v) {
  if (!v.stale) return `<p class="empty"><code>${esc(v.flow)}</code> is current.</p>`;
  return `<h2 style="font-size:14px;margin:0 0 6px">${v.entries.length} stale entries</h2><ul class="list">${v.entries.map((e) => `<li>${esc(e.kind)} <strong>${esc(e.reason)}</strong> — <code>${esc(e.label)}</code></li>`).join("")}</ul>`;
}

export function renderProvenance(v) {
  const tiers = Object.entries(v.tiers).map(([t, ids]) => `<li><code>${esc(t)}</code>: ${ids.length}</li>`).join("");
  const un = v.unresolved.map((u) => `<li><code>${esc(u.edgeId)}</code> → <code>${esc(u.declaredTarget)}</code> (${u.candidates.length} candidates)</li>`).join("");
  return `<h2 style="font-size:14px;margin:0 0 6px">Provenance</h2><ul class="list">${tiers}</ul>` +
    (un ? `<h2 style="font-size:14px;margin:18px 0 4px">Unresolved (${v.unresolved.length})</h2><ul class="list">${un}</ul>` : "");
}

