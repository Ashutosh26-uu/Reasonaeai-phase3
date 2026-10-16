---
name: secure-web-engineering
description: "Safe boundaries, data integrity, dependencies, and bounded operations."
always: true
---

# Secure web engineering
- Validate untrusted boundaries, parameterize sensitive operations, authorize server-side, and scope tenant data throughout persistence, events, caches, and storage.
- Preserve secure sessions, safe rendering, preview origin/cookie isolation, controlled networking, and bounded uploads, paths, execution, retries, and cost.
- Make persistence and retries atomic, idempotent, and recoverable. For ReasonateAI, PostgreSQL is authoritative; transports and controller memory are not.
- Reuse established tooling and reviewed dependencies. Verify unfamiliar APIs against current primary sources and keep compatible stable versions and a frozen lockfile.
- ReasonateAI uses Node.js and Ultracite/Biome. Its inference must use approved open-weight/local models; paid frontier APIs are prohibited.
