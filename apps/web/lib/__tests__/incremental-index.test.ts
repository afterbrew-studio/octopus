import { describe, it, expect, mock, beforeEach } from "bun:test";

// ── Mock external dependencies before importing ──

// `server-only` is a Next.js marker module that throws outside a Server
// Component context; neutralize it for bun test (same as sibling tests).
mock.module("server-only", () => ({}));

// A small in-memory chunk store, so overlapping updates can be replayed against it.
type StoredChunk = { id: string; filePath: string };
let store: StoredChunk[] = [];
const storeUpsert = (points: { id: string; payload: { filePath: string } }[]) => {
  store.push(...points.map((point) => ({ id: point.id, filePath: point.payload.filePath })));
  return Promise.resolve();
};
let mockListChunkIds = mock((_owner: unknown, paths: string[]) => Promise.resolve(store.filter((chunk) => paths.includes(chunk.filePath)).map((chunk) => chunk.id)));
let mockDeleteChunkPoints = mock((_owner: unknown, ids: string[]) => {
  store = store.filter((chunk) => !ids.includes(chunk.id));
  return Promise.resolve();
});
let mockEnsureCollection = mock(() => Promise.resolve());
let mockUpsertChunks = mock(storeUpsert as (...args: never[]) => Promise<void>);

mock.module("@/lib/qdrant", () => ({
  listRepoFileChunkIds: (...args: [unknown, string[]]) => mockListChunkIds(...args),
  deleteChunkPoints: (...args: [unknown, string[]]) => mockDeleteChunkPoints(...args),
  ensureCollection: () => mockEnsureCollection(),
  upsertChunks: (...args: unknown[]) => mockUpsertChunks(...args),
  scrollActiveChunkVectors: async function* () {},
}));

let mockCreateEmbeddings = (texts: string[]) => Promise.resolve(texts.map(() => new Array(3072).fill(0.1)));
mock.module("@/lib/embeddings", () => ({
  resolveEmbedConfig: () => Promise.resolve({ provider: "openai", model: "text-embedding-3-large", dim: 3072 }),
  createEmbeddings: (texts: string[]) => mockCreateEmbeddings(texts),
}));

mock.module("@/lib/sparse-vector", () => ({
  generateSparseVectors: (texts: string[]) =>
    texts.map(() => ({ indices: [0, 1], values: [0.5, 0.5] })),
}));

let mockGetInstallationToken = mock(() => Promise.resolve("test-token"));
let mockGhGetFileContent = mock((_installationId: number, _owner: string, _repo: string, _branch: string, filePath: string) => {
  if (filePath === "src/index.ts") return Promise.resolve("export const hello = 'world';\n");
  if (filePath === "src/utils.ts") return Promise.resolve("export function add(a: number, b: number) { return a + b; }\n");
  if (filePath === "README.md") return Promise.resolve("# Test Repo\n\nThis is a test.\n");
  return Promise.resolve(null);
});

mock.module("@/lib/github", () => ({
  getInstallationToken: (...args: unknown[]) => mockGetInstallationToken(...args),
  getFileContent: (...args: unknown[]) => mockGhGetFileContent(...(args as Parameters<typeof mockGhGetFileContent>)),
  getRepositoryDetails: () => Promise.resolve(null),
}));

mock.module("@/lib/bitbucket", () => ({
  getFileContent: () => Promise.resolve(null),
  getAccessToken: () => Promise.resolve("bb-token"),
}));

let mockParseOctopusIgnore = mock((_content: string) => ({ ignores: () => false }));

mock.module("@/lib/octopus-ignore", () => ({
  parseOctopusIgnore: (...args: unknown[]) => mockParseOctopusIgnore(...(args as [string])),
}));

// Static imports are hoisted above the mock.module calls, which would load the
// real module graph (and its throwing "server-only" import) first — dynamic
// import after the mocks fixes the ordering (same as ai-router.test.ts).
const { incrementalIndex } = await import("@/lib/indexer");

const indexOwner = { repoId: "repo-1", activeIndexGeneration: null };

