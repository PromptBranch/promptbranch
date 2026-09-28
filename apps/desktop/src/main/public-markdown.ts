import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import ipaddr from "ipaddr.js";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const GLOBAL_IPV6_RANGE = ipaddr.parseCIDR("2000::/3");

// IANA special-purpose blocks are denied even where a protocol anycast
// exception is globally reachable; this importer needs ordinary public hosts.
const NON_PUBLIC_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.31.196.0/24",
  "192.52.193.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "192.175.48.0/24",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
  "::/128",
  "::1/128",
  "::ffff:0:0/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "100:0:0:1::/64",
  "2001::/23",
  "2001:2::/48",
  "2001:3::/32",
  "2001:4:112::/48",
  "2001:10::/28",
  "2001:20::/28",
  "2001:30::/28",
  "2001:db8::/32",
  "2002::/16",
  "2620:4f:8000::/48",
  "3fff::/20",
  "5f00::/16",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
].map((cidr) => ipaddr.parseCIDR(cidr));

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home",
  ".lan",
  ".test",
  ".invalid",
  ".example",
  ".onion",
];

export interface ResolvedMarkdownAddress {
  address: string;
  family: 4 | 6;
}

export interface MarkdownRequestInput {
  url: URL;
  /** Address resolved and validated for this hop; the adapter must pin it. */
  address: ResolvedMarkdownAddress;
  signal: AbortSignal;
}

export interface MarkdownResponse {
  statusCode: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: AsyncIterable<Uint8Array>;
  /** Closes the response when a redirect or validation failure skips its body. */
  cancel: () => void;
}

export interface MarkdownFetchDeps {
  resolve: (hostname: string) => Promise<readonly ResolvedMarkdownAddress[]>;
  request: (input: MarkdownRequestInput) => Promise<MarkdownResponse>;
  /** A short value can be injected to test the single chain-wide deadline. */
  timeoutMs?: number;
}

export interface PublicMarkdownResult {
  sourceUrl: string;
  finalUrl: string;
  content: string;
  suggestedTitle: string;
}

export class MarkdownFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownFetchError";
  }
}

const productionDeps: MarkdownFetchDeps = {
  resolve: async (hostname) =>
    (await dnsLookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({
      address,
      family: family as 4 | 6,
    })),
  request: requestPinnedHttps,
};

function validatePublicUrl(rawUrl: string): URL {
  if (!rawUrl || rawUrl.length > 2_000 || rawUrl !== rawUrl.trim()) {
    throw new MarkdownFetchError("Enter a public HTTPS Markdown URL.");
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new MarkdownFetchError("Enter a public HTTPS Markdown URL.");
  }

  const hostname = url.hostname.toLowerCase();
  const authority = rawUrl.match(/^https:\/\/([^/?#]*)/i)?.[1] ?? "";
  const unbracketedHostname = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    authority.includes("@") ||
    rawUrl.includes("#") ||
    url.port !== "" ||
    isIP(unbracketedHostname) !== 0 ||
    hostname.endsWith(".") ||
    !hostname.includes(".") ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix))
  ) {
    throw new MarkdownFetchError("Only public HTTPS hostnames on port 443 are supported.");
  }
  return url;
}

function isGloballyRoutableAddress(record: ResolvedMarkdownAddress): boolean {
  if (record.family !== 4 && record.family !== 6) return false;
  if (isIP(record.address) !== record.family || record.address.includes("%")) return false;

  let address: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    address = ipaddr.parse(record.address);
  } catch {
    return false;
  }
  if (address.kind() !== (record.family === 4 ? "ipv4" : "ipv6")) return false;
  if (address.range() !== "unicast") return false;
  if (record.family === 6 && !address.match(GLOBAL_IPV6_RANGE)) return false;
  return !NON_PUBLIC_CIDRS.some(
    ([network, prefix]) => network.kind() === address.kind() && address.match(network, prefix),
  );
}

function headerValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | null | undefined {
  const keys = Object.keys(headers).filter((candidate) => candidate.toLowerCase() === name);
  if (keys.length === 0) return undefined;
  if (keys.length !== 1) return null;
  const value = headers[keys[0]!];
  return typeof value === "string" ? value : null;
}

function checkResponseHeaders(url: URL, response: MarkdownResponse): void {
  const contentEncoding = headerValue(response.headers, "content-encoding");
  if (
    contentEncoding === null ||
    (contentEncoding !== undefined && contentEncoding.toLowerCase().trim() !== "identity")
  ) {
    response.cancel();
    throw new MarkdownFetchError("The Markdown server returned an unsupported encoding.");
  }

  const contentLength = headerValue(response.headers, "content-length");
  if (contentLength !== undefined) {
    if (
      contentLength === null ||
      !/^\d+$/.test(contentLength.trim()) ||
      Number(contentLength) > MAX_BODY_BYTES
    ) {
      response.cancel();
      throw new MarkdownFetchError("Markdown files must be 1 MiB or smaller.");
    }
  }

  const rawType = headerValue(response.headers, "content-type");
  const [mediaType = "", ...parameters] = typeof rawType === "string" ? rawType.split(";") : [];
  const normalizedType = mediaType.trim().toLowerCase();
  const acceptsMarkdown = normalizedType === "text/markdown" || normalizedType === "text/plain";
  const filenameOnlyType =
    normalizedType === "application/octet-stream" && /\.(?:md|markdown)$/i.test(url.pathname);
  const charset = parameters
    .map((parameter) => parameter.trim().match(/^charset\s*=\s*"?([^";]+)"?$/i)?.[1])
    .find((value) => value !== undefined);
  if (
    (!acceptsMarkdown && !filenameOnlyType) ||
    rawType === null ||
    (charset !== undefined && charset.toLowerCase() !== "utf-8")
  ) {
    response.cancel();
    throw new MarkdownFetchError("The URL did not return a supported Markdown text file.");
  }
}

