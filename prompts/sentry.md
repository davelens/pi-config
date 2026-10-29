---
description: Triage and fix one or more Sentry issues
argument-hint: "<ISSUE-ID...>"
---
Process Sentry issue(s): $@

1. Fetch each issue and its latest event through the Sentry MCP: exception, top in-app frames, event and user counts, first/last seen, release.
2. Check whether it is already handled: `git log --all -i --grep` on the issue ID and on the exception message, plus recent commits touching the top in-app frame.
3. When the issue involves specific records, reproduce it against the local database (usually a production copy).
4. Decide: real bug, transient/third-party failure, or bot/noise. For noise, explain why and propose how to handle or ignore it instead of changing code.
5. For a real bug: fix the root cause in the shared code (grep every caller), add a regression spec that fails first, and run the project's default test command.
6. Commit with a `Fixes <ISSUE-ID>` trailer. Leave pushing and deploying to me.
7. Report the cause and the fix, whether existing data needs repair (with the exact production command), and how confident you are.
