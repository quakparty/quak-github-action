import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { KEY, json, play, runAction, workspace } from "./helpers.js";

// fail-on-error: true, so the exit code shows every failure; the default is tested on its own below.
const base = { "api-key": KEY, "fail-on-error": "true" };
const strict = { "fail-on-error": "true" };

describe("requests", () => {
  test("text: JSON to /v1/play/text with the key and the client name", async () => {
    const { code, calls } = await runAction({ ...base, type: "text", text: "Deployed.", to: "office, kitchen" });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.request.method).toBe("POST");
    expect(call!.url.href).toBe("https://api.test/v1/play/text");
    expect(call!.request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call!.request.headers.get("x-quak-client")).toMatch(
      new RegExp(`^github-action/${pkg.version}( \\(.+\\))?$`),
    );
    expect(call!.request.headers.has("x-quak-workspace")).toBe(false);
    expect(call!.json).toEqual({ text: "Deployed.", to: ["office", "kitchen"] });
  });

  test("sound, clip and url: JSON to their routes", async () => {
    const sound = await runAction({ ...base, type: "sound", sound: "alarm" });
    expect(sound.calls[0]!.url.pathname).toBe("/v1/play/sound");
    expect(sound.calls[0]!.json).toEqual({ sound: "alarm" });

    const clip = await runAction({ ...base, type: "clip", clip: "release-fanfare", process: "true", intro: "alarm" });
    expect(clip.calls[0]!.url.pathname).toBe("/v1/play/clip");
    expect(clip.calls[0]!.json).toEqual({ clip: "release-fanfare", process: true, intro: "alarm" });

    const url = await runAction({ ...base, type: "url", url: "https://example.com/a.mp3", process: "false" });
    expect(url.calls[0]!.url.pathname).toBe("/v1/play/url");
    expect(url.calls[0]!.json).toEqual({ url: "https://example.com/a.mp3", process: false });
  });

  test("explicit false and 0 reach the API", async () => {
    const { calls } = await runAction({
      ...base,
      type: "sound",
      sound: "a",
      priority: "false",
      "start-in": "0",
      gap: "0",
    });
    expect(calls[0]!.json).toEqual({ sound: "a", priority: false, startIn: 0, gap: 0 });
  });

  test("text with unicode, quotes, line breaks and shell characters arrives unchanged", async () => {
    const text = `Build "#42" failed: $(whoami) \`id\` ; rm -rf / && echo 'ok' | cat\nCrème brûlée in Zürich 🚀`;
    const { calls, log } = await runAction({ ...base, type: "text", text });
    expect(calls[0]!.json!.text).toBe(text);
    expect(log).not.toContain("whoami");
  });

  test("file: multipart with the bytes, the file name and the options as form fields", async () => {
    const dir = workspace();
    const bytes = new Uint8Array([0x49, 0x44, 0x33, 0, 1, 2, 3, 255]);
    writeFileSync(join(dir, "my notification.mp3"), bytes);
    const { code, calls } = await runAction(
      {
        ...base,
        type: "file",
        file: "my notification.mp3",
        to: "office,kitchen",
        volumes: '{"office": 30}',
        volume: "50",
      },
      undefined,
      { GITHUB_WORKSPACE: dir },
    );
    expect(code).toBe(0);
    const form = calls[0]!.form!;
    expect(calls[0]!.url.pathname).toBe("/v1/play/file");
    const file = form.get("file") as File;
    expect(file.name).toBe("my notification.mp3");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect(form.get("to")).toBe("office,kitchen");
    expect(form.get("volumes")).toBe('{"office":30}');
    expect(form.get("volume")).toBe("50");
  });

  test("file: absolute paths work too", async () => {
    const dir = workspace();
    const path = join(dir, "a.mp3");
    writeFileSync(path, "audio");
    const { code, calls } = await runAction({ ...base, type: "file", file: path });
    expect(code).toBe(0);
    expect((calls[0]!.form!.get("file") as File).name).toBe("a.mp3");
  });
});

