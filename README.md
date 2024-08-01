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
mkdir -p ~/www/static
mkdir -p ~/public_html
wget https://raw.githubusercontent.com/addshore/wikibase-cloud-status/main/.lighttpd.conf -O .lighttpd.conf
wget https://raw.githubusercontent.com/addshore/wikibase-cloud-status/main/public_html/index.html -O public_html/index.html
wget https://raw.githubusercontent.com/addshore/wikibase-cloud-status/main/public_html/tf.js -O public_html/tf.js
webservice start
# todo wget venve
toolforge jobs run bootstrap-venv --command "cd $PWD && ./bootstrap_venv.sh" --image python3.11 --wait
wget https://raw.githubusercontent.com/addshore/wikibase-cloud-status/main/py/index.py -O index.py
toolforge jobs run pychecks --command "pyvenv/bin/python index.py" --image python3.11 --continuous
```

Then you can update or start the cron with:

```sh
wget https://raw.githubusercontent.com/addshore/wikibase-cloud-status/main/py/index.py -O index.py
toolforge jobs restart pychecks
wget https://raw.githubusercontent.com/addshore/wikibase-cloud-status/main/.lighttpd.conf -O .lighttpd.conf
webservice restart
```

You can check the status of the job and webservice with:

```sh
webservice status
toolforge jobs list
```
