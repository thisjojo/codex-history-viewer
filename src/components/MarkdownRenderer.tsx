import { useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { formatJson } from "../lib/format";

function isPureJson(s: string): boolean {
  const t = s.trimStart();
  if (t[0] !== "{" && t[0] !== "[") return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

/** `data:`/`blob:` and same-origin or relative sources reveal nothing to a third party. */
function isSelfContainedSource(src: string): boolean {
  return (
    src.startsWith("data:") ||
    src.startsWith("blob:") ||
    src.startsWith("./") ||
    src.startsWith("../") ||
    src.startsWith("/") ||
    src.startsWith("#")
  );
}

// react-markdown's default URL filter drops every scheme outside http/https/mailto/etc, which
// also removes `data:`/`blob:` images. Those are self-contained (nothing leaves the machine), so
// keep them — but only those; everything else still goes through the upstream default.
function urlTransform(url: string, _key: string, node: { tagName?: string }): string {
  if (node.tagName === "img" && (url.startsWith("data:image/") || url.startsWith("blob:"))) {
    return url;
  }
  return defaultUrlTransform(url);
}

/**
 * A markdown image pointing at a remote host would be fetched the moment the history is opened,
 * telling an arbitrary third party that this conversation was read. Render a placeholder instead
 * and only set `src` once the reader asks for it.
 *
 * Local and `data:` sources are not gated: the message already carries them.
 */
function GatedImage({ src, alt }: { src: string; alt: string }) {
  const [revealed, setRevealed] = useState(false);
  if (!src) return null;
  if (isSelfContainedSource(src)) {
    return <img src={src} alt={alt} loading="lazy" />;
  }
  if (revealed) {
    return <img src={src} alt={alt} />;
  }
  return (
    <button
      type="button"
      className="md-image-gate"
      onClick={() => setRevealed(true)}
      title={src}
      aria-label={`Load remote image: ${src}`}
    >
      <span className="md-image-gate__label">
        {alt ? `Load image: ${alt}` : "Load remote image"}
      </span>
      <span className="md-image-gate__src">{src}</span>
    </button>
  );
}

export function MarkdownRenderer({ content }: { content: string }) {
  if (isPureJson(content)) {
    return (
      <SyntaxHighlighter language="json" style={oneDark} PreTag="div">
        {formatJson(content)}
      </SyntaxHighlighter>
    );
  }

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={urlTransform}
      components={{
        code({ className, children }) {
          const match = /language-(\w+)/.exec(className ?? "");
          const lang = match ? match[1] : "";
          const code = String(children).replace(/\n$/, "");
          if (lang) {
            return (
              <SyntaxHighlighter language={lang} style={oneDark} PreTag="div">
                {code}
              </SyntaxHighlighter>
            );
          }
          return <code className={className}>{children}</code>;
        },
        img({ src, alt }) {
          return <GatedImage src={typeof src === "string" ? src : ""} alt={alt ?? ""} />;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
