import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createAgentOutputStore,
  createArtifactStore,
  runArtifactsDir,
} from "../src/resources/artifacts.js";
import { createRunResources } from "../src/resources/handlers/index.js";
import {
  applyPathSegments,
  PathLookupError,
  parsePathSegments,
} from "../src/resources/json-path.js";
import { parseResourceUrl, resourceScheme } from "../src/resources/parse.js";
import { ResourceRouter } from "../src/resources/router.js";
import type {
  ProtocolHandler,
  ResolveContext,
} from "../src/resources/types.js";
import { ResourceError } from "../src/resources/types.js";
import type { RunScope } from "../src/run-scope.js";
import {
  isLineInRanges,
  parseLineRangeChunk,
  parseLineRanges,
  SelectorError,
  selectorIsConflicts,
  selectorIsRaw,
  selectorLineRanges,
  splitPathAndSel,
} from "../src/tools/selectors.js";

const scope: RunScope = {
  buildSessionId: "bs_1",
  organizationId: "org_1",
  projectId: "proj_1",
  runId: "run_1",
} as RunScope;

function context(cwd: string): ResolveContext {
  return { cwd, scope };
}

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

describe("selector grammar", () => {
  it("parses a single line as that one line, not an open range", () => {
    expect(parseLineRangeChunk("50")).toEqual({ endLine: 50, startLine: 50 });
  });

  it("parses an open-ended range as unbounded above", () => {
    expect(parseLineRangeChunk("301-")).toEqual({
      endLine: undefined,
      startLine: 301,
    });
  });

  it("treats a plus suffix as a window of that many lines from the start", () => {
    // `50+10` names ten lines beginning at 50, so it ends at 59, not 60.
    expect(parseLineRangeChunk("50+10")).toEqual({
      endLine: 59,
      startLine: 50,
    });
  });

  it("accepts range aliases and gutter prefixes a model may copy", () => {
    expect(parseLineRangeChunk("2724..2727")).toEqual({
      endLine: 2727,
      startLine: 2724,
    });
    expect(parseLineRangeChunk("2724..")).toEqual({
      endLine: undefined,
      startLine: 2724,
    });
    expect(parseLineRangeChunk("L50-L60")).toEqual({
      endLine: 60,
      startLine: 50,
    });
  });

  it("rejects a range whose end precedes its start", () => {
    expect(() => parseLineRangeChunk("50-10")).toThrow(SelectorError);
  });

  it("rejects line zero, because lines are 1-indexed", () => {
    expect(() => parseLineRangeChunk("0")).toThrow(SelectorError);
  });

  it("sorts and merges a comma list into non-overlapping ascending ranges", () => {
    // 960-973 is adjacent to 974 and contains 965, so all three collapse.
    expect(parseLineRanges("960-973,5-16,965,974")).toEqual([
      { endLine: 16, startLine: 5 },
      { endLine: 974, startLine: 960 },
    ]);
  });

  it("lets an open-ended range absorb every later range", () => {
    expect(parseLineRanges("10-,20-30")).toEqual([
      { endLine: undefined, startLine: 10 },
    ]);
  });

  it("reports whether a line falls in any range, treating an open end as unbounded", () => {
    const ranges = parseLineRanges("5-16,301-");
    expect(ranges).not.toBeNull();
    if (ranges === null) {
      return;
    }
    expect(isLineInRanges(4, ranges)).toBe(false);
    expect(isLineInRanges(5, ranges)).toBe(true);
    expect(isLineInRanges(17, ranges)).toBe(false);
    expect(isLineInRanges(9999, ranges)).toBe(true);
  });

  it("splits a selector chain off a path, including a compound range plus raw", () => {
    expect(splitPathAndSel("src/app.ts")).toEqual({
      path: "src/app.ts",
      sel: undefined,
    });
    expect(splitPathAndSel("src/app.ts:50-60")).toEqual({
      path: "src/app.ts",
      sel: "50-60",
    });
    expect(splitPathAndSel("src/app.ts:2-4:raw")).toEqual({
      path: "src/app.ts",
      sel: "2-4:raw",
    });
    expect(splitPathAndSel("src/app.ts:raw:50-60")).toEqual({
      path: "src/app.ts",
      sel: "raw:50-60",
    });
  });

  it("never eats a Windows drive letter as a selector", () => {
    expect(splitPathAndSel("C:\\src\\app.ts")).toEqual({
      path: "C:\\src\\app.ts",
      sel: undefined,
    });
    expect(splitPathAndSel("C:\\src\\app.ts:10")).toEqual({
      path: "C:\\src\\app.ts",
      sel: "10",
    });
  });

  it("leaves a non-selector colon in the path", () => {
    expect(splitPathAndSel("weird:name")).toEqual({
      path: "weird:name",
      sel: undefined,
    });
  });

  it("extracts the flags and ranges from a chain independently of order", () => {
    expect(selectorLineRanges("raw:50-60")).toEqual([
      { endLine: 60, startLine: 50 },
    ]);
    expect(selectorLineRanges("raw")).toBeUndefined();
    expect(selectorIsRaw("2-4:raw")).toBe(true);
    expect(selectorIsRaw("2-4")).toBe(false);
    expect(selectorIsConflicts("conflicts")).toBe(true);
  });
});

