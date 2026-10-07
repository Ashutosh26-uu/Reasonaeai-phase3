# Next.js starter

This optional starter is baked into the sandbox image. It is available when a
project explicitly uses Next.js; it does not select or scaffold a stack for the
CTO. Use the normal sandbox file and shell tools to copy it into an empty
workspace when appropriate.

The starter includes Next.js App Router, React, TypeScript, Tailwind CSS v4,
shadcn-compatible configuration, Lucide icons, and editable Button, Card,
Input, and Badge components. The components are source files in this workspace,
so they can be changed freely. The shadcn CLI is intentionally not bundled;
the shipped CLI dependency tree currently includes high-severity advisories.
Additional components can be copied into the project as source files.

Vitest is preinstalled and `npm test` runs the starter's unit tests. The image
build runs that test command before the production build so a broken test setup
cannot be baked into the shared sandbox image.

The image pins npm 12.2.0 because npm 10.9.9 fails to resolve the pinned Vitest
5 dependency graph. npm's remote-package policy is enabled for the locked
install; the lockfile pins the resolved package URLs and integrity hashes. Both
online and offline installation are verified at image build time.

Run `npm run dev` to start the app on `0.0.0.0:4173`. Then call ReasonateAI's
`open_preview` tool with `http://127.0.0.1:4173/` to open this app in the
conversation's App preview. The port is explicit so it cannot select an
unrelated server.

Dependencies belong to this app's `package.json` and `package-lock.json`. Add
other packages with npm as needed; Node.js itself is provided by the sandbox.
