import { execFileSync } from "node:child_process";
import type { SymbolId } from "../analysis/types.ts";
import type { Flow, FlowNode } from "./model.ts";

export interface IdentityResult {
  /** old file path -> new file path, from version control rename detection. */
  movedFiles: Map<string, string>;
  /** old symbol id -> new symbol id, for identities we could establish exactly. */
  carried: Map<SymbolId, SymbolId>;
  /** Old ids with no exact match. Their entries are invalidated, not guessed. */
  invalidated: SymbolId[];
}

/**
 * Renames reported by git between `fromRev` and the working tree.
 * Returns an empty map outside a repository, or when git is unavailable.
 */
export function detectFileRenames(root: string, fromRev: string): Map<string, string> {
  const out = new Map<string, string>();
  let stdout: string;
  try {
    stdout = execFileSync("git", ["diff", "-M", "--name-status", fromRev, "--", "."], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return out;
  }
  for (const line of stdout.split("\n")) {
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    if (!status.startsWith("R")) continue;
    const from = parts[1];
    const to = parts[2];
    if (from && to) out.set(from, to);
  }
  return out;
}

function reId(id: SymbolId, oldFile: string, newFile: string): SymbolId {
  return id.startsWith(`${oldFile}#`) ? `${newFile}#${id.slice(oldFile.length + 1)}` : id;
}

/**
 * Establish which nodes in `previous` are the same nodes in `current`.
 *
 * Only two cases are matched, both exact (design D7): a file move reported by
 * version control, and a symbol renamed in place with an identical body hash.
 * Everything else invalidates. Approximate matching is deliberately absent --
 * a genuine restructure should invalidate broadly and earn a real review.
 */
export function reconcile(
  root: string,
  previous: Flow,
  current: Flow,
  opts: { fromRev?: string } = {},
): IdentityResult {
  const movedFiles = opts.fromRev ? detectFileRenames(root, opts.fromRev) : new Map();
  const carried = new Map<SymbolId, SymbolId>();
  const invalidated: SymbolId[] = [];

  const currentById = new Map(current.nodes.map((n) => [n.id, n]));
  const takenNew = new Set<SymbolId>();

  // Group surviving current nodes by (file, bodyHash) for the rename case.
  const byFileBody = new Map<string, FlowNode[]>();
  for (const n of current.nodes) {
    const key = `${n.file}\u0000${n.bodyHash}`;
    const list = byFileBody.get(key);
    if (list) list.push(n);
    else byFileBody.set(key, [n]);
  }

  for (const prev of previous.nodes) {
    // 1. Identical id: unchanged location and name.
    if (currentById.has(prev.id) && !takenNew.has(prev.id)) {
      carried.set(prev.id, prev.id);
      takenNew.add(prev.id);
      continue;
    }

    // 2. File move reported by git: rewrite the path component of the id.
    const movedTo = movedFiles.get(prev.file);
    if (movedTo) {
      const candidate = reId(prev.id, prev.file, movedTo);
      if (currentById.has(candidate) && !takenNew.has(candidate)) {
        carried.set(prev.id, candidate);
        takenNew.add(candidate);
        continue;
      }
    }

    // 3. Renamed in place: same file, identical IMPLEMENTATION body, exactly
    //    one match. The body hash excludes the signature, so a pure rename
    //    still matches; an ambiguous match invalidates rather than guessing.
    //    External symbols are skipped: they carry no body and would all collide.
    if (prev.external) {
      invalidated.push(prev.id);
      continue;
    }
    const file = movedTo ?? prev.file;
    const matches = (byFileBody.get(`${file}\u0000${prev.bodyHash}`) ?? []).filter(
      (n) => !takenNew.has(n.id),
    );
    if (matches.length === 1 && matches[0]) {
      carried.set(prev.id, matches[0].id);
      takenNew.add(matches[0].id);
      continue;
    }

    // 4. Anything else: invalidate. No approximate matching.
    invalidated.push(prev.id);
  }

  return { movedFiles, carried, invalidated };
}
