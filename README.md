
Run locally with `npx wrangler dev --test-scheduled`

Make a requst to http://localhost:8787/__scheduled?cron=0+*+*+*+* and itshould trigger the schedule

Deploy with `npx wrangler deploy`