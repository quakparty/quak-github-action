// src/run.ts
import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

// node_modules/openapi-fetch/dist/index.mjs
var PATH_PARAM_RE = /\{[^{}]+\}/g;
var supportsRequestInitExt = () => {
  return typeof process === "object" && Number.parseInt(process?.versions?.node?.substring(0, 2)) >= 18 && process.versions.undici;
};
function randomID() {
  return Math.random().toString(36).slice(2, 11);
}
function createClient(clientOptions) {
  let {
    baseUrl = "",
    Request: CustomRequest = globalThis.Request,
    fetch: baseFetch = globalThis.fetch,
    querySerializer: globalQuerySerializer,
    bodySerializer: globalBodySerializer,
    pathSerializer: globalPathSerializer,
    headers: baseHeaders,
    requestInitExt = undefined,
    ...baseOptions
  } = { ...clientOptions };
  requestInitExt = supportsRequestInitExt() ? requestInitExt : undefined;
  baseUrl = removeTrailingSlash(baseUrl);
  const globalMiddlewares = [];
  async function coreFetch(schemaPath, fetchOptions) {
    const {
      baseUrl: localBaseUrl,
      fetch = baseFetch,
      Request = CustomRequest,
      headers,
      params = {},
      parseAs = "json",
      querySerializer: requestQuerySerializer,
      bodySerializer = globalBodySerializer ?? defaultBodySerializer,
      pathSerializer: requestPathSerializer,
      body,
      middleware: requestMiddlewares = [],
      ...init
    } = fetchOptions || {};
    let finalBaseUrl = baseUrl;
    if (localBaseUrl) {
      finalBaseUrl = removeTrailingSlash(localBaseUrl) ?? baseUrl;
    }
    let querySerializer = typeof globalQuerySerializer === "function" ? globalQuerySerializer : createQuerySerializer(globalQuerySerializer);
    if (requestQuerySerializer) {
      querySerializer = typeof requestQuerySerializer === "function" ? requestQuerySerializer : createQuerySerializer({
        ...typeof globalQuerySerializer === "object" ? globalQuerySerializer : {},
        ...requestQuerySerializer
      });
    }
    const pathSerializer = requestPathSerializer || globalPathSerializer || defaultPathSerializer;
    const serializedBody = body === undefined ? undefined : bodySerializer(body, mergeHeaders(baseHeaders, headers, params.header));
    const finalHeaders = mergeHeaders(serializedBody === undefined || serializedBody instanceof FormData ? {} : {
      "Content-Type": "application/json"
    }, baseHeaders, headers, params.header);
    const finalMiddlewares = [...globalMiddlewares, ...requestMiddlewares];
    const requestInit = {
      redirect: "follow",
      ...baseOptions,
      ...init,
      body: serializedBody,
      headers: finalHeaders
    };
    let id;
    let options;
    let request = new Request(createFinalURL(schemaPath, { baseUrl: finalBaseUrl, params, querySerializer, pathSerializer }), requestInit);
    let response;
    for (const key in init) {
      if (!(key in request)) {
        request[key] = init[key];
      }
    }
    if (finalMiddlewares.length) {
      id = randomID();
      options = Object.freeze({
        baseUrl: finalBaseUrl,
        fetch,
        parseAs,
        querySerializer,
        bodySerializer,
        pathSerializer
      });
      for (const m of finalMiddlewares) {
        if (m && typeof m === "object" && typeof m.onRequest === "function") {
          const result = await m.onRequest({
            request,
            schemaPath,
            params,
            options,
            id
          });
          if (result) {
            if (result instanceof Request) {
              request = result;
            } else if (result instanceof Response) {
              response = result;
              break;
            } else {
              throw new Error("onRequest: must return new Request() or Response() when modifying the request");
            }
          }
        }
      }
    }
    if (!response) {
      try {
        response = await fetch(request, requestInitExt);
      } catch (error2) {
        let errorAfterMiddleware = error2;
        if (finalMiddlewares.length) {
          for (let i = finalMiddlewares.length - 1;i >= 0; i--) {
            const m = finalMiddlewares[i];
            if (m && typeof m === "object" && typeof m.onError === "function") {
              const result = await m.onError({
                request,
                error: errorAfterMiddleware,
                schemaPath,
                params,
                options,
                id
              });
              if (result) {
                if (result instanceof Response) {
                  errorAfterMiddleware = undefined;
                  response = result;
                  break;
                }
                if (result instanceof Error) {
                  errorAfterMiddleware = result;
                  continue;
                }
                throw new Error("onError: must return new Response() or instance of Error");
              }
            }
          }
        }
        if (errorAfterMiddleware) {
          throw errorAfterMiddleware;
        }
      }
      if (finalMiddlewares.length) {
        for (let i = finalMiddlewares.length - 1;i >= 0; i--) {
          const m = finalMiddlewares[i];
          if (m && typeof m === "object" && typeof m.onResponse === "function") {
            const result = await m.onResponse({
              request,
              response,
              schemaPath,
              params,
              options,
              id
            });
            if (result) {
              if (!(result instanceof Response)) {
                throw new Error("onResponse: must return new Response() when modifying the response");
              }
              response = result;
            }
          }
        }
      }
    }
    const contentLength = response.headers.get("Content-Length");
    if (response.status === 204 || request.method === "HEAD" || contentLength === "0" && !response.headers.get("Transfer-Encoding")?.includes("chunked")) {
      return response.ok ? { data: undefined, response } : { error: undefined, response };
    }
    if (response.ok) {
      const getResponseData = async () => {
        if (parseAs === "stream") {
          return response.body;
        }
        if (parseAs === "json" && !contentLength) {
          const raw = await response.text();
          return raw ? JSON.parse(raw) : undefined;
        }
        return await response[parseAs]();
      };
      return { data: await getResponseData(), response };
    }
    let error = await response.text();
    try {
      error = JSON.parse(error);
    } catch {}
    return { error, response };
  }
  return {
    request(method, url, init) {
      return coreFetch(url, { ...init, method: method.toUpperCase() });
    },
    GET(url, init) {
      return coreFetch(url, { ...init, method: "GET" });
    },
    PUT(url, init) {
      return coreFetch(url, { ...init, method: "PUT" });
    },
    POST(url, init) {
      return coreFetch(url, { ...init, method: "POST" });
    },
    DELETE(url, init) {
      return coreFetch(url, { ...init, method: "DELETE" });
    },
    OPTIONS(url, init) {
      return coreFetch(url, { ...init, method: "OPTIONS" });
    },
    HEAD(url, init) {
      return coreFetch(url, { ...init, method: "HEAD" });
    },
    PATCH(url, init) {
      return coreFetch(url, { ...init, method: "PATCH" });
    },
    TRACE(url, init) {
      return coreFetch(url, { ...init, method: "TRACE" });
    },
    use(...middleware) {
      for (const m of middleware) {
        if (!m) {
          continue;
        }
        if (typeof m !== "object" || !(("onRequest" in m) || ("onResponse" in m) || ("onError" in m))) {
          throw new Error("Middleware must be an object with one of `onRequest()`, `onResponse() or `onError()`");
        }
        globalMiddlewares.push(m);
      }
    },
    eject(...middleware) {
      for (const m of middleware) {
        const i = globalMiddlewares.indexOf(m);
        if (i !== -1) {
          globalMiddlewares.splice(i, 1);
        }
      }
    }
  };
}
function serializePrimitiveParam(name, value, options) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "object") {
    throw new Error("Deeply-nested arrays/objects aren’t supported. Provide your own `querySerializer()` to handle these.");
  }
  return `${name}=${options?.allowReserved === true ? value : encodeURIComponent(value)}`;
}
function serializeObjectParam(name, value, options) {
  if (!value || typeof value !== "object") {
    return "";
  }
  const values = [];
  const joiner = {
    simple: ",",
    label: ".",
    matrix: ";"
  }[options.style] || "&";
  if (options.style !== "deepObject" && options.explode === false) {
    for (const k in value) {
      values.push(k, options.allowReserved === true ? value[k] : encodeURIComponent(value[k]));
    }
    const final2 = values.join(",");
    switch (options.style) {
      case "form": {
        return `${name}=${final2}`;
      }
      case "label": {
        return `.${final2}`;
      }
      case "matrix": {
        return `;${name}=${final2}`;
      }
      default: {
        return final2;
      }
    }
  }
  for (const k in value) {
    const finalName = options.style === "deepObject" ? `${name}[${k}]` : k;
    values.push(serializePrimitiveParam(finalName, value[k], options));
  }
  const final = values.join(joiner);
  return options.style === "label" || options.style === "matrix" ? `${joiner}${final}` : final;
}
function serializeArrayParam(name, value, options) {
  if (!Array.isArray(value)) {
    return "";
  }
  if (options.explode === false) {
    const joiner2 = { form: ",", spaceDelimited: "%20", pipeDelimited: "|" }[options.style] || ",";
    const final = (options.allowReserved === true ? value : value.map((v) => encodeURIComponent(v))).join(joiner2);
    switch (options.style) {
      case "simple": {
        return final;
      }
      case "label": {
        return `.${final}`;
      }
      case "matrix": {
        return `;${name}=${final}`;
      }
      default: {
        return `${name}=${final}`;
      }
    }
  }
  const joiner = { simple: ",", label: ".", matrix: ";" }[options.style] || "&";
  const values = [];
  for (const v of value) {
    if (options.style === "simple" || options.style === "label") {
      values.push(options.allowReserved === true ? v : encodeURIComponent(v));
    } else {
      values.push(serializePrimitiveParam(name, v, options));
    }
  }
  return options.style === "label" || options.style === "matrix" ? `${joiner}${values.join(joiner)}` : values.join(joiner);
}
function createQuerySerializer(options) {
  return function querySerializer(queryParams) {
    const search = [];
    if (queryParams && typeof queryParams === "object") {
      for (const name in queryParams) {
        const value = queryParams[name];
        if (value === undefined || value === null) {
          continue;
        }
        if (Array.isArray(value)) {
          if (value.length === 0) {
            continue;
          }
          search.push(serializeArrayParam(name, value, {
            style: "form",
            explode: true,
            ...options?.array,
            allowReserved: options?.allowReserved || false
          }));
          continue;
        }
        if (typeof value === "object") {
          search.push(serializeObjectParam(name, value, {
            style: "deepObject",
            explode: true,
            ...options?.object,
            allowReserved: options?.allowReserved || false
          }));
          continue;
        }
        search.push(serializePrimitiveParam(name, value, options));
      }
    }
    return search.join("&");
  };
}
function defaultPathSerializer(pathname, pathParams) {
  let nextURL = pathname;
  for (const match of pathname.match(PATH_PARAM_RE) ?? []) {
    let name = match.substring(1, match.length - 1);
    let explode = false;
    let style = "simple";
    if (name.endsWith("*")) {
      explode = true;
      name = name.substring(0, name.length - 1);
    }
    if (name.startsWith(".")) {
      style = "label";
      name = name.substring(1);
    } else if (name.startsWith(";")) {
      style = "matrix";
      name = name.substring(1);
    }
    if (!pathParams || pathParams[name] === undefined || pathParams[name] === null) {
      continue;
    }
    const value = pathParams[name];
    if (Array.isArray(value)) {
      nextURL = nextURL.replace(match, serializeArrayParam(name, value, { style, explode }));
      continue;
    }
    if (typeof value === "object") {
      nextURL = nextURL.replace(match, serializeObjectParam(name, value, { style, explode }));
      continue;
    }
    if (style === "matrix") {
      nextURL = nextURL.replace(match, `;${serializePrimitiveParam(name, value)}`);
      continue;
    }
    nextURL = nextURL.replace(match, style === "label" ? `.${encodeURIComponent(value)}` : encodeURIComponent(value));
  }
  return nextURL;
}
function defaultBodySerializer(body, headers) {
  if (body instanceof FormData) {
    return body;
  }
  if (headers) {
    const contentType = headers.get instanceof Function ? headers.get("Content-Type") ?? headers.get("content-type") : headers["Content-Type"] ?? headers["content-type"];
    if (contentType === "application/x-www-form-urlencoded") {
      return new URLSearchParams(body).toString();
    }
  }
  return JSON.stringify(body);
}
function createFinalURL(pathname, options) {
  let finalURL = `${options.baseUrl}${pathname}`;
  if (options.params?.path) {
    finalURL = options.pathSerializer(finalURL, options.params.path);
  }
  let search = options.querySerializer(options.params.query ?? {});
  if (search.startsWith("?")) {
    search = search.substring(1);
  }
  if (search) {
    finalURL += `?${search}`;
  }
  return finalURL;
}
function mergeHeaders(...allHeaders) {
  const finalHeaders = new Headers;
  for (const h of allHeaders) {
    if (!h || typeof h !== "object") {
      continue;
    }
    const iterator = h instanceof Headers ? h.entries() : Object.entries(h);
    for (const [k, v] of iterator) {
      if (v === null) {
        finalHeaders.delete(k);
      } else if (Array.isArray(v)) {
        for (const v2 of v) {
          finalHeaders.append(k, v2);
        }
      } else if (v !== undefined) {
        finalHeaders.set(k, v);
      }
    }
  }
  return finalHeaders;
}
function removeTrailingSlash(url) {
  if (url.endsWith("/")) {
    return url.substring(0, url.length - 1);
  }
  return url;
}

