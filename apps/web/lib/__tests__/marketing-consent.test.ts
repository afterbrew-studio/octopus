import { expect, test } from "bun:test";
import { parseMarketingConsent } from "../marketing-consent";

test("optional consent requires separate explicit booleans and rejects malformed saved choices", () => {
  for (const saved of [null, "{}", "false", '{"analytics":"true","attribution":true}', '{"analytics":true,"attribution":true,"extra":1}', "broken"]) {
    expect(parseMarketingConsent(saved)).toBeNull();
  }
  expect(parseMarketingConsent('{"analytics":true,"attribution":false}')).toEqual({ analytics: true, attribution: false });
  expect(parseMarketingConsent('{"analytics":false,"attribution":true}')).toEqual({ analytics: false, attribution: true });
  expect(parseMarketingConsent('{"analytics":false,"attribution":false}')).toEqual({ analytics: false, attribution: false });
});
