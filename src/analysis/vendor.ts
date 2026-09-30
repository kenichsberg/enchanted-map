/**
 * Which files are the project's own source, and which are dependencies that
 * merely live inside its directory.
 *
 * The original test — does the path escape the project root — was written
 * against typeshed, which basedpyright ships inside its own node_modules. It
 * answers correctly there and wrongly for a virtualenv, which is the ordinary
 * Python arrangement: `<project>/.venv/` does not escape anything, so every
 * dependency read as first-party and was traversed.
 */

/**
 * Directory names that mark third-party code.
 *
 * Deliberately short. Every entry is a name that could plausibly hold
 * first-party code, and a marker that hides real source is a worse failure
 * than one that lets a dependency through (design D6).
 */
export const DEFAULT_VENDOR_MARKERS: readonly string[] = [
  ".venv",
  "venv",
  "env",
  "site-packages",
  "node_modules",
  "__pycache__",
  ".tox",
  ".nox",
  "vendor",
];

/** How a project's stated markers relate to the defaults (design D4). */
export interface VendorConfig {
  /** Added to the base set. */
  extend?: string[];
  /** Used as the base set instead of the defaults. */
  replace?: string[];
}

/**
 * The effective marker set.
 *
 * A bare list would be ambiguous — a reader could not tell whether it adds to
 * or overrides the defaults — and guessing "replace" silently loses `.venv`
 * for someone who only meant to add one directory.
 */
export function resolveMarkers(config?: VendorConfig | null): string[] {
  const base = config?.replace ?? DEFAULT_VENDOR_MARKERS;
  const extra = config?.extend ?? [];
  return [...new Set([...base, ...extra])];
}

function segments(relPath: string): string[] {
  return relPath.split("/").filter((s) => s.length > 0);
}

/**
 * True when any directory in the path is a marker.
 *
 * Segment equality, not prefix or substring (design D1): a prefix test misses
 * `libs/vendor/...`, and a substring test wrongly catches `my_venv_helpers.py`.
 */
export function isVendored(relPath: string, markers: readonly string[]): boolean {
  const set = new Set(markers);
  // The final segment is the file itself; a file named `vendor` is not a
  // vendored directory.
  const dirs = segments(relPath).slice(0, -1);
  return dirs.some((s) => set.has(s));
}

/**
 * A machine- and toolchain-independent label for a third-party file.
 *
 * Strips up to and including the LAST marker segment, because nesting is
 * normal — `site-packages` sits under `.venv` — and the last one yields the
 * dependency's own path. That also removes the interpreter version, so two
 * developers on different Python patch releases store identical bytes
 * (design D3).
 *
 *   .venv/lib/python3.13/site-packages/pandas/core/frame.py
 *     -> <ext>/pandas/core/frame.py
 */
export function externalLabel(relPath: string, markers: readonly string[]): string {
  const set = new Set(markers);
  const parts = segments(relPath);
  let last = -1;
  for (let i = 0; i < parts.length - 1; i++) {
    if (set.has(parts[i] as string)) last = i;
  }
  if (last >= 0) return `<ext>/${parts.slice(last + 1).join("/")}`;
  return `<ext>/${parts[parts.length - 1] ?? relPath}`;
}

/** A path outside the project root escapes it with a leading `..`. */
export function escapesRoot(relPath: string): boolean {
  return relPath.startsWith("../") || relPath.startsWith("/");
}

/**
 * Not part of the project's own source: either outside the root, or vendored
 * inside it. The two are deliberately indistinguishable downstream (design D2).
 */
export function isExternal(relPath: string, markers: readonly string[]): boolean {
  return escapesRoot(relPath) || isVendored(relPath, markers);
}
