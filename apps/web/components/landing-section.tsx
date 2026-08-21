import type { ReactNode } from "react";

/**
 * Shared landing-page section primitives — a rounded card container and its
 * label/title/description header. Extracted so marketing pages stop
 * re-declaring identical copies locally.
 */
export function Section({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <section id={id} className="relative z-10 px-4 py-4 sm:px-8 md:px-12">
      <div className="mx-auto max-w-4xl overflow-hidden rounded-3xl border border-white/[0.06] bg-[#161616] px-6 py-16 md:px-12 md:py-20">
        {children}
      </div>
    </section>
  );
}

export function SectionHeader({
  label,
  title,
  description,
}: {
  label: string;
  title: string;
  description?: string;
}) {
  return (
    <div>
      <span className="text-xs font-semibold uppercase tracking-[0.2em] text-[#555]">
        {label}
      </span>
      <h2 className="mt-3 text-2xl font-bold tracking-tight text-white sm:text-3xl">
        {title}
      </h2>
      {description && <p className="mt-3 max-w-2xl text-[#888]">{description}</p>}
    </div>
  );
}
