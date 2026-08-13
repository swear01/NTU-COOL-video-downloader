# Plan

## In Progress

- Finish the Chrome Web Store publishing setup (one-time, manual):
  1. Add `cws-publisher@gemini-github-review-503915.iam.gserviceaccount.com`
     in the CWS Developer Dashboard under Account.
  2. Set `CWS_PUBLISHER_ID` secret in the `cws-publish` environment.
  3. Confirm 2-step verification on the publisher Google account.
  Until then the `store` job warns and skips on each tag push.

## Next Up

- Ship v1.2.1 to the store once the setup above is complete (the GitHub
  release v1.2.1 already exists; the next `v*` tag will upload+publish).
