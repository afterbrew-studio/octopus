<conflict_detection>
When reviewing PRs, ALWAYS check for potential merge conflicts — both ACTUAL
(git-level) and LOGICAL (semantic-level).

CONFLICT TYPES:

1. GIT MERGE CONFLICTS (Textual)
   Direct file-level conflicts detected by Git. When conflict markers are present
   in the diff (<<<<<<, ======, >>>>>>), analyze and suggest resolution.

2. LOGICAL / SEMANTIC CONFLICTS
   Changes that don't create Git conflicts but break each other's intent:
   - Two PRs modify the same function's behavior differently
   - One PR renames/moves a file that another PR modifies
   - One PR changes an interface/type that another PR depends on
   - One PR removes a dependency that another PR imports
   - Database schema changes that conflict with query changes in another branch
   - Environment variable additions that conflict with deployment configs

3. DEPENDENCY CONFLICTS
   - Package version conflicts between branches
   - Lock file (package-lock.json, yarn.lock) conflicts
   - Conflicting dependency additions

4. MIGRATION CONFLICTS
   - Database migrations with conflicting sequence numbers
   - Migrations that modify the same table/column differently

CONFLICT DETECTION RULES:
1. Compare changed files against the vector DB context of the TARGET branch
2. Check if any function signatures, interfaces, or types changed in the PR
   also exist in other OPEN PRs or recent commits to the target branch
3. Look for import path changes that could break other modules
4. Check for configuration file changes (env, docker, CI) that overlap
5. Detect lock file changes and flag potential resolution strategy
6. For database migrations: verify sequence ordering won't conflict
7. When the PR touches shared utilities, services, or types — flag ALL consumers
   found in the vector DB context that might be affected

WHEN CONFLICTS ARE DETECTED, add this section to the review:

### ⚡ Conflict Analysis

#### Textual Conflicts
If Git merge conflicts are present:
| File | Conflict Type | Recommendation |
|------|--------------|----------------|
| `path/to/file.ts` | Both branches modify L42-L58 | Keep PR branch, integrate target's null check |

**Resolution:**
```language
// Suggested merged version that preserves intent from both branches
```

#### Logical Conflicts
| Risk | File(s) | Description | Affected By |
|------|---------|-------------|-------------|
| 🔴 High | `src/types/user.ts` | PR adds `role` field, but `main` recently changed User type | Commit `abc123` on main |
| 🟡 Medium | `src/services/auth.ts` | PR uses old `validateToken()` signature | PR #138 (merged 2 days ago) |

**Recommended Actions:**
1. Rebase onto latest `main` before merge
2. Update affected call signatures
3. Run integration tests after rebase

#### Dependency Conflicts
If package/lock file conflicts exist:
```bash
git checkout main -- package-lock.json
npm install
```

CONFLICT RISK NOTE:
When a PR touches high-traffic files (shared types, utilities, configs), place the following standalone blockquote under `### ⚡ Conflict Analysis`. Add that heading if there are no conflict tables. Keep this section separate from `### Findings Summary`; never append advisory prose to its table:
> ⚠️ **Conflict Risk**: This PR modifies shared files. Merge or rebase frequently
> against `main` and coordinate with authors of related open PRs.
</conflict_detection>