describe("json path extraction", () => {
  const document = { count: 1, findings: [{ id: 7, note: "a" }] };

  it("addresses members and array indices in either notation", () => {
    expect(
      applyPathSegments(document, parsePathSegments(".findings[0].id"))
    ).toBe(7);
    expect(
      applyPathSegments(document, parsePathSegments("findings/0/note"))
    ).toBe("a");
  });

  it("lists member names so a caller can discover the real shape", () => {
    // Member order is incidental; listing the real names is the contract.
    expect(applyPathSegments(document, parsePathSegments("keys"))).toEqual(
      expect.arrayContaining(["findings", "count"])
    );
  });

  it("names the available members when a member is missing", () => {
    expect(() =>
      applyPathSegments(document, parsePathSegments(".missing"))
    ).toThrow(PathLookupError);
    expect(() =>
      applyPathSegments(document, parsePathSegments(".missing"))
    ).toThrow("findings");
  });

  it("reports an out-of-range index with the real length", () => {
    expect(() =>
      applyPathSegments(document, parsePathSegments(".findings[9]"))
    ).toThrow("1 entries");
  });
});

describe("resource url parsing", () => {
  it("recognises a scheme and keeps a namespaced host intact", () => {
    // A colon in the authority would be a port to `URL`; it is part of the name here.
    expect(parseResourceUrl("skill://plugin:name").host).toBe("plugin:name");
    expect(resourceScheme("artifact://3")).toBe("artifact");
    expect(resourceScheme("src/app.ts")).toBeUndefined();
  });

  it("keeps the query and fragment apart", () => {
    const parsed = parseResourceUrl("agent://out?q=.a.b#frag");
    expect(parsed.search).toBe("?q=.a.b");
    expect(parsed.hash).toBe("#frag");
    expect(parsed.host).toBe("out");
  });

  it("rejects input that is not a resource url", () => {
    expect(() => parseResourceUrl("src/app.ts")).toThrow(ResourceError);
  });
});

describe("resource router", () => {
  const handler: ProtocolHandler = {
    description: "demo scheme",
    immutable: true,
    resolve: async (url) => ({
      content: "body",
      contentType: "text/plain",
      url: url.raw,
    }),
    scheme: "demo",
  };

  it("applies immutability from the handler rather than trusting the resource", async () => {
    // The handler returned no `immutable`, so the router supplies the declaration.
    const router = new ResourceRouter([handler]);
    const resource = await router.resolve("demo://x", context(process.cwd()));
    expect(resource.immutable).toBe(true);
  });

  it("does not claim a filesystem path, which is how the filesystem front door is chosen", () => {
    const router = new ResourceRouter([handler]);
    expect(router.canHandle("src/app.ts")).toBe(false);
    expect(router.canHandle("demo://x")).toBe(true);
  });

  it("lists the supported schemes when one is unknown", async () => {
    const router = new ResourceRouter([handler]);
    await expect(
      router.resolve("nope://x", context(process.cwd()))
    ).rejects.toThrow("demo://");
  });
});

describe("artifact store", () => {
  it("assigns dense ids from zero and reads them back", async () => {
    const root = await tempDir("reasonate-artifacts-");
    const store = createArtifactStore(root, scope);

    expect(await store.write("first")).toBe(0);
    expect(await store.write("second", "json")).toBe(1);
    expect(await store.list()).toEqual([0, 1]);
    expect(await store.read(1)).toMatchObject({ content: "second" });
    expect(await store.read(9)).toBeUndefined();
  });

  it("keeps each tenant and run in its own directory", async () => {
    const root = await tempDir("reasonate-tenant-");
    const other = createArtifactStore(root, {
      ...scope,
      organizationId: "org_2",
    } as RunScope);

    await createArtifactStore(root, scope).write("mine");
    // A different organization must not see, or be able to enumerate, this run's output.
    expect(await other.list()).toEqual([]);
    expect(runArtifactsDir(root, scope)).not.toBe(
      runArtifactsDir(root, { ...scope, runId: "run_2" } as RunScope)
    );
  });

  it("addresses agent output by label rather than by counter", async () => {
    const root = await tempDir("reasonate-agents-");
    const store = createAgentOutputStore(root, scope);

    await store.write("reviewer_0", '{"ok":true}');
    expect(await store.list()).toEqual(["reviewer_0"]);
    expect(await store.read("reviewer_0")).toMatchObject({
      content: '{"ok":true}',
    });
    expect(await store.read("missing")).toBeUndefined();
  });
});

