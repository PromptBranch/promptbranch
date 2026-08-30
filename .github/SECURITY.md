# Security Policy

> PromptBranch is built to protect valuable prompt libraries, provider
> credentials, and the decisions people make with them. We welcome careful,
> good-faith security research that helps us keep those boundaries strong.

## Supported Versions

PromptBranch is currently pre-1.0. Security fixes are provided for the latest
`0.1.x` release line.

| Version | Supported | Security updates |
| ------- | :-------: | ---------------- |
| 0.1.x   | ✅        | Active           |
| < 0.1   | ❌        | Not supported    |

Development branches, untagged builds, forks, and modified distributions are
not supported releases. Reports are still welcome when the same issue affects
the latest supported release.

## Scope and Security Priorities

This policy covers the PromptBranch monorepo, including the desktop app, core
library, AI integrations, sharing contract, CLI, MCP server, and peer-to-peer
sync. Reports concerning the production service at `promptbranch.app` are also
welcome through the same private channel and will be routed appropriately.

We are especially interested in vulnerabilities that could cause:

- Unauthorized access to, modification of, deletion of, or publication of a
  user's prompts, versions, notes, evaluations, or run history.
- Exposure of provider API keys, share deletion tokens, pairing secrets, or
  other sensitive material across process, storage, logging, export, or sync
  boundaries.
- A renderer-to-main-process escape, unsafe IPC behavior, arbitrary code
  execution, or unintended local file or command access.
- Bypass of the "agents propose, humans approve" boundary.
- Authentication, authorization, secret-scanning, sanitization, or revocation
  failures in the sharing flow or hosted snapshot viewer.
- Peer identity, certificate-pinning, pairing, or merge-integrity failures in
  multi-device sync that expose or corrupt library data.
- Supply-chain or release-packaging compromises affecting distributed
  PromptBranch artifacts.

Severity is assessed from demonstrated exploitability, required privileges and
user interaction, affected data, deployment reachability, and impact—not from
a scanner score alone.

## Reporting a Vulnerability

**Do not open a public issue, discussion, or pull request for a suspected
vulnerability.**

Submit the report privately through
[GitHub Security Advisories](https://github.com/PromptBranch/promptbranch/security/advisories/new).

Please submit one vulnerability per report unless multiple issues must be
combined to demonstrate impact.

A useful report includes:

- The affected component, version or commit, operating system, and installation
  method.
- A concise description of the vulnerability, realistic attack scenario, and
  security impact.
- Reproduction steps and a minimal proof of concept, including prerequisite
  permissions or user interaction.
- Relevant logs, screenshots, or suggested remediation.
- Whether the issue affects `promptbranch.app`, and the relevant URL or API
  route if it does.

Remove API keys, prompt contents, personal data, access tokens, and unrelated
secrets from all submitted evidence.

## What to Expect

| Milestone | Target |
| --------- | ------ |
| Acknowledgment | Within 3 business days |
| Initial validation and severity assessment | Within 7 business days |
| Progress updates for an accepted report | At least every 7 days |
| Coordinated disclosure | After a fix or agreed mitigation is available |

If a report is declined, duplicate, or determined not to cross a security
boundary, we will provide a brief explanation. Remediation timing depends on
severity, complexity, release coordination, and risk to users.

## Coordinated Disclosure

For an accepted vulnerability, we will work with you on validation,
remediation, and a responsible disclosure timeline. When appropriate, we will
publish a GitHub Security Advisory, request a CVE, and credit the reporter.
Tell us if you prefer to remain anonymous.

Please keep the report confidential until we publish an advisory or agree in
writing that disclosure is appropriate.

## Research Guidelines and Safe Harbor

- Test only with accounts, devices, prompt libraries, and data you own or have
  explicit permission to use.
- Use the minimum interaction necessary to demonstrate the vulnerability.
- Do not persist access, exfiltrate data, disrupt availability, perform
  high-volume automated testing, or use social engineering.
- Stop immediately if you encounter another person's data, credentials, or
  private content.
- Follow applicable law and give us reasonable time to investigate and
  remediate before disclosure.

To the extent we control the matter, research performed in good faith and in
accordance with this policy will be considered authorized, and we will not
initiate legal action against the researcher. This safe harbor cannot bind
third parties.

## Generally Out of Scope

The following are generally not eligible unless they demonstrate a concrete,
previously unknown security impact:

- Scanner output without a reproducible exploit path or meaningful impact.
- Vulnerable dependencies without evidence that the behavior is reachable.
- Self-XSS requiring users to paste code into developer tools or a terminal.
- Social engineering, phishing, physical attacks, denial-of-service testing,
  or high-volume load testing.
- Findings requiring an already-compromised operating system or unrestricted
  administrator access without crossing an additional security boundary.
- Missing best-practice headers with no demonstrated security consequence.
- Issues limited to unsupported versions, forks, or modified builds.

These exclusions do not override a demonstrated boundary crossing, privilege
increase, sensitive-data exposure, or realistic attack chain.

## Recognition and Rewards

We appreciate responsible vulnerability research. PromptBranch does not
currently operate a paid bug-bounty program, and this policy does not promise
financial compensation.
