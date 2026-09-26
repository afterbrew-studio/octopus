import Link from "next/link";

export default function ReviewRecordNotFound() {
  return <main className="mx-auto max-w-xl space-y-4 px-6 py-16">
    <h1 className="text-2xl font-semibold">Review unavailable</h1>
    <p className="text-muted-foreground">We couldn’t find this review for your signed-in account. Check the link or open Octopus to check your account.</p>
    <Link href="/dashboard" className="inline-flex min-h-11 items-center font-medium underline underline-offset-4">Open Octopus</Link>
  </main>;
}
