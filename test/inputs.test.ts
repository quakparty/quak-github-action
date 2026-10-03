import { describe, expect, test } from "bun:test";
import { InputError, parseInputs, type Inputs } from "../src/inputs.js";

function parse(inputs: Record<string, string>): Inputs {
  const env: Record<string, string> = { "INPUT_API-KEY": "qk_key_test" };
  for (const [name, value] of Object.entries(inputs)) {
    env[`INPUT_${name.toUpperCase()}`] = value;
  }
  return parseInputs(env);
}

function problems(inputs: Record<string, string>): string[] {
  try {
    parse(inputs);
  } catch (error) {
    if (error instanceof InputError) {
      return error.problems;
    }
    throw error;
  }
  throw new Error("no InputError");
}

describe("type and content", () => {
  test("every kind takes its own input", () => {
    expect(parse({ type: "text", text: "Hi" })).toMatchObject({ kind: "text", content: "Hi" });
    expect(parse({ type: "sound", sound: "alarm" })).toMatchObject({ kind: "sound", content: "alarm" });
    expect(parse({ type: "clip", clip: "release-fanfare" })).toMatchObject({
      kind: "clip",
      content: "release-fanfare",
    });
    expect(parse({ type: "file", file: "a.mp3" })).toMatchObject({ kind: "file", content: "a.mp3" });
    expect(parse({ type: "url", url: "https://example.com/a.mp3" })).toMatchObject({ kind: "url" });
  });

  test("type is required and has to be known", () => {
    expect(problems({ text: "Hi" })).toEqual(["type is missing. Set it to one of text, sound, clip, file, url."]);
    expect(problems({ type: "talk" })[0]).toContain('type "talk" is unknown');
    expect(problems({ type: "Text", text: "Hi" })[0]).toContain('type "Text" is unknown');
  });

  test("the content input of the type is required", () => {
    expect(problems({ type: "sound" })).toEqual(["type is sound, but the input sound is empty."]);
    expect(problems({ type: "text", text: "   " })).toEqual(["type is text, but the input text is empty."]);
  });

  test("content inputs of other types are refused", () => {
    expect(problems({ type: "sound", sound: "alarm", clip: "fanfare", text: "Hi" })).toEqual([
      "text is set, but type is sound. Set only the input that matches type.",
      "clip is set, but type is sound. Set only the input that matches type.",
    ]);
  });

  test("text keeps line breaks, quotes and shell characters, only the ends are trimmed", () => {
    const text = `Deploy of "main" done: $HOME \`whoami\` $(rm -rf /) ; | & 🚀\nÜmlaute ok`;
    expect(parse({ type: "text", text: `${text}\n` }).content).toBe(text);
  });

  test("text has at most 1000 characters", () => {
    expect(parse({ type: "text", text: "a".repeat(1000) }).content).toHaveLength(1000);
    expect(problems({ type: "text", text: "a".repeat(1001) })).toEqual([
      "text has 1001 characters, Quak speaks at most 1000.",
    ]);
  });

  test("url has to be http or https", () => {
    expect(parse({ type: "url", url: "http://example.com/a.mp3" }).content).toBe("http://example.com/a.mp3");
    expect(problems({ type: "url", url: "file:///etc/passwd" })).toEqual([
      "url must be an http:// or https:// address.",
    ]);
    expect(problems({ type: "url", url: "not a url" })).toEqual(["url must be an http:// or https:// address."]);
  });

  test("all problems come at once", () => {
    expect(problems({ type: "sound", sound: "alarm", volume: "0", gap: "150", priority: "yes" })).toHaveLength(3);
  });
});

