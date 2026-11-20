# Wikibase Cloud Status (live)

A continuous Toolforge job that populates CSV files with data around the status of wikibase.cloud.

Under the hood, this is performing checks on https://addshore-wikibase-cloud-status.wikibase.cloud/

## Development

You can run the collector locally with:

```sh
python ./py/index.py 
```

## Deployment

The collector is a continuous job. The CSVs are served from `public_html` by a small Caddy webservice on Toolforge; it serves static files and does not require PHP.

Access:

```sh
ssh login.toolforge.org
become addshore-wikibase-cloud-status
```

Initial webservice setup (or migration from the old PHP webservice):

```sh
mkdir -p ~/public_html/data
wget https://raw.githubusercontent.com/addshore/wikibase-cloud-status/main/toolforge/setup-webservice.sh -O setup-webservice.sh
# If the old webservice is still running, stop it before starting the trixie service.
webservice stop
sh setup-webservice.sh start
```

Initial setup of the Python venv (can take ~5 mins):

```sh
toolforge jobs run bootstrap-venv --command "cd $PWD && ./bootstrap_venv.sh" --image python3.11 --wait
wget https://raw.githubusercontent.com/addshore/wikibase-cloud-status/main/py/index.py -O index.py
toolforge jobs run pychecks --command "pyvenv/bin/python index.py" --image python3.11 --continuous
```

To update the collector or restart the Caddy webservice:

```sh
wget https://raw.githubusercontent.com/addshore/wikibase-cloud-status/main/py/index.py -O index.py
toolforge jobs restart pychecks
sh setup-webservice.sh restart
```

You can check the status of the job and webservice with:

```sh
webservice status
toolforge jobs list
```
