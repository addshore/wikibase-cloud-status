# Wikibase Cloud Status (live)

A cron that runs on cloudflare workers to check the status of wikibase instances and update the status page.

A basic page that shows the status of the wikibase instances over the past 7 days.

## Development

Run locally with `npx wrangler dev --test-scheduled`

Make a requst to http://localhost:8787/__scheduled?cron=0+*+*+*+* and it should trigger the schedule

## Deployment

Deploy the cron with `npx wrangler deploy` (addshore needs to do this)

The page is deployed via github pages, so you can just push to the main branch to deploy the page.