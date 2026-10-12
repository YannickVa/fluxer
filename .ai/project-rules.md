# Repository agent guidance

This is the owner-maintained Fluxer fork. Follow the repository owner's explicit instructions for AI-assisted development and repository operations.

## Working style

- Work autonomously once the objective and scope are clear. Discover routine facts from the repository and environment instead of asking.
- Ask immediately when a genuinely consequential decision is unclear. When several approaches materially differ, present concise options and a recommendation before implementing.
- Lead with evidence from code, tests, logs, configuration, or build output. Distinguish verified facts from inferences and untested assumptions.
- Once the owner explicitly requests the complete commit, push, PR, and merge workflow, finish it without asking for each normal step again.

## Implementation

- Prefer a proper source fix over launch flags, copied binaries, runtime patches, or manual recovery instructions.
- Keep changes focused, maintainable, and production-ready. Do not refactor unrelated code or discard existing user changes.
- Add tests for important behavior, especially desktop startup, native integrations, media capture, installation, and update paths.
- Define concrete success criteria and verify end to end. A successful compile is not proof that packaging, installation, startup, or runtime behavior works.
- Preserve compatibility with upstream where practical and keep fork-specific behavior explicit and reviewable.

## Builds and CI

- Reuse pnpm, Cargo, native-module, and Electron caches. Verify cache keys and the cache-owning ref before starting an expensive build.
- Do not restart a long build without identifying the failure or the expected improvement.
- Do not weaken tests or omit native components merely to make a build pass.
- If CI or another external process is still running and no useful work remains, stop and report its link. Do not continuously poll unless explicitly asked to monitor it.

## Git and documentation

- Treat this checkout and `YannickVa/fluxer` as the application source of truth; do not create permanent parallel workspaces.
- Use focused `codex/*` branches, stage only relevant files, and use clear commits and one logical PR per change.
- Keep documentation concise and update it when behavior changes. Operational and instance-specific documentation belongs in `YannickVa/fluxer-infra`.
- State exactly what was verified and what remains. Never describe real voice, camera, screen sharing, shared audio, or GPU behavior as working until it has been tested on the relevant hardware and with another participant when required.
