import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function RepositoryAnalysisMarkdown({ content }: { content: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        p: ({ children }) => (
          <p className="my-2 text-sm leading-relaxed text-muted-foreground">
            {children}
          </p>
        ),
        ul: ({ children }) => (
          <ul className="my-2 list-disc space-y-1 pl-4">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="my-2 list-decimal space-y-1 pl-4">{children}</ol>
        ),
        li: ({ children }) => (
          <li className="text-sm text-muted-foreground marker:text-muted-foreground">
            {children}
          </li>
        ),
        strong: ({ children }) => <strong>{children}</strong>,
        em: ({ children }) => <em>{children}</em>,
        code: ({ className, children }) =>
          className ? (
            <code className={className}>{children}</code>
          ) : (
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              {children}
            </code>
          ),
        pre: ({ children }) => (
          <pre className="my-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
            {children}
          </pre>
        ),
        a: ({ href, children }) => (
          <a
            href={href}
            target={href?.startsWith("http") ? "_blank" : undefined}
            rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
            className="underline underline-offset-4 hover:text-foreground"
          >
            {children}
          </a>
        ),
        img: ({ alt }) => <span>{alt ?? ""}</span>,
      }}
    >
      {content}
    </Markdown>
  );
}
