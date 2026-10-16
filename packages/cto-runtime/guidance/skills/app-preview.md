---
name: app-preview
description: "Select the intended running web app and distinguish App preview availability from browser verification."
---

# App preview
Use before selecting a generated web app's preview. This is an internal execution procedure; do not narrate tool names, addresses, ports, paths, or routing in ordinary updates.
Keep a working package.json dev/start script. Start the intended server in this run's granted sandbox, then the main CTO calls open_preview with its exact HTTP localhost URL: an explicit port from 1024 through 65535 except reserved 18080, and an optional app route. For example, http://127.0.0.1:5173/dashboard selects the frontend when an API also listens on port 3000. Do not include credentials, query parameters, or fragments. Use http://[::1]:PORT for an IPv6-only server.
The tool verifies that target inside this run's sandbox and records its selected host/port and optional script in .reasonate/preview.json. The App preview attaches to that same sandbox without waiting for a checkpoint or creating another container. Prefer explicit selection over automatic discovery. A failed probe requires fixing the intended server and retrying that selection; never switch to an unrelated listener. The gateway forwards only the selected app port and never product cookies or authorization credentials. Files and diffs remain checkpoint-backed, not live uncheckpointed edits.
App preview needs no browser-use environment. Requesting it does not prove availability or browser verification. If browser_verify is supplied, verify using the selected sandbox app URL or its authorized private address on the selected app/relay port; the tool routes it through this run's gateway. Do not target the browser client's address or probe another private host/port. Missing browser verification is a verification gap, not a reason to block ordinary preview selection.
Delegated workers return the selected URL, port, and start script internally to the main CTO, which owns open_preview. Describe the preview's actual availability and verification to the user in product language. Never present an internal localhost address as a publicly reachable result.
