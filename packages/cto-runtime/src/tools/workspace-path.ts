import { posix } from "node:path";

const FILE_URI_RE = /^file:\/\//i;
const LOCALHOST_RE = /^localhost\//i;
const DRIVE_RE = /^[A-Za-z]:/;
const URI_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function fileUriPath(uri: string): string {
  let path = uri.replace(FILE_URI_RE, "");
  if (LOCALHOST_RE.test(path)) {
    path = path.replace(LOCALHOST_RE, "/");
  }
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw new Error("Use a local file URI without a query or fragment.");
  }
  try {
    path = decodeURIComponent(path);
  } catch (cause) {
    throw new Error("The file URI contains invalid percent encoding.", {
      cause,
    });
  }
  // file:///C:/workspace/file is a Windows representation of the sandbox path.
  return DRIVE_RE.test(path.slice(1)) ? path.slice(1) : path;
}

/** Resolve a file-tool argument in the sandbox namespace, never on the host. */
export function resolveWorkspacePath(argument: string, root: string): string {
  const workspaceRoot = posix.normalize(root);
  if (!posix.isAbsolute(workspaceRoot)) {
    throw new Error("The workspace root must be an absolute POSIX path.");
  }
  let path = FILE_URI_RE.test(argument) ? fileUriPath(argument) : argument;
  path = path.replaceAll("\\", "/");
  // Only the explicit @/ shortcut is syntax; @scope is a real filename.
  if (path.startsWith("@/")) {
    path = path.slice(2) || ".";
  }
  if (DRIVE_RE.test(path)) {
    if (path[2] !== "/") {
      throw new Error(
        "Drive-relative paths are not available in the workspace."
      );
    }
    path = path.slice(2);
  }
  if (path.length === 0 || path.includes("\0")) {
    throw new Error("A non-empty workspace path is required.");
  }
  if (path === "~" || path.startsWith("~/")) {
    throw new Error("Home-directory paths are not available in the workspace.");
  }
  if (path.startsWith("//") || URI_RE.test(path)) {
    throw new Error("Use a project path or a local file URI.");
  }
  const target = posix.resolve(workspaceRoot, path);
  const relative = posix.relative(workspaceRoot, target);
  if (relative === ".." || relative.startsWith("../")) {
    throw new Error("The path escapes the verified workspace.");
  }
  return target;
}
