import { describe, expect, it, vi } from "vitest";
import {
  fetchPublicMarkdown,
  type MarkdownFetchDeps,
  type MarkdownRequestInput,
  type MarkdownResponse,
  type ResolvedMarkdownAddress,
} from "./public-markdown.js";

const PUBLIC_V4: ResolvedMarkdownAddress = { address: "93.184.216.34", family: 4 };
const PUBLIC_V6: ResolvedMarkdownAddress = { address: "2606:4700:4700::1111", family: 6 };
const MARKDOWN = "# Rôle\n\nKeep this exact.\r\n";

function makeResponse(options: {
  statusCode?: number;
  headers?: Record<string, string | undefined>;
  chunks?: Uint8Array[];
} = {}): MarkdownResponse {
  return {
    statusCode: options.statusCode ?? 200,
    headers: options.headers ?? { "content-type": "text/markdown; charset=utf-8" },
    body: (async function* () {
      for (const chunk of options.chunks ?? [new TextEncoder().encode(MARKDOWN)]) yield chunk;
    })(),
    cancel: vi.fn(),
  };
}

function setup(options: {
  addresses?: ResolvedMarkdownAddress[];
  responses?: MarkdownResponse[];
  resolveSequence?: ResolvedMarkdownAddress[][];
  timeoutMs?: number;
} = {}) {
  let responseIndex = 0;
  let resolveIndex = 0;
  const requests: MarkdownRequestInput[] = [];
  const resolve = vi.fn(async (_hostname: string) => {
    const sequence = options.resolveSequence?.[resolveIndex++];
    return sequence ?? options.addresses ?? [PUBLIC_V4];
  });
  const request = vi.fn(async (input: MarkdownRequestInput) => {
    requests.push(input);
    const response = options.responses?.[responseIndex++];
    if (!response) throw new Error("No response fixture configured");
    return response;
  });
  const deps: MarkdownFetchDeps = {
    resolve,
    request,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
  return { deps, resolve, request, requests };
}

describe("fetchPublicMarkdown", () => {
  it("fetches Markdown over a pinned public HTTPS address and preserves exact text", async () => {
    const fake = setup({ responses: [makeResponse()] });
    const result = await fetchPublicMarkdown("https://example.com/prompts/team.md", fake.deps);

    expect(result).toEqual({
      sourceUrl: "https://example.com/prompts/team.md",
      finalUrl: "https://example.com/prompts/team.md",
      content: MARKDOWN,
      suggestedTitle: "team",
    });
    expect(fake.request).toHaveBeenCalledOnce();
    expect(fake.requests[0]?.address).toEqual(PUBLIC_V4);
    expect(fake.requests[0]?.url.hostname).toBe("example.com");

    const explicitDefaultPort = setup({ responses: [makeResponse()] });
    await expect(
      fetchPublicMarkdown("https://example.com:443/prompts/team.md", explicitDefaultPort.deps),
    ).resolves.toMatchObject({ suggestedTitle: "team" });
  });

  it.each([
    ["plain text", "text/plain; charset=utf-8", "https://example.com/team.markdown"],
    ["Markdown octet stream", "application/octet-stream", "https://example.com/team.MD"],
  ])("accepts %s when the media type contract permits it", async (_label, type, url) => {
    const fake = setup({
      responses: [makeResponse({ headers: { "content-type": type } })],
    });

    const result = await fetchPublicMarkdown(url, fake.deps);

    expect(result.content).toBe(MARKDOWN);
  });

  it("uses the filename as a bounded title and falls back when there is no Markdown filename", async () => {
    const filename = setup({ responses: [makeResponse()] });
    await expect(
      fetchPublicMarkdown(`https://example.com/${"a".repeat(250)}.md`, filename.deps),
    ).resolves.toMatchObject({ suggestedTitle: "a".repeat(200) });

    const fallback = setup({
      responses: [makeResponse({ headers: { "content-type": "text/plain" } })],
    });
    await expect(fetchPublicMarkdown("https://example.com/", fallback.deps)).resolves.toMatchObject({
      suggestedTitle: "Imported prompt",
    });
  });

  it.each([
    "http://example.com/prompt.md",
    "file:///etc/passwd",
    "data:text/plain,hello",
    "https://user@example.com/prompt.md",
    "https://@example.com/prompt.md",
    "https://example.com:8443/prompt.md",
    "https://93.184.216.34/prompt.md",
    "https://[2606:4700:4700::1111]/prompt.md",
    "https://localhost/prompt.md",
    "https://localhost./prompt.md",
    "https://sub.localhost/prompt.md",
    "https://router.local/prompt.md",
    "https://service.internal/prompt.md",
    "https://service.internal./prompt.md",
  ])("rejects an unsafe URL before DNS or network access: %s", async (url) => {
    const fake = setup();

    await expect(fetchPublicMarkdown(url, fake.deps)).rejects.toThrow();

    expect(fake.resolve).not.toHaveBeenCalled();
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("rejects fragments even though they are not sent in HTTP requests", async () => {
    const fake = setup();
    await expect(fetchPublicMarkdown("https://example.com/prompt.md#part", fake.deps)).rejects.toThrow();
    await expect(fetchPublicMarkdown("https://example.com/prompt.md#", fake.deps)).rejects.toThrow();
    await expect(
      fetchPublicMarkdown("https://example.com/prompt.md", {
        ...fake.deps,
        request: vi.fn(async () =>
          makeResponse({ statusCode: 302, headers: { location: "https://cdn.example.net/final.md#" } }),
        ),
      }),
    ).rejects.toThrow();
    expect(fake.request).not.toHaveBeenCalled();
  });

  it.each([
    ["IPv4 loopback", "127.0.0.1", 4],
    ["IPv4 private", "10.1.2.3", 4],
    ["IPv4 link local", "169.254.1.1", 4],
    ["IPv4 carrier-grade NAT", "100.64.0.1", 4],
    ["IPv4 documentation", "192.0.2.1", 4],
    ["IPv4 protocol anycast", "192.31.196.1", 4],
    ["IPv4 benchmark", "198.18.0.1", 4],
    ["IPv4 multicast", "224.0.0.1", 4],
    ["IPv4 reserved", "240.0.0.1", 4],
    ["IPv6 loopback", "::1", 6],
    ["IPv6 link local", "fe80::1", 6],
    ["IPv6 unique local", "fd00::1", 6],
    ["IPv6 documentation", "2001:db8::1", 6],
    ["IPv6 benchmark", "2001:2::1", 6],
    ["IPv6 protocol anycast", "2001:4:112::1", 6],
    ["IPv4-mapped private IPv6", "::ffff:10.0.0.1", 6],
  ])("rejects %s DNS answers before opening a socket", async (_label, address, family) => {
    const fake = setup({ addresses: [{ address, family } as ResolvedMarkdownAddress] });

    await expect(fetchPublicMarkdown("https://example.com/prompt.md", fake.deps)).rejects.toThrow();

    expect(fake.request).not.toHaveBeenCalled();
  });

  it("rejects a hostname if any DNS answer is not globally routable", async () => {
    const fake = setup({ addresses: [PUBLIC_V4, { address: "192.168.1.2", family: 4 }] });

    await expect(fetchPublicMarkdown("https://example.com/prompt.md", fake.deps)).rejects.toThrow();

    expect(fake.request).not.toHaveBeenCalled();
  });

  it("pins each request to the validated DNS result and revalidates a redirect", async () => {
    const fake = setup({
      resolveSequence: [[PUBLIC_V4], [PUBLIC_V6]],
      responses: [
        makeResponse({ statusCode: 302, headers: { location: "https://cdn.example.net/final.md" } }),
        makeResponse(),
      ],
    });

    const result = await fetchPublicMarkdown("https://example.com/start.md", fake.deps);

    expect(result.finalUrl).toBe("https://cdn.example.net/final.md");
    expect(fake.requests.map((request) => request.address)).toEqual([PUBLIC_V4, PUBLIC_V6]);
    expect(fake.requests[0]?.signal).toBe(fake.requests[1]?.signal);
    expect(fake.resolve.mock.calls.map(([hostname]) => hostname)).toEqual([
      "example.com",
      "cdn.example.net",
    ]);
  });

  it("blocks a redirect to a private address before a second request", async () => {
    const fake = setup({
      responses: [
        makeResponse({ statusCode: 302, headers: { location: "https://127.0.0.1/private.md" } }),
      ],
    });

    await expect(fetchPublicMarkdown("https://example.com/start.md", fake.deps)).rejects.toThrow();

    expect(fake.request).toHaveBeenCalledOnce();
  });

  it("rejects a DNS rebinding answer on a later redirect hop before that hop connects", async () => {
    const fake = setup({
      resolveSequence: [[PUBLIC_V4], [{ address: "10.0.0.4", family: 4 }]],
      responses: [
        makeResponse({ statusCode: 302, headers: { location: "https://example.com/final.md" } }),
      ],
    });

    await expect(fetchPublicMarkdown("https://example.com/start.md", fake.deps)).rejects.toThrow();

    expect(fake.request).toHaveBeenCalledOnce();
  });

  it("limits redirect hops and rejects loops", async () => {
    const tooMany = setup({
      responses: [
        ...Array.from({ length: 4 }, (_, index) =>
          makeResponse({
            statusCode: 302,
            headers: { location: `https://example.com/${index + 1}.md` },
          }),
        ),
      ],
    });
    await expect(fetchPublicMarkdown("https://example.com/0.md", tooMany.deps)).rejects.toThrow();
    expect(tooMany.request).toHaveBeenCalledTimes(4);

    const loop = setup({
      responses: [
        makeResponse({ statusCode: 302, headers: { location: "https://example.com/start.md" } }),
      ],
    });
    await expect(fetchPublicMarkdown("https://example.com/start.md", loop.deps)).rejects.toThrow();
    expect(loop.request).toHaveBeenCalledOnce();
  });

  it.each([
    ["HTML", "text/html"],
    ["other binary", "application/octet-stream"],
    ["compressed", "text/markdown"],
  ])("rejects %s responses", async (_label, type) => {
    const headers: Record<string, string> = { "content-type": type };
    if (_label === "compressed") headers["content-encoding"] = "gzip";
    const fake = setup({ responses: [makeResponse({ headers })] });
    const url = _label === "other binary" ? "https://example.com/prompt.bin" : "https://example.com/prompt.md";

    await expect(fetchPublicMarkdown(url, fake.deps)).rejects.toThrow();
  });

  it("caps Content-Length and streamed bytes at one MiB", async () => {
    const declaredLarge = setup({
      responses: [
        makeResponse({
          headers: { "content-type": "text/markdown", "content-length": String(1024 * 1024 + 1) },
        }),
      ],
    });
    await expect(
      fetchPublicMarkdown("https://example.com/prompt.md", declaredLarge.deps),
    ).rejects.toThrow();

    const streamedLarge = setup({
      responses: [
        makeResponse({
          headers: { "content-type": "text/markdown" },
          chunks: [new Uint8Array(1024 * 1024), new Uint8Array([1])],
        }),
      ],
    });
    await expect(
      fetchPublicMarkdown("https://example.com/prompt.md", streamedLarge.deps),
    ).rejects.toThrow();
  });

  it("rejects invalid UTF-8 and blank text", async () => {
    const invalid = setup({
      responses: [makeResponse({ chunks: [new Uint8Array([0xc3, 0x28])] })],
    });
    await expect(fetchPublicMarkdown("https://example.com/prompt.md", invalid.deps)).rejects.toThrow();

    const blank = setup({
      responses: [makeResponse({ chunks: [new TextEncoder().encode(" \r\n\t")] })],
    });
    await expect(fetchPublicMarkdown("https://example.com/prompt.md", blank.deps)).rejects.toThrow();
  });

  it("applies one deadline to DNS and the whole request chain", async () => {
    const dnsTimeout = setup({
      timeoutMs: 5,
      responses: [makeResponse()],
    });
    dnsTimeout.resolve.mockImplementation(() => new Promise(() => {}));
    await expect(
      fetchPublicMarkdown("https://example.com/prompt.md", dnsTimeout.deps),
    ).rejects.toThrow(/timed out/i);
    expect(dnsTimeout.request).not.toHaveBeenCalled();

    const requestTimeout = setup({ timeoutMs: 5 });
    requestTimeout.request.mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    await expect(
      fetchPublicMarkdown("https://example.com/prompt.md", requestTimeout.deps),
    ).rejects.toThrow(/timed out/i);
  });

  it("converts DNS and network errors into safe import errors", async () => {
    const dnsFailure = setup();
    dnsFailure.resolve.mockRejectedValue(new Error("secret internal resolver detail"));
    await expect(
      fetchPublicMarkdown("https://example.com/prompt.md", dnsFailure.deps),
    ).rejects.not.toThrow("secret internal resolver detail");

    const networkFailure = setup();
    networkFailure.request.mockRejectedValue(new Error("secret socket detail"));
    await expect(
      fetchPublicMarkdown("https://example.com/prompt.md", networkFailure.deps),
    ).rejects.not.toThrow("secret socket detail");
  });
});
