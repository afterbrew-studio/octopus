"use client";

import { useState } from "react";
import { IconMail, IconCheck, IconLoader2 } from "@tabler/icons-react";
import { trackEvent } from "@/lib/analytics";

export function NewsletterForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || status === "loading") return;

    setStatus("loading");
    trackEvent("newsletter_subscribe", { location: "landing_page" });

    try {
      const res = await fetch("/api/newsletter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();

      if (res.ok) {
        setStatus("success");
        setMessage("You're in! We'll keep you posted.");
        setEmail("");
      } else {
        setStatus("error");
        setMessage(data.error || "Something went wrong. Try again.");
      }
    } catch {
      setStatus("error");
      setMessage("Something went wrong. Try again.");
    }
  }

  return (
    <div className="mx-auto max-w-md">
      {status === "success" ? (
        <div className="flex items-center justify-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-5 py-3 text-sm text-white">
          <IconCheck className="size-4 text-green-400" />
          {message}
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex gap-2">
          <div className="relative flex-1">
            <IconMail className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#555]" />
            <input
              type="email"
              required
              placeholder="you@email.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (status === "error") setStatus("idle");
              }}
              className="w-full rounded-full border border-white/[0.1] bg-white/[0.04] py-3 pl-10 pr-4 text-sm text-white placeholder-[#555] outline-none transition-colors focus:border-white/[0.2] focus:bg-white/[0.06]"
            />
          </div>
          <button
            type="submit"
            disabled={status === "loading"}
            className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-medium text-background transition-colors hover:bg-[#e0e0e0] disabled:opacity-50"
          >
            {status === "loading" ? (
              <IconLoader2 className="size-4 animate-spin" />
            ) : (
              "Subscribe"
            )}
          </button>
        </form>
      )}
      {status === "error" && (
        <p className="mt-2 text-center text-xs text-red-400/80">{message}</p>
      )}
    </div>
  );
}
