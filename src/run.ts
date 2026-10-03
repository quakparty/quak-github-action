// One run of the action: check the inputs, send one play, report it. Returns the exit code; nothing here exits the
// process, so the tests drive it with their own environment, fetch and log.

import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Quak, QuakError, type Play, type PlayTextParams } from "@quak/js";
import { createRunner, type Runner } from "./github.js";
import { InputError, input, parseInputs, type Env, type Inputs } from "./inputs.js";
import pkg from "../package.json" with { type: "json" };

/**
 * How long the action waits for Quak's answer. Plays answer within seconds; the slow cases are a URL Quak downloads
 * first (up to 15 s on its side) and a long text or file it processes. No input for it: nobody should have to tune it.
 */
export const TIMEOUT_MS = 30_000;

/** The upload limit of the API (PLAY_LIMITS.uploadBytes). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export type RunOptions = {
  env: Env;
  /** One line to the log. */
  write: (line: string) => void;
  /** Replaces the global fetch (tests). */
  fetch?: typeof globalThis.fetch;
  /** The API to talk to; the action itself has no input for it. */
  baseUrl?: string;
  timeoutMs?: number;
};

/**
 * A failed announcement does not fail the step unless the input fail-on-error is true: the run stays green, the error
 * is still an annotation on its summary page.
 */
export async function run(options: RunOptions): Promise<number> {
  const runner = createRunner(options.env, options.write);
  // The key is masked before anything else is written, in case it did not come from a secret.
  const apiKey = input(options.env, "api-key");
  if (apiKey) {
    runner.mask(apiKey);
  }
  const failOnError = parseFailOnError(options.env, runner);
  const code = await playOnce(options, runner);
  if (code !== 0 && !failOnError) {
    runner.info("The step passes anyway. Set fail-on-error: true to fail it.");
    return 0;
  }
  return code;
}

/** fail-on-error, false when unset or invalid (an invalid value is reported and counts as a failure). */
function parseFailOnError(env: Env, runner: Runner): boolean {
  const value = input(env, "fail-on-error");
  if (["true", "True", "TRUE"].includes(value)) {
    return true;
  }
  if (value && !["false", "False", "FALSE"].includes(value)) {
    runner.warning(`fail-on-error must be true or false, not "${value}". Using false.`);
  }
  return false;
}

async function playOnce(options: RunOptions, runner: Runner): Promise<number> {
  const { env } = options;

  let inputs: Inputs;
  try {
    inputs = parseInputs(env);
  } catch (error) {
    if (error instanceof InputError) {
      for (const problem of error.problems) {
        runner.error(problem);
      }
      return 1;
    }
    throw error;
  }

  if (!inputs.apiKey) {
    const without = runsWithoutSecrets(env);
    if (without) {
      // Secrets are not passed to these runs. The play is left out instead of failing a contributor's pull request.
      runner.warning(`Nothing played: api-key is empty, because ${without} get no secrets.`);
      return 0;
    }
    runner.error(
      "api-key is empty. Add the key as the repository secret QUAK_API_KEY (Settings → Secrets and variables → " +
        "Actions) and pass it with api-key: ${{ secrets.QUAK_API_KEY }}.",
    );
    return 1;
  }

  if (inputs.ignored.length > 0) {
    const what = inputs.kind === "url" ? "the URL is played without processing" : `the ${inputs.kind} plays as stored`;
    runner.warning(
      `${list(inputs.ignored)} ${inputs.ignored.length === 1 ? "has" : "have"} no effect: ${what}. ` +
        (inputs.kind === "url" ? "Remove process: false to use them." : "Set process: true to use them."),
    );
  }

  let file: { bytes: Uint8Array; name: string } | undefined;
  if (inputs.kind === "file") {
    const loaded = await loadFile(inputs.content, env, runner);
    if (!loaded) {
      return 1;
    }
    file = loaded;
  }

  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const quak = new Quak({
    apiKey: inputs.apiKey,
    client: `github-action/${pkg.version}`,
    fetch: guardedFetch(options.fetch ?? globalThis.fetch, timeoutMs),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  });

  let play: Play;
  try {
    const response = await send(quak, inputs, file);
    play = checkPlay(response);
  } catch (error) {
    runner.error(describeError(error, timeoutMs));
    return 1;
  }

  return report(play, inputs, file?.name, quak.credits, runner);
}

// --- Sending -----------------------------------------------------------------------------------------------------