async function readBody(response: MarkdownResponse): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > MAX_BODY_BYTES) {
        response.cancel();
        throw new MarkdownFetchError("Markdown files must be 1 MiB or smaller.");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    response.cancel();
    throw error;
  }

  const content = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

function titleFromUrl(url: URL): string {
  let filename = url.pathname.split("/").at(-1) ?? "";
  try {
    filename = decodeURIComponent(filename);
  } catch {
    return "Imported prompt";
  }
  const title = filename
    .replace(/\.(?:md|markdown)$/i, "")
    .replace(/[\\/]/g, "-")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
  return title || "Imported prompt";
}

function withDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new MarkdownFetchError("The Markdown download timed out."));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new MarkdownFetchError("The Markdown download timed out."));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function resolvePublicAddress(
  deps: MarkdownFetchDeps,
  hostname: string,
  signal: AbortSignal,
): Promise<readonly ResolvedMarkdownAddress[]> {
  return withDeadline(deps.resolve(hostname), signal).then((addresses) => {
    if (addresses.length === 0 || addresses.some((address) => !isGloballyRoutableAddress(address))) {
      throw new MarkdownFetchError("The hostname did not resolve only to public IP addresses.");
    }
    return addresses;
  });
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/** Downloads a user-reviewed public Markdown URL without browser credentials. */
export async function fetchPublicMarkdown(
  rawUrl: string,
  deps: MarkdownFetchDeps = productionDeps,
): Promise<PublicMarkdownResult> {
  const sourceUrl = rawUrl;
  let currentUrl = validatePublicUrl(rawUrl);
  const visited = new Set<string>();
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    for (let redirects = 0; ; ) {
      if (controller.signal.aborted) {
        throw new MarkdownFetchError("The Markdown download timed out.");
      }
      if (visited.has(currentUrl.href)) {
        throw new MarkdownFetchError("The Markdown server returned a redirect loop.");
      }
      visited.add(currentUrl.href);

      const addresses = await resolvePublicAddress(deps, currentUrl.hostname, controller.signal);
      const address = addresses[0];
      if (!address) throw new MarkdownFetchError("The hostname did not resolve to a public IP address.");

      let response: MarkdownResponse;
      try {
        response = await withDeadline(
          deps.request({ url: currentUrl, address, signal: controller.signal }),
          controller.signal,
        );
      } catch (error) {
        if (error instanceof MarkdownFetchError) throw error;
        throw new MarkdownFetchError("The Markdown URL could not be reached.");
      }

      if (REDIRECT_CODES.has(response.statusCode)) {
        const location = headerValue(response.headers, "location");
        response.cancel();
        if (!location) throw new MarkdownFetchError("The Markdown server returned an invalid redirect.");
        if (redirects >= MAX_REDIRECTS) {
          throw new MarkdownFetchError("The Markdown server redirected too many times.");
        }
        let redirectUrl: URL;
        try {
          redirectUrl = new URL(location, currentUrl);
        } catch {
          throw new MarkdownFetchError("The Markdown server returned an invalid redirect.");
        }
        currentUrl = validatePublicUrl(redirectUrl.href);
        redirects++;
        continue;
      }

      if (response.statusCode !== 200) {
        response.cancel();
        throw new MarkdownFetchError(`The Markdown server returned HTTP ${response.statusCode}.`);
      }

      checkResponseHeaders(currentUrl, response);
      const bytes = await withDeadline(readBody(response), controller.signal);
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw new MarkdownFetchError("The Markdown file is not valid UTF-8 text.");
      }
      if (!content.trim()) throw new MarkdownFetchError("The Markdown file is empty.");

      return {
        sourceUrl,
        finalUrl: currentUrl.href,
        content,
        suggestedTitle: titleFromUrl(currentUrl),
      };
    }
  } catch (error) {
    if (error instanceof MarkdownFetchError) throw error;
    if (controller.signal.aborted) {
      throw new MarkdownFetchError("The Markdown download timed out.");
    }
    throw new MarkdownFetchError("The Markdown URL could not be fetched safely.");
  } finally {
    clearTimeout(timeout);
  }
}

function requestPinnedHttps({ url, address, signal }: MarkdownRequestInput): Promise<MarkdownResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        protocol: "https:",
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        agent: false,
        headers: {
          accept: "text/markdown, text/plain, application/octet-stream;q=0.5",
          "accept-encoding": "identity",
        },
        lookup: (_hostname, options, callback) => {
          if (typeof options === "object" && options.all) {
            callback(null, [{ address: address.address, family: address.family }]);
          } else {
            callback(null, address.address, address.family);
          }
        },
        servername: url.hostname,
        rejectUnauthorized: true,
        signal,
      },
      (response) => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers as IncomingHttpHeaders,
          body: response,
          cancel: () => response.destroy(),
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}
