---
name: npm-release
description: Release a new npm version of @canglongcl/dsh-tool-retry through the CI-only release pipeline. Use when asked to publish, release, ship, tag, or bump a new npm version of this repo; when a release workflow run (pack/publish) fails and needs diagnosis; or when changing the release pipeline itself (version-sync conventions, tag conventions, .github/workflows/release-npm.yml, scripts/verify-release.ts).
---

# npm release pipeline

Every release of `@canglongcl/dsh-tool-retry` runs in GitHub Actions; nothing is published from a local machine. Locally you only sync versions, push, and tag.

## Release steps

1. **Sync the version.** `packages/dsh-tool-retry/package.json` and root `package.json` must carry the SAME publishable semver (`x.y.z` or `x.y.z-<prerelease>`). `scripts/verify-release.ts` fails on any mismatch, and the publish job aborts if the tag differs from `v<version>`.
2. **Sanity-check locally** (cheap, optional):
   ```sh
   pnpm release:verify   # identity checks (non-publish mode: no ref checks)
   pnpm check            # full repo gate (CI runs this too)
   pnpm package:official && sha256sum -c dist/SHA256SUMS
   ```
3. **Commit** with the repo's conventional style (`feat: ...`, `fix: ...`, `docs: ...`) and push to `main`.
4. **Tag and push:** `git tag v<version> && git push origin v<version>`.
5. **Watch the workflow.** The `pack` job runs on every PR and push; the `publish` job runs only for `v*` tags and `needs: pack`.

## What the pipeline does

- **pack job** (`.github/workflows/release-npm.yml`): `pnpm release:verify` → `pnpm check` → `pnpm package:official` → `sha256sum -c SHA256SUMS` → upload `dist/*.tgz` + `SHA256SUMS` as the `dsh-tool-retry-npm` artifact.
- **publish job**: downloads the artifact, verifies the checksum and identity (package name, `publishConfig.access === "public"`, tag/version match `refs/tags/v<version>`), then `npm publish --access public --tag latest|next`. A `-` in the version (prerelease) routes to the `next` dist-tag.

## Design invariants (do not "simplify" away)

- **Exact-bytes publish.** The publish job publishes the pack job's artifact and never rebuilds. Never repack inside the publish job.
- **Trusted Publishing only.** Auth is npm Trusted Publishing via GitHub OIDC (`permissions: id-token: write`). The workflow must never contain `NODE_AUTH_TOKEN`, `secrets.NPM_TOKEN`, any other long-lived token, `--access restricted`, or `pull_request_target`; `verify-release.ts` rejects all of them.
- **No registry-url in the publish job's setup-node.** setup-node writes an `_authToken` placeholder that masks npm's OIDC flow. The pack job's setup-node may set `registry-url` (anonymous public installs).
- **Source manifest stays private.** The source `packages/dsh-tool-retry/package.json` keeps `private: true` with `publishConfig.access: public`; only the allowlisted staged manifest under `dist/package/` (which omits `private`) is publishable. Never publish from the source workspace.
- **Locked actions.** Every third-party `uses:` is pinned to a full 40-hex commit SHA; `verify-release.ts` enforces it.
- **Fork safety.** The pack job refuses PRs from external forks (`head.repo.full_name == github.repository`), so repository secrets are never exposed to fork code.
- **Identity guards** (all enforced by `pnpm release:verify`, `scripts/verify-release.ts`): package name `@canglongcl/dsh-tool-retry`, registry `https://registry.npmjs.org/`, repository `git+https://github.com/CanglongCl/dsh-tool-retry.git`, root `packageManager: pnpm@11.20.0`, `.npmrc` containing exactly the two scoped-registry lines, and on publish `GITHUB_REF == refs/tags/v<version>` plus `GITHUB_REPOSITORY == CanglongCl/dsh-tool-retry`.

## Common failures

- **`release verify` fails** → read the message: root/package version mismatch, `.npmrc` drift, wrong package identity, or the workflow content regressed against the required/forbidden string lists. Fix the repo, never weaken the check.
- **Publish job aborts with "tag/version mismatch"** → the tag does not equal `v<manifest version>`; retag or bump the version.
- **`npm publish` returns 403/404** → Trusted Publishing is not configured: npmjs.org → Access Tokens → Trusted Publishing must authorize GitHub repo `CanglongCl/dsh-tool-retry` for the `@canglongcl` scope. No token is stored in the repo, and none may ever be added.
- **Pack job failed** → reproduce locally with `pnpm check`; the CI gate is exactly the local gate.
- **`--trust-lockfile` looks suspicious** → intentional: `pnpm install --frozen-lockfile --trust-lockfile` keeps freshly published (under 24 h) public dependency entries from failing the install solely for their age.

## Verification after a release

- `npm view @canglongcl/dsh-tool-retry version` matches the tag; `npm view @canglongcl/dsh-tool-retry dist-tags` shows `latest` (or `next` for prereleases).
- The published tarball sha256 equals `dist/SHA256SUMS` (fetch via `npm view @canglongcl/dsh-tool-retry dist.tarball`).
- The GitHub Actions run shows both jobs green, with the publish job executed on the tag ref.

## Out of scope

Installing the prebuilt tarball into a running DSH profile (`dsh plugin add file:...`) is the official-channel flow in AGENTS.md ("Installing the prebuilt tarball into a running profile"); it does not publish to npm.