// node_modules/@quak/js/dist/version.js
var VERSION = "0.9.6";

// node_modules/@quak/js/dist/client-header.js
var OS = { darwin: "macos", win32: "windows", linux: "linux", android: "android" };
var ARCH = { arm64: "arm64", aarch64: "arm64", x64: "x86_64", x86_64: "x86_64" };
function systemComment(globals = globalThis) {
  const deno = globals.Deno?.build;
  const node = globals.process?.versions?.node ? globals.process : undefined;
  const os = deno?.os ?? node?.platform;
  const arch = deno?.arch ?? node?.arch;
  if (!os || !arch) {
    return;
  }
  return `(${OS[os] ?? os}; ${ARCH[arch] ?? arch})`;
}
function clientHeader(globals, client) {
  const system = systemComment(globals);
  const name = client?.trim() || `js/${VERSION}`;
  return system ? `${name} ${system}` : name;
}

// node_modules/@quak/js/dist/errors.js
class QuakError extends Error {
  name = "QuakError";
  status;
  code;
  field;
  details;
  requestId;
  response;
  constructor(init) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.status = init.status;
    this.code = init.code;
    this.field = init.field;
    this.details = init.details;
    this.requestId = init.requestId;
    this.response = init.response;
  }
  static fromResponse(response, body) {
    const error = isErrorBody(body) ? body.error : undefined;
    return new QuakError({
      status: response.status,
      code: error?.code ?? `HTTP_${response.status}`,
      message: error?.message ?? (response.statusText || `request failed with status ${response.status}`),
      field: error?.field,
      details: error?.details,
      requestId: error?.requestId ?? response.headers.get("x-request-id") ?? undefined,
      response
    });
  }
  static network(cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return new QuakError({ status: 0, code: "ERROR_NETWORK", message: `network error: ${message}`, cause });
  }
}
function isErrorBody(body) {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return false;
  }
  const error = body.error;
  return typeof error === "object" && error !== null && typeof error.code === "string";
}
async function unwrap(request) {
  let result;
  try {
    result = await request;
  } catch (error) {
    throw error instanceof QuakError ? error : QuakError.network(error);
  }
  if (!result.response.ok) {
    throw QuakError.fromResponse(result.response, result.error);
  }
  return result.data;
}

