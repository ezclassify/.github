# <img src="profile/icon.svg" alt="" width="32"> EzClassify community defaults

This repository holds the organization-wide community health files for the
[EzClassify](https://github.com/ezclassify) GitHub organization. GitHub applies
them to any repository in the organization that does not carry its own copy.

| File | Purpose |
| --- | --- |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute, and the commit sign-off |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Standards for project participation |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability |
| [SUPPORT.md](SUPPORT.md) | Where to get help |
| [profile/README.md](profile/README.md) | The organization page shown on github.com/ezclassify |
| [.github/ISSUE_TEMPLATE/config.yml](.github/ISSUE_TEMPLATE/config.yml) | Disables blank issues and links the central tracker |
| [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) | Pull request checklist |

Issues for every EzClassify repository are tracked in
[ezclassify/ezclassify](https://github.com/ezclassify/ezclassify), which is also
the organization's starting point. The issue forms live there.

## Shared CI lanes

Consumers pin `.github/workflows/ci-policy.yml` and `ci-result.yml` at a reviewed
full commit SHA. The policy selects one primary toolchain version for ready pull
requests and main pushes; manual and scheduled qualification use the full
supported matrix. Pull requests retain required validation while in draft.

Repositories own their native commands, applicability decisions, dependency
closures, and artifact identities. Every consumer's stable `ci` job joins all
other jobs. A separate `qualification` job runs only for full qualification;
publishers require its successful exact revision and attempt, never routine CI.
`ci-result.yml` rejects failed, missing, cancelled, or unexpectedly skipped jobs.
Explicit full-only and inapplicable lanes must be named by the caller.

The shared workflows hold no secrets, write no source, and publish no artifacts.
They do not install dependencies or repeat quarantine checks. Native admission
owns each closure once; matching Node/npm setup uses `actions/setup-node-npm`.
Callers retain workflow/ref concurrency with separate event groups for manual
qualification. Nightly triggers remain inactive until operator approval; the
three paused Release Train reconciliation workflows stay disabled separately.
