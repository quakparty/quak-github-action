// The runner's side: workflow commands on stdout (https://docs.github.com/actions/reference/workflow-commands) and
// step outputs in the file named by GITHUB_OUTPUT. Written by hand instead of pulling in @actions/core for these few
// lines.

import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Env } from "./inputs.js";

export type Runner = {
  info(message: string): void;
  /** Only in the log when debug logging is on (secret or variable ACTIONS_STEP_DEBUG). */
  debug(message: string): void;
  /** Annotations: shown on the run's summary page as well as in the log. */
  notice(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  /** Replaces the value with *** in everything the runner logs after this. */
  mask(value: string): void;
  setOutput(name: string, value: string): void;
};

const TITLE = "Quak";

export function createRunner(env: Env, write: (line: string) => void): Runner {
  const command = (name: string, message: string, title?: string) =>
    write(`::${name}${title ? ` title=${escapeProperty(title)}` : ""}::${escapeData(message)}`);
  return {
    info: (message) => write(message),
    debug: (message) => command("debug", message),
    notice: (message) => command("notice", message, TITLE),
    warning: (message) => command("warning", message, TITLE),
    error: (message) => command("error", message, TITLE),
    mask: (value) => command("add-mask", value),
    setOutput: (name, value) => {
      const file = env.GITHUB_OUTPUT;
      if (!file) {
        return;
      }
      const delimiter = `quak_${randomUUID()}`;
      appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
    },
  };
}

export function escapeData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}
