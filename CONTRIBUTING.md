# Contributing to PromptBranch

Thank you for helping improve PromptBranch. Keep changes focused, include tests
for behavioral changes, and run the relevant quality gates before opening a
pull request.

## Pull Requests

- Open pull requests against `main` from a focused branch.
- Explain the user-visible behavior and the verification performed.
- Keep security reports private by following `.github/SECURITY.md`.
- Do not commit API keys, signing material, user prompt libraries, or other
  private data.

## Required Repository Protections

The GitHub protections for `main` are expected to:

- Require pull requests and at least one approving review for normal contributors.
- Require review from Code Owners and dismiss stale approvals.
- Require the `Typecheck, Test & Build` status check and resolved conversations.
- Apply required status checks to administrators, block force pushes, and block
  branch deletion.

While the organization has only one maintainer, `NightRang3r` has an auditable
pull-request-only bypass for the review requirement. It does not allow direct
pushes to `main` or bypass the required CI status check. Remove this exception
after an independent maintainer is available to review owner-authored changes.

Release tags matching `v*` should be protected from modification or deletion,
and creation should be restricted to release maintainers. Desktop publishing
should use a protected `release` environment with required reviewer approval
and deployment restricted to protected release tags.

Repository settings remain the enforcement source of truth. Maintainers should
compare the live rulesets and release environment with these expectations after
material workflow or governance changes.
