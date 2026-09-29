import { readFileSync } from "node:fs";
import path from "node:path";

export const FIXTURE = path.resolve(import.meta.dirname, "fixtures/pyproj");

/** Locate `def <name>` (or `class <name>`) and return a 0-based LSP position of the name. */
export function findDef(
  file: string,
  name: string,
  occurrence = 0,
): { line: number; character: number } {
  const text = readFileSync(path.join(FIXTURE, file), "utf8");
  const lines = text.split("\n");
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = new RegExp(`^\\s*(?:def|class)\\s+(${name})\\b`).exec(lines[i] ?? "");
    if (m && m[1]) {
      if (seen++ < occurrence) continue;
      return { line: i, character: (lines[i] ?? "").indexOf(name) };
    }
  }
  throw new Error(`no definition of ${name} in ${file}`);
}
