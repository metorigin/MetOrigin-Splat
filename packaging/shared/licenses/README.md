# Exact npm publication notice evidence

This source-only collection supplies an original notice when an exact npm
publication omitted it. It is not an installed-package patch or a runtime
dependency. Both platform license collectors may consume the read-only
`scripts/shared/npm-notice-evidence.mjs` verifier. An unmatched version returns
no notice; corrupt identity or installed-file evidence fails verification.

`react-resizable-panels@3.0.6` was downloaded from the official npm version and
tarball URLs recorded in `npm-notice-index.json`. The complete tarball's SHA-512
matches `pnpm-lock.yaml`; all 30 regular archive members match the installed
files exactly. The archive has no LICENSE, despite listing one in `files`.
Official npm metadata identifies publication gitHead
`43a071df6bb96d54e8b81a6be0e2d453af45cc4b`. At that exact commit the repository
package manifest is byte-for-byte identical to the published package manifest.
Its root LICENSE is preserved verbatim, including Brian Vaughn's original
copyright. GitHub blob identities and SHA-256 values are recorded separately.

The tarball itself is retained only in the ignored
`.test-results/jan-ui-migration/npm-notice-recovery/` acquisition cache. The
checked-in official metadata, fixed upstream manifest, original LICENSE and
complete archive-member SHA-256 inventory make installed-byte verification
offline. Acquisition can be reproduced by downloading the exact recorded
`publication.url`, checking `publication.integrity` against the lockfile,
hashing every regular `package/` archive member, and fetching the two source
paths from the recorded full commit. No build or install scripts are needed.

`react-remove-scroll-bar@2.3.8` remains unresolved. Its official tarball also
omits a notice; all 27 installed files match it and its SHA-512 matches the lock.
However, npm gitHead `b3b1287aad81def2e2ae707274b74531b61ddbaf` is unavailable
from the declared repository (GitHub contents 404 and commit 422). The inspected
public tags/package history expose 2.3.7 rather than 2.3.8. Its npm metadata and
failed identity evidence are recorded under `npm/react-remove-scroll-bar/2.3.8/`.
No license from main, an earlier release or another author is substituted, and
this collection does not close that distribution evidence gap.
