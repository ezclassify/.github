# Contributing to EzClassify

Thank you for your interest in contributing! This guide applies to all public
EzClassify repositories. Individual repos may have additional guidelines in
their own CONTRIBUTING.md.

## Before You Start

1. **Sign the CLA.** All contributors must sign our
   [Contributor License Agreement](CLA.md) before their first pull request can
   be merged. You will be prompted automatically when you open your first PR.

2. **Fork the repository.** All contributions come through pull requests from
   forks. Direct pushes to official repositories are not permitted.

3. **Open an issue first** for non-trivial changes. This lets us discuss the
   approach before you invest time in implementation.

## Development Workflow

1. Fork the repository and clone your fork.
2. Create a branch from `main`: `git checkout -b my-change`
3. Make your changes, keeping them scoped to a single concern.
4. Run tests and lint before pushing:
   ```bash
   npm test
   npx eslint .
   ```
5. Open a pull request against `main` in the official repository.

## Pull Request Requirements

All pull requests must:

- [ ] Pass all CI checks (tests, lint, type checking)
- [ ] Be approved by a maintainer
- [ ] Have a signed CLA on file
- [ ] Include tests for new or changed behavior
- [ ] Follow the code style of the repository

## Code Standards

- **TypeScript** strict mode. No `any` in source files.
- **Vitest** for all tests. Use `vi.fn()`, not `jest.fn()`.
- **CSS modules** for styling. No inline styles (except CSS custom property
  injection).
- **rem units** for sizing. No `px` except for borders and outlines.
- **Semantic HTML** with ARIA attributes. All UI must meet WCAG 2.1 AA.
- **JSDoc** on all exported functions, classes, and interfaces.

## What We Accept

- Bug fixes with tests demonstrating the fix.
- New community profiles with round-trip and aggregation tests.
- Documentation improvements.
- Integration improvements and new framework integrations.
- Performance improvements with benchmarks.

## What We Cannot Accept

- Contributions without a signed CLA.
- Proprietary, classified, or export-controlled information.
- Changes that weaken validation or bypass constraints.

## Questions

Open an issue or start a discussion on the relevant repository.
