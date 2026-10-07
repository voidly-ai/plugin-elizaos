# Release setup for the owner

This bundle proposes the public GitHub repository `voidly-ai/plugin-elizaos` for the npm package `@voidly/plugin-elizaos`. The source is prepared for review; no repository, tag, or npm release has been created by this bundle.

1. Create the public GitHub repository with exactly this source tree. Confirm the npm `@voidly` organization grants the publishing owner access to `@voidly/plugin-elizaos`.
2. In npm, configure a GitHub Actions trusted publisher for package `@voidly/plugin-elizaos`: owner `voidly-ai`, repository `plugin-elizaos`, workflow `publish.yml`, environment `npm-publish`. Set the trusted publisher to allow direct `npm publish` in the current npm settings, rather than only `npm stage publish`. Configure the GitHub `npm-publish` environment for the intended release approvers. No `NPM_TOKEN` is used.
3. If npm cannot configure a trusted publisher before this package exists, the owner must use the approved bootstrap publication process first, then configure trusted publishing. This workflow fails closed until trust is configured. If bootstrap publishes `0.1.0`, bump both `package.json` and `package-lock.json` to the next unused version before creating a trusted-publisher tag; the workflow rejects `v0.1.0` after that release exists.
4. Review `package.json` and `package-lock.json` together, run `npm ci --ignore-scripts --no-audit --no-fund` and `npm run audit:pack`, then merge to `main`. The publish workflow accepts only a `v<package version>` tag on the exact repository and rejects an npm version that already exists. For the current source that tag is `v0.1.0`.
5. After the owner creates the tag and the GitHub run succeeds, verify the exact npm version, tarball, and provenance independently before claiming publication.

The default plugin remains public read-only discovery. Optional buy and sell actions require a host-owned wallet-kit 0.2.0 connection and one-use authorization; an incomplete paid response retains recovery guidance and must not trigger repayment. This release workflow never performs a live wallet action.
