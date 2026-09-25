# Agent Instructions

## Working tree and publishing

The repository root is the application's only working checkout. The application source is in `app/`; inspect the remote with `git remote -v`. Run Git commands from the root. Do not create a second source checkout in `.publish/` or elsewhere.

Keep models, textures, saved projects, and other user data locally in `models/` or `local-data/` (`textures/` and `media/` are also available). These directories and common project file types are excluded by `.gitignore`. Before preparing a commit, inspect `git status` and `git diff --cached --name-only` to ensure user data is absent. Never force-add it with `git add -f`.

You may edit files, run checks, and prepare a diff without separate approval. **Get explicit user approval for the specific changes, branch, and remote before each `git commit` and `git push`.** The same applies to tags and releases. If the user explicitly asks you to commit and push the current work, that request authorizes those actions for that work only.

After finishing development of a feature, ask the user whether to push the completed changes. Do not assume a feature request authorizes a push.

## Reference projects

Use `mapmap/` and `splash/` only as references. Do not copy or directly reuse their code or assets, add them as dependencies, modify them, or add them to this Git repository, including through a submodule or forced `git add`. Implement the new application independently in `app/`.

## Local task notes

If this workspace has a local `tasks/` directory, follow its `README.md` and update your task there. The directory is ignored by Git; keep its files in the workspace.

## Implementation team

If a local `docs/agent-team.md` exists in the workspace, use it when delegating implementation; the primary agent remains the coordinator. Give each agent specific files, a contract, and verification criteria. Do not let agents edit the same files concurrently. The coordinator verifies integration and results without adding user models to Git.