describe("run resource handlers", () => {
  it("serves a spilled artifact and lists real ids when one is missing", async () => {
    const root = await tempDir("reasonate-res-");
    const { artifacts, router } = createRunResources({
      cwd: process.cwd(),
      root,
      scope,
    });
    await artifacts.write("spilled body");

    const resource = await router.resolve(
      "artifact://0",
      context(process.cwd())
    );
    expect(resource.content).toBe("spilled body");

    await expect(
      router.resolve("artifact://4", context(process.cwd()))
    ).rejects.toThrow("Available: 0");
  });

  it("refuses a non-numeric artifact id", async () => {
    const root = await tempDir("reasonate-res-");
    const { router } = createRunResources({ cwd: process.cwd(), root, scope });
    await expect(
      router.resolve("artifact://abc", context(process.cwd()))
    ).rejects.toThrow("numeric");
  });

  it("extracts one field from a worker's JSON result", async () => {
    const root = await tempDir("reasonate-agent-");
    const { agentOutputs, router } = createRunResources({
      cwd: process.cwd(),
      root,
      scope,
    });
    await agentOutputs.write(
      "reviewer_0",
      JSON.stringify({ findings: [{ id: 7 }] })
    );

    const byPath = await router.resolve(
      "agent://reviewer_0/.findings[0].id",
      context(process.cwd())
    );
    const byQuery = await router.resolve(
      "agent://reviewer_0?q=.findings[0].id",
      context(process.cwd())
    );

    expect(byPath.content).toBe("7");
    expect(byQuery.content).toBe("7");
    expect(byPath.contentType).toBe("application/json");
  });

  it("refuses to combine a path with a query, rather than silently preferring one", async () => {
    const root = await tempDir("reasonate-agent-");
    const { agentOutputs, router } = createRunResources({
      cwd: process.cwd(),
      root,
      scope,
    });
    await agentOutputs.write("out", "{}");

    await expect(
      router.resolve("agent://out/.a?q=.b", context(process.cwd()))
    ).rejects.toThrow("cannot combine");
  });

  it("names the worker outputs that exist when one is unknown", async () => {
    const root = await tempDir("reasonate-agent-");
    const { agentOutputs, router } = createRunResources({
      cwd: process.cwd(),
      root,
      scope,
    });
    await agentOutputs.write("scout_0", "text");

    await expect(
      router.resolve("agent://nope", context(process.cwd()))
    ).rejects.toThrow("scout_0");
  });

  it("serves project rules by name and rejects a name that does not exist", async () => {
    const root = await tempDir("reasonate-rules-");
    const project = await tempDir("reasonate-proj-");
    await writeFile(join(project, "AGENTS.md"), "Always run the tests.\n");

    const { router } = createRunResources({
      cwd: project,
      home: project,
      root,
      scope,
    });

    const resource = await router.resolve("rule://AGENTS.md", context(project));
    expect(resource.content).toContain("Always run the tests.");

    await expect(
      router.resolve("rule://absent.md", context(project))
    ).rejects.toThrow("Available: AGENTS.md");
  });

  it("lists documentation and reads a document by its prefixed name", async () => {
    const root = await tempDir("reasonate-docs-");
    const docsDir = await tempDir("reasonate-docroot-");
    await mkdir(join(docsDir, "nested"), { recursive: true });
    await writeFile(join(docsDir, "nested", "SPEC.md"), "# Spec\n");

    const { router } = createRunResources({
      cwd: process.cwd(),
      docsRoots: [{ directory: docsDir, prefix: "context/" }],
      root,
      scope,
    });

    const listing = await router.resolve("docs://", context(process.cwd()));
    expect(listing.content).toContain("context/nested/SPEC.md");

    const document = await router.resolve(
      "docs://context/nested/SPEC.md",
      context(process.cwd())
    );
    expect(document.content).toBe("# Spec\n");
  });

  it("refuses to escape a documentation root", async () => {
    const root = await tempDir("reasonate-docs-");
    const docsDir = await tempDir("reasonate-docroot-");

    const { router } = createRunResources({
      cwd: process.cwd(),
      docsRoots: [{ directory: docsDir, prefix: "context/" }],
      root,
      scope,
    });

    await expect(
      router.resolve("docs://context/../../etc/passwd", context(process.cwd()))
    ).rejects.toThrow(ResourceError);
  });

  it("omits a scheme whose backing store does not exist, so it fails as unknown", async () => {
    const root = await tempDir("reasonate-res-");
    const { router } = createRunResources({ cwd: process.cwd(), root, scope });

    // No docs roots were configured, so `docs://` is absent rather than present
    // and failing on every use.
    expect(router.schemes()).toContain("artifact");
    expect(router.schemes()).not.toContain("docs");
    expect(router.schemes()).not.toContain("skill");
  });
});
