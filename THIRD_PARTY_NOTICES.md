# Third-party notices

## npm dependencies

| Name | Version | Licence | Upstream | How used |
|---|---|---|---|---|
| ical.js | 2.2.1 | MPL-2.0 | https://github.com/kewisch/ical.js | npm dependency, used unmodified (never patched in `node_modules`) |
| express | ^5.1.0 | MIT | https://github.com/expressjs/express | npm dependency |

## Adapted ideas (reimplemented, no code copied)

| Project | Licence | Copyright | Upstream | What was adapted |
|---|---|---|---|---|
| Super Productivity | MIT | Copyright (c) 2018 Johannes Millan | https://github.com/johannesjo/super-productivity | `sanitizeIcalData` idea, reimplemented as `unfoldOrphans` in `lib/ics.js` |
| Planly | MIT | Copyright (c) 2026 Daniil Kokorev | — | `wireBlock` drag/resize pattern, used as a structural reference for the hand-built drag and resize (spec §10.3) |

Every adapted snippet carries a provenance comment of the form
`// Idea from <project> (<licence>): <what>; reimplemented.`

Idea-only sources (taskcheck AGPL, sp-autoplan GPL, keeper.sh AGPL, Open Sunsama non-commercial) were consulted for
ideas only and are never transcribed.
