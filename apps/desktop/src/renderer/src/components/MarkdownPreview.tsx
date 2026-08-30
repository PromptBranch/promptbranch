import { isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlightCode, useHighlighterReady } from "../lib/highlight";

/** Open links in the system browser, never in the Electron window. */
function openLink(event: React.MouseEvent<HTMLAnchorElement>, href?: string) {
  event.preventDefault();
  if (!href || !/^https?:\/\//i.test(href)) return;
  void window.promptBuilder.app.openExternal(href).catch(() => {});
}

/** Language + raw source of a fenced code block, from its <code> child. */
function fenceInfo(children: ReactNode): { language: string | null; code: string | null } {
  if (!isValidElement(children)) return { language: null, code: null };
  const props = (children as ReactElement<{ className?: string; children?: ReactNode }>).props;
  const language = /language-([\w+-]+)/.exec(props.className ?? "")?.[1] ?? null;
  const code = typeof props.children === "string" ? props.children.replace(/\n$/, "") : null;
  return { language, code };
}

/**
 * Fenced code block: language-label header, hover copy button, and Shiki
 * highlighting once the highlighter has loaded. Until then (or for unknown
 * languages) the children render as a plain block — progressive enhancement,
 * no layout shift: the header and padding are identical either way.
 * `partial` marks a block that may still grow (streaming): it is highlighted
 * but kept out of the highlight cache (see lib/highlight.ts).
 */
function CodeBlock({ children, partial = false }: { children: ReactNode; partial?: boolean }) {
  const ready = useHighlighterReady();
  const [copied, setCopied] = useState(false);
  const { language, code } = fenceInfo(children);
  const html = ready ? highlightCode(code ?? "", language, { partial }) : null;
  return (
    <div className="group relative my-3 overflow-hidden rounded-lg border border-line bg-app">
      {language && (
        <div className="border-b border-line px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
          {language}
        </div>
      )}
      {html !== null ? (
        <div className="pb-shiki overflow-x-auto p-3" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="overflow-x-auto p-3">{children}</pre>
      )}
      {code !== null && (
        <button
          type="button"
          aria-label="Copy code"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            }, () => {});
          }}
          className="absolute right-2 top-2 rounded border border-line bg-raised p-1 text-ink-dim opacity-0 transition-opacity hover:text-ink focus:opacity-100 group-hover:opacity-100"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      )}
    </div>
  );
}

/**
 * Read-only rendered Markdown (GFM: tables, task lists, strikethrough).
 * Styled to the app theme; fenced code blocks are syntax highlighted (Shiki,
 * dual github-light/github-dark themes driven by [data-theme], see
 * lib/highlight.ts). With `autoScroll`, the view sticks to the bottom as
 * content grows (live streaming) — until the user scrolls up, which releases
 * the stick.
 */
export function MarkdownPreview({ content, autoScroll = false }: { content: string; autoScroll?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  useEffect(() => {
    const el = containerRef.current;
    if (autoScroll && el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [content, autoScroll]);
  return (
    // break-words: long unbroken strings (URLs, base64, hashes) must wrap
    // instead of overflowing narrow compare columns.
    <div
      ref={containerRef}
      onScroll={
        autoScroll
          ? (event) => {
              const el = event.currentTarget;
              stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }
          : undefined
      }
      className="h-full overflow-y-auto break-words px-5 py-4 text-[13px] leading-relaxed text-ink"
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-3 mt-5 border-b border-line pb-2 text-lg font-semibold text-ink first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-5 text-[15px] font-semibold text-ink first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-2 mt-4 text-[13px] font-semibold text-ink first:mt-0">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mb-1.5 mt-4 text-[12px] font-semibold uppercase tracking-wide text-ink-dim first:mt-0">
              {children}
            </h4>
          ),
          p: ({ children }) => <p className="my-2.5 leading-relaxed text-ink">{children}</p>,
          ul: ({ children }) => <ul className="my-2.5 list-disc space-y-1 pl-5 text-ink">{children}</ul>,
          ol: ({ children }) => <ol className="my-2.5 list-decimal space-y-1 pl-5 text-ink">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed [&>input]:mr-1.5">{children}</li>,
          // GFM task-list checkboxes (always disabled in a read-only preview).
          input: ({ checked }) => (
            <input type="checkbox" checked={checked} disabled readOnly className="accent-accent align-middle" />
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-accent/50 pl-3 text-ink-dim">{children}</blockquote>
          ),
          hr: () => <hr className="my-4 border-line" />,
          strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(event) => openLink(event, href)}
              className="cursor-pointer text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
            >
              {children}
            </a>
          ),
          code: ({ className, children }) =>
            className?.includes("language-") ? (
              <code className={`${className} block font-mono text-[12px] leading-relaxed text-ink`}>
                {children}
              </code>
            ) : (
              <code className="rounded border border-line bg-raised px-1 py-px font-mono text-[12px] text-ink">
                {children}
              </code>
            ),
          pre: ({ children, node }) => (
            // In streaming (autoScroll) mode the block that reaches the end of
            // the content may still grow — its per-delta texts must not
            // pollute the highlight cache. Settled blocks keep cache hits.
            <CodeBlock
              partial={
                autoScroll &&
                node?.position?.end?.offset !== undefined &&
                content.slice(node.position.end.offset).trim() === ""
              }
            >
              {children}
            </CodeBlock>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-lg border border-line">
              <table className="w-full border-collapse text-[12px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-raised">{children}</thead>,
          th: ({ children }) => (
            <th className="border-b border-line px-2.5 py-1.5 text-left font-semibold text-ink">{children}</th>
          ),
          td: ({ children }) => <td className="border-t border-line px-2.5 py-1.5 text-ink-dim">{children}</td>,
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
