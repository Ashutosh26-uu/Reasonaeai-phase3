/**
 * Resource handler registration.
 *
 * One factory builds the router for a run. Handlers receive the stores they need
 * by construction, so a handler instance belongs to exactly one run and cannot
 * answer a read for another. That is the reason the router is not a process
 * global: a shared handler holding a shared store would be a cross-tenant read
 * waiting to happen.
 *
 * Only schemes with a real backing store are registered. A scheme whose data does
 * not exist yet is absent rather than present-and-failing, so a read of it fails
 * with "unknown scheme" and the list of schemes that do work, instead of
 * appearing available and then erroring on every use.
 */

import type { RunScope } from "../../run-scope.js";
import { createFormatReaders } from "../../tools/readers/registry.js";
import type { FormatReader } from "../../tools/readers/types.js";
import type { AgentOutputStore, ArtifactStore } from "../artifacts.js";
import { createAgentOutputStore, createArtifactStore } from "../artifacts.js";
import { ResourceRouter } from "../router.js";
import type { ProtocolHandler } from "../types.js";
import { AgentOutputHandler } from "./agent.js";
import { ArtifactHandler } from "./artifact.js";
import type { DocsRoot } from "./docs.js";
import { DocsHandler } from "./docs.js";
import { RuleHandler } from "./rule.js";

export interface RunResourceOptions {
  /** Working directory of the run, used to discover the project's rules. */
  cwd: string;
  /** Documentation roots to publish under `docs://`. Omit to leave it unregistered. */
  docsRoots?: readonly DocsRoot[] | undefined;
  /** Overrides the home directory used for user-level rules. */
  home?: string | undefined;
  /** Root under which per-run stores live. */
  root: string;
  scope: RunScope;
}

/** The router for a run, with the stores its handlers resolve against. */
export interface RunResources {
  agentOutputs: AgentOutputStore;
  artifacts: ArtifactStore;
  /**
   * Format readers, in dispatch order.
   *
   * Returned here because one read needs both halves: the router for a resource
   * URL, and the readers for a path whose format is not text. A caller that wired
   * only the router would still hand a database or an archive to the text path.
   */
  readers: readonly FormatReader[];
  router: ResourceRouter;
}

/**
 * Build the resource layer for one run.
 *
 * The stores are returned alongside the router because the same run-scoped
 * storage is written by the read tool when it spills output and read back by the
 * `artifact://` handler, so both must be the same store rather than two
 * independently derived directories.
 */
export function createRunResources(options: RunResourceOptions): RunResources {
  const artifacts = createArtifactStore(options.root, options.scope);
  const agentOutputs = createAgentOutputStore(options.root, options.scope);

  const handlers: ProtocolHandler[] = [
    new ArtifactHandler(artifacts),
    new AgentOutputHandler(agentOutputs),
    new RuleHandler(options.cwd, { home: options.home }),
  ];

  if (options.docsRoots !== undefined && options.docsRoots.length > 0) {
    handlers.push(new DocsHandler(options.docsRoots));
  }

  return {
    agentOutputs,
    artifacts,
    readers: createFormatReaders(),
    router: new ResourceRouter(handlers),
  };
}
