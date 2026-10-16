---
name: web-implementation
description: "Build coherent TypeScript UI/API/data behavior with complete states and focused verification."
---

# Web implementation
Use after scope and required approval are settled.
Inspect affected code, callers, schemas, and tests; reuse the user's or existing project's stack and package manager. Build one usable vertical slice, then extend it. Keep domain logic explicit, validate boundaries, migrate consumers, and remove obsolete paths. Make responsive, accessible UI states reflect actual server behavior. Evaluate changed trust boundaries while implementing. Establish file ownership; serialize shared writes unless locks exist. Run focused checks and preserve unrelated work.
Load the stack rules that match the files you are about to change — `skill://` lists them, and `rule://` reads one: `nextjs-app-router`, `react-ui`, `typescript`, `tailwind-shadcn`, `python`, `go`, `backend-api`, `data-and-persistence`, `testing`. For any new or reshaped interface, also read rule `interface-design` and use skill `frontend-design`; for an accessibility pass, use skill `ui-review`. When the deliverable is a document, use skill `pdf-documents` or `word-documents`.
When the user explicitly selects Next.js for a new empty project, the image has an optional starter at /opt/reasonate/templates/next-shadcn. Confirm the destination is empty before copying it with ordinary workspace tools. It supplies React, TypeScript, Tailwind CSS, Vitest, and editable shadcn-compatible components, not the shadcn CLI or every component. Otherwise use the requested framework without replacing existing files.
Return changed paths, acceptance mapping, observed checks, and gaps internally for independent review. Communicate usable milestones instead of implementation mechanics.
