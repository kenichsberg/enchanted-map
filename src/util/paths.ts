import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Canonical absolute path, with symlinks resolved.
 *
 * Everything that compares a file against the project root must agree on the
 * form of that root. On macOS `/tmp` is a symlink to `/private/tmp`, and an
 * editor resolves it while a shell may not -- so the same project reaches the
 * analyzer under two different paths. `path.relative` between the two forms
 * then yields `../..`, every project file looks like it lives outside the
 * project, and the flow collapses into external stubs.
 *
 * Falls back to the resolved-but-unresolved path when the target does not
 * exist yet, which is the normal case for a directory about to be created.
 */
export function canonical(p: string): string {
  const abs = path.resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

const memo = new Map<string, string>();

/** Memoised `canonical`, for paths resolved once per file during a traversal. */
export function canonicalCached(p: string): string {
  const hit = memo.get(p);
  if (hit !== undefined) return hit;
  const resolved = canonical(p);
  memo.set(p, resolved);
  return resolved;
}
