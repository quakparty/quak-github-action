// Reads and checks the inputs of the action. GitHub hands every input over as a string in INPUT_<NAME>. Everything is
// checked before a request goes out, and every problem is reported at once, so one run shows all of them.

export const KINDS = ["text", "sound", "clip", "file", "url"] as const;
export type Kind = (typeof KINDS)[number];

const INTENSITIES = ["off", "weak", "medium", "strong"];

/** The longest text the API speaks. */
export const MAX_TEXT_CHARACTERS = 1000;

/** The options every play kind shares, in the API's names. Unset inputs stay out, so Quak uses its defaults. */
export type PlayOptions = {
  to?: string[];
  volume?: number;
  volumes?: Record<string, number>;
  voice?: string;
  language?: string;
  intro?: string;
  outro?: string;
  gap?: number;
  effect?: string;
  effectIntensity?: string;
  ambience?: string;
  ambienceIntensity?: string;
  quietHours?: string;
  priority?: boolean;
  preview?: boolean;
  process?: boolean;
  skipCache?: boolean;
  startIn?: number;
};

export type Inputs = {
  apiKey: string;
  kind: Kind;
  /** The text, sound slug, clip slug, file path or URL. */
  content: string;
  options: PlayOptions;
  /** Inputs set that do nothing for this play, because it is not processed. */
  ignored: string[];
};

/** Problems with the inputs, all of them. */
export class InputError extends Error {
  override name = "InputError";
  constructor(readonly problems: string[]) {
    super(problems.join("\n"));
  }
}

export type Env = Record<string, string | undefined>;

/** An input as GitHub passes it, trimmed; "" when it is not set. */
export function input(env: Env, name: string): string {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

/** Inputs that only work when the play is processed. */
const PROCESSING = [
  "intro",
  "outro",
  "gap",
  "effect",
  "effect-intensity",
  "ambience",
  "ambience-intensity",
  "skip-cache",
];

export function parseInputs(env: Env): Inputs {
  const problems: string[] = [];
  const get = (name: string) => input(env, name);

  const apiKey = get("api-key");

  const type = get("type");
  let kind: Kind = "text";
  if (!type) {
    problems.push(`type is missing. Set it to one of ${KINDS.join(", ")}.`);
  } else if (!(KINDS as readonly string[]).includes(type)) {
    problems.push(`type "${type}" is unknown. Use one of ${KINDS.join(", ")}.`);
  } else {
    kind = type as Kind;
  }
  const kindKnown = (KINDS as readonly string[]).includes(type);

  const content = get(kind);
  if (kindKnown) {
    if (!content) {
      problems.push(`type is ${kind}, but the input ${kind} is empty.`);
    }
    for (const other of KINDS) {
      if (other !== kind && get(other)) {
        problems.push(`${other} is set, but type is ${kind}. Set only the input that matches type.`);
      }
    }
  }
  if (kindKnown && kind === "text" && content.length > MAX_TEXT_CHARACTERS) {
    problems.push(`text has ${content.length} characters, Quak speaks at most ${MAX_TEXT_CHARACTERS}.`);
  }
  if (kindKnown && kind === "url" && content && !isHttpUrl(content)) {
    problems.push("url must be an http:// or https:// address.");
  }

  const options: PlayOptions = {};
  const string = (name: string, key: keyof PlayOptions) => {
    const value = get(name);
    if (value) {
      (options as Record<string, unknown>)[key] = value;
    }
  };
  const integer = (name: string, key: keyof PlayOptions, min: number, max: number, step = 1) => {
    const value = get(name);
    if (!value) {
      return;
    }
    const number = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!(number >= min && number <= max && number % step === 0)) {
      const steps = step === 1 ? "" : ` in steps of ${step}`;
      problems.push(`${name} must be a whole number from ${min} to ${max}${steps}, not "${value}".`);
      return;
    }
    (options as Record<string, unknown>)[key] = number;
  };
  const boolean = (name: string, key: keyof PlayOptions) => {
    const value = get(name);
    if (!value) {
      return;
    }
    if (["true", "True", "TRUE"].includes(value)) {
      (options as Record<string, unknown>)[key] = true;
    } else if (["false", "False", "FALSE"].includes(value)) {
      (options as Record<string, unknown>)[key] = false;
    } else {
      problems.push(`${name} must be true or false, not "${value}".`);
    }
  };
  const intensity = (name: string, key: keyof PlayOptions) => {
    const value = get(name);
    if (value && !INTENSITIES.includes(value)) {
      problems.push(`${name} must be one of ${INTENSITIES.join(", ")}, not "${value}".`);
      return;
    }
    string(name, key);
  };

  const to = get("to");
  if (to) {
    const speakers = to
      .split(",")
      .map((slug) => slug.trim())
      .filter(Boolean);
    if (speakers.length === 0) {
      problems.push('to has no speaker in it. Use slugs separated by commas, like "office, kitchen".');
    } else {
      options.to = speakers;
    }
  }
  integer("volume", "volume", 1, 100);
  const volumes = get("volumes");
  if (volumes) {
    const parsed = parseVolumes(volumes);
    if (typeof parsed === "string") {
      problems.push(parsed);
    } else {
      options.volumes = parsed;
    }
  }
  for (const name of ["voice", "language"]) {
    if (get(name) && kindKnown && kind !== "text") {
      problems.push(`${name} only works with type text.`);
    }
  }
  string("voice", "voice");
  string("language", "language");
  string("intro", "intro");
  string("outro", "outro");
  integer("gap", "gap", 0, 1000, 100);
  string("effect", "effect");
  intensity("effect-intensity", "effectIntensity");
  string("ambience", "ambience");
  intensity("ambience-intensity", "ambienceIntensity");
  string("quiet-hours", "quietHours");
  boolean("priority", "priority");
  boolean("preview", "preview");
  boolean("process", "process");
  boolean("skip-cache", "skipCache");
  const startIn = get("start-in");
  if (startIn) {
    const number = /^\d+(\.\d+)?$/.test(startIn) ? Number(startIn) : NaN;
    if (number >= 0 && number <= 60) {
      options.startIn = number;
    } else {
      problems.push(`start-in must be a number of seconds from 0 to 60, not "${startIn}".`);
    }
  }

  if (options.process === false && (kind === "text" || kind === "file")) {
    problems.push(`process: false does not work with type ${kind}, Quak always processes it. Remove process.`);
  }

  if (problems.length > 0) {
    throw new InputError(problems);
  }

  // Sounds and clips play as stored unless process is true, URLs are processed unless it is false. Without
  // processing Quak ignores these inputs; the action says so instead of switching processing on by itself.
  const processed =
    kind === "sound" || kind === "clip" ? options.process === true : kind === "url" ? options.process !== false : true;
  const ignored = processed ? [] : PROCESSING.filter((name) => get(name));

  return { apiKey, kind, content, options, ignored };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseVolumes(value: string): Record<string, number> | string {
  const problem = `volumes must be a JSON object of speaker slugs and volumes from 1 to 100, like {"office": 30, "kitchen": 60}.`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return problem;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return problem;
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    return problem;
  }
  for (const [slug, volume] of entries) {
    if (!slug.trim() || !Number.isInteger(volume) || (volume as number) < 1 || (volume as number) > 100) {
      return problem;
    }
  }
  return parsed as Record<string, number>;
}
