import csv
import json
import logging
import os
import random
import signal
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

import requests
from dotenv import load_dotenv

ACTION_API = "https://addshore-wikibase-cloud-status.wikibase.cloud/w/api.php"
SPARQL_ENDPOINT = "https://addshore-wikibase-cloud-status.wikibase.cloud/query/sparql"
SEARCH_URL = "https://addshore-wikibase-cloud-status.wikibase.cloud/w/index.php"
ENTITY_BASE = "https://addshore-wikibase-cloud-status.wikibase.cloud/entity/"
USER_AGENT = "addshore-wikibase-cloud-status/py"

CHECK_INTERVAL_SECONDS = 60
EDIT_INTERVAL_SECONDS = 5 * 60
PROPAGATION_TIMEOUT_SECONDS = 15 * 60
HTTP_TIMEOUT = (3.05, 8.0)  # connect timeout, read timeout
READ_REQUEST_ATTEMPTS = 2
MAX_RETRY_DELAY_SECONDS = 4
MAX_POLL_DELAY_SECONDS = 30
RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}

DATA_DIR = Path(os.getenv("DATA_DIR", str(Path.cwd() / "public_html" / "data")))
RECORD_LOCK = threading.Lock()
LOGGER = logging.getLogger("wikibase_cloud_status")

