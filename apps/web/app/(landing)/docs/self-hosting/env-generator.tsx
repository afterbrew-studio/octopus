"use client";

import { useState, useCallback, useEffect } from "react";
import { IconCopy, IconCheck, IconRefresh } from "@tabler/icons-react";

function generateSecret(length = 64): string {
  const array = new Uint8Array(length / 2);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

const DEFAULT_ENV = {
  DATABASE_URL: "postgresql://octopus:octopus@localhost:43332/octopus",
  QDRANT_URL: "http://localhost:43333",
  BETTER_AUTH_URL: "http://localhost:43300",
};

export function EnvGenerator() {
  const [secret, setSecret] = useState("");
  const [dataKey, setDataKey] = useState("");
  const [copied, setCopied] = useState(false);
  const ready = secret.length > 0 && dataKey.length > 0;

  const envContent = `# Database (overridden by docker-compose when using Docker)
DATABASE_URL=${DEFAULT_ENV.DATABASE_URL}

# Qdrant (overridden by docker-compose when using Docker)
QDRANT_URL=${DEFAULT_ENV.QDRANT_URL}
QDRANT_API_KEY=

# Auth
BETTER_AUTH_SECRET=${secret || "GENERATING_IN_BROWSER"}
BETTER_AUTH_URL=${DEFAULT_ENV.BETTER_AUTH_URL}

# Data encryption key (32 bytes hex). Encrypts OAuth tokens and per-org AI
# provider keys at rest. Decoupled from BETTER_AUTH_SECRET so the auth secret
# can rotate without invalidating encrypted data.
OCTOPUS_DATA_KEY=${dataKey || "GENERATING_IN_BROWSER"}

# AI Providers
OPENAI_API_KEY=
ANTHROPIC_API_KEY=

# GitHub App (only when connecting GitHub repositories)
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
NEXT_PUBLIC_GITHUB_APP_SLUG=

# Private Forgejo (optional; requires web and review workers on the LAN/VPN)
# Comma-separated exact HTTPS origins without paths or wildcards.
# Runtime server flag for custom/prebuilt images. The official self-host image
# already has NEXT_PUBLIC_OCTOPUS_SELF_HOSTED=true baked in at build time.
OCTOPUS_SELF_HOSTED=true
FORGEJO_ALLOWED_PRIVATE_ORIGINS=
# Mounted trusted PEM CA file for internal certificates, if needed.
# Never disable TLS verification.
NODE_EXTRA_CA_CERTS=

# Optional
COHERE_API_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=`;

  const regenerate = useCallback(() => {
    setSecret(generateSecret());
    setDataKey(generateSecret());
    setCopied(false);
  }, []);

  // Keep the server and first browser render identical. Each visitor gets fresh
  // cryptographic keys after mount, never keys cached in server-rendered HTML.
  useEffect(() => { regenerate(); }, [regenerate]);

  const copy = useCallback(async () => {
    if (!ready) return;
    await navigator.clipboard.writeText(envContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [envContent, ready]);

  return (
    <div className="mb-6 overflow-hidden rounded-lg border border-white/[0.06]">
      <div className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.02] px-4 py-2">
        <span className="text-xs text-[#666]">.env</span>
        <div className="flex items-center gap-2">
          <button
            onClick={regenerate}
            type="button"
            className="flex items-center gap-1.5 rounded-md bg-white/[0.06] px-2.5 py-1 text-xs text-[#888] transition-colors hover:bg-white/[0.1] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            <IconRefresh className="size-3" />
            Regenerate Secret
          </button>
          <button
            onClick={copy}
            type="button"
            aria-label="Copy environment configuration"
            disabled={!ready}
            className="flex items-center gap-1.5 rounded-md bg-white/[0.06] px-2.5 py-1 text-xs text-[#888] transition-colors hover:bg-white/[0.1] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copied ? (
              <>
                <IconCheck className="size-3 text-green-400" />
                <span className="text-green-400">Copied</span>
              </>
            ) : (
              <>
                <IconCopy className="size-3" />
                Copy
              </>
            )}
          </button>
        </div>
      </div>
      <pre className="overflow-x-auto bg-[#161616] px-4 py-3">
        <code className="text-sm leading-relaxed text-[#ccc]">{envContent}</code>
      </pre>
    </div>
  );
}