describe("files that cannot be sent", () => {
  test("a missing file fails before any request", async () => {
    const { code, calls, log } = await runAction({ ...base, type: "file", file: "out/missing.mp3" }, undefined, {
      GITHUB_WORKSPACE: workspace(),
    });
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(log).toContain("::error title=Quak::file out/missing.mp3 does not exist");
  });

  test("a directory, an empty file and one over 10 MB are refused", async () => {
    const dir = workspace();
    writeFileSync(join(dir, "empty.mp3"), "");
    writeFileSync(join(dir, "big.wav"), new Uint8Array(10 * 1024 * 1024 + 1));
    writeFileSync(join(dir, "max.mp3"), new Uint8Array(10 * 1024 * 1024));
    const env = { GITHUB_WORKSPACE: dir };
    expect((await runAction({ ...base, type: "file", file: "." }, undefined, env)).log).toContain("is not a file");
    expect((await runAction({ ...base, type: "file", file: "empty.mp3" }, undefined, env)).log).toContain("is empty");
    const big = await runAction({ ...base, type: "file", file: "big.wav" }, undefined, env);
    expect(big.code).toBe(1);
    expect(big.calls).toHaveLength(0);
    expect(big.log).toContain("file big.wav has 10 MB, Quak takes at most 10 MB.");
    expect((await runAction({ ...base, type: "file", file: "max.mp3" }, undefined, env)).code).toBe(0);
  });
});

describe("answers", () => {
  test("a play: one line in the log and all outputs", async () => {
    const { code, lines, outputs } = await runAction({ ...base, type: "sound", sound: "alarm" }, () =>
      json(
        {
          data: play({
            players: [
              { id: "1", slug: "office", name: "Office", status: "PENDING", error: null },
              { id: "2", slug: "kitchen", name: "Kitchen", status: "PENDING", error: null },
            ],
          }),
        },
        200,
        { "X-Quak-Credits": "248" },
      ),
    );
    expect(code).toBe(0);
    expect(lines).toContain('Quak: sound "alarm" sent to Office and Kitchen (1 credit).');
    expect(outputs).toEqual({
      "play-id": "0b7a1f7e-4a53-4e0c-9f38-1d0f2a8b9c10",
      status: "PENDING",
      "skip-reason": "",
      "audio-url": "https://cdn.test/audio.mp3",
      credits: "1",
      "starts-at": "",
    });
  });

  test("the log never shows the text or the URL", async () => {
    const text = await runAction({ ...base, type: "text", text: "Secret project Falcon is live." });
    expect(text.log).toContain("Quak: text (30 characters) sent to Office (1 credit).");
    expect(text.log).not.toContain("Falcon");

    const url = await runAction({ ...base, type: "url", url: "https://example.com/private/a.mp3?token=abc" });
    expect(url.log).toContain("Quak: audio from a URL sent to Office");
    expect(url.log).not.toContain("example.com");
  });

  test("202 SCHEDULED is a success with starts-at", async () => {
    const { code, lines, outputs } = await runAction({ ...base, type: "sound", sound: "alarm", "start-in": "30" }, () =>
      json({ data: play({ status: "SCHEDULED", startsAt: "2026-10-03T10:00:30.000Z", credits: 0 }) }, 202),
    );
    expect(code).toBe(0);
    expect(lines).toContain('Quak: sound "alarm" scheduled for 2026-10-03 10:00:30 UTC to Office (0 credits).');
    expect(outputs.status).toBe("SCHEDULED");
    expect(outputs["starts-at"]).toBe("2026-10-03T10:00:30.000Z");
  });

  test("SKIPPED is a success with a notice, not an error", async () => {
    const quiet = await runAction({ ...base, type: "sound", sound: "alarm" }, () =>
      json({ data: play({ status: "SKIPPED", skipReason: "QUIET_HOURS", credits: 0, audioUrl: null }) }),
    );
    expect(quiet.code).toBe(0);
    expect(quiet.log).toContain("::notice title=Quak::Nothing played: it is quiet hours.");
    expect(quiet.log).not.toContain("::error");
    expect(quiet.outputs.status).toBe("SKIPPED");
    expect(quiet.outputs["skip-reason"]).toBe("QUIET_HOURS");
    expect(quiet.outputs["audio-url"]).toBe("");

    const busy = await runAction({ ...base, type: "sound", sound: "alarm" }, () =>
      json({ data: play({ status: "SKIPPED", skipReason: "BUSY" }) }),
    );
    expect(busy.code).toBe(0);
    expect(busy.log).toContain("every speaker is busy with a play of higher priority");
  });

  test("preview: says that nothing played", async () => {
    const { code, log, outputs } = await runAction({ ...base, type: "text", text: "Hi", preview: "true" }, () =>
      json({ data: play({ preview: true, players: [], credits: 1 }) }),
    );
    expect(code).toBe(0);
    expect(log).toContain("Quak: preview of text (2 characters) made, nothing played on the speakers (1 credit).");
    expect(outputs["audio-url"]).toBe("https://cdn.test/audio.mp3");
  });

  test("speakers that failed while others play: a warning", async () => {
    const { code, log } = await runAction({ ...base, type: "sound", sound: "alarm" }, () =>
      json({
        data: play({
          players: [
            { id: "1", slug: "office", name: "Office", status: "PENDING", error: null },
            { id: "2", slug: "kitchen", name: "Kitchen", status: "FAILED", error: "offline" },
          ],
        }),
      }),
    );
    expect(code).toBe(0);
    expect(log).toContain("::warning title=Quak::Not played on Kitchen (offline).");
  });

  test("FAILED on every speaker fails the step", async () => {
    const { code, log } = await runAction({ ...base, type: "sound", sound: "alarm" }, () =>
      json({
        data: play({
          status: "FAILED",
          players: [{ id: "1", slug: "office", name: "Office", status: "FAILED", error: "offline" }],
        }),
      }),
    );
    expect(code).toBe(1);
    expect(log).toContain("::error title=Quak::Quak could not play the sound on Office (Office: offline).");
  });

  test("processing inputs without processing: a warning, the play still goes out unchanged", async () => {
    const { code, log, calls } = await runAction({
      ...base,
      type: "sound",
      sound: "alarm",
      intro: "x",
      effect: "robot",
    });
    expect(code).toBe(0);
    expect(log).toContain(
      "::warning title=Quak::intro and effect have no effect: the sound plays as stored. Set process: true to use them.",
    );
    expect(calls[0]!.json).toEqual({ sound: "alarm", intro: "x", effect: "robot" });
  });
});

