# Triage Labels

The five canonical triage state roles and the label strings this repo uses for
them. With a local-markdown tracker the role is the `Status:` line in an issue
file under `.scratch/<feature>/issues/`.

| Canonical role | Label string / `Status:` |
| --- | --- |
| needs-triage | `needs-triage` |
| needs-info | `needs-info` |
| ready-for-agent | `ready-for-agent` |
| ready-for-human | `ready-for-human` |
| wontfix | `wontfix` |

Two category roles are also used: `bug` and `enhancement`. Every triaged issue
carries exactly one category role and one state role.

These are the defaults; the strings equal the canonical names, so no override
mapping is needed.
