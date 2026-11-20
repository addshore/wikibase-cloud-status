import csv
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock, patch

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py"))
import index as collector  # noqa: E402


def daily_csvs(data_dir: Path, name: str) -> list[Path]:
    return [
        path for path in data_dir.rglob(f"{name}.csv")
        if len(path.relative_to(data_dir).parts) == 4
    ]


class RecordDataTests(unittest.TestCase):
    def test_writes_compatible_daily_and_iso_weekly_rows(self) -> None:
        recorded_at = datetime(2021, 1, 1, 12, 34, 56, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as temporary_directory:
            data_dir = Path(temporary_directory)
            collector.record_data("cloud_home", recorded_at, (125, 1), data_dir)

            daily_file = data_dir / "2021/01/01/cloud_home.csv"
            weekly_file = data_dir / "2020/53/cloud_home.csv"
            with daily_file.open(encoding="utf-8") as source:
                self.assertEqual(next(csv.reader(source)), ["12:34:56", "125", "1"])
            with weekly_file.open(encoding="utf-8") as source:
                self.assertEqual(next(csv.reader(source)), ["12:34:56", "125", "1"])

    def test_timeout_records_a_failed_sample(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            data_dir = Path(temporary_directory)
            with patch.object(collector.requests, "get", side_effect=requests.Timeout("read timed out")):
                status = collector.basic_check("cloud_home", "https://example.test/", data_dir)

            self.assertEqual(status, 0)
            daily_files = daily_csvs(data_dir, "cloud_home")
            self.assertEqual(len(daily_files), 1)
            with daily_files[0].open(encoding="utf-8") as source:
                row = next(csv.reader(source))
            self.assertEqual(row[-1], "0")
            self.assertGreaterEqual(int(row[1]), 0)


class RequestRetryTests(unittest.TestCase):
    def test_safe_read_retries_once_after_timeout(self) -> None:
        session = Mock()
        response = Mock(status_code=200, text="ok")
        response.raise_for_status.return_value = None
        session.request.side_effect = [requests.Timeout("temporary"), response]

        with patch.object(collector.time, "sleep"):
            result = collector.request_with_retry(
                session,
                "GET",
                "https://example.test/",
                retryable=True,
                attempts=2,
            )

        self.assertIs(result, response)
        self.assertEqual(session.request.call_count, 2)

    def test_non_idempotent_write_is_not_retried(self) -> None:
        session = Mock()
        session.request.side_effect = requests.Timeout("write response lost")

        with self.assertRaises(requests.Timeout):
            collector.create_test_item(session, "csrf-token", "test label")

        self.assertEqual(session.request.call_count, 1)


class QueryServiceTests(unittest.TestCase):
    def test_queries_the_instance_entity_iri(self) -> None:
        session = Mock()
        response = Mock(status_code=200)
        response.raise_for_status.return_value = None
        response.json.return_value = {"boolean": True}
        session.request.return_value = response

        self.assertTrue(
            collector.item_in_query_service(
                session,
                "Q42",
                time.monotonic() + 10,
            )
        )
        query = session.request.call_args.kwargs["params"]["query"]
        self.assertIn(f"<{collector.ENTITY_BASE}Q42>", query)


class PollDeadlineTests(unittest.TestCase):
    def test_expired_deadline_records_timeout_without_network_request(self) -> None:
        session = Mock()
        with tempfile.TemporaryDirectory() as temporary_directory:
            data_dir = Path(temporary_directory)
            with patch.object(collector, "item_in_query_service") as query_check, patch.object(
                collector, "item_in_search_index"
            ) as search_check:
                result = collector.poll_for_item(
                    session,
                    "Q1",
                    "test label",
                    datetime.now(timezone.utc),
                    time.monotonic(),
                    check_elastic=True,
                    data_dir=data_dir,
                    timeout_seconds=0,
                )

            self.assertEqual(result, (False, False))
            query_check.assert_not_called()
            search_check.assert_not_called()
            query_rows = daily_csvs(data_dir, "query_create_time")
            elastic_rows = daily_csvs(data_dir, "elastic_create_time")
            self.assertEqual(len(query_rows), 1)
            self.assertEqual(len(elastic_rows), 1)
            with query_rows[0].open(encoding="utf-8") as source:
                self.assertEqual(next(csv.reader(source))[-1], "0")
            with elastic_rows[0].open(encoding="utf-8") as source:
                self.assertEqual(next(csv.reader(source))[-1], "0")


if __name__ == "__main__":
    unittest.main()
