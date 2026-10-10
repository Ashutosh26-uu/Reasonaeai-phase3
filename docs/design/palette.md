# Product appearance palette

The accepted light and dark palette comes from [Bklit Components](https://bklit.com/docs/components), inspected in the browser on October 10, 2026. The live page was viewed in both themes. Its loaded stylesheet exposes original hex declarations followed by equivalent compiled Lab declarations; [the source capture](bklit-palette.json) records the hex declarations rather than estimates from a screenshot.

| Role | Dark | Light |
| --- | --- | --- |
| Canvas | `#08090B` | `#F5F5F5` |
| Text | `#F9FBFB` | `#090B0C` |
| Card | `#0E0F12` | `#FFFFFF` |
| Popover | `#18181B` | `#FFFFFF` |
| Primary control | `#E3E7E8` | `#3E3E3E` |
| Primary control text | `#161B1D` | `#ECECEC` |
| Secondary surface | `#22242B` | `#F8F8FA` |
| Secondary text | `#F9FBFB` | `#18181B` |
| Muted surface | `#2B2D37` | `#EAEAEA` |
| Muted text | `#818694` | `#757575` |
| Accent surface | `#292B34` | `#EBEBEB` |
| Accent text | `#F9FBFB` | `#182034` |
| Destructive indicator | `#FF6568` | `#E33F57` |
| Border | `#6F748033` | `#E4E4E4` |
| Input | `#545B6A33` | `#F1F1F1` |
| Focus ring | `#67787C` | `#000000` |

Eight-digit values retain their source alpha, including the dark border and input. The shared UI stylesheet owns these colors; workspace aliases reference the same semantic tokens. The navigation canvas uses background, the main pane uses card, raised menus/dialogs use popover, hover uses accent, conversation bubbles use muted, and the composer uses secondary. Authentication uses the same canvas/card/control tokens, including its original CSS illustration. No Bklit assets, layouts, or components were imported.

Small text on secondary/highlighted surfaces uses secondary foreground or the foreground at the same 90% opacity used by the reference's article text. Error text uses foreground with destructive tint/border/indicators so the exact destructive token does not become low-contrast small text. Existing success/approval indicators and the Google identity mark retain their semantic/brand colors; they are not neutral surface tokens.

Theme initialization lives at the application root, so direct signup/login/verification routes honor System, Light, and Dark preferences too. Settings keep the existing browser-local preference and System mode continues following OS changes. There are no dependencies, API changes, or migrations. Rollback restores the previous styles and root theme mounting together.

## Verification

The built application was checked against the running local API on October 10, 2026. All 18 shared core tokens matched the captured source declarations exactly in both themes, including alpha. Measured canvas RGB values were `(8, 9, 11)` in dark and `(245, 245, 245)` in light; card values were `(14, 15, 18)` and `(255, 255, 255)`. [Measured values and assertions](evidence/measured-colors.json) accompany the source capture.

Browser scenarios passed: switching Light/Dark through Settings, retaining Light after reload, retaining both saved themes on direct authentication verification visits, opening/cancelling project dialogs, and no horizontal overflow at 390 × 844. Desktop workspace logos remained visible in both themes. The dark sketch editor opened and closed successfully with themed chrome; drawing colors and the artboard remain user content. System preference was restored after testing. The centered authentication progress geometry remains unchanged.

Screenshots: [dark workspace](evidence/workspace-dark.jpg), [light workspace](evidence/workspace-light.jpg), [dark project dialog](evidence/project-dialog-dark.jpg), [light project dialog](evidence/project-dialog-light.jpg), [dark verification](evidence/verify-dark.jpg), and [light verification](evidence/verify-light.jpg). Verification screenshots intentionally exercise the missing-link error state without exposing login tokens.

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed |
| `pnpm check` | Passed |
| `pnpm typecheck` | Passed; 10 tasks |
| `pnpm test` | Passed; 17 tasks, 16 cached |
| `pnpm build` | Passed; 10 tasks, 8 cached |
| `pnpm --filter @reasonateai/web build` | Passed again after the final chrome refinements; this artifact was browser-verified |
| `pnpm audit --prod --audit-level high` | Passed; baseline two low and two moderate advisories, no high/critical findings |
| `git diff --cached \| docker run --rm -i zricethezav/gitleaks:latest stdin --redact --no-banner` | Passed; staged patch scanned, no leaks |

The default root test run's API suite passed 79 tests with 106 conditional skips because integration variables were absent. This appearance follow-up does not claim a fresh full identity integration run; [authentication operations](../operations/authentication.md) retains that earlier evidence. No authentication, authorization, persistence, or provider contract changed. An independent reviewer checked source mapping, theme lifecycle, readability, and control states; all actionable findings were resolved. No new dependency or migration is involved, and no performance improvement is claimed.
