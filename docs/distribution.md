# Distribution policy

- Status: static application; not an npm package
- Current channels: GitHub source and releases, plus the GitHub Pages operator
- Package guard: root `package.json` remains `private: true`

WasmHatch currently ships as a browser application. The repository root has no
stable JavaScript import surface, `exports` map, package build, or npm consumer
contract. Publishing the application source as `wasmhatch` would therefore add
a registry artifact without a supported way to use it.

The canonical releases are:

1. signed Git history and tagged GitHub Releases for source versions;
2. the static GitHub Pages deployment for the Business Operator; and
3. portable user-created workspace bundles, which are data artifacts rather
   than executable npm packages.

`private: true` is a deliberate fail-closed guard against accidental
`npm publish`. Development still uses npm for lockfile installation and scripts;
that does not make the application an npm distribution.

## Future package gate

A separate package may be proposed only when it has all of the following:

- a narrow consumer, such as connector manifest authors or effect-protocol
  adapters;
- a documented, tested import surface and generated type declarations;
- a package-specific name, license, repository metadata, `exports`, files list,
  semantic-versioning policy, and migration contract;
- no browser application credentials, deployment configuration, fixtures with
  business data, or ambient network authority; and
- independent conformance tests showing that package consumers cannot bypass
  the host credential, sandbox, policy, or approval boundaries.

Likely candidates are a future `@haya-inc/wasmhatch-connector-sdk` or protocol
types package—not the current application root. A candidate must be justified
by at least one external consumer rather than by registry visibility alone.

## Publication security

If a package passes the gate, publish it from a protected GitHub Actions workflow
using npm Trusted Publishing and short-lived OIDC identity. Do not store a
long-lived npm publish token in the repository, source tree, logs, local
workspace, or GitHub Actions secrets when trusted publishing is available.

References:

- <https://docs.npmjs.com/files/package.json/#private>
- <https://docs.npmjs.com/trusted-publishers/>
- <https://docs.npmjs.com/revoking-access-tokens/>