// ── Tests ──

describe("incrementalIndex", () => {
  beforeEach(() => {
    mockCreateEmbeddings = (texts: string[]) => Promise.resolve(texts.map(() => new Array(3072).fill(0.1)));
    store = [];
    mockListChunkIds = mock((_owner: unknown, paths: string[]) => Promise.resolve(store.filter((chunk) => paths.includes(chunk.filePath)).map((chunk) => chunk.id)));
    mockDeleteChunkPoints = mock((_owner: unknown, ids: string[]) => {
      store = store.filter((chunk) => !ids.includes(chunk.id));
      return Promise.resolve();
    });
    mockEnsureCollection = mock(() => Promise.resolve());
    mockUpsertChunks = mock(storeUpsert as (...args: never[]) => Promise<void>);
    mockGetInstallationToken = mock(() => Promise.resolve("test-token"));
    mockGhGetFileContent = mock((_installationId: number, _owner: string, _repo: string, _branch: string, filePath: string) => {
      if (filePath === "src/index.ts") return Promise.resolve("export const hello = 'world';\n");
      if (filePath === "src/utils.ts") return Promise.resolve("export function add(a: number, b: number) { return a + b; }\n");
      if (filePath === "README.md") return Promise.resolve("# Test Repo\n\nThis is a test.\n");
      return Promise.resolve(null);
    });
    mockParseOctopusIgnore = mock((_content: string) => ({ ignores: () => false }));
  });

  it("deletes old chunks and indexes modified files", async () => {
    const result = await incrementalIndex(
      indexOwner,
      "owner/repo",
      "main",
      12345,
      [
        { filename: "src/index.ts", status: "modified" },
        { filename: "src/utils.ts", status: "added" },
      ],
      "github",
    );

    // Should delete chunks for changed files
    expect(mockListChunkIds).toHaveBeenCalledTimes(1);
    const deleteArgs = mockListChunkIds.mock.calls[0];
    expect(deleteArgs[0]).toEqual(indexOwner);
    expect(deleteArgs[1]).toEqual(["src/index.ts", "src/utils.ts"]);

    // Should upsert new chunks
    expect(mockUpsertChunks).toHaveBeenCalledTimes(1);
    const upsertArgs = mockUpsertChunks.mock.calls[0] as [{ payload: { filePath: string; indexedAt: string } }[]];
    const points = upsertArgs[0];
    expect(points.length).toBeGreaterThan(0);

    // All points should have indexedAt metadata
    for (const point of points) {
      expect(point.payload.indexedAt).toBeDefined();
      expect(typeof point.payload.indexedAt).toBe("string");
    }

    expect(result.updatedFiles).toBe(2);
    expect(result.removedFiles).toBe(0);
    expect(result.newVectors).toBeGreaterThan(0);
  });

  it("keeps the old chunks when embedding fails", async () => {
    mockCreateEmbeddings = () => Promise.reject(new Error("Embedding service unavailable"));

    await expect(incrementalIndex(
      indexOwner, "owner/repo", "main", 12345,
      [{ filename: "src/index.ts", status: "modified" }, { filename: "src/old.ts", status: "removed" }],
      "github",
    )).rejects.toThrow("Embedding service unavailable");

    expect(mockListChunkIds).not.toHaveBeenCalled();
    expect(mockUpsertChunks).not.toHaveBeenCalled();
  });

  it("keeps the old chunks when the upsert fails after the embeddings succeed", async () => {
    store = [{ id: "old-1", filePath: "src/index.ts" }];
    mockUpsertChunks = mock(() => Promise.reject(new Error("Qdrant unavailable")));

    await expect(incrementalIndex(
      indexOwner, "owner/repo", "main", 12345,
      [{ filename: "src/index.ts", status: "modified" }],
      "github",
    )).rejects.toThrow("Qdrant unavailable");

    expect(mockDeleteChunkPoints).not.toHaveBeenCalled();
    expect(store).toEqual([{ id: "old-1", filePath: "src/index.ts" }]);
  });

  it("captures the old chunks, writes the new ones, then deletes exactly the captured ones", async () => {
    const order: string[] = [];
    store = [{ id: "old-1", filePath: "src/index.ts" }, { id: "other", filePath: "src/other.ts" }];
    mockCreateEmbeddings = (texts: string[]) => { order.push("embed"); return Promise.resolve(texts.map(() => [0.1])); };
    const list = mockListChunkIds;
    mockListChunkIds = mock((owner: unknown, paths: string[]) => { order.push("capture"); return list(owner, paths); });
    const upsert = mockUpsertChunks;
    mockUpsertChunks = mock(((points: never) => { order.push("upsert"); return (upsert as unknown as (p: never) => Promise<void>)(points); }) as (...args: never[]) => Promise<void>);
    const del = mockDeleteChunkPoints;
    mockDeleteChunkPoints = mock((owner: unknown, ids: string[]) => { order.push("delete"); return del(owner, ids); });

    await incrementalIndex(indexOwner, "owner/repo", "main", 12345, [{ filename: "src/index.ts", status: "modified" }], "github");

    expect(order).toEqual(["embed", "capture", "upsert", "delete"]);
    expect(mockDeleteChunkPoints.mock.calls[0][1]).toEqual(["old-1"]);
    expect(store.filter((chunk) => chunk.filePath === "src/index.ts").length).toBeGreaterThan(0);
    expect(store.some((chunk) => chunk.id === "old-1")).toBe(false);
    expect(store.some((chunk) => chunk.id === "other")).toBe(true);
  });

  it("leaves every update's chunks in place when two merges overlap on the same file", async () => {
    store = [{ id: "old-1", filePath: "src/index.ts" }];
    // Both updates capture before either writes, and both write before either deletes: the worst interleaving.
    const barrier = (parties: number) => {
      let arrived = 0;
      let release!: () => void;
      const open = new Promise<void>((resolve) => { release = resolve; });
      return async () => { if (++arrived === parties) release(); await open; };
    };
    const captured = barrier(2);
    const written = barrier(2);
    const list = mockListChunkIds;
    mockListChunkIds = mock(async (owner: unknown, paths: string[]) => {
      const ids = await list(owner, paths);
      await captured();
      return ids;
    });
    const upsert = mockUpsertChunks;
    mockUpsertChunks = mock((async (points: never) => {
      await (upsert as unknown as (p: never) => Promise<void>)(points);
      await written();
    }) as (...args: never[]) => Promise<void>);

    const merge = () => incrementalIndex(indexOwner, "owner/repo", "main", 12345, [{ filename: "src/index.ts", status: "modified" }], "github");
    await Promise.all([merge(), merge()]);

    const remaining = store.filter((chunk) => chunk.filePath === "src/index.ts");
    expect(remaining.some((chunk) => chunk.id === "old-1")).toBe(false);
    const eachWrote = (mockUpsertChunks.mock.calls as unknown as [{ id: string }[]][]).map(([points]) => points.map((point) => point.id));
    expect(eachWrote).toHaveLength(2);
    for (const ids of eachWrote) for (const id of ids) expect(remaining.map((chunk) => chunk.id)).toContain(id);
  });

  it("keeps the old chunks when GitHub answers with an unsuccessful response, but replaces those of an empty file", async () => {
    mockGhGetFileContent = mock((_installationId: number, _owner: string, _repo: string, _branch: string, filePath: string) => {
      if (filePath === "src/unavailable.ts") return Promise.resolve(null);
      if (filePath === "src/emptied.ts") return Promise.resolve("");
      return Promise.resolve("export const x = 1;\n");
    });
    store = [{ id: "u", filePath: "src/unavailable.ts" }, { id: "e", filePath: "src/emptied.ts" }];

    const result = await incrementalIndex(
      indexOwner, "owner/repo", "main", 12345,
      [{ filename: "src/unavailable.ts", status: "modified" }, { filename: "src/emptied.ts", status: "modified" }, { filename: "src/utils.ts", status: "modified" }],
      "github",
    );

    expect(result.incompleteFiles).toEqual(["src/unavailable.ts"]);

    expect(mockListChunkIds.mock.calls[0][1]).toEqual(["src/emptied.ts", "src/utils.ts"]);
    expect(store.map((chunk) => chunk.id)).toContain("u");
    expect(store.map((chunk) => chunk.id)).not.toContain("e");
  });

  it("keeps the old chunks of a file whose fetch failed", async () => {
    mockGhGetFileContent = mock((_installationId: number, _owner: string, _repo: string, _branch: string, filePath: string) => {
      if (filePath === "src/broken.ts") return Promise.reject(new Error("503"));
      return Promise.resolve("export const x = 1;\n");
    });

    const result = await incrementalIndex(
      indexOwner, "owner/repo", "main", 12345,
      [{ filename: "src/broken.ts", status: "modified" }, { filename: "src/utils.ts", status: "modified" }],
      "github",
    );

    expect(result.incompleteFiles).toEqual(["src/broken.ts"]);
    expect(mockListChunkIds.mock.calls[0][1]).toEqual(["src/utils.ts"]);
  });

  it("handles removed files without fetching content", async () => {
    const result = await incrementalIndex(
      indexOwner,
      "owner/repo",
      "main",
      12345,
      [
        { filename: "src/old-file.ts", status: "removed" },
      ],
      "github",
    );

    // Should delete chunks for removed file
    expect(mockListChunkIds).toHaveBeenCalledTimes(1);
    const deleteArgs = mockListChunkIds.mock.calls[0];
    expect(deleteArgs[1]).toEqual(["src/old-file.ts"]);

    // Should NOT upsert anything (removed file = no new content)
    expect(mockUpsertChunks).not.toHaveBeenCalled();

    expect(result.updatedFiles).toBe(0);
    expect(result.removedFiles).toBe(1);
    expect(result.newVectors).toBe(0);
  });

  it("handles mix of added, modified, removed, and renamed files", async () => {
    mockGhGetFileContent = mock(() => Promise.resolve("export const x = 1;\n"));
    const result = await incrementalIndex(
      indexOwner,
      "owner/repo",
      "main",
      12345,
      [
        { filename: "src/index.ts", status: "modified" },
        { filename: "src/deleted.ts", status: "removed" },
        { filename: "src/old-name.ts", status: "renamed" },
        { filename: "src/utils.ts", status: "added" },
      ],
      "github",
    );

    // All changed paths should be in the delete call
    const deleteArgs = mockListChunkIds.mock.calls[0];
    const deletedPaths = deleteArgs[1] as string[];
    expect(deletedPaths).toContain("src/index.ts");
    expect(deletedPaths).toContain("src/deleted.ts");
    expect(deletedPaths).toContain("src/old-name.ts");
    expect(deletedPaths).toContain("src/utils.ts");

    // Only "removed" counts as removedFiles; renamed files get re-indexed under their new name
    expect(result.removedFiles).toBe(1); // only "removed"
    expect(result.updatedFiles).toBe(3); // modified + added + renamed (renamed gets re-indexed)
  });

  it("skips non-indexable file types", async () => {
    const result = await incrementalIndex(
      indexOwner,
      "owner/repo",
      "main",
      12345,
      [
        { filename: "image.png", status: "added" },
        { filename: "data.bin", status: "modified" },
      ],
      "github",
    );

    // PNG and BIN are not in CODE_EXTENSIONS, should be skipped
    expect(result.updatedFiles).toBe(0);
    expect(result.newVectors).toBe(0);
  });

  it("returns zero vectors when no files changed", async () => {
    const result = await incrementalIndex(
      indexOwner,
      "owner/repo",
      "main",
      12345,
      [],
      "github",
    );

    expect(mockListChunkIds).not.toHaveBeenCalled();
    expect(mockUpsertChunks).not.toHaveBeenCalled();
    expect(result.updatedFiles).toBe(0);
    expect(result.removedFiles).toBe(0);
    expect(result.newVectors).toBe(0);
  });

  it("continues indexing when one file fetch fails", async () => {
    // Override getFileContent to fail for one file
    mockGhGetFileContent = mock((_installationId: number, _owner: string, _repo: string, _branch: string, filePath: string) => {
      if (filePath === "src/broken.ts") return Promise.reject(new Error("404 Not Found"));
      if (filePath === "src/utils.ts") return Promise.resolve("export const x = 1;\n");
      return Promise.resolve(null);
    });

    const result = await incrementalIndex(
      indexOwner,
      "owner/repo",
      "main",
      12345,
      [
        { filename: "src/broken.ts", status: "modified" },
        { filename: "src/utils.ts", status: "modified" },
      ],
      "github",
    );

    // Should still index the successful file
    expect(mockUpsertChunks).toHaveBeenCalledTimes(1);
    expect(result.newVectors).toBeGreaterThan(0);
  });

  it("skips fetched files that exceed MAX_FILE_SIZE bytes", async () => {
    mockGhGetFileContent = mock((_installationId: number, _owner: string, _repo: string, _branch: string, filePath: string) => {
      if (filePath === "src/big.ts") return Promise.resolve("a".repeat(100_001));
      return Promise.resolve(null);
    });

    const result = await incrementalIndex(
      indexOwner,
      "owner/repo",
      "main",
      12345,
      [{ filename: "src/big.ts", status: "modified" }],
      "github",
    );

    expect(mockUpsertChunks).not.toHaveBeenCalled();
    expect(result.newVectors).toBe(0);
  });

  it("honours .octopusignore from the default branch", async () => {
    mockGhGetFileContent = mock((_installationId: number, _owner: string, _repo: string, _branch: string, filePath: string) => {
      if (filePath === ".octopusignore") return Promise.resolve("src/secret.ts\n");
      if (filePath === "src/secret.ts") return Promise.resolve("const key = 'hush';\n");
      if (filePath === "src/utils.ts") return Promise.resolve("export const x = 1;\n");
      return Promise.resolve(null);
    });
    mockParseOctopusIgnore = mock((_content: string) => ({
      ignores: (path: string) => path === "src/secret.ts",
    }));

    const result = await incrementalIndex(
      indexOwner,
      "owner/repo",
      "main",
      12345,
      [
        { filename: "src/secret.ts", status: "modified" },
        { filename: "src/utils.ts", status: "modified" },
      ],
      "github",
    );

    // The ignored path must never be fetched
    const fetchedPaths = mockGhGetFileContent.mock.calls.map((c) => c[4]);
    expect(fetchedPaths).not.toContain("src/secret.ts");

    // Only the non-ignored file is indexed
    const upsertArgs = mockUpsertChunks.mock.calls[0] as [{ payload: { filePath: string } }[]];
    const filePaths = upsertArgs[0].map((p) => p.payload.filePath);
    expect(filePaths).toContain("src/utils.ts");
    expect(filePaths).not.toContain("src/secret.ts");
    expect(result.updatedFiles).toBe(1);
  });

  it("sets correct payload fields on upserted points", async () => {
    await incrementalIndex(
      indexOwner,
      "owner/repo",
      "main",
      12345,
      [{ filename: "src/index.ts", status: "modified" }],
      "github",
    );

    const upsertArgs = mockUpsertChunks.mock.calls[0] as [{ id: string; vector: number[]; payload: Record<string, unknown> }[]];
    const point = upsertArgs[0][0];

    expect(point.id).toBeDefined();
    expect(point.vector).toBeArray();
    expect(point.vector.length).toBe(3072);
    expect(point.payload.repoId).toBe("repo-1");
    expect(point.payload.fullName).toBe("owner/repo");
    expect(point.payload.filePath).toBe("src/index.ts");
    expect(point.payload.language).toBe("ts");
    expect(point.payload.indexedAt).toBeDefined();
    expect(typeof point.payload.startLine).toBe("number");
    expect(typeof point.payload.endLine).toBe("number");
    expect(typeof point.payload.text).toBe("string");
  });
});
