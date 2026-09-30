import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { VendorConfig } from "../analysis/vendor.ts";

export interface EntryPointDecl {
  name: string;
  file: string;
  symbol: string;
}

export interface ProjectConfig {
  entryPoints: EntryPointDecl[];
  maxDepth: number;
  /**
   * Directory names marking third-party code. Absent means the defaults;
   * `extend` adds to them, `replace` sets the base instead (design D4).
   */
  vendor?: VendorConfig;
}

export const DEFAULT_MAX_DEPTH = 3;

export function configPath(root: string): string {
  return path.join(root, ".enchanted", "config.yaml");
}

export function flowsDir(root: string): string {
  return path.join(root, ".enchanted", "flows");
}

export function loadConfig(root: string): ProjectConfig {
  const file = configPath(root);
  if (!existsSync(file)) return { entryPoints: [], maxDepth: DEFAULT_MAX_DEPTH };
  const raw = YAML.parse(readFileSync(file, "utf8")) as Partial<ProjectConfig> | null;
  const entryPoints = Array.isArray(raw?.entryPoints) ? raw.entryPoints : [];
  const vendor = raw?.vendor;
  const cleaned: VendorConfig | undefined =
    vendor && (Array.isArray(vendor.extend) || Array.isArray(vendor.replace))
      ? {
          ...(Array.isArray(vendor.extend) ? { extend: vendor.extend } : {}),
          ...(Array.isArray(vendor.replace) ? { replace: vendor.replace } : {}),
        }
      : undefined;
  return {
    entryPoints: entryPoints.filter(
      (e): e is EntryPointDecl => Boolean(e?.name && e?.file && e?.symbol),
    ),
    maxDepth: typeof raw?.maxDepth === "number" ? raw.maxDepth : DEFAULT_MAX_DEPTH,
    ...(cleaned ? { vendor: cleaned } : {}),
  };
}

export function saveConfig(root: string, config: ProjectConfig): void {
  const file = configPath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  const sorted: ProjectConfig = {
    entryPoints: [...config.entryPoints].sort((a, b) => a.name.localeCompare(b.name)),
    maxDepth: config.maxDepth,
    ...(config.vendor ? { vendor: config.vendor } : {}),
  };
  writeFileSync(file, YAML.stringify(sorted, { lineWidth: 0 }), "utf8");
}

/** Add or replace an entry point, returning the updated config. */
export function declareEntryPoint(root: string, decl: EntryPointDecl): ProjectConfig {
  const config = loadConfig(root);
  const next = config.entryPoints.filter((e) => e.name !== decl.name);
  next.push(decl);
  const updated: ProjectConfig = { ...config, entryPoints: next };
  saveConfig(root, updated);
  return updated;
}
