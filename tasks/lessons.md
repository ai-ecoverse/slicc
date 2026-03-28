# Lessons

- When restarting a feature after architectural churn, use a fresh branch/worktree from `origin/main` instead of reshaping a dirty experimental branch in place.
- When a feature is meant to live on the existing production worker domain, keep the implementation on that canonical host in both code and docs instead of introducing a parallel domain.
