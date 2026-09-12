import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownRenderer } from "./MarkdownRenderer";

vi.mock("react-syntax-highlighter", () => ({
  Prism: ({ children, language }: { children: string; language: string }) => (
    <pre data-language={language}>{children}</pre>
  ),
}));
vi.mock("react-syntax-highlighter/dist/esm/styles/prism", () => ({ oneDark: {} }));

describe("MarkdownRenderer", () => {
  it("renders plain markdown text", () => {
    render(<MarkdownRenderer content="Hello world" />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("renders markdown bold", () => {
    const { container } = render(<MarkdownRenderer content="**bold text**" />);
    expect(container.querySelector("strong")).toBeInTheDocument();
  });

  it("detects bare JSON object and renders via SyntaxHighlighter", () => {
    const { container } = render(<MarkdownRenderer content='{"key":"value","num":42}' />);
    expect(container.querySelector('[data-language="json"]')).toBeInTheDocument();
    expect(container.textContent).toContain('"key"');
  });

  it("detects bare JSON array and renders via SyntaxHighlighter", () => {
    const { container } = render(<MarkdownRenderer content="[1,2,3]" />);
    expect(container.querySelector('[data-language="json"]')).toBeInTheDocument();
  });

  it("formats bare JSON with pretty-printing", () => {
    const { container } = render(<MarkdownRenderer content='{"a":1,"b":2}' />);
    expect(container.textContent).toMatch(/\n/);
  });

  it("does not treat invalid JSON starting with { as a code block", () => {
    const { container } = render(<MarkdownRenderer content="{not valid json}" />);
    expect(container.querySelector("[data-language]")).not.toBeInTheDocument();
  });

  it("does not treat plain text as JSON", () => {
    const { container } = render(<MarkdownRenderer content="just text" />);
    expect(container.querySelector("[data-language]")).not.toBeInTheDocument();
  });

  it("renders fenced code block with syntax highlighting via ReactMarkdown", () => {
    const { container } = render(<MarkdownRenderer content={"```js\nconsole.log('hi')\n```"} />);
    expect(container.querySelector('[data-language="js"]')).toBeInTheDocument();
  });

  // A remote markdown image would otherwise be fetched the moment a conversation is opened,
  // telling an arbitrary third party that the message was read.
  describe("remote image gating", () => {
    it("does not set src for a remote markdown image until it is clicked", () => {
      const { container } = render(
        <MarkdownRenderer content={"![tracker](https://tracker.example/pixel.png)"} />,
      );
      const gate = container.querySelector("button.md-image-gate");
      expect(gate).toBeInTheDocument();
      expect(container.querySelector("img")).toBeNull();
      expect(gate!.textContent).toContain("tracker.example");
      // The URL is shown so the reader can judge it before loading.
      expect(gate!.getAttribute("title")).toBe("https://tracker.example/pixel.png");

      fireEvent.click(gate!);
      const img = container.querySelector("img");
      expect(img).toBeInTheDocument();
      expect(img!.getAttribute("src")).toBe("https://tracker.example/pixel.png");
    });

    it("does not gate same-origin, relative or data sources", () => {
      for (const src of ["/assets/logo.png", "./logo.png", "data:image/png;base64,iVBORw0KGgo="]) {
        const { container } = render(<MarkdownRenderer content={`![x](${src})`} />);
        expect(container.querySelector("img")!.getAttribute("src")).toBe(src);
        expect(container.querySelector("button.md-image-gate")).toBeNull();
      }
    });

    it("renders no image element at all for a non-http(s) protocol", () => {
      const { container } = render(
        <MarkdownRenderer content={"![x](file:///C:/Windows/win.ini)"} />,
      );
      expect(container.querySelector("img")).toBeNull();
    });
  });
});
