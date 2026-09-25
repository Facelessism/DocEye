import { parse } from "yaml";
import { readTextInside, toRepoPath } from "./repository";
import { RULES, type FailOn, type Level, type RuleName } from "./types";

export class ConfigError extends Error {}

export type ExternalLinksConfig = {
  enabled: boolean;
  maxUrls: number;
  timeoutMs: number;
  concurrency: number;
  retries: number;
  /** Repo-relative .json file where successful results are remembered between runs. */
  cacheFile?: string;
  /** How long a remembered result stays valid. */
  cacheHours: number;
};

export type Config = {
  readme: string;
  /** Extra documentation files or directories scanned in addition to the README. */
  docs: string[];
  rules: Record<RuleName, Level>;
  ignore: string[];
  externalLinks: ExternalLinksConfig;
  failOn: FailOn;
};

export const CONFIG_FILENAMES = [".doceye.yml", ".doceye.yaml", "doceye.yml", "doceye.yaml"];

export function defaultConfig(): Config {
  return {
    readme: "README.md",
    docs: ["docs"],
    rules: {
      "local-links": "error",
      anchors: "warning",
      "external-links": "warning",
      "package-manager": "warning",
      "package-scripts": "error",
      commands: "error",
      paths: "warning",
      "config-files": "error",
      runtime: "warning",
      workflows: "error",
      docker: "error",
      license: "warning",
    },
    ignore: [],
    externalLinks: { enabled: true, maxUrls: 100, timeoutMs: 10_000, concurrency: 5, retries: 2, cacheHours: 168 },
    failOn: "error",
  };
}

const LEVELS = new Set<string>(["error", "warning", "notice", "off"]);
const FAIL_ON = new Set<string>(["error", "warning", "notice", "none"]);
const TOP_LEVEL_KEYS = new Set(["readme", "docs", "rules", "ignore", "external-links", "fail-on"]);

export function isFailOn(value: string): value is FailOn {
  return FAIL_ON.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ConfigError(`"${key}" must be a list of strings`);
  }
  return value as string[];
}

function boundedInt(value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`"external-links.${key}" must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** A cache file must be a .json path that stays inside the repository. */
export function cachePath(value: unknown): string {
  const normalized = typeof value === "string" ? toRepoPath(value) : undefined;
  if (normalized === undefined || !normalized.endsWith(".json")) {
    throw new ConfigError('"external-links.cache-file" must be a .json path inside the repository');
  }
  return normalized;
}

/** Parse and validate configuration YAML. Unknown keys are rejected so typos are not silently ignored. */
export function parseConfig(text: string, source = "configuration"): Config {
  let raw: unknown;
  try {
    raw = parse(text, { maxAliasCount: 10 });
  } catch (error) {
    throw new ConfigError(`${source} is not valid YAML: ${(error as Error).message}`);
  }
  const config = defaultConfig();
  if (raw === null || raw === undefined) return config;
  if (!isRecord(raw)) throw new ConfigError(`${source} must contain a YAML mapping`);

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) throw new ConfigError(`${source}: unknown key "${key}"`);
  }

  if (raw["readme"] !== undefined) {
    if (typeof raw["readme"] !== "string" || raw["readme"] === "") throw new ConfigError('"readme" must be a path string');
    config.readme = raw["readme"];
  }
  if (raw["docs"] !== undefined) config.docs = stringList(raw["docs"], "docs");
  if (raw["ignore"] !== undefined) config.ignore = stringList(raw["ignore"], "ignore");

  if (raw["fail-on"] !== undefined) {
    if (typeof raw["fail-on"] !== "string" || !isFailOn(raw["fail-on"])) {
      throw new ConfigError('"fail-on" must be one of: error, warning, notice, none');
    }
    config.failOn = raw["fail-on"];
  }

  if (raw["rules"] !== undefined) {
    if (!isRecord(raw["rules"])) throw new ConfigError('"rules" must be a mapping of rule name to level');
    for (const [name, level] of Object.entries(raw["rules"])) {
      if (!(RULES as readonly string[]).includes(name)) {
        throw new ConfigError(`unknown rule "${name}". Known rules: ${RULES.join(", ")}`);
      }
      if (typeof level !== "string" || !LEVELS.has(level)) {
        throw new ConfigError(`rule "${name}" must be one of: error, warning, notice, off`);
      }
      config.rules[name as RuleName] = level as Level;
    }
  }

  const external = raw["external-links"];
  if (external !== undefined) {
    if (!isRecord(external)) throw new ConfigError('"external-links" must be a mapping');
    for (const [key, value] of Object.entries(external)) {
      switch (key) {
        case "enabled":
          if (typeof value !== "boolean") throw new ConfigError('"external-links.enabled" must be true or false');
          config.externalLinks.enabled = value;
          break;
        case "max-urls":
          config.externalLinks.maxUrls = boundedInt(value, key, 0, 1000);
          break;
        case "timeout-ms":
          config.externalLinks.timeoutMs = boundedInt(value, key, 100, 60_000);
          break;
        case "concurrency":
          config.externalLinks.concurrency = boundedInt(value, key, 1, 20);
          break;
        case "retries":
          config.externalLinks.retries = boundedInt(value, key, 0, 5);
          break;
        case "cache-hours":
          config.externalLinks.cacheHours = boundedInt(value, key, 0, 720);
          break;
        case "cache-file":
          config.externalLinks.cacheFile = cachePath(value);
          break;
        default:
          throw new ConfigError(`${source}: unknown key "external-links.${key}"`);
      }
    }
  }
  return config;
}

/** Load the explicit config file, or the first default-named one; defaults if none exists. */
export async function loadConfig(root: string, explicitPath?: string): Promise<{ config: Config; path?: string }> {
  const candidates = explicitPath ? [explicitPath] : CONFIG_FILENAMES;
  for (const candidate of candidates) {
    const text = await readTextInside(root, candidate, 256 * 1024);
    if (text !== undefined) return { config: parseConfig(text, candidate), path: candidate };
    if (explicitPath) throw new ConfigError(`config file not found: ${explicitPath}`);
  }
  return { config: defaultConfig() };
}

/** `*` matches within a path segment and `**` across segments. Everything else, including `?`, is literal. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === "*" && glob[i + 1] === "*") {
      source += ".*";
      i++;
    } else if (ch === "*") source += "[^/]*";
    else source += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** A finding is ignored if an entry matches the file it is in or the thing it refers to. */
export function isIgnored(config: Pick<Config, "ignore">, file: string | undefined, subject: string | undefined): boolean {
  return config.ignore.some((entry) => {
    const pattern = globToRegExp(entry.replace(/^\.\//, ""));
    return (file !== undefined && pattern.test(file)) || (subject !== undefined && pattern.test(subject));
  });
}
