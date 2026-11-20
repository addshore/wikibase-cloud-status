# Wikibase Cloud Status (live)

A continuous Toolforge job that populates CSV files with data around the status of wikibase.cloud.

Under the hood, this is performing checks on https://addshore-wikibase-cloud-status.wikibase.cloud/

## Development

You can run the collector locally with:

```sh
python ./py/index.py
```

The authenticated item-creation check uses `MW_USERNAME` and `MW_PASSWORD` from `.dev.vars`, `.env`, or the environment. Without credentials, the basic endpoint checks still run. Run the tests with:

```sh
python -m unittest discover -s tests -v
```

## Deployment

The collector is a continuous Toolforge job. The CSVs are served from `public_html` by a small Caddy webservice on Toolforge; it serves static files and does not require PHP.

The GitHub Actions workflow deploys **only the GitHub Pages site** from `public_html`. It does not deploy the collector or restart Toolforge jobs. Toolforge deployment below is manual and uses the configured Wikimedia CLI (`mw`) with access to the tool account.

Toolforge access:

```sh
mw toolforge shell --tool=addshore-wikibase-cloud-status
```

Initial webservice setup:

```sh
mw toolforge shell --tool=addshore-wikibase-cloud-status -- mkdir -p /data/project/addshore-wikibase-cloud-status/public_html/data
mw toolforge cp --tool=addshore-wikibase-cloud-status toolforge/setup-webservice.sh setup-webservice.sh
mw toolforge shell --tool=addshore-wikibase-cloud-status -- sh setup-webservice.sh start
```

When migrating an existing PHP webservice, stop it once before starting Caddy:

```sh
mw toolforge shell --tool=addshore-wikibase-cloud-status -- webservice stop
mw toolforge shell --tool=addshore-wikibase-cloud-status -- sh setup-webservice.sh start
```

Initial setup of the Python venv (can take ~5 mins):

```sh
mw toolforge cp --tool=addshore-wikibase-cloud-status py/bootstrap_venv.sh bootstrap_venv.sh
mw toolforge job run bootstrap-venv --tool=addshore-wikibase-cloud-status --command "cd /data/project/addshore-wikibase-cloud-status && bash bootstrap_venv.sh" --image python3.11
mw toolforge cp --tool=addshore-wikibase-cloud-status py/index.py index.py
mw toolforge job run pychecks --tool=addshore-wikibase-cloud-status --command "cd /data/project/addshore-wikibase-cloud-status && pyvenv/bin/python index.py" --image python3.11 --continuous
```

To update the collector:

```sh
mw toolforge cp --tool=addshore-wikibase-cloud-status py/index.py index.py
mw toolforge job restart pychecks --tool=addshore-wikibase-cloud-status
```

If Python dependencies change, stop `pychecks` and rerun the venv bootstrap as a one-off job using the `python3.11` image before starting the collector again. Do not install into `pyvenv` from an interactive shell with a different Python version.

To update the Caddy webservice configuration:

```sh
mw toolforge cp --tool=addshore-wikibase-cloud-status toolforge/setup-webservice.sh setup-webservice.sh
mw toolforge shell --tool=addshore-wikibase-cloud-status -- sh setup-webservice.sh restart
```

Set `MW_USERNAME` and `MW_PASSWORD` as Toolforge environment variables for the authenticated item-creation check; never commit credentials. Without them, the collector still runs the basic endpoint checks.

Check job and webservice status with:

```sh
mw toolforge shell --tool=addshore-wikibase-cloud-status -- webservice status
mw toolforge job list --tool=addshore-wikibase-cloud-status
```