// node_modules/@quak/js/dist/watch.js
var FINAL_CODES = new Set([4001, 4401, 4403]);
var FIRST_RETRY_MS = 1000;
var MAX_RETRY_MS = 30000;
var SILENCE_MS = 60000;
function watchPlays(url, apiKey, options) {
  const Found = options.WebSocket ?? globalThis.WebSocket;
  if (!Found) {
    throw new QuakError({
      status: 0,
      code: "ERROR_NETWORK",
      message: "watch() needs a WebSocket: Node 22 or newer, Bun, Deno or a browser, or pass one as `WebSocket`"
    });
  }
  let socket;
  let connected = false;
  let closed = false;
  let retryMs = FIRST_RETRY_MS;
  let retry;
  let silence;
  function listen() {
    clearTimeout(silence);
    silence = setTimeout(() => socket?.close(), SILENCE_MS);
  }
  const Socket = Found;
  function connect() {
    const current = new Socket(url);
    socket = current;
    current.onopen = () => {
      current.send(JSON.stringify({ type: "auth", apiKey }));
      listen();
    };
    current.onmessage = (event) => {
      listen();
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === "ready") {
        connected = true;
        retryMs = FIRST_RETRY_MS;
        options.onReady?.();
      } else if (message.type === "play") {
        options.onPlay(message.data);
      } else if (message.type === "error") {
        options.onError?.(new QuakError({ status: 0, code: message.code, message: `watch: ${message.code}` }));
      }
    };
    current.onclose = (event) => {
      if (socket !== current) {
        return;
      }
      clearTimeout(silence);
      connected = false;
      const reconnecting = !closed && options.reconnect !== false && !FINAL_CODES.has(event.code);
      options.onClose?.({ code: event.code, reason: event.reason, reconnecting });
      if (reconnecting) {
        retry = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      }
    };
  }
  connect();
  return {
    get connected() {
      return connected;
    },
    close() {
      closed = true;
      clearTimeout(retry);
      clearTimeout(silence);
      socket?.close();
    }
  };
}

// node_modules/@quak/js/dist/client.js
var DEFAULT_BASE_URL = "https://api.quak.party";

class Quak {
  api;
  credits = null;
  play;
  plays;
  keys;
  workspace;
  speakers;
  voices;
  sounds;
  clips;
  effects;
  baseUrl;
  apiKey;
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    const headers = {
      ...options.headers,
      "X-Quak-Client": clientHeader(undefined, options.client)
    };
    if (options.apiKey) {
      headers.Authorization = `Bearer ${options.apiKey}`;
    }
    this.api = createClient({
      baseUrl: this.baseUrl,
      headers,
      ...options.fetch ? { fetch: options.fetch } : {}
    });
    this.api.use({
      onResponse: ({ response }) => {
        const credits = response.headers.get("x-quak-credits");
        if (credits !== null && credits !== "" && Number.isFinite(Number(credits))) {
          this.credits = Number(credits);
        }
        return;
      }
    });
    const api = this.api;
    this.play = {
      text: (params) => unwrap(api.POST("/v1/play/text", { body: params })),
      talk: (params) => unwrap(api.POST("/v1/play/talk", { body: {}, bodySerializer: () => toFormData(params) })),
      sound: (params) => unwrap(api.POST("/v1/play/sound", { body: params })),
      clip: (params) => unwrap(api.POST("/v1/play/clip", { body: params })),
      file: (params) => unwrap(api.POST("/v1/play/file", { body: {}, bodySerializer: () => toFormData(params) })),
      url: (params) => unwrap(api.POST("/v1/play/url", { body: params }))
    };
    this.plays = {
      list: (query) => unwrap(api.GET("/v1/plays", { params: { query } })),
      get: (uuid, query) => unwrap(api.GET("/v1/plays/{uuid}", { params: { path: { uuid }, query } })),
      last: (query) => unwrap(api.GET("/v1/plays/{uuid}", { params: { path: { uuid: "last" }, query } })),
      stop: (uuid) => unwrap(api.POST("/v1/plays/{uuid}/stop", { params: { path: { uuid } } })),
      replay: (uuid, params = {}) => unwrap(api.POST("/v1/plays/{uuid}/replay", { params: { path: { uuid } }, body: params })),
      save: (uuid, params = {}) => unwrap(api.POST("/v1/plays/{uuid}/save", { params: { path: { uuid } }, body: params }))
    };
    this.keys = {
      current: () => unwrap(api.GET("/v1/keys/current"))
    };
    this.workspace = {
      get: () => unwrap(api.GET("/v1/workspace"))
    };
    this.speakers = {
      list: (query) => unwrap(api.GET("/v1/speakers", { params: { query } }))
    };
    this.voices = {
      list: (query) => unwrap(api.GET("/v1/voices", { params: { query } })),
      languages: () => unwrap(api.GET("/v1/voices/languages")),
      locales: (query) => unwrap(api.GET("/v1/voices/locales", { params: { query } })),
      models: () => unwrap(api.GET("/v1/voices/models"))
    };
    this.sounds = {
      list: (query) => unwrap(api.GET("/v1/sounds", { params: { query } })),
      tags: () => unwrap(api.GET("/v1/sounds/tags"))
    };
    this.clips = {
      list: () => unwrap(api.GET("/v1/clips"))
    };
    this.effects = {
      list: (query) => unwrap(api.GET("/v1/effects", { params: { query } }))
    };
  }
  stop(params = {}) {
    return unwrap(this.api.POST("/v1/play/stop", { body: params }));
  }
  watch(options) {
    if (!this.apiKey) {
      throw new QuakError({ status: 0, code: "ERROR_MISSING_API_KEY", message: "watch() needs an apiKey" });
    }
    const url = `${this.baseUrl.replace(/^http/, "ws")}/v1/plays/watch`;
    return watchPlays(url, this.apiKey, options);
  }
}
function toFormData(params) {
  const { file, filename, ...fields } = params;
  const form = new FormData;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) {
      continue;
    }
    form.append(key, formValue(value));
  }
  form.append("file", toBlob(file), filename ?? (typeof File !== "undefined" && file instanceof File ? file.name : "audio"));
  return form;
}
function formValue(value) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value) && value.every((item) => ["string", "number"].includes(typeof item))) {
    return value.join(",");
  }
  return JSON.stringify(value);
}
function toBlob(file) {
  if (file instanceof Blob) {
    return file;
  }
  return new Blob([file instanceof Uint8Array ? new Uint8Array(file) : file]);
}
// src/github.ts
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
var TITLE = "Quak";
function createRunner(env, write) {
  const command = (name, message, title) => write(`::${name}${title ? ` title=${escapeProperty(title)}` : ""}::${escapeData(message)}`);
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
      appendFileSync(file, `${name}<<${delimiter}
${value}
${delimiter}
`, "utf8");
    }
  };
}
function escapeData(value) {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function escapeProperty(value) {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

// src/inputs.ts
var KINDS = ["text", "sound", "clip", "file", "url"];
var INTENSITIES = ["off", "weak", "medium", "strong"];
var MAX_TEXT_CHARACTERS = 1000;

class InputError extends Error {
  problems;
  name = "InputError";
  constructor(problems) {
    super(problems.join(`
`));
    this.problems = problems;
  }
}
function input(env, name) {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}
var PROCESSING = [
  "intro",
  "outro",
  "gap",
  "effect",
  "effect-intensity",
  "ambience",
  "ambience-intensity",
  "skip-cache"
];
function parseInputs(env) {
  const problems = [];
  const get = (name) => input(env, name);
  const apiKey = get("api-key");
  const type = get("type");
  let kind = "text";
  if (!type) {
    problems.push(`type is missing. Set it to one of ${KINDS.join(", ")}.`);
  } else if (!KINDS.includes(type)) {
    problems.push(`type "${type}" is unknown. Use one of ${KINDS.join(", ")}.`);
  } else {
    kind = type;
  }
  const kindKnown = KINDS.includes(type);
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
  const options = {};
  const string = (name, key) => {
    const value = get(name);
    if (value) {
      options[key] = value;
    }
  };
  const integer = (name, key, min, max, step = 1) => {
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
    options[key] = number;
  };
  const boolean = (name, key) => {
    const value = get(name);
    if (!value) {
      return;
    }
    if (["true", "True", "TRUE"].includes(value)) {
      options[key] = true;
    } else if (["false", "False", "FALSE"].includes(value)) {
      options[key] = false;
    } else {
      problems.push(`${name} must be true or false, not "${value}".`);
    }
  };
  const intensity = (name, key) => {
    const value = get(name);
    if (value && !INTENSITIES.includes(value)) {
      problems.push(`${name} must be one of ${INTENSITIES.join(", ")}, not "${value}".`);
      return;
    }
    string(name, key);
  };
  const to = get("to");
  if (to) {
    const speakers = to.split(",").map((slug) => slug.trim()).filter(Boolean);
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
  const processed = kind === "sound" || kind === "clip" ? options.process === true : kind === "url" ? options.process !== false : true;
  const ignored = processed ? [] : PROCESSING.filter((name) => get(name));
  return { apiKey, kind, content, options, ignored };
}
function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
function parseVolumes(value) {
  const problem = `volumes must be a JSON object of speaker slugs and volumes from 1 to 100, like {"office": 30, "kitchen": 60}.`;
  let parsed;
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
    if (!slug.trim() || !Number.isInteger(volume) || volume < 1 || volume > 100) {
      return problem;
    }
  }
  return parsed;
}
// package.json
var package_default = {
  name: "quak-github-action",
  version: "1.0.0",
  private: true,
  description: "GitHub Action for the Quak API: announcements, sounds and clips on Sonos speakers from a workflow",
  license: "MIT",
  author: "Mike Lieser",
  type: "module",
  scripts: {
    build: "bun build src/main.ts --target=node --format=esm --outfile=dist/index.js",
    lint: "tsc --noEmit",
    format: "prettier --write --ignore-unknown .",
    "format:check": "prettier --check --ignore-unknown ."
  },
  dependencies: {
    "@quak/js": "0.9.6"
  },
  devDependencies: {
    "@types/bun": "1.4.2",
    prettier: "3.9.9",
    typescript: "7.0.2"
  }
};

// src/run.ts
var TIMEOUT_MS = 30000;
var MAX_FILE_BYTES = 10 * 1024 * 1024;
async function run(options) {
  const runner = createRunner(options.env, options.write);
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
function parseFailOnError(env, runner) {
  const value = input(env, "fail-on-error");
  if (["true", "True", "TRUE"].includes(value)) {
    return true;
  }
  if (value && !["false", "False", "FALSE"].includes(value)) {
    runner.warning(`fail-on-error must be true or false, not "${value}". Using false.`);
  }
  return false;
}
async function playOnce(options, runner) {
  const { env } = options;
  let inputs;
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
      runner.warning(`Nothing played: api-key is empty, because ${without} get no secrets.`);
      return 0;
    }
    runner.error("api-key is empty. Add the key as the repository secret QUAK_API_KEY (Settings → Secrets and variables → " + "Actions) and pass it with api-key: ${{ secrets.QUAK_API_KEY }}.");
    return 1;
  }
  if (inputs.ignored.length > 0) {
    const what = inputs.kind === "url" ? "the URL is played without processing" : `the ${inputs.kind} plays as stored`;
    runner.warning(`${list(inputs.ignored)} ${inputs.ignored.length === 1 ? "has" : "have"} no effect: ${what}. ` + (inputs.kind === "url" ? "Remove process: false to use them." : "Set process: true to use them."));
  }
  let file;
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
    client: `github-action/${package_default.version}`,
    fetch: guardedFetch(options.fetch ?? globalThis.fetch, timeoutMs),
    ...options.baseUrl ? { baseUrl: options.baseUrl } : {}
  });
  let play;
  try {
    const response = await send(quak, inputs, file);
    play = checkPlay(response);
  } catch (error) {
    runner.error(describeError(error, timeoutMs));
    return 1;
  }
  return report(play, inputs, file?.name, quak.credits, runner);
}
function send(quak, inputs, file) {
  const { content } = inputs;
  const options = inputs.options;
  switch (inputs.kind) {
    case "text":
      return quak.play.text({ ...options, text: content });
    case "sound":
      return quak.play.sound({ ...options, sound: content });
    case "clip":
      return quak.play.clip({ ...options, clip: content });
    case "file":
      return quak.play.file({ ...options, file: file.bytes, filename: file.name });
    case "url":
      return quak.play.url({ ...options, url: content });
  }
}
function guardedFetch(fetch, timeoutMs) {
  return (input, init) => fetch(input, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
}
async function loadFile(path, env, runner) {
  const full = resolve(env.GITHUB_WORKSPACE || process.cwd(), path);
  let size;
  try {
    const stat = statSync(full);
    if (!stat.isFile()) {
      runner.error(`file ${path} is not a file.`);
      return null;
    }
    size = stat.size;
  } catch {
    runner.error(`file ${path} does not exist (looked in ${full}). Paths are relative to the workspace; create the file in an ` + "earlier step or check out the repository first.");
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
function checkPlay(response) {
  const play = response?.data;
  if (typeof play !== "object" || play === null || typeof play.id !== "string" || typeof play.status !== "string") {
    throw new UnexpectedAnswer;
  }
  return play;
}

class UnexpectedAnswer extends Error {
}
function report(play, inputs, fileName, left, runner) {
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
  const cost = describeCredits(play.credits, left);
  if (play.status === "SKIPPED") {
    const why = play.skipReason === "QUIET_HOURS" ? "it is quiet hours" : play.skipReason === "BUSY" ? "every speaker is busy with a play of higher priority" : "Quak skipped it";
    runner.notice(`Nothing played: ${why}. The ${inputs.kind} was not announced${on}.`);
    return 0;
  }
  if (play.status === "FAILED") {
    const errors = players.filter((player) => player.error).map((player) => `${player.name}: ${player.error}`);
    runner.error(`Quak could not play the ${inputs.kind}${on}${errors.length ? ` (${errors.join("; ")})` : ""}. Check the speakers in Quak.`);
    return 1;
  }
  if (play.preview) {
    runner.info(`Quak: preview of ${what} made, nothing played on the speakers${cost}. The audio is in the output audio-url.`);
    return 0;
  }
  if (play.status === "SCHEDULED") {
    const at = play.startsAt ? ` for ${play.startsAt.replace("T", " ").replace(/\.\d+Z$|Z$/, " UTC")}` : "";
    runner.info(`Quak: ${what} scheduled${at}${to}${cost}.`);
  } else {
    runner.info(`Quak: ${what} sent${to}${cost}.`);
  }
  const failed = players.filter((player) => player.status === "FAILED");
  if (failed.length > 0) {
    const names = failed.map((player) => player.error ? `${player.name} (${player.error})` : player.name);
    runner.warning(`Not played on ${list(names)}.`);
  }
  return 0;
}
function describeContent(inputs, fileName) {
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
function describeCredits(used, left) {
  const parts = [];
  if (typeof used === "number") {
    parts.push(`${used} ${used === 1 ? "credit" : "credits"}`);
  }
  if (left !== null) {
    parts.push(`${left} left`);
  }
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}
var HINTS = {
  ERROR_INVALID_API_KEY: "Check the secret QUAK_API_KEY: the key is unknown or was deleted.",
  ERROR_MISSING_API_KEY: "Check the secret QUAK_API_KEY.",
  ERROR_INSUFFICIENT_SCOPE: "The key needs the scope play.",
  ERROR_INSUFFICIENT_CREDITS: "The workspace is out of credits.",
  ERROR_NOT_ENOUGH_CREDITS: "The workspace is out of credits.",
  ERROR_SONOS_RECONNECT_REQUIRED: "Reconnect Sonos in Quak.",
  ERROR_TOO_MANY_REQUESTS: "Too many plays in a short time, try again later."
};
function describeError(error, timeoutMs = TIMEOUT_MS) {
  if (error instanceof UnexpectedAnswer) {
    return "Quak sent an answer the action does not understand. The play may have gone out anyway.";
  }
  if (!(error instanceof QuakError)) {
    return `Unexpected error: ${clean(error instanceof Error ? error.message : String(error))}`;
  }
  if (error.status === 0) {
    const cause = error.cause;
    if (cause?.name === "TimeoutError") {
      return `Quak did not answer within ${timeoutMs / 1000} s. The play may have gone out anyway, so the action does ` + "not try again.";
    }
    if (cause instanceof SyntaxError) {
      return "Quak sent an answer that is not JSON. The play may have gone out anyway.";
    }
    return `Could not reach Quak: ${clean(error.message.replace(/^network error: /, ""))}.`;
  }
  if (error.status >= 300 && error.status < 400) {
    return `Quak answered with a redirect (HTTP ${error.status}), which the action does not follow.`;
  }
  const message = clean(error.message).replace(/\.$/, "");
  const field = error.field ? ` (input ${kebab(error.field)})` : "";
  const hint = HINTS[error.code] ?? (error.status >= 500 ? "Quak or Sonos has a problem right now." : "");
  const request = error.requestId ? ` Request ID: ${error.requestId}.` : "";
  return `${message}${field}.${hint ? ` ${hint}` : ""} [HTTP ${error.status}, ${error.code}]${request}`;
}
function clean(message) {
  const line = message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}
function kebab(field) {
  return field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
function runsWithoutSecrets(env) {
  if (env.GITHUB_ACTOR === "dependabot[bot]") {
    return "Dependabot runs";
  }
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
  } catch {}
  return null;
}
function list(items) {
  return items.length <= 1 ? items[0] ?? "" : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
}

// src/main.ts
try {
  process.exitCode = await run({ env: process.env, write: (line) => process.stdout.write(`${line}
`) });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`::error title=Quak::Unexpected error in the action: ${message.replace(/\r?\n/g, " ")}
`);
  process.exitCode = ["true", "True", "TRUE"].includes(process.env["INPUT_FAIL-ON-ERROR"]?.trim() ?? "") ? 1 : 0;
}
