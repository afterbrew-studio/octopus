import type { RulePack } from "./types";

/**
 * Terse per-language anti-pattern packs. Only the packs for languages actually
 * present in a diff are loaded (see selectRulePacks). Keep each rule to a signal
 * + one fix example — these are hunting hints, not a style guide.
 */
export const LANGUAGE_PACKS: Record<string, RulePack> = {
  typescript: {
    key: "typescript",
    title: "TypeScript / JavaScript rulepack",
    rules: [
      { id: "ts-floating-promise", title: "Floating promise", signal: "an async call not awaited/returned, so errors are swallowed.", languages: ["typescript"], severityHint: "🟠", remediation: "await it or attach a .catch.", example: "`await save()` not `save()`." },
      { id: "ts-react-deps", title: "Stale/incorrect hook deps", signal: "useEffect/useMemo/useCallback referencing values missing from the dep array.", languages: ["typescript"], severityHint: "🟠", remediation: "include every referenced value (or a stable ref).", example: "add `userId` to `[userId]`." },
      { id: "ts-any-cast", title: "Unsafe `as any` / non-null `!`", signal: "a cast that erases a real type mismatch or a `!` on a possibly-null value.", languages: ["typescript"], severityHint: "🟡", remediation: "narrow with a guard instead of asserting.", example: "`if (x) …` not `x!`." },
      { id: "ts-await-loop", title: "Serial await in a loop", signal: "independent awaits inside a for-loop that could run in parallel.", languages: ["typescript"], severityHint: "🟡", remediation: "collect promises and `Promise.all`.", example: "`await Promise.all(items.map(f))`." },
    ],
  },
  python: {
    key: "python",
    title: "Python rulepack",
    rules: [
      { id: "py-mutable-default", title: "Mutable default argument", signal: "a def with a list/dict/set default — shared across calls.", languages: ["python"], severityHint: "🟠", remediation: "default to None and build inside.", example: "`def f(x=None): x = x or []`." },
      { id: "py-bare-except", title: "Bare/broad except", signal: "`except:` or `except Exception` that swallows and continues.", languages: ["python"], severityHint: "🟡", remediation: "catch the specific exception; re-raise otherwise.", example: "`except ValueError:` not bare `except:`." },
      { id: "py-async-blocking", title: "Blocking call in async", signal: "sync I/O (requests, time.sleep, open) inside an async def.", languages: ["python"], severityHint: "🟠", remediation: "use the async equivalent or a thread executor.", example: "`await aiohttp…` / `asyncio.sleep`." },
      { id: "py-subprocess-shell", title: "subprocess with shell=True", signal: "shell=True on a command built from input.", languages: ["python"], severityHint: "🔴", remediation: "pass an argv list, shell=False.", example: "`subprocess.run([cmd, arg])`." },
    ],
  },
  go: {
    key: "go",
    title: "Go rulepack",
    rules: [
      { id: "go-err-ignored", title: "Ignored error", signal: "an error return assigned to `_` or not checked.", languages: ["go"], severityHint: "🟠", remediation: "handle or wrap-and-return the error.", example: "`if err != nil { return err }`." },
      { id: "go-goroutine-leak", title: "Goroutine leak", signal: "a goroutine with no exit path / unbounded on a request.", languages: ["go"], severityHint: "🟠", remediation: "bound it with context cancellation.", example: "select on `ctx.Done()`." },
      { id: "go-loopvar-capture", title: "Loop variable capture", signal: "a goroutine/closure capturing the loop variable (pre-1.22 semantics).", languages: ["go"], severityHint: "🟡", remediation: "shadow the variable inside the loop.", example: "`v := v` before `go f(v)`." },
      { id: "go-defer-loop", title: "defer inside a loop", signal: "defer of a resource inside a long loop — released only at function end.", languages: ["go"], severityHint: "🟡", remediation: "close per-iteration or extract a function.", example: "wrap the body in a func with its own defer." },
    ],
  },
  rust: {
    key: "rust",
    title: "Rust rulepack",
    rules: [
      { id: "rs-unwrap", title: "unwrap/expect on fallible value", signal: "`.unwrap()`/`.expect()` on Result/Option that can be None/Err at runtime.", languages: ["rust"], severityHint: "🟠", remediation: "propagate with `?` or match.", example: "`let x = maybe()?;`." },
      { id: "rs-unsafe", title: "Unjustified unsafe block", signal: "an `unsafe` block without an invariant comment.", languages: ["rust"], severityHint: "🟠", remediation: "document why it is sound, or avoid it.", example: "`// SAFETY: … ` above the block." },
      { id: "rs-blocking-async", title: "Blocking in async", signal: "std blocking I/O or `std::thread::sleep` in an async fn.", languages: ["rust"], severityHint: "🟡", remediation: "use the async runtime equivalent.", example: "`tokio::time::sleep`." },
    ],
  },
  java: {
    key: "java",
    title: "Java rulepack",
    rules: [
      { id: "java-resource-leak", title: "Unclosed resource", signal: "a stream/connection opened without try-with-resources.", languages: ["java"], severityHint: "🟠", remediation: "use try-with-resources.", example: "`try (var s = open()) { … }`." },
      { id: "java-npe", title: "Potential NPE", signal: "dereference of a value that can be null (map.get, nullable return).", languages: ["java"], severityHint: "🟡", remediation: "Optional or an explicit null check.", example: "`Optional.ofNullable(x)`." },
      { id: "java-raw-type", title: "Raw generic type", signal: "a raw collection/generic without type params.", languages: ["java"], severityHint: "🟡", remediation: "parameterize the type.", example: "`List<String>` not `List`." },
    ],
  },
  ruby: {
    key: "ruby",
    title: "Ruby rulepack",
    rules: [
      { id: "rb-mass-assign", title: "Unsafe mass assignment", signal: "params passed to a model without strong-params permit.", languages: ["ruby"], severityHint: "🟠", remediation: "permit an explicit attribute allowlist.", example: "`params.require(:x).permit(:a, :b)`." },
      { id: "rb-nplus1", title: "N+1 query", signal: "an association accessed inside an each without includes/preload.", languages: ["ruby"], severityHint: "🟡", remediation: "eager-load the association.", example: "`.includes(:comments)`." },
      { id: "rb-rescue-nil", title: "rescue swallowing errors", signal: "`rescue => e` / `rescue nil` that hides failures.", languages: ["ruby"], severityHint: "🟡", remediation: "rescue the specific class; log/re-raise.", example: "`rescue ActiveRecord::RecordNotFound`." },
    ],
  },
};
