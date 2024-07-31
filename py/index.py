import datetime
import time
import os
from wikidataintegrator import wdi_core, wdi_login
from dotenv import load_dotenv
import threading
import requests

action_api = "https://addshore-wikibase-cloud-status.wikibase.cloud/w/api.php"
sparql_endpoint = "https://addshore-wikibase-cloud-status.wikibase.cloud/query/sparql"
ua = "addshore-wikibase-cloud-status/py"

basic_checks = {
    'cloud_home': "https://www.wikibase.cloud/",
    'wb_item': "https://addshore-wikibase-cloud-status.wikibase.cloud/wiki/Item:Q1",
    'cradle': "https://addshore-wikibase-cloud-status.wikibase.cloud/tools/cradle/",
    'quickstatements': "https://addshore-wikibase-cloud-status.wikibase.cloud/tools/quickstatements/",
    # skipped query basic check as, as we time this as part of another check
    # 'query': "https://addshore-wikibase-cloud-status.wikibase.cloud/query/",
}

# Load username and password from ./../.dev.vars if it exists (MW_USERNAME and MW_PASSWORD)
# Otherwise load from the environment
if os.path.exists("./.dev.vars"):
    load_dotenv(dotenv_path="./.dev.vars")
if os.path.exists("./.env"):
    load_dotenv()
username = os.getenv("MW_USERNAME")
password = os.getenv("MW_PASSWORD")
if not username or not password:
    raise ValueError("MW_USERNAME and MW_PASSWORD must be set in the environment or in a .dev.vars file")

# Records data to the relevant CSV file
# check_name: The name of the check
# check_start_time: The time the check was started
# data: The data to record (in csv format)
def record_data( check_name, check_start_time, data ):
    log_data(check_name, check_start_time, data)
    path = "./public_html/data/{}/{:02d}/{:02d}".format(check_start_time.year, check_start_time.month, check_start_time.day)
    os.makedirs(path, exist_ok=True)
    with open("{}/{}.csv".format(path, check_name), "a") as f:
        f.write("{},{}\n".format(check_start_time.strftime("%H:%M:%S"), data))

def log_data( check_name, check_start_time, txt ):
    print("{}@{}: {}".format(check_name, check_start_time, txt))

def basic_check(check_name, url):
    check_start_time = datetime.datetime.now()
    req = requests.get(url, headers={ 'User-Agent': ua })
    request_done_time = datetime.datetime.now()
    request_time = request_done_time - check_start_time
    is200 = 1 if req.status_code == 200 else 0
    record_data(check_name, check_start_time, "{},{}".format(int(request_time.total_seconds() * 1000), is200))
    log_data(check_name, check_start_time, "Request took {} ms".format(request_time.total_seconds()*1000))

def elastic_check():
    url = "https://addshore-wikibase-cloud-status.wikibase.cloud/w/index.php?search=haslabel%3Aen+Q6"
    check_start_time = datetime.datetime.now()
    req = requests.get(url, headers={ 'User-Agent': ua })
    request_done_time = datetime.datetime.now()
    request_time = request_done_time - check_start_time
    is200 = 1 if req.status_code == 200 else 0
    # check conrent for "WDQS-time: 2024-07-31 19:28:39.226451"
    content = req.content.decode('utf-8')
    found = 1 if "WDQS-time: 2024-07-31 19:28:39.226451" in content else 0
    record_data("elastic_check", check_start_time, "{},{},{}".format(int(request_time.total_seconds() * 1000), is200, found))
    log_data("elastic_check", check_start_time, "Request took {} ms".format(request_time.total_seconds()*1000))

# TODO could checlk maxlag, except it always says sql-mariadb-primary.default.svc.cluster.local currently
# so mw will not tell us afaik?!

def query_check():
    check_start_time = datetime.datetime.now()
    check_name = "query_check"
    login = wdi_login.WDLogin(user=username, pwd=password, mediawiki_api_url=action_api)
    item = wdi_core.WDItemEngine(data=[], mediawiki_api_url=action_api)
    timestamp = datetime.datetime.now()
    label = "Q-time: {}".format(timestamp)
    item.set_label(label, lang="en")
    pre_write_time = datetime.datetime.now()
    item.write(login)
    post_write_time = datetime.datetime.now()
    write_time = post_write_time - pre_write_time
    record_data("wb_item_create_time", check_start_time, "{}".format(int(write_time.total_seconds() * 1000)))
    item_id = item.wd_item_id
    written_time = datetime.datetime.now()
    log_data(check_name, check_start_time, "Item {} created at {}".format(item_id, written_time))

    # make a query to the sparql endpoint every 1 second, looking for the item
    query = """
    SELECT ?item WHERE {
        ?item rdfs:label """ + '"' + label + '"' + """@en.
        }
        """
    sleep_time = 1
    max_sleep_time = 60
    counter = 0
    found = 0
    while True:
        pre_query_time = datetime.datetime.now()
        res = wdi_core.WDItemEngine.execute_sparql_query(query, endpoint=sparql_endpoint)
        post_query_time = datetime.datetime.now()
        if counter == 0:
            query_time = post_query_time - pre_query_time
            record_data("query_response_time", check_start_time, "{}".format(int(query_time.total_seconds() * 1000)))
        if len(res['results']['bindings']) > 0:
            log_data(check_name, check_start_time, "Item {} found at {}".format(item_id, datetime.datetime.now()))
            found = 1
            break
        else:
            time.sleep(sleep_time)
            counter += 1
            # if counter is at 24 hours, give up
            if counter == 60*60*24:
                log_data(check_name, check_start_time, "Giving up after 24 hours")
                break
            new_sleep_time = min(sleep_time * max((counter//60), 1), max_sleep_time)
            if new_sleep_time != sleep_time:
                log_data(check_name, check_start_time, "Sleep time increased to {}".format(new_sleep_time))
                sleep_time = new_sleep_time

    # record the time of the find
    found_time = datetime.datetime.now()
    # record the time between the two
    time_between = found_time - written_time
    record_data("query_create_time", check_start_time, "{},{}".format(int(time_between.total_seconds() * 1000), found))

# Do the checks every 60 seconds
while True:
    active_threads = threading.active_count() - 1
    if active_threads > 100:
        print("Too many active threads, killing the process")
        exit(1)
    print("Starting checks at {} with {} current threads".format(datetime.datetime.now(), active_threads))
    thread = threading.Thread(target=query_check)
    thread.start()
    thread = threading.Thread(target=elastic_check)
    thread.start()
    for check_name, url in basic_checks.items():
        thread = threading.Thread(target=basic_check, args=(check_name, url))
        thread.start()
    time.sleep(60)