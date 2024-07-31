# Wikibase Cloud Status (live)

A cron run from toolforge that populates CSV files with data around the status of wikibase.cloud.

## Development

You can run the cron locally with:

```sh
python ./py/index.py 
```

## Deployment

The code is deployed to the `addshore-wikidata-cloud-status` tool.

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
wget https://raw.githubusercontent.com/addshore/wikibase-cloud-status/main/py/index.py -O index.py
toolforge jobs run pychecks --command "pyvenv/bin/python index.py" --image python3.11 --continuous
```

You can check the status of the job with:

```sh
toolforge jobs list
```
