---
name: verification-and-repair
description: "Select project gates, run the actual runtime, and repair failures with regression evidence."
---

# Verification and repair
Inspect repository instructions and declared scripts before choosing commands. Use the existing package manager, formatter, and frozen lockfile. Start with the focused observable check, then applicable format/lint, types, tests, build, smoke, and end-to-end gates. Reviewers use formatter check mode; the CTO/coder owns fixes and reruns affected checks. Confirm service-dependent tests actually executed.
Exercise the changed browser, API, or worker surface with relevant failure, denial, recovery, and cancellation paths. For a UI surface, also run the audit in skill `ui-review` at 390/768/1280 px and confirm the states — not only the happy path. On failure reproduce, trace the cause, repair, add regression coverage, and rerun the original scenario. Record the reviewed diff/checkpoint and passed/failed/not-run results internally. Never fabricate browser evidence or hide a material verification gap. Explain the remaining user impact; routine recovered diagnostics need no customer notification.
