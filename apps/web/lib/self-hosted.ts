/**
 * Server-side self-hosted detection.
 *
 * `NEXT_PUBLIC_OCTOPUS_SELF_HOSTED` is inlined at BUILD time (even in server
 * code), so the official self-host image — built with
 * `--build-arg NEXT_PUBLIC_OCTOPUS_SELF_HOSTED=true` — reports self-host
 * correctly. For custom/prebuilt images where that flag wasn't baked in, also
 * honor a plain **runtime** `OCTOPUS_SELF_HOSTED=true` so server-side gates
 * (e.g. the GitHub App manifest routes) still work without a rebuild.
 */
export function isSelfHosted(): boolean {
  return (
    process.env.NEXT_PUBLIC_OCTOPUS_SELF_HOSTED === "true" ||
    process.env.OCTOPUS_SELF_HOSTED === "true"
  );
}
