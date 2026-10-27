# Project history

Explore the repository's recorded line changes by Conventional Commit type,
time, and release version. This chart is generated from the checked-out Git
history on every documentation build; it contains no editorial storyline.

[Open the interactive chart full screen](assets/project-history.html){ .md-button }

<iframe
  src="assets/project-history.html"
  title="Interactive Jarela commit history and accumulated LOC"
  width="100%"
  height="1100"
  loading="lazy"
  style="border: 0; border-radius: 12px;"
></iframe>

## Reading the chart

- Switch between daily, weekly, monthly and release-version buckets.
- Select line changes, additions, deletions, commit count or **Accumulated LOC**.
- Toggle commit types, filter the date range, and include or exclude lockfiles.
- Hover or focus chart bars for details, or export the filtered values to CSV.
- Summary cards describe changes within the date range, even in accumulated mode.

Accumulated LOC means running **added minus deleted text lines** from the
reachable non-merge history, with earlier history retained when zooming. It
includes docs, comments, blank lines, tests and generated text, not just source
code. It is not a direct measurement of historical checkouts: branch commits
are included and merge-only edits are excluded. Negative type balances appear
below zero; the tooltip and table give the net total.

Renames are counted as deleting and adding files, which can create large churn
spikes without a comparable net change. Release buckets use tag timestamps,
not proof that a commit was first shipped in that release. Only reachable app
version tags are included; workspace-package tags and untagged version bumps
are not releases in this view.

The embedded chart includes the full counting methodology and snapshot HEAD.
It uses no external libraries, analytics, or model calls. The generated data
contains commit types, dates, numeric statistics, abbreviated commit hashes,
and app version tags, but no author identities, commit subjects or file paths.
