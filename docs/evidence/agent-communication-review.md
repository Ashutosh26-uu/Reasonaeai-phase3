# Product communication candidate — October 13, 2026

Status: review draft; behavioral acceptance remains in progress.

## Scope and comparison

The candidate gives the CTO a calm, capable persona, concise outcome-first responses, selective progress, and an explicit boundary between customer communication and internal evidence. Worker reports, title/continuation definitions, environment context, bundled guidance, and fallback dispatch instructions follow that boundary. Detailed preview selection and Python setup remain available through the existing named skill router. Material blockers and verification gaps must remain visible; permissions, event schemas, audit records, and existing expandable activity are unchanged.

[Baseline](./agent-communication-before.json) and [candidate](./agent-communication-after.json) contain actual approved `deepseek/deepseek-flash` responses to the same nine synthetic scenarios. The harness composes the production CTO role, rules, catalog, resource/environment context, and an empty scoped workspace; it then supplies those instructions to a standalone Mastra Agent. It does not run the production coding-agent controller, tool loop, actual compaction, application generation, browser journey, or deployment. Each scenario uses a fresh agent, one step, a 60-second timeout, and at most 1,400 output tokens. Multiple prompt revisions were explored; these reports retain the original baseline and final candidate, not every intermediate run. This is a small development comparison, not a repeated benchmark or general reliability estimate.

| Observation | Baseline | Candidate |
| --- | --- | --- |
| Mechanical checks passed | 1 of 9 | 8 of 9 |
| Ordinary responses flagged for internal mechanics | 6 of 8 | 0 of 8 |
| Responses exceeding scenario length limit | 8 of 9 | 1 of 9 |
| Simple explanation length | 391 words | 50 words |
| Composed instructions | 13,099 characters | 15,372 characters |

The communication policy adds context overall even though preview/Python procedures moved out of permanent instructions. Character counts include changing run/date facts and are not token-cost benchmarks. Requested technical diagnostics still contain the requested tool and port. Mechanical checks flag review candidates; passing them does not establish truth, tone, or completion.

## Manual and independent review

The final source is coherent as a draft. Independent review found no new permission, preview-routing, secret-handling, or evidence-boundary regression. Model responses still have acceptance findings:

- `simple-question` assumes anyone a user shares with can access the private preview. Actual access depends on authorization.
- `missing-provider` calls the provider connection the only missing piece and guarantees every customer will receive an email afterward. Real delivery was not verified.
- `verification-gap` turns an unverified purchase/deployment into claims that neither occurred, invents a likely settings remedy, and implies checkout alone clears publishing. It is also 104 words against a 100-word scenario limit.
- `recovered-preview`, `missing-provider`, `cancelled-work`, and `worker-handoff` retain unwanted follow-up invitations. The worker summary omits internal tool/path names but adds a publishing offer.
- `requested-diagnostics` correctly distinguishes successful selection from missing browser verification, but describes preview availability more strongly than selection evidence alone establishes.

The source policy forbids unsupported facts and generic offers; these outputs demonstrate remaining model adherence limits. Do not describe eight mechanical passes as eight semantic passes, treat the candidate as launch acceptance, or filter away material blockers to achieve a cleaner transcript.

## Verification and remaining work

Local frozen installation, root formatting/type checking/tests/build, and 404 CTO-runtime tests passed. The built API was started on an isolated loopback port and exercised through real HTTP: health succeeded and both raw agent/controller routes returned 404; this is serving/ingress evidence, not a product journey. The three new evaluator tests defend disclosure, brevity, empty-response, and identifier checks; existing guidance tests resolve every advertised named procedure through the real router. Service-dependent PostgreSQL/Redis/Docker tests skipped locally; they must run in CI. The production dependency audit has no high/critical findings (two low and two moderate remain); the shipped sandbox starter audit has zero findings. Gitleaks 8.30.1, downloaded from its official release and checksum-verified, scanned the pre-change HEAD ancestry: 118 commits, no findings. Final patch/history scans and formatting results are recorded in the pull request.

Full sandbox/browser acceptance is pending because the local Docker runtime is stopped. Respect the existing instruction to leave the user development server stopped. Required follow-through is real named-skill selection and preview opening, repaired and persistent failures, cancellation/resume, requested technical explanations, and internal worker synthesis through the authenticated product surface. Evaluate model adherence across repeated and unseen scenarios before accepting this behavior; preserve revision-specific evidence and rerun after any further prompt/runtime change. No deployment was performed.
