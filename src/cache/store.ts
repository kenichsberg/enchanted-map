import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { canonical } from "../util/paths.ts";

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 32);
}

export function hashParts(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 32);
}

/**
 * Content-addressed store for derived facts.
 *
 * Lives outside version control: everything here is regenerable from source
 * and must never be reviewed (design D8).
 */
export class FactCache {
  readonly dir: string;
  #memo = new Map<string, unknown>();
  #fileHashes = new Map<string, string>();
  #root: string;
  #hits = 0;
  #misses = 0;

  constructor(root: string, dir?: string) {
    this.#root = canonical(root);
    this.dir = dir ?? path.join(this.#root, ".enchanted", "cache");
    mkdirSync(this.dir, { recursive: true });
  }

  get stats(): { hits: number; misses: number } {
    return { hits: this.#hits, misses: this.#misses };
  }

  /** Content hash of a repo-relative file, memoised for the run. */
  fileHash(file: string): string {
    const cached = this.#fileHashes.get(file);
    if (cached !== undefined) return cached;
    let h: string;
    try {
      h = hashContent(readFileSync(path.resolve(this.#root, file), "utf8"));
    } catch {
      h = "missing";
    }
    this.#fileHashes.set(file, h);
    return h;
  }

  /** Drop memoised file hashes so a re-read sees edits made since. */
  invalidateFileHashes(): void {
    this.#fileHashes.clear();
  }

  #pathFor(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  get<T>(key: string): T | undefined {
    if (this.#memo.has(key)) {
      this.#hits++;
      return this.#memo.get(key) as T;
    }
    const file = this.#pathFor(key);
    if (!existsSync(file)) {
      this.#misses++;
      return undefined;
    }
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as T;
      this.#memo.set(key, value);
      this.#hits++;
      return value;
    } catch {
      this.#misses++;
      return undefined;
    }
  }

  set<T>(key: string, value: T): void {
    this.#memo.set(key, value);
    writeFileSync(this.#pathFor(key), JSON.stringify(value), "utf8");
  }

  clear(): void {
    this.#memo.clear();
    this.#fileHashes.clear();
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
  }
}
