# Wikibase Cloud Status (live)

A cron that runs on cloudflare workers to check the status of wikibase instances and update the status page.

A basic page that shows the status of the wikibase instances over the past 7 days.

![](https://i.imgur.com/4t5q9Wx.png)

## Future thoughts

Currently the data API only allows access of the last 7 days of data. (And that is also a large ammount for 1 request).

The whole page should become more dynamic, allow you to reshap the data etc, but more importantly, it should allow you to select a date range and see the data for that date range.

This was we could strat on a cheap (last 24 h view), but also cache the days of data that are entirely decided for much longer periods of time (rather than the current 60 seconds).

## Development

Run everything locally with `npm run dev`.

Note: by default:
 - the worker does not persist data, only echos it to the console for you to see
 - the html page uses the live data from the live site

Make a requst to http://localhost:8787/__scheduled?cron=0+*+*+*+* to trigger the cron for the worker.

## Deployment

Deploy the cron with `npx wrangler deploy` (addshore needs to do this)

The page is deployed via github pages, so you can just push to the main branch to deploy the page.

**Toolforge**

Access:

```sh
ssh login.toolforge.org
become addshore-wikidata-cloud-status
```

Initial setup of python venv (can take ~5 mins):

```sh
toolforge jobs run bootstrap-venv --command "cd $PWD && ./bootstrap_venv.sh" --image python3.11 --wait
```

Then you can update or start the cron with:

```sh
toolforge jobs delete pychecks
wget https://raw.githubusercontent.com/addshore/wikibase-cloud-status/main/toolforge/py/index.py
toolforge jobs run pychecks --command pyvenv/bin/python index.py --image python3.11 --continuous
```