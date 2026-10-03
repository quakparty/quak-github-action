// The entry point GitHub runs (bundled into dist/index.js).

import { run } from "./run.js";

try {
  process.exitCode = await run({ env: process.env, write: (line) => process.stdout.write(`${line}\n`) });
} catch (error) {
  // A bug in the action, not a problem with the play: still one clear line instead of a stack trace.
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`::error title=Quak::Unexpected error in the action: ${message.replace(/\r?\n/g, " ")}\n`);
  process.exitCode = ["true", "True", "TRUE"].includes(process.env["INPUT_FAIL-ON-ERROR"]?.trim() ?? "") ? 1 : 0;
}