describe("options", () => {
  test("unset inputs stay out, so Quak uses its defaults", () => {
    expect(parse({ type: "sound", sound: "alarm" }).options).toEqual({});
  });

  test("all options in the API's names", () => {
    const { options } = parse({
      type: "text",
      text: "Hi",
      to: "office",
      volume: "40",
      volumes: '{"office": 30}',
      voice: "nova",
      language: "de-DE",
      intro: "clip:release-fanfare",
      outro: "none",
      gap: "300",
      effect: "robot",
      "effect-intensity": "strong",
      ambience: "stadium",
      "ambience-intensity": "weak",
      "quiet-hours": "22-7",
      priority: "true",
      preview: "false",
      "skip-cache": "true",
      "start-in": "2.5",
    });
    expect(options).toEqual({
      to: ["office"],
      volume: 40,
      volumes: { office: 30 },
      voice: "nova",
      language: "de-DE",
      intro: "clip:release-fanfare",
      outro: "none",
      gap: 300,
      effect: "robot",
      effectIntensity: "strong",
      ambience: "stadium",
      ambienceIntensity: "weak",
      quietHours: "22-7",
      priority: true,
      preview: false,
      skipCache: true,
      startIn: 2.5,
    });
  });

  test("to takes slugs separated by commas, with or without spaces", () => {
    expect(parse({ type: "sound", sound: "a", to: "office,kitchen" }).options.to).toEqual(["office", "kitchen"]);
    expect(parse({ type: "sound", sound: "a", to: " office , kitchen, " }).options.to).toEqual(["office", "kitchen"]);
    expect(parse({ type: "sound", sound: "a", to: "all" }).options.to).toEqual(["all"]);
    expect(problems({ type: "sound", sound: "a", to: ", ," })[0]).toContain("to has no speaker in it");
  });

  test("explicit false and 0 are kept", () => {
    const { options } = parse({
      type: "sound",
      sound: "a",
      process: "false",
      priority: "False",
      gap: "0",
      "start-in": "0",
    });
    expect(options).toEqual({ process: false, priority: false, gap: 0, startIn: 0 });
  });

  test("booleans are strict", () => {
    expect(parse({ type: "sound", sound: "a", priority: "TRUE" }).options.priority).toBe(true);
    for (const value of ["yes", "1", "on", "tru"]) {
      expect(problems({ type: "sound", sound: "a", priority: value })).toEqual([
        `priority must be true or false, not "${value}".`,
      ]);
    }
  });

  test("volume is a whole number from 1 to 100", () => {
    expect(parse({ type: "sound", sound: "a", volume: "1" }).options.volume).toBe(1);
    expect(parse({ type: "sound", sound: "a", volume: "100" }).options.volume).toBe(100);
    for (const value of ["0", "101", "50.5", "-5", "loud", "1e2"]) {
      expect(problems({ type: "sound", sound: "a", volume: value })).toEqual([
        `volume must be a whole number from 1 to 100, not "${value}".`,
      ]);
    }
  });

  test("gap is 0 to 1000 in steps of 100", () => {
    expect(parse({ type: "sound", sound: "a", gap: "1000" }).options.gap).toBe(1000);
    for (const value of ["150", "1100", "-100"]) {
      expect(problems({ type: "sound", sound: "a", gap: value })[0]).toContain("in steps of 100");
    }
  });

  test("start-in is 0 to 60 seconds, decimals allowed", () => {
    expect(parse({ type: "sound", sound: "a", "start-in": "60" }).options.startIn).toBe(60);
    expect(parse({ type: "sound", sound: "a", "start-in": "0.5" }).options.startIn).toBe(0.5);
    for (const value of ["61", "-1", "soon", "1,5", ".5"]) {
      expect(problems({ type: "sound", sound: "a", "start-in": value })[0]).toContain("start-in must be");
    }
  });

  test("volumes is a JSON object of slugs and volumes", () => {
    expect(parse({ type: "sound", sound: "a", volumes: '{"office":30,"kitchen":100}' }).options.volumes).toEqual({
      office: 30,
      kitchen: 100,
    });
    for (const value of ["office: 30", "[30]", "{}", '{"office": 0}', '{"office": "30"}', '{"office": 30.5}', "null"]) {
      expect(problems({ type: "sound", sound: "a", volumes: value })[0]).toContain("volumes must be a JSON object");
    }
  });

  test("intensities are off, weak, medium or strong", () => {
    expect(problems({ type: "text", text: "Hi", "effect-intensity": "max" })).toEqual([
      'effect-intensity must be one of off, weak, medium, strong, not "max".',
    ]);
  });

  test("effect and ambience values are left to the API", () => {
    expect(parse({ type: "text", text: "Hi", effect: "brand-new-effect" }).options.effect).toBe("brand-new-effect");
  });

  test("voice and language only with text", () => {
    expect(problems({ type: "sound", sound: "a", voice: "nova", language: "de" })).toEqual([
      "voice only works with type text.",
      "language only works with type text.",
    ]);
  });
});

describe("processing", () => {
  test("process: false is refused for text and file", () => {
    expect(problems({ type: "text", text: "Hi", process: "false" })[0]).toContain("does not work with type text");
    expect(problems({ type: "file", file: "a.mp3", process: "false" })[0]).toContain("does not work with type file");
    expect(parse({ type: "text", text: "Hi", process: "true" }).options.process).toBe(true);
  });

  test("sounds and clips: processing inputs are ignored unless process is true", () => {
    const inputs = { intro: "alarm", effect: "robot", "ambience-intensity": "weak" };
    expect(parse({ type: "sound", sound: "a", ...inputs }).ignored).toEqual(["intro", "effect", "ambience-intensity"]);
    expect(parse({ type: "clip", clip: "a", ...inputs, process: "false" }).ignored).toHaveLength(3);
    expect(parse({ type: "clip", clip: "a", ...inputs, process: "true" }).ignored).toEqual([]);
  });

  test("urls: processing inputs are ignored only with process: false", () => {
    const url = "https://example.com/a.mp3";
    expect(parse({ type: "url", url, effect: "robot" }).ignored).toEqual([]);
    expect(parse({ type: "url", url, effect: "robot", process: "false" }).ignored).toEqual(["effect"]);
  });

  test("text and file are always processed", () => {
    expect(parse({ type: "text", text: "Hi", effect: "robot" }).ignored).toEqual([]);
    expect(parse({ type: "file", file: "a.mp3", effect: "robot" }).ignored).toEqual([]);
  });
});