function send(quak: Quak, inputs: Inputs, file: { bytes: Uint8Array; name: string } | undefined) {
  // effect and ambience are beta and their values change on the API's side, so the API checks them, not the action.
  const { content } = inputs;
  const options = inputs.options as Omit<PlayTextParams, "text">;
  switch (inputs.kind) {
    case "text":
      return quak.play.text({ ...options, text: content });
    case "sound":
      return quak.play.sound({ ...options, sound: content });
    case "clip":
      return quak.play.clip({ ...options, clip: content });
    case "file":
      return quak.play.file({ ...options, file: file!.bytes, filename: file!.name });
    case "url":
      return quak.play.url({ ...options, url: content });
  }
}

/**
 * The fetch for the client: a bounded wait, and redirects are not followed (they would carry the key elsewhere).
 * Never a retry: a lost answer can still mean the play went out, and a second request would play it twice.
 */
function guardedFetch(fetch: typeof globalThis.fetch, timeoutMs: number): typeof globalThis.fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) })) as typeof globalThis.fetch;
}

async function loadFile(path: string, env: Env, runner: Runner): Promise<{ bytes: Uint8Array; name: string } | null> {
  const full = resolve(env.GITHUB_WORKSPACE || process.cwd(), path);
  let size: number;
  try {
    const stat = statSync(full);
    if (!stat.isFile()) {
      runner.error(`file ${path} is not a file.`);
      return null;
    }
    size = stat.size;
  } catch {
    runner.error(
      `file ${path} does not exist (looked in ${full}). Paths are relative to the workspace; create the file in an ` +
        "earlier step or check out the repository first.",
    );
    return null;
  }
  if (size === 0) {
    runner.error(`file ${path} is empty.`);
    return null;
  }
  if (size > MAX_FILE_BYTES) {
    runner.error(`file ${path} has ${megabytes(size)}, Quak takes at most ${megabytes(MAX_FILE_BYTES)}.`);
    return null;
  }
  return { bytes: new Uint8Array(await readFile(full)), name: basename(full) };
}

// --- Answers -----------------------------------------------------------------------------------------------------

/** A 2xx answer has to be a play; anything else is reported instead of guessed at. */
function checkPlay(response: unknown): Play {
  const play = (response as { data?: unknown } | undefined)?.data as Partial<Play> | undefined;
  if (typeof play !== "object" || play === null || typeof play.id !== "string" || typeof play.status !== "string") {
    throw new UnexpectedAnswer();
  }
  return play as Play;
}

class UnexpectedAnswer extends Error {}

function report(play: Play, inputs: Inputs, fileName: string | undefined, left: number | null, runner: Runner): number {
  runner.setOutput("play-id", play.id);
  runner.setOutput("status", play.status);
  runner.setOutput("skip-reason", play.skipReason ?? "");
  runner.setOutput("audio-url", play.audioUrl ?? "");
  runner.setOutput("credits", typeof play.credits === "number" ? String(play.credits) : "");
  runner.setOutput("starts-at", play.startsAt ?? "");
  runner.debug(`play ${play.id}: status ${play.status}, from cache ${play.fromCache}`);

  const what = describeContent(inputs, fileName);
  const players = Array.isArray(play.players) ? play.players : [];
  const speakers = players.map((player) => player.name || player.slug).filter(Boolean);
  const on = speakers.length > 0 ? ` on ${list(speakers)}` : "";
  const to = speakers.length > 0 ? ` to ${list(speakers)}` : "";
  const cost = describeCredits(play.credits);
  // The balance stays out of the log: logs of public repositories are public. Debug logging needs write access.
  if (left !== null) {
    runner.debug(`credits left: ${left}`);
  }

  if (play.status === "SKIPPED") {
    const why =
      play.skipReason === "QUIET_HOURS"
        ? "it is quiet hours"
        : play.skipReason === "BUSY"
          ? "every speaker is busy with a play of higher priority"
          : "Quak skipped it";
    runner.notice(`Nothing played: ${why}. The ${inputs.kind} was not announced${on}.`);
    return 0;
  }

  if (play.status === "FAILED") {
    const errors = players.filter((player) => player.error).map((player) => `${player.name}: ${player.error}`);
    runner.error(
      `Quak could not play the ${inputs.kind}${on}${errors.length ? ` (${errors.join("; ")})` : ""}. Check the speakers in Quak.`,
    );
    return 1;
  }

  if (play.preview) {
    runner.info(
      `Quak: preview of ${what} made, nothing played on the speakers${cost}. The audio is in the output audio-url.`,
    );
    return 0;
  }

  if (play.status === "SCHEDULED") {
    const at = play.startsAt ? ` for ${play.startsAt.replace("T", " ").replace(/\.\d+Z$|Z$/, " UTC")}` : "";
    runner.info(`Quak: ${what} scheduled${at}${to}${cost}.`);
  } else {
    runner.info(`Quak: ${what} sent${to}${cost}.`);
  }

  // Some speakers can fail while others play: worth a warning, not a failed step.
  const failed = players.filter((player) => player.status === "FAILED");
  if (failed.length > 0) {
    const names = failed.map((player) => (player.error ? `${player.name} (${player.error})` : player.name));
    runner.warning(`Not played on ${list(names)}.`);
  }
  return 0;
}

