-- Binds a frozen ReviewRun to the pull request state it was frozen for.
-- `headSha` already existed; `reviewRequestVersion` completes the pair so an
-- execution can tell "this run's pull request moved on" from "this is still
-- the request I was frozen for", instead of only comparing head SHAs (two
-- requests at the same head with different review configuration are still
-- distinct requests -- the version disambiguates them).
ALTER TABLE "review_runs" ADD COLUMN "reviewRequestVersion" INTEGER;
