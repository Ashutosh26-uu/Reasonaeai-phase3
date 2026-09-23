/**
 * Ambient types for `turndown`, which ships no declarations and has no
 * `@types/turndown` in this workspace. Only the surface this package uses is
 * declared, so a call to anything else fails to compile rather than silently
 * taking the `any` path.
 */
declare module "turndown" {
  interface TurndownOptions {
    bulletListMarker?: string | undefined;
    codeBlockStyle?: "fenced" | "indented" | undefined;
    headingStyle?: "atx" | "setext" | undefined;
  }

  class TurndownService {
    constructor(options?: TurndownOptions);
    remove(filter: string | string[]): void;
    turndown(input: string): string;
  }

  export default TurndownService;
}