describe("errors", () => {
  const apiError =
    (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
    () =>
      json({ error: { code, message, requestId: "req_123", ...extra } }, status);

  test.each([
    [401, "ERROR_INVALID_API_KEY", "invalid API key", "Check the secret QUAK_API_KEY"],
    [403, "ERROR_INSUFFICIENT_SCOPE", "the key lacks scope play", "The key needs the scope play."],
    [404, "ERROR_NOT_FOUND", "sound not found", ""],
    [409, "ERROR_CONFLICT", "conflict", ""],
    [422, "ERROR_INVALID_PARAMS", "bad", ""],
    [424, "ERROR_SONOS_FAILED", "Sonos did not answer", ""],
    [503, "ERROR_INTEGRATION_UNAVAILABLE", "try later", "Quak or Sonos has a problem right now."],
  ])("HTTP %i %s fails the step with status, code, message and request ID", async (status, code, message, hint) => {
    const result = await runAction({ ...base, type: "sound", sound: "alarm" }, apiError(status, code, message));
    expect(result.code).toBe(1);
    expect(result.calls).toHaveLength(1);
    const line = result.lines.find((l) => l.startsWith("::error"))!;
    expect(line).toContain(message);
    expect(line).toContain(`[HTTP ${status}, ${code}]`);
    expect(line).toContain("Request ID: req_123.");
    expect(line).toContain(hint);
    expect(result.outputs).toEqual({});
  });

  test("out of credits: never the balance, also when the API's message names it", async () => {
    const result = await runAction(
      { ...base, type: "sound", sound: "alarm" },
      apiError(402, "ERROR_NOT_ENOUGH_CREDITS", "needs 2 credits, 1 left", { details: { balance: 1 } }),
    );
    expect(result.code).toBe(1);
    expect(result.log).toContain(
      "::error title=Quak::The workspace is out of credits. [HTTP 402, ERROR_NOT_ENOUGH_CREDITS] Request ID: req_123.",
    );
    expect(result.log).not.toContain("1 left");
  });

  test("the balance is only in the debug log", async () => {
    const { lines } = await runAction({ ...base, type: "sound", sound: "alarm" });
    expect(lines.filter((line) => line.includes("248"))).toEqual(["::debug::credits left: 248"]);
  });

  test("a field in the error is named as the input", async () => {
    const { log } = await runAction(
      { ...base, type: "text", text: "Hi", effect: "nope" },
      apiError(400, "ERROR_INVALID_PARAMS", "unknown effect", { field: "effectIntensity" }),
    );
    expect(log).toContain(
      "::error title=Quak::unknown effect (input effect-intensity). [HTTP 400, ERROR_INVALID_PARAMS]",
    );
  });

  test("a network error is reported once, never retried", async () => {
    const { code, calls, log } = await runAction({ ...base, type: "sound", sound: "alarm" }, () => {
      throw new TypeError("fetch failed");
    });
    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
    expect(log).toContain("::error title=Quak::Could not reach Quak: fetch failed.");
  });

  test("a timeout says the play may have gone out, and is not retried", async () => {
    const hang = (request: Request) =>
      new Promise<Response>((_, reject) =>
        request.signal.addEventListener("abort", () => reject(request.signal.reason)),
      );
    const { code, calls, log } = await runAction({ ...base, type: "sound", sound: "alarm" }, hang, {}, 50);
    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
    expect(log).toContain(
      "::error title=Quak::Quak did not answer within 0.05 s. The play may have gone out anyway, so the action does not try again.",
    );
  });

  test("redirects are not followed", async () => {
    const { code, calls, log } = await runAction({ ...base, type: "sound", sound: "alarm" }, (request) => {
      expect(request.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { Location: "https://elsewhere.test/" } });
    });
    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
    expect(log).toContain("Quak answered with a redirect (HTTP 302), which the action does not follow.");
  });

  test("an answer that is not JSON, or not a play", async () => {
    const html = await runAction(
      { ...base, type: "sound", sound: "alarm" },
      () => new Response("<html>oops</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    );
    expect(html.code).toBe(1);
    expect(html.log).toContain("Quak sent an answer that is not JSON. The play may have gone out anyway.");

    const empty = await runAction({ ...base, type: "sound", sound: "alarm" }, () => json({ data: { nope: 1 } }));
    expect(empty.code).toBe(1);
    expect(empty.log).toContain("Quak sent an answer the action does not understand.");
  });

  test("a non-JSON error answer still fails with the status", async () => {
    const { code, log } = await runAction(
      { ...base, type: "sound", sound: "alarm" },
      () => new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" }),
    );
    expect(code).toBe(1);
    expect(log).toContain("[HTTP 502, HTTP_502]");
  });

  test("an error message with line breaks stays one line", async () => {
    const { lines } = await runAction(
      { ...base, type: "sound", sound: "alarm" },
      apiError(400, "ERROR_INVALID_PARAMS", "line one\nline two\r\n::set-output name=x::y"),
    );
    const line = lines.find((l) => l.startsWith("::error"))!;
    expect(line).not.toContain("\n");
    expect(line).toContain("line one line two ::set-output");
    expect(lines.filter((l) => l.startsWith("::set-output"))).toEqual([]);
  });
});

describe("inputs", () => {
  test("invalid inputs: every problem as an error, no request", async () => {
    const { code, calls, lines } = await runAction({
      ...base,
      type: "sound",
      sound: "a",
      volume: "200",
      priority: "yes",
    });
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(lines.filter((l) => l.startsWith("::error"))).toEqual([
      '::error title=Quak::volume must be a whole number from 1 to 100, not "200".',
      '::error title=Quak::priority must be true or false, not "yes".',
    ]);
  });
});

describe("the key", () => {
  test("is masked before anything else is written and never shows up in the log", async () => {
    const result = await runAction({ ...base, type: "sound", sound: "alarm" }, () =>
      json({ error: { code: "ERROR_INVALID_API_KEY", message: "invalid API key", requestId: "r" } }, 401),
    );
    expect(result.lines[0]).toBe(`::add-mask::${KEY}`);
    expect(result.lines.slice(1).join("\n")).not.toContain(KEY);
  });

  test("missing: fails with how to set the secret", async () => {
    const { code, calls, log } = await runAction({ ...strict, type: "sound", sound: "alarm" });
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(log).toContain("::error title=Quak::api-key is empty. Add the key as the repository secret QUAK_API_KEY");
  });

  test("missing in a pull request from a fork: a warning, the step passes", async () => {
    const dir = workspace();
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify({ pull_request: { head: { repo: { full_name: "someone/fork" } } } }));
    const env = { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: "acme/app" };
    const fork = await runAction({ ...strict, type: "sound", sound: "alarm" }, undefined, env);
    expect(fork.code).toBe(0);
    expect(fork.calls).toHaveLength(0);
    expect(fork.log).toBe(
      "::warning title=Quak::Nothing played: api-key is empty, because pull requests from forks get no secrets.",
    );

    // the same repository: the secret is just missing
    const own = await runAction({ ...strict, type: "sound", sound: "alarm" }, undefined, {
      ...env,
      GITHUB_REPOSITORY: "someone/fork",
    });
    expect(own.code).toBe(1);

    // pull_request_target gets the secrets of the base repository
    const target = await runAction({ ...strict, type: "sound", sound: "alarm" }, undefined, {
      ...env,
      GITHUB_EVENT_NAME: "pull_request_target",
    });
    expect(target.code).toBe(1);
  });

  test("missing in a Dependabot run: a warning, the step passes", async () => {
    const { code, log } = await runAction({ ...strict, type: "sound", sound: "alarm" }, undefined, {
      GITHUB_ACTOR: "dependabot[bot]",
    });
    expect(code).toBe(0);
    expect(log).toContain("because Dependabot runs get no secrets");
  });
});

describe("fail-on-error", () => {
  const noKey = () => json({ error: { code: "ERROR_INVALID_API_KEY", message: "invalid API key" } }, 401);

  test("by default a failed announcement leaves the step green, the error is still an annotation", async () => {
    const api = await runAction({ "api-key": KEY, type: "sound", sound: "alarm" }, noKey);
    expect(api.code).toBe(0);
    expect(api.log).toContain("::error title=Quak::invalid API key.");
    expect(api.lines.at(-1)).toBe("The step passes anyway. Set fail-on-error: true to fail it.");

    const inputs = await runAction({ "api-key": KEY, type: "sound", sound: "alarm", volume: "0" });
    expect(inputs.code).toBe(0);
    expect(inputs.calls).toHaveLength(0);

    const missingKey = await runAction({ type: "sound", sound: "alarm" });
    expect(missingKey.code).toBe(0);
    expect(missingKey.log).toContain("::error title=Quak::api-key is empty.");
  });

  test("a successful play says nothing about it", async () => {
    const { code, log } = await runAction({ "api-key": KEY, type: "sound", sound: "alarm" });
    expect(code).toBe(0);
    expect(log).not.toContain("fail-on-error");
  });

  test("an invalid value is a warning and counts as false", async () => {
    const { code, log } = await runAction(
      { "api-key": KEY, "fail-on-error": "yes", type: "sound", sound: "alarm" },
      noKey,
    );
    expect(code).toBe(0);
    expect(log).toContain('::warning title=Quak::fail-on-error must be true or false, not "yes". Using false.');
  });
});
