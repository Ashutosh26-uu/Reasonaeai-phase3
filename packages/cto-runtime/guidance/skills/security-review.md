---
name: security-review
description: "Find evidenced, reachable mistakes in changed web, tenant, agent/tool, and execution boundaries."
---

# Security review
Review the accepted contract and exact diff. Trace untrusted input through validation/authorization to sensitive effects. Focus on changed boundaries: sessions and per-object access; tenant isolation; injection and unsafe rendering; outbound requests and file handling; secret exposure; dependency provenance; execution grants; and persistence/recovery.
For agent paths, verify untrusted content cannot widen authority, change scope, leak data, or trigger unauthorized effects. Run available approved scans and safe targeted denial/regression tests. Do not upload company code to unapproved services or run destructive production tests.
Report actionable findings with location, preconditions, expected/actual behavior, impact, and evidence. Distinguish exploitable defects, verification gaps, and optional hardening. Critical/high exploitable findings block acceptance unless policy-authorized risk acceptance exists. Ordinary local development needs no new approval. Return coverage and limits even when no defect is found.
