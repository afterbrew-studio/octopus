import { expect, it } from "bun:test";
import { connectorPollDelay } from "../../../../packages/forgejo-connector/src/runner";

it("polls quickly while busy and backs off to one second when idle", () => {
  let delay = connectorPollDelay(1000, true);
  expect(delay).toBe(50);
  let pollingTime = 0;
  for (let file = 0; file < 2000; file++) {
    for (let idle = 0; idle < 2; idle++) {
      delay = connectorPollDelay(delay, false);
      pollingTime += delay;
    }
    delay = connectorPollDelay(delay, true);
    pollingTime += delay;
  }
  expect(pollingTime).toBeLessThan(25 * 60_000);
  for (let idle = 0; idle < 10; idle++) delay = connectorPollDelay(delay, false);
  expect(delay).toBe(1000);
  expect(connectorPollDelay(delay, true)).toBe(50);
});
