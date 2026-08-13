# Seeds

## reddit-page-mappings.csv

Page mappings for the Reddit traffic tab. Upload it through
**Traffic → Mappings → Upload Page Mappings** (it uses the importer's 7-column
format, so it round-trips with the "Download CSV" button on that screen).

The importer *inserts* rows — it does not upsert — so uploading twice creates
duplicates. Check the Page Mappings table for existing `r/…` rows first.

### How the mediums were chosen

Every value came from the live `traffic_daily` table, so the mediums match what
GA4 actually reports rather than what the tagging convention intended:

- **Per-community rows** (`r/CFB_v2`, `r/SportsGossips`, …) cover the UTM-tagged
  posting that ran Feb–Jun 2026, where `utm_medium` is the subreddit name.
  Spelling variants and typos are folded into one page (`cfbv2` + `cfbv`,
  `nflmemeswars` + `nflmemeswar`, `sportsgossips` + `sportsgossip` +
  `sportsgossipe`). Casing variants need no entry — the lookup lowercases both
  sides — but underscore variants do (`golfunfiltered` vs `golf_unfiltered`).
- **`Reddit General (catch-all tag)`** covers the tags that carry no community
  (`es_reddit_general` and its three truncated typos, plus the generic
  `subreddit` / `reddit` mediums).
- **`Organic Referral`** covers untagged traffic arriving from `*.reddit.com`,
  which GA4 records as `medium = referral`. Since July 2026 this is the bulk of
  Reddit traffic — UTM tagging of Reddit links stopped around end of June, so the
  volume moved from the tagged rows to here rather than disappearing.

Reddit strips the `/r/<name>` path from its referrer, so organic traffic cannot
be attributed to a specific community — verified against the 2026-08-12 event
shard, where 18,575 of 18,608 Reddit sessions had no community in
`page_referrer`. `Organic Referral` is therefore one bucket by necessity, not by
choice.
