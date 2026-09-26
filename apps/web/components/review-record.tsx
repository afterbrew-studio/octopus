import Link from "next/link";
import { IconDownload, IconGitPullRequest, IconHistory } from "@tabler/icons-react";
import { RepositoryAnalysisMarkdown } from "@/components/repository-analysis-markdown";
import { Button } from "@/components/ui/button";
import { canRenderReviewMarkdown } from "@/lib/review-markdown-budget";

type HistoryEntry = { id: string; headSha: string | null; createdAt: Date };
export type ReviewRecord = HistoryEntry & {
  baseSha: string | null;
  reviewBody: string;
  pullRequest: { number: number; repository: { fullName: string }; reviewAttempts: HistoryEntry[] };
};

function reviewDate(date: Date) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date) + " UTC";
}

export function ReviewRecordView({ record }: { record: ReviewRecord }) {
  return (
    <main className="mx-auto max-w-7xl space-y-8 px-4 py-8 sm:px-6">
      <header className="space-y-4">
        <Link href="/dashboard" className="inline-flex min-h-11 items-center text-sm font-medium underline-offset-4 hover:underline">Octopus</Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <p className="flex items-center gap-2 text-sm text-muted-foreground"><IconGitPullRequest className="size-4 shrink-0" aria-hidden="true" /><span className="break-all">{record.pullRequest.repository.fullName} · PR #{record.pullRequest.number}</span></p>
            <h1 className="text-2xl font-semibold tracking-tight">Review history</h1>
            <p className="text-sm text-muted-foreground">Read saved reviews for each revision of this pull request.</p>
          </div>
          <Button variant="outline" asChild className="min-h-11">
            <a href={`/api/review-attempts/${record.id}?download=1`}><IconDownload className="size-4" aria-hidden="true" />Download JSON</a>
          </Button>
        </div>
      </header>
      <div className="grid min-w-0 gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <nav aria-label="Recent reviews" className="order-last min-w-0 lg:order-first">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><IconHistory className="size-4" aria-hidden="true" />Recent reviews</h2>
          <ol className="space-y-2">
            {record.pullRequest.reviewAttempts.map(attempt => (
              <li key={attempt.id}>
                <Link href={`/review-attempts/${attempt.id}`} prefetch={false} aria-current={attempt.id === record.id ? "page" : undefined}
                  className="block min-h-11 rounded-lg border p-3 text-sm transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-[current=page]:border-primary aria-[current=page]:bg-muted">
                  <time dateTime={attempt.createdAt.toISOString()} className="block font-medium">{reviewDate(attempt.createdAt)}</time>
                  <span className="mt-1 block text-muted-foreground">Commit {attempt.headSha?.slice(0, 7) ?? "not recorded"}{attempt.id === record.id ? " · Selected" : ""}</span>
                </Link>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-xs text-muted-foreground">Up to 10 recent reviews. Each record keeps its original result.</p>
        </nav>
        <article className="min-w-0 rounded-xl border bg-card p-4 sm:p-6" aria-label="Selected review">
          <div className="mb-6 space-y-2 border-b pb-4">
            <h2 className="text-lg font-semibold">Review from {reviewDate(record.createdAt)}</h2>
            <p className="text-sm text-muted-foreground">Commit <code>{record.headSha?.slice(0, 7) ?? "not recorded"}</code></p>
          </div>
          <div className="min-w-0 break-words text-sm [&_table]:my-4 [&_table]:block [&_table]:max-h-96 [&_table]:max-w-full [&_table]:overflow-auto [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2 [&_th]:text-left">
            {canRenderReviewMarkdown(record.reviewBody) ? (
            <RepositoryAnalysisMarkdown content={record.reviewBody} components={{
              h1: ({ children }) => <h3 className="my-4 text-lg font-semibold">{children}</h3>,
              h2: ({ children }) => <h3 className="my-4 text-lg font-semibold">{children}</h3>,
              h3: ({ children }) => <h4 className="my-3 font-semibold">{children}</h4>,
              h4: ({ children }) => <h5 className="my-3 font-semibold">{children}</h5>,
            }} />
            ) : (
              <>
                <p className="mb-3 text-muted-foreground">Showing this review as plain text. Download JSON includes the original record.</p>
                <pre className="max-h-160 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-4 text-sm" tabIndex={0} aria-label="Saved review in plain text">{record.reviewBody}</pre>
              </>
            )}
          </div>
          <details className="mt-6 border-t pt-4 text-sm">
            <summary className="min-h-11 cursor-pointer py-3 font-medium">Record details</summary>
            <dl className="mt-3 space-y-3 break-all text-muted-foreground">
              <div><dt className="font-medium text-foreground">Review ID</dt><dd>{record.id}</dd></div>
              <div><dt className="font-medium text-foreground">Head commit</dt><dd>{record.headSha ?? "Not recorded"}</dd></div>
              <div><dt className="font-medium text-foreground">Base commit</dt><dd>{record.baseSha ?? "Not recorded"}</dd></div>
            </dl>
          </details>
        </article>
      </div>
    </main>
  );
}