/** What was played, without the text or URL itself: those can hold things that do not belong in a public log. */
function describeContent(inputs: Inputs, fileName: string | undefined): string {
  switch (inputs.kind) {
    case "text":
      return `text (${inputs.content.length} characters)`;
    case "sound":
      return `sound "${inputs.content}"`;
    case "clip":
      return `clip "${inputs.content}"`;
    case "file":
      return `file ${fileName}`;
    case "url":
      return "audio from a URL";
  }
}

function describeCredits(used: unknown): string {
  return typeof used === "number" ? ` (${used} ${used === 1 ? "credit" : "credits"})` : "";
}

// --- Errors ------------------------------------------------------------------------------------------------------

/** Advice for the API errors that someone setting up a workflow runs into. */
const HINTS: Record<string, string> = {
  ERROR_INVALID_API_KEY: "Check the secret QUAK_API_KEY: the key is unknown or was deleted.",
  ERROR_MISSING_API_KEY: "Check the secret QUAK_API_KEY.",
  ERROR_INSUFFICIENT_SCOPE: "The key needs the scope play.",
  ERROR_SONOS_RECONNECT_REQUIRED: "Reconnect Sonos in Quak.",
  ERROR_TOO_MANY_REQUESTS: "Too many plays in a short time, try again later.",
};

const CREDIT_ERRORS = ["ERROR_INSUFFICIENT_CREDITS", "ERROR_NOT_ENOUGH_CREDITS"];

export function describeError(error: unknown, timeoutMs = TIMEOUT_MS): string {
  if (error instanceof UnexpectedAnswer) {
    return "Quak sent an answer the action does not understand. The play may have gone out anyway.";
  }
  if (!(error instanceof QuakError)) {
    return `Unexpected error: ${clean(error instanceof Error ? error.message : String(error))}`;
  }
  if (error.status === 0) {
    const cause = error.cause as { name?: string } | undefined;
    if (cause?.name === "TimeoutError") {
      return (
        `Quak did not answer within ${timeoutMs / 1000} s. The play may have gone out anyway, so the action does ` +
        "not try again."
      );
    }
    if (cause instanceof SyntaxError) {
      return "Quak sent an answer that is not JSON. The play may have gone out anyway.";
    }
    return `Could not reach Quak: ${clean(error.message.replace(/^network error: /, ""))}.`;
  }
  if (error.status >= 300 && error.status < 400) {
    return `Quak answered with a redirect (HTTP ${error.status}), which the action does not follow.`;
  }
  const request = error.requestId ? ` Request ID: ${error.requestId}.` : "";
  if (error.status === 402 || CREDIT_ERRORS.includes(error.code)) {
    // Not the API's message: it can name the balance, and logs of public repositories are public.
    return `The workspace is out of credits. [HTTP ${error.status}, ${error.code}]${request}`;
  }
  const message = clean(error.message).replace(/\.$/, "");
  const field = error.field ? ` (input ${kebab(error.field)})` : "";
  const hint = HINTS[error.code] ?? (error.status >= 500 ? "Quak or Sonos has a problem right now." : "");
  return `${message}${field}.${hint ? ` ${hint}` : ""} [HTTP ${error.status}, ${error.code}]${request}`;
}

/** One line, no control characters, not endless. */
function clean(message: string): string {
  const line = message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

/** The API's field names in the inputs' spelling: effectIntensity → effect-intensity. */
function kebab(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

// --- Helpers -----------------------------------------------------------------------------------------------------

/** Pull requests from forks and Dependabot runs get no secrets: the reason, or null when secrets are passed. */
function runsWithoutSecrets(env: Env): string | null {
  if (env.GITHUB_ACTOR === "dependabot[bot]") {
    return "Dependabot runs";
  }
  // pull_request_target runs in the base repository and gets its secrets.
  const event = env.GITHUB_EVENT_NAME ?? "";
  if (!event.startsWith("pull_request") || event === "pull_request_target" || !env.GITHUB_EVENT_PATH) {
    return null;
  }
  try {
    const payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    const head = payload?.pull_request?.head?.repo?.full_name;
    if (typeof head === "string" && head !== env.GITHUB_REPOSITORY) {
      return "pull requests from forks";
    }
  } catch {
    // Without the event there is nothing to tell, so it is treated like any missing key.
  }
  return null;
}

function list(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
}
