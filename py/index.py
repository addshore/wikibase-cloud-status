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

def edit_check():
    check_start_time = datetime.datetime.now()
    check_name = "edit_check"
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
    foundQueryService = 0
    foundElastic = 0
    queryCheckDone = False
    elasticCheckDone = False
    queriesTookHowLong = 0 # How long the queries took in total, to be used to dynamically increase sleep time
    while queryCheckDone is False or elasticCheckDone is False:
        # Exit, or sleep, if we are looping
        if counter != 0:
            # Give up after 12 hours
            if counter >= 60*60*12:
                log_data(check_name, check_start_time, "Giving up after 12 hours")
                break
            # Increase sleep time every 15 seconds, by an additional second, up to a max of 60 seconds
            # So:
            # 0-15 seconds = 1 second
            # 15-30 seconds = 2 seconds
            # 30-45 seconds = 3 seconds
            # 45-60 seconds = 4 seconds
            # etc, so if we have been waiting for 14min, we will be sleeping for the max of 60 seconds
            # Also add the time the queries took to the sleep time each loop, as a dynamic way to increase sleep time based on load
            new_sleep_time = min(max((counter//15), 1), max_sleep_time) + queriesTookHowLong
            if new_sleep_time > sleep_time:
                log_data(check_name, check_start_time, "Sleep time increased to {}".format(new_sleep_time))
                sleep_time = new_sleep_time
            # Actually sleep
            time.sleep(sleep_time)
        counter += 1
        queriesTookHowLong = 0

        # Check in the query service
        if queryCheckDone is False:
            pre_query_time = datetime.datetime.now()
            res = wdi_core.WDItemEngine.execute_sparql_query(query, endpoint=sparql_endpoint)
            post_query_time = datetime.datetime.now()
            queriesTookHowLong += (post_query_time - pre_query_time).total_seconds()
            if counter == 1:
                query_time = post_query_time - pre_query_time
                record_data("query_response_time", check_start_time, "{}".format(int(query_time.total_seconds() * 1000)))
            if len(res['results']['bindings']) > 0:
                log_data(check_name, check_start_time, "Item {} found in query service at {}".format(item_id, datetime.datetime.now()))
                foundQueryService = 1
                foundQueryServiceTime = datetime.datetime.now()
                foundQueryServiceTimeDelta = foundQueryServiceTime - written_time
                record_data("query_create_time", check_start_time, "{},{}".format(int(foundQueryServiceTimeDelta.total_seconds() * 1000), foundQueryService))
                queryCheckDone = True

        # Check in the elastic search index
        if elasticCheckDone is False:
            url = "https://addshore-wikibase-cloud-status.wikibase.cloud/w/index.php?search=haslabel%3Aen+'{}'".format(label)
            pre_elastic_time = datetime.datetime.now()
            req = requests.get(url, headers={ 'User-Agent': ua })
            post_elastic_time = datetime.datetime.now()
            queriesTookHowLong += (post_elastic_time - pre_elastic_time).total_seconds()
            if counter == 1:
                elastic_time = post_elastic_time - pre_elastic_time
                record_data("elastic_response_time", check_start_time, "{}".format(int(elastic_time.total_seconds() * 1000)))
            if req.status_code == 200:
                # Check that /wiki/Item:item_id is in the response
                if "/wiki/Item:{}".format(item_id) in req.text:
                    log_data(check_name, check_start_time, "Item {} found in elastic at {}".format(item_id, datetime.datetime.now()))
                    foundElastic = 1
                    foundElasticTime = datetime.datetime.now()
                    foundElasticTimeDelta = foundElasticTime - written_time
                    record_data("elastic_create_time", check_start_time, "{},{}".format(int(foundElasticTimeDelta.total_seconds() * 1000), foundElastic))
                    elasticCheckDone = True

    time_since_written = datetime.datetime.now() - written_time
    if foundQueryService == 0:
        log_data(check_name, check_start_time, "Item {} not found in query service".format(item_id))
        record_data("query_create_time", check_start_time, "{},{}".format(int(time_since_written.total_seconds() * 1000), foundQueryService))
    if foundElastic == 0:
        log_data(check_name, check_start_time, "Item {} not found in elastic".format(item_id))
        record_data("elastic_create_time", check_start_time, "{},{}".format(int(time_since_written.total_seconds() * 1000), foundElastic))

# Do the checks every 60 seconds
while True:
    active_threads = threading.active_count() - 1
    # Preventative measure to stop the process from getting out of control if something goes wrong or services are overloaded
    # But this should mostly be handeled by the backoffs in any looping checks
    # TODO consider adding timeouts in the requests? but really cloud should kick us off at a reasonable time
    if active_threads > 69:
        print("Too many active threads, killing the process")
        exit(1)
    print("Starting checks at {} with {} current threads".format(datetime.datetime.now(), active_threads))
    thread = threading.Thread(target=edit_check)
    thread.start()
    # thread = threading.Thread(target=elastic_check)
    # thread.start()
    for check_name, url in basic_checks.items():
        thread = threading.Thread(target=basic_check, args=(check_name, url))
        thread.start()
    time.sleep(60)