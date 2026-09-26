"use client";

import { useState, useCallback } from "react";
import { IconCopy, IconCheck } from "@tabler/icons-react";

export function CodeBlock({
  children,
  title,
}: {
  children: string;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  const copy = useCallback(async () => {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  }, [children]);

  return (
    <div className="mb-4 min-w-0 overflow-hidden rounded-lg border border-white/10">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-white/[0.02] px-4 py-2">
        <span className="min-w-0 text-xs text-[#bbb]">{title ?? "Code"}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${title ?? "code"}`}
          className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs text-[#ccc] transition-colors hover:bg-white/[0.1] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
        >
          {copied ? (
            <IconCheck aria-hidden="true" className="size-3.5 text-green-400" />
          ) : (
            <IconCopy aria-hidden="true" className="size-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre tabIndex={0} aria-label={title ?? "Code"} className="overflow-x-auto bg-[#161616] px-4 py-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cyan-400">
        <code className="text-sm text-[#ccc]">{children}</code>
      </pre>
      <span className="sr-only" role="status">{copied ? `${title ?? "Code"} copied to clipboard.` : ""}</span>
      {copyError && (
        <p role="alert" className="border-t border-white/10 px-4 py-3 text-sm text-[#ccc]">
          Couldn&apos;t copy automatically. Select the code above and copy it manually.
        </p>
      )}
    </div>
  );
}
