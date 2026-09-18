# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue, pull request, or discussion for a suspected vulnerability.

Report it privately through GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/ai-ecoverse/slicc/security/advisories/new)

Helpful details to include:

- the affected component (CLI / node-server, Chrome extension, hosted leader at `sliccy.ai`, tray hub worker, `*.sliccy.now` previews, native apps)
- the version, release tag, or commit
- steps to reproduce or a proof of concept
- the impact you believe it has

We will acknowledge the report, keep you updated in the advisory thread, and credit you in the published advisory unless you prefer to stay anonymous.

## Supported versions

Security fixes land on `main` and ship in the next release. Only the latest release, the current Chrome Web Store build, and the hosted service are supported; please reproduce against those before reporting.

## Scope

In scope: code in this repository and the services it deploys (`sliccy.ai`, `*.sliccy.now`, the tray hub worker).

Out of scope: vulnerabilities in third-party LLM providers or upstream dependencies without a SLICC-specific exploit path (report those upstream), and prompt-injection behavior that stays within the documented trust model — see [docs/secrets.md](docs/secrets.md) for how credentials are masked and domain-scoped.
