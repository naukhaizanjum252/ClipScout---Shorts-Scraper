# DESIGN — shorts-scraper

preset:   high-end
audience: the ~40-person LookUp Media team who press "Get latest shorts" and take links away, plus Erik. Luka judges the rendered screen, not this file
palette:  #08080F #0F1020 #14162A #F3F4FA #9AA2BE #7C5CFF #22D3EE #34D399 #FBBF24 #64748B #FB7185
type:     Space Grotesk / Inter / JetBrains Mono (figures, handles, keys)
density:  comfortable — a list people scan and pull links out of, not a terminal
motion:   restrained but present — hover lift, glow, 150–250ms; nothing that delays a copy
avoid:    the industrial/terminal look this replaced — flat near-black, hairline grey rules, all-mono body text, square corners, zero depth

## The read

Erik, 2026-08-22: *"that shitty industrial look — something more modern and
gamey"*. The same ruling, the same client, the same people — so this tool takes
the impressions system whole rather than growing a second one. Anyone moving
between the two should not find a seam.

## The three things that carry it

**1. Depth instead of rules.** Panels are translucent surfaces with a 1px light
border and a soft shadow over a fixed deep aurora. Elevation separates things;
grey hairlines do not.

**2. Platform is the category, and a category is a word.** Erik, 2026-09-02:
*"come back with shorts over 500k views categorized by platform"*. So platform
is the grouping — a heading per platform, rows beneath it, highest views first —
and on a row it is a chip carrying the platform's **name**. It is not a hue.
There are five platforms and the tier ramp has three colours, and stretching it
would say the platforms are ranked, which they are not. The one dimension that
*is* ranked is views, and it already has the ramp.

**3. Violet is the interface, not a state.** `--accent` #7C5CFF is buttons,
focus rings, links and the active nav — the things you *do*. It never appears as
data, so a violet thing on screen is always something to press.

## The tier ramp carries whether a platform could be read

This replaces the curation state, which the product no longer has. The colour
now answers the question this repo cares about most: *did we actually read this
platform?* Every chip carries a word and a mark, never colour alone.

| Per-platform state | Colour | Reads as |
|---|---|---|
| Read | `--tier-high` #34D399 | we asked and it answered — this count is real |
| Nothing over the threshold | `--tier-mid` #FBBF24 | read fine; nothing cleared 500,000. An answer, not a failure |
| Not attempted | `--tier-low` #64748B | no adapter, or no key — deliberately quiet, and not a reject pile |
| Could not be read | `--signal` #FB7185 | it broke. A person has to go and fix something outside the app |

The bottom two rows are the whole reason the ramp exists here. **"Nothing over
the threshold" and "could not be read" must never look the same**, and neither
may look like an empty list. A platform that failed says so in words on the
screen, next to its heading, with the reason the adapter gave.

Because `--tier-low` at 11px measures 3.6:1 on a lit panel, chips and text use
`--tier-low-ink` #94A3B8 — same family, lifted — while the 3px row pip keeps the
true slate.

## Numbers

**View count is the figure that matters.** It is what the threshold is set
against and what the sort runs on, so it is the largest figure on a row and the
only one at full `--ink`; likes, comments and duration sit beside it in
`--muted`. All of them are JetBrains Mono with `tabular-nums`, right-aligned,
and never abbreviated in a list — 1,284,000 rather than 1.28M, because these get
compared down a column.

An unmeasured figure is an em dash and never a zero, and never a bare em dash
either: each one carries a title saying *why* that particular number is absent,
and the reasons differ per row and per platform — a source that does not publish
comment counts and a source that failed mid-read are different dashes. `.unknown`
gives the dash a dotted rule so it reads as something with more to say. Those
sentences are scars from shipped falsehoods — restyle them, never let them claim
more.

## Links

Every row carries two: the **post link**, which is permanent and is a link, and
a **download** control, which is a button. It is a button because there is
nothing to link to until it is pressed — a direct media URL is signed and expires
in minutes, so it is fetched on demand and never stored. A fresh URL may be
shown; it must never be styled to look like something that will still work
tomorrow.

## Accessibility

Lists stay real tables with `th scope` where they are tabular; the platform chip
keeps its word, the read-state chip keeps its word and its mark; focus-visible
keeps its violet ring. A glassy panel that fails contrast is worse than the flat
one it replaced, so `--faint` is carried a shade lighter than impressions ships
it — it labels columns here, not just chrome.