BASIC_CHECKS = {
    "cloud_home": "https://www.wikibase.cloud/",
    "cloud_api": "https://www.wikibase.cloud/api/wiki?page=1&per_page=1",
    "wb_item": "https://addshore-wikibase-cloud-status.wikibase.cloud/wiki/Item:Q1",
    "cradle": "https://addshore-wikibase-cloud-status.wikibase.cloud/tools/cradle/",
    "quickstatements": "https://addshore-wikibase-cloud-status.wikibase.cloud/tools/quickstatements/",
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def load_credentials() -> tuple[str | None, str | None]:
    """Load local development vars without requiring them for basic checks."""
    for env_file in (Path.cwd() / ".dev.vars", Path.cwd() / ".env"):
        if env_file.is_file():
            load_dotenv(dotenv_path=env_file, override=False)
    return os.getenv("MW_USERNAME"), os.getenv("MW_PASSWORD")


def record_data(
    check_name: str,
    recorded_at: datetime,
    values: Sequence[object],
    data_dir: Path = DATA_DIR,
) -> None:
    """Append a legacy-compatible, headerless row to daily and weekly CSVs."""
    iso_year, iso_week, _ = recorded_at.isocalendar()
    timestamp = recorded_at.strftime("%H:%M:%S")
    row = [timestamp, *(str(value) for value in values)]
    daily_path = data_dir / f"{recorded_at.year:04d}/{recorded_at.month:02d}/{recorded_at.day:02d}/{check_name}.csv"
    weekly_path = data_dir / f"{iso_year:04d}/{iso_week:02d}/{check_name}.csv"

    with RECORD_LOCK:
        for path in (daily_path, weekly_path):
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8", newline="") as output:
                csv.writer(output, lineterminator="\n").writerow(row)

    LOGGER.info("%s@%s: %s", check_name, recorded_at.isoformat(), ",".join(row[1:]))


def request_with_retry(
    session: requests.Session,
    method: str,
    url: str,
    *,
    retryable: bool = False,
    attempts: int = 1,
    deadline: float | None = None,
    **kwargs: Any,
) -> requests.Response:
    """Make a time-limited request; only retry operations declared safe to retry."""
    attempts = max(1, attempts)
    headers = {"User-Agent": USER_AGENT}
    headers.update(kwargs.pop("headers", {}))
    kwargs["headers"] = headers
    kwargs["timeout"] = HTTP_TIMEOUT

    for attempt in range(attempts):
        if deadline is not None and time.monotonic() >= deadline:
            raise requests.Timeout("request deadline exceeded")

        try:
            response = session.request(method, url, **kwargs)
            if (
                retryable
                and response.status_code in RETRYABLE_STATUS_CODES
                and attempt < attempts - 1
            ):
                delay = min(2**attempt, MAX_RETRY_DELAY_SECONDS)
                if deadline is not None and time.monotonic() + delay >= deadline:
                    response.raise_for_status()
                LOGGER.warning("HTTP %s from %s; retrying in %s seconds", response.status_code, url, delay)
                response.close()
                time.sleep(delay)
                continue

            response.raise_for_status()
            return response
        except requests.RequestException as error:
            response = getattr(error, "response", None)
            retryable_error = response is None or response.status_code in RETRYABLE_STATUS_CODES
            if not retryable or not retryable_error or attempt >= attempts - 1:
                raise

            delay = min(2**attempt, MAX_RETRY_DELAY_SECONDS)
            if deadline is not None and time.monotonic() + delay >= deadline:
                raise
            LOGGER.warning("Request to %s failed (%s); retrying in %s seconds", url, error, delay)
            time.sleep(delay)

    raise requests.Timeout("request attempts exhausted")


def request_json(
    session: requests.Session,
    method: str,
    url: str,
    *,
    retryable: bool = False,
    attempts: int = 1,
    deadline: float | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    response = request_with_retry(
        session,
        method,
        url,
        retryable=retryable,
        attempts=attempts,
        deadline=deadline,
        **kwargs,
    )
    payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError("API response was not a JSON object")
    if "error" in payload:
        error = payload["error"]
        raise RuntimeError(f"MediaWiki API error: {error.get('code', 'unknown')}: {error.get('info', '')}")
    return payload


def login_for_edit(session: requests.Session, username: str, password: str) -> str:
    login_token_response = request_json(
        session,
        "GET",
        ACTION_API,
        retryable=True,
        attempts=READ_REQUEST_ATTEMPTS,
        params={"action": "query", "meta": "tokens", "type": "login", "format": "json"},
    )
    login_token = login_token_response["query"]["tokens"]["logintoken"]
    login_response = request_json(
        session,
        "POST",
        ACTION_API,
        retryable=True,
        attempts=READ_REQUEST_ATTEMPTS,
        data={
            "action": "login",
            "lgname": username,
            "lgpassword": password,
            "lgtoken": login_token,
            "format": "json",
        },
    )
    if login_response.get("login", {}).get("result") != "Success":
        result = login_response.get("login", {}).get("result", "unknown")
        raise RuntimeError(f"MediaWiki login failed: {result}")

    csrf_response = request_json(
        session,
        "GET",
        ACTION_API,
        retryable=True,
        attempts=READ_REQUEST_ATTEMPTS,
        params={"action": "query", "meta": "tokens", "format": "json"},
    )
    return csrf_response["query"]["tokens"]["csrftoken"]


def create_test_item(session: requests.Session, csrf_token: str, label: str) -> str:
    """Create exactly one item. Do not retry this non-idempotent request."""
    payload = {"labels": {"en": {"language": "en", "value": label}}}
    response = request_json(
        session,
        "POST",
        ACTION_API,
        data={
            "action": "wbeditentity",
            "new": "item",
            "data": json.dumps(payload),
            "token": csrf_token,
            "format": "json",
            "maxlag": 5,
        },
    )
    item_id = response.get("entity", {}).get("id")
    if not item_id:
        raise RuntimeError("MediaWiki API did not return the created item ID")
    return item_id


def basic_check(check_name: str, url: str, data_dir: Path = DATA_DIR) -> int:
    started_at = utc_now()
    started = time.monotonic()
    status = 0
    try:
        response = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=HTTP_TIMEOUT)
        status = int(response.status_code == 200)
        if not status:
            LOGGER.warning("%s returned HTTP %s", check_name, response.status_code)
    except requests.RequestException as error:
        LOGGER.warning("%s request failed: %s", check_name, error)

    duration_ms = int((time.monotonic() - started) * 1000)
    record_data(check_name, started_at, (duration_ms, status), data_dir)
    return status


def item_in_query_service(session: requests.Session, item_id: str, deadline: float) -> bool:
    response = request_json(
        session,
        "GET",
        SPARQL_ENDPOINT,
        retryable=True,
        attempts=READ_REQUEST_ATTEMPTS,
        deadline=deadline,
        params={
            "query": f"ASK {{ <{ENTITY_BASE}{item_id}> ?predicate ?value }}",
            "format": "json",
        },
    )
    if "boolean" not in response:
        raise ValueError("SPARQL response did not contain an ASK result")
    return bool(response["boolean"])


def item_in_search_index(session: requests.Session, item_id: str, label: str, deadline: float) -> bool:
    response = request_with_retry(
        session,
        "GET",
        SEARCH_URL,
        retryable=True,
        attempts=READ_REQUEST_ATTEMPTS,
        deadline=deadline,
        params={"search": f"haslabel:en '{label}'"},
    )
    return f"/wiki/Item:{item_id}" in response.text


def poll_for_item(
    session: requests.Session,
    item_id: str,
    label: str,
    written_at: datetime,
    written_monotonic: float,
    *,
    check_elastic: bool,
    data_dir: Path = DATA_DIR,
    timeout_seconds: int = PROPAGATION_TIMEOUT_SECONDS,
    stop_event: threading.Event | None = None,
) -> tuple[bool, bool]:
    """Poll propagation with a wall-clock deadline and bounded backoff."""
    deadline = time.monotonic() + timeout_seconds
    query_found = False
    elastic_found = not check_elastic
    query_response_recorded = False
    elastic_response_recorded = False
    delay = 1

    while not (query_found and elastic_found):
        if stop_event is not None and stop_event.is_set():
            break
        if time.monotonic() >= deadline:
            break

        if not query_found:
            request_started_at = utc_now()
            request_started = time.monotonic()
            request_ok = 0
            try:
                query_found = item_in_query_service(session, item_id, deadline)
                request_ok = 1
            except Exception as error:
                LOGGER.warning("Query service check for %s failed: %s", item_id, error)
            if not query_response_recorded:
                duration_ms = int((time.monotonic() - request_started) * 1000)
                record_data("query_response_time", request_started_at, (duration_ms, request_ok), data_dir)
                query_response_recorded = True
            if query_found:
                found_at = utc_now()
                elapsed_ms = int((time.monotonic() - written_monotonic) * 1000)
                record_data("query_create_time", found_at, (elapsed_ms, 1), data_dir)
                LOGGER.info("Item %s appeared in the query service", item_id)

        if check_elastic and not elastic_found and time.monotonic() < deadline:
            request_started_at = utc_now()
            request_started = time.monotonic()
            request_ok = 0
            try:
                elastic_found = item_in_search_index(session, item_id, label, deadline)
                request_ok = 1
            except Exception as error:
                LOGGER.warning("Search index check for %s failed: %s", item_id, error)
            if not elastic_response_recorded:
                duration_ms = int((time.monotonic() - request_started) * 1000)
                record_data("elastic_response_time", request_started_at, (duration_ms, request_ok), data_dir)
                elastic_response_recorded = True
            if elastic_found:
                found_at = utc_now()
                elapsed_ms = int((time.monotonic() - written_monotonic) * 1000)
                record_data("elastic_create_time", found_at, (elapsed_ms, 1), data_dir)
                LOGGER.info("Item %s appeared in the search index", item_id)

        if query_found and elastic_found:
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        wait_seconds = min(delay, remaining)
        if stop_event is not None:
            if stop_event.wait(wait_seconds):
                break
        else:
            time.sleep(wait_seconds)
        delay = min(delay * 2, MAX_POLL_DELAY_SECONDS)

    if stop_event is not None and stop_event.is_set():
        return query_found, elastic_found

    elapsed_ms = int((time.monotonic() - written_monotonic) * 1000)
    recorded_at = utc_now()
    if not query_found:
        record_data("query_create_time", recorded_at, (elapsed_ms, 0), data_dir)
        LOGGER.warning("Item %s did not appear in the query service before the deadline", item_id)
    if check_elastic and not elastic_found:
        record_data("elastic_create_time", recorded_at, (elapsed_ms, 0), data_dir)
        LOGGER.warning("Item %s did not appear in the search index before the deadline", item_id)
    return query_found, elastic_found


def edit_check(
    username: str,
    password: str,
    *,
    data_dir: Path = DATA_DIR,
    propagation_timeout_seconds: int = PROPAGATION_TIMEOUT_SECONDS,
    session_factory: Any = requests.Session,
    stop_event: threading.Event | None = None,
) -> tuple[bool, bool]:
    """Create one test item and measure its appearance in downstream services."""
    session = session_factory()
    check_started_at = utc_now()
    write_started_at = check_started_at
    write_started = time.monotonic()
    try:
        try:
            csrf_token = login_for_edit(session, username, password)
            label = f"Q-time: {utc_now().isoformat(timespec='microseconds')}"
            write_started_at = utc_now()
            write_started = time.monotonic()
            item_id = create_test_item(session, csrf_token, label)
        except Exception:
            duration_ms = int((time.monotonic() - write_started) * 1000)
            record_data("wb_item_create_time", write_started_at, (duration_ms, 0), data_dir)
            LOGGER.exception("Unable to create the Wikibase test item; a timed-out write may have an uncertain outcome")
            return False, False

        write_duration_ms = int((time.monotonic() - write_started) * 1000)
        record_data("wb_item_create_time", write_started_at, (write_duration_ms, 1), data_dir)
        written_at = utc_now()
        written_monotonic = time.monotonic()
        LOGGER.info("Created test item %s", item_id)
        return poll_for_item(
            session,
            item_id,
            label,
            written_at,
            written_monotonic,
            check_elastic=True,
            data_dir=data_dir,
            timeout_seconds=propagation_timeout_seconds,
            stop_event=stop_event,
        )
    finally:
        session.close()


def _run_edit_check(username: str, password: str, data_dir: Path, stop_event: threading.Event) -> None:
    try:
        edit_check(username, password, data_dir=data_dir, stop_event=stop_event)
    except Exception:
        LOGGER.exception("Unexpected error in item propagation check")


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    username, password = load_credentials()
    if not username or not password:
        LOGGER.error("MW_USERNAME/MW_PASSWORD missing; continuing with endpoint checks only")

    data_dir = Path(os.getenv("DATA_DIR", str(DATA_DIR)))
    stop_event = threading.Event()

    def request_shutdown(signum: int, _frame: Any) -> None:
        LOGGER.info("Received signal %s; shutting down after the current check", signum)
        stop_event.set()

    signal.signal(signal.SIGINT, request_shutdown)
    signal.signal(signal.SIGTERM, request_shutdown)

    action_thread: threading.Thread | None = None
    next_action_check = time.monotonic()
    while not stop_event.is_set():
        cycle_started = time.monotonic()
        LOGGER.info("Starting endpoint check cycle")
        for check_name, url in BASIC_CHECKS.items():
            if stop_event.is_set():
                break
            try:
                basic_check(check_name, url, data_dir)
            except Exception:
                LOGGER.exception("Unable to record endpoint check %s", check_name)

        now = time.monotonic()
        if username and password and now >= next_action_check and not stop_event.is_set():
            if action_thread is None or not action_thread.is_alive():
                action_thread = threading.Thread(
                    target=_run_edit_check,
                    args=(username, password, data_dir, stop_event),
                    name="item-propagation-check",
                    daemon=True,
                )
                action_thread.start()
            else:
                LOGGER.warning("Skipping item check; previous item check is still running")
            next_action_check = now + EDIT_INTERVAL_SECONDS

        elapsed = time.monotonic() - cycle_started
        wait_seconds = max(0, CHECK_INTERVAL_SECONDS - elapsed) + random.uniform(0, 5)
        stop_event.wait(wait_seconds)


if __name__ == "__main__":
    main()
