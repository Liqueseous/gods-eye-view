# AI development notes

Before finalizing work in this repository:

- Update the build number for release or deployment builds with `GEV_BUILD_NUMBER` (or the CI-provided `BUILD_NUMBER` / `GITHUB_RUN_NUMBER`). Local development may continue to use the `dev` fallback.
- Check the parent repository remote (`remote-origin`) and identify the latest parent commit merged into this fork. Keep `package.json` `sourceVersion` and `sourceCommit` current so the in-app `SRC` build identity remains accurate.
- If the parent baseline changes, update the corresponding source-version note in `README.md` and `docs/CURRENT-STATE.md`.
- Verify the displayed build identity with a production build before release.
