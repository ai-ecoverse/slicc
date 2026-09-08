# Vendored just-bash (2d9d41fd)

`just-bash-2d9d41fd.tgz` is `just-bash@3.4.2` built from
[`vercel-labs/just-bash@2d9d41fd`](https://github.com/vercel-labs/just-bash/commit/2d9d41fd90ad024cf54a7bc0caa345af7966c410)
(`fix(diff): default to POSIX normal format`, #413).

npm `latest` is still 3.4.2. The upstream release that will include #413 is
queued as just-bash 3.5.0 (`vercel-labs/just-bash#387`) and is not published
yet. The git repo is a pnpm monorepo: `dist/` is not committed and
`packages/just-bash` has no `prepare` script, so

`github:vercel-labs/just-bash#2d9d41fd::path:packages/just-bash`

installs source without the published bundles.

Replace this pin with the published npm version that contains #413, then
delete the tarball.
