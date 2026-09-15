---
description: Address review comments on a PR, push fixes, and reply in-thread
---

Run this on a separate worktree with clean context.

Address every open review comment on the PR ($ARGUMENTS — a PR number, or the current
branch's PR if omitted). For each one:

1. Decide whether it needs a code change. My own responses to the reviewer may already be
   posted on the PR — read them first and treat them as the decision.
2. Make the change if it needs one, and commit it separately per comment or per coherent
   group.
3. Push.
4. Reply in that comment's own GitHub thread with the fix that was implemented (if any)
   and a short explanation of why.

When done, tell me what landed and what was declined.

Afterwards, on the original worktree: pull, because the branch has moved.
