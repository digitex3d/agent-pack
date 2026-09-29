# Contributing to agent-pack

Thank you for your interest. agent-pack is maintainer-led (see [GOVERNANCE.md](./GOVERNANCE.md)): the maintainer has the final say on the language, the specification, the implementation and who is admitted as a contributor.

## Issues and ideas

Anyone may open an issue — a bug, a question or an idea. Use the issue templates. For a security problem, do not open an issue: follow [SECURITY.md](./SECURITY.md).

## Pull requests

Code contributions are accepted from contributors admitted by the maintainer. Before a large change, open an issue to discuss it: a proposal becomes part of agent-pack only when the maintainer merges it.

1. Build and test (Node 20 or newer):

   ```bash
   npm ci
   npm test        # builds, then runs the whole suite
   ```

2. Keep the change focused; add or update tests under `test/` and the docs under `docs/` when behaviour changes, and a line under `[Unreleased]` in [CHANGELOG.md](./CHANGELOG.md).
3. New source files start with the SPDX header used across the repository:

   ```ts
   // SPDX-License-Identifier: Apache-2.0
   // Copyright (c) 2026 Giuseppe Federico
   ```

4. Write commit messages in English.

## Contributor License Agreement

Every contributor signs the [CLA](./CLA.md) once. On your first pull request the CLA workflow asks you to comment:

> I have read the CLA Document and I hereby sign the CLA

The signature is recorded with your GitHub account. A pull request cannot be merged before it is signed.

## Conduct

Everyone taking part follows the [Code of Conduct](./CODE_OF_CONDUCT.md).
