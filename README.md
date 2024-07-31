# Wikibase Cloud Status (live)

A cron run from toolforge that populates CSV files with data around the status of wikibase.cloud.

Under the hood, this is performing checks on https://addshore-wikibase-cloud-status.wikibase.cloud/

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
wget https://raw.githubusercontent.com/addshore/wikibase-cloud-status/main/.lighttpd.conf -O .lighttpd.conf
webservice start
toolforge jobs run bootstrap-venv --command "cd $PWD && ./bootstrap_venv.sh" --image python3.11 --wait
```

Then you can update or start the cron with:

```sh
toolforge jobs delete pychecks
wget https://raw.githubusercontent.com/addshore/wikibase-cloud-status/main/py/index.py -O index.py
toolforge jobs run pychecks --command "pyvenv/bin/python index.py" --image python3.11 --continuous
wget https://raw.githubusercontent.com/addshore/wikibase-cloud-status/main/.lighttpd.conf -O .lighttpd.conf
webservice restart
```

You can check the status of the job and webservice with:

```sh
webservice status
toolforge jobs list
```
