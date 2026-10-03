import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/run.js";

export const KEY = "qk_key_test_not_a_real_key_0000000000000000";

export type Call = { request: Request; url: URL; json?: Record<string, unknown>; form?: FormData };

/** A play as the API answers it. */
export function play(overrides: Record<string, unknown> = {}) {
  return {
    id: "0b7a1f7e-4a53-4e0c-9f38-1d0f2a8b9c10",
    type: "SOUND",
    status: "PENDING",
    skipReason: null,
    preview: false,
    params: {},
    players: [
      { id: "p1", slug: "office", name: "Office", status: "PENDING", error: null, startedAt: null, endedAt: null },
    ],
    audioUrl: "https://cdn.test/audio.mp3",
    length: 2,
    credits: 1,
    fromCache: false,
    startsAt: null,
    canReplay: false,
    canSave: false,
    client: { platform: "GITHUB", name: "github-action", version: "1.0.0" },
    createdAt: "2026-10-03T10:00:00.000Z",
    ...overrides,
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export type ActionResult = {
  code: number;
  lines: string[];
  log: string;
  calls: Call[];
  outputs: Record<string, string>;
};

/**
 * Runs the action with these inputs (names as in action.yml) and a fetch that records every request and answers with
 * `respond` (default: a play, 248 credits left). Never a real request.
 */
export async function runAction(
  inputs: Record<string, string>,
  respond: (request: Request) => Response | Promise<Response> = () =>
    json({ data: play() }, 200, { "X-Quak-Credits": "248" }),
  extraEnv: Record<string, string> = {},
  timeoutMs?: number,
): Promise<ActionResult> {
  const dir = mkdtempSync(join(tmpdir(), "quak-action-"));
  const outputFile = join(dir, "output");
  writeFileSync(outputFile, "");
  const env: Record<string, string> = { GITHUB_OUTPUT: outputFile, GITHUB_WORKSPACE: dir, ...extraEnv };
  for (const [name, value] of Object.entries(inputs)) {
    env[`INPUT_${name.toUpperCase()}`] = value;
  }
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const call: Call = { request, url: new URL(request.url) };
    const type = request.headers.get("content-type") ?? "";
    if (type.includes("application/json")) {
      call.json = await request.clone().json();
    } else if (type.includes("multipart/form-data")) {
      call.form = await request.clone().formData();
    }
    calls.push(call);
    return respond(request);
  }) as typeof globalThis.fetch;
  const lines: string[] = [];
  const code = await run({ env, write: (line) => lines.push(line), fetch, baseUrl: "https://api.test", timeoutMs });
  return { code, lines, log: lines.join("\n"), calls, outputs: readOutputs(outputFile) };
}

function readOutputs(file: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  const text = readFileSync(file, "utf8");
  const pattern = /^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2\n/gm;
  for (const match of text.matchAll(pattern)) {
    outputs[match[1]!] = match[3]!;
  }
  return outputs;
}

/** A new empty directory to pass as GITHUB_WORKSPACE. */
export function workspace(): string {
  return mkdtempSync(join(tmpdir(), "quak-workspace-"));
}
