-- Fences one execution of a review against another.
--
-- pg-boss times a handler out with Promise.race and aborts a signal nothing
-- observes, so a timed-out worker keeps running while the reaper marks the row
-- failed and enqueues a retry. Both then post a review and both write a terminal
-- status. Nullable because every existing row predates the fence and a worker
-- treats a null as "not mine".
ALTER TABLE "pull_requests" ADD COLUMN "claimToken" TEXT;
