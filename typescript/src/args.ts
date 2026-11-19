/** Dependency-free command-line argument parsing. */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface FlagSpec {
  /** Kebab-case flag name without the leading dashes, e.g. "max-iterations". */
  name: string;
  short?: string;
  type: "string" | "number" | "boolean";
  description: string;
  /** Placeholder shown in help for value-taking flags, e.g. "<url>". */
  valueName?: string;
  /** Excluded from help output (test-only flags). */
  hidden?: boolean;
}

export type FlagValues = Record<string, string | number | boolean | undefined>;

export interface ParsedArgs {
  flags: FlagValues;
  positionals: string[];
  helpRequested: boolean;
}

export function parseArgs(argv: string[], spec: FlagSpec[]): ParsedArgs {
  const byName = new Map(spec.map(flag => [flag.name, flag]));
  const byShort = new Map(spec.filter(flag => flag.short).map(flag => [flag.short!, flag]));
  argv = [...argv];
  const flags: FlagValues = {};
  const positionals: string[] = [];
  let helpRequested = false;
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (positionalOnly || !token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      positionalOnly = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      helpRequested = true;
      continue;
    }

    const long = token.startsWith("--");
    const equals = token.indexOf("=");
    const option = long ? (equals === -1 ? token.slice(2) : token.slice(2, equals)) : token[1];
    const flag = long ? byName.get(option) : byShort.get(option);
    if (!flag) throw new UsageError(`Unknown option ${long ? "--" : "-"}${option}`);
    const name = flag.name;
    let inlineValue = long
      ? (equals === -1 ? undefined : token.slice(equals + 1))
      : (token.length === 2 ? undefined : token.slice(token[2] === "=" ? 3 : 2));
    if (!long && flag.type === "boolean" && inlineValue !== undefined && token[2] !== "=") {
      argv.splice(index + 1, 0, `-${inlineValue}`);
      inlineValue = undefined;
    }

    if (flag.type === "boolean") {
      if (inlineValue !== undefined) {
        throw new UsageError(`Option --${name} does not take a value`);
      }
      flags[name] = true;
      continue;
    }

    let value = inlineValue;
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || (next.startsWith("-") && next.length > 1 && !(flag.type === "number" && Number.isFinite(Number(next))))) {
        throw new UsageError(`Option --${name} requires a value`);
      }
      value = next;
      index += 1;
    }
    if (value.length === 0) throw new UsageError(`Option --${name} requires a value`);

    if (flag.type === "number") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        throw new UsageError(`Option --${name} expects a number, got "${value}"`);
      }
      flags[name] = parsed;
    } else {
      flags[name] = value;
    }
  }

  return { flags, positionals, helpRequested };
}

export function formatFlagHelp(spec: FlagSpec[]): string {
  const visible = spec.filter(flag => !flag.hidden);
  const rendered = visible.map(flag => ({
    left: `  ${flag.short ? `-${flag.short}, ` : ""}--${flag.name}${flag.type === "boolean" ? "" : ` ${flag.valueName ?? "<value>"}`}`,
    right: flag.description,
  }));
  const width = Math.max(...rendered.map(entry => entry.left.length), 0) + 2;
  return rendered
    .map(entry => `${entry.left.padEnd(width)}${entry.right}`)
    .join("\n");
}

export function stringFlag(flags: FlagValues, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function numberFlag(flags: FlagValues, name: string): number | undefined {
  const value = flags[name];
  return typeof value === "number" ? value : undefined;
}

export function booleanFlag(flags: FlagValues, name: string): boolean {
  return flags[name] === true;
}
