#!/usr/bin/env python3
"""Review-only extraction of SKU quantities from the supplied stock report.

Requires pypdf locally when a NEW report is supplied. Do not run this on a
trading ledger: it creates a source snapshot, never updates live inventory.
Use: python3 scripts/extract-instore-stock.py Stock-2026-11-12.pdf products.csv data/instore-stock-snapshot.json
"""

import csv
import hashlib
import json
import re
import sys
from pathlib import Path

try:
    from pypdf import PdfReader
except ImportError as exc:
    raise SystemExit("Install pypdf in a local environment to review a new stock PDF; it is not needed by the POS runtime.") from exc

ROW = re.compile(r"^\s*(\d{1,5})\s{2,}(.*)$")
CODE = re.compile(r"^(\d{1,8})\s{2,}(.+)$")
WITH_UNIT = re.compile(r"(?<!\d)(-?\d+)\s+(Each|Eachb|Eacg)\s+(-?[\d,]+\.\d{2})", re.I)
WITHOUT_UNIT = re.compile(r"\s{2,}(-?\d+)\s{2,}(-?[\d,]+\.\d{2})\s{2,}")


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    if len(sys.argv) != 4:
        raise SystemExit("Usage: extract-instore-stock.py stock.pdf products.csv output.json")
    pdf_path, csv_path, output_path = map(Path, sys.argv[1:])
    with csv_path.open(encoding="utf-8-sig", newline="") as source:
        products = list(csv.DictReader(source))
    skus = [r["SKU"].strip() for r in products if r["SKU"].strip()]
    if len(skus) != len(set(skus)):
        raise SystemExit("Duplicate SKUs in product export; stop for owner review.")
    rows = []
    unidentified = []
    seen_report_rows = set()
    for page_number, page in enumerate(PdfReader(pdf_path).pages, 1):
        for line in (page.extract_text(extraction_mode="layout") or "").splitlines():
            match = ROW.match(line)
            if not match or not 1 <= int(match.group(1)) <= len(products):
                continue
            report_row, tail = match.groups()
            report_row = int(report_row)
            if report_row in seen_report_rows:
                raise SystemExit(f"Duplicate PDF report row {report_row}; stop for owner review.")
            seen_report_rows.add(report_row)
            coded = CODE.match(tail)
            sku, rest = coded.groups() if coded else ("", tail)
            with_unit = WITH_UNIT.search(rest)
            without_unit = list(WITHOUT_UNIT.finditer(rest)) if not with_unit else []
            quantity = int(with_unit.group(1)) if with_unit else int(without_unit[-1].group(1)) if without_unit else None
            unit = with_unit.group(2) if with_unit else ""
            if sku:
                rows.append({"sku": sku, "quantity": quantity, "unit": unit, "reportRow": report_row, "page": page_number})
            else:
                # Visible source row, but neither the PDF nor CSV has a code.
                # Keep it for owner identification; NEVER infer a sellable SKU.
                fields = re.split(r"\s{2,}", rest[:with_unit.start() if with_unit else len(rest)].strip())
                unidentified.append({"name": fields[1] if len(fields) > 1 else "", "quantity": quantity,
                                     "unit": unit, "reportRow": report_row, "page": page_number})
    found = [r["sku"] for r in rows]
    if len(found) != len(set(found)) or set(found) != set(skus) or seen_report_rows != set(range(1, len(products) + 1)):
        raise SystemExit("PDF row numbers and SKUs do not exactly match the CSV; stop for owner review.")
    if len(unidentified) != len(products) - len(skus):
        raise SystemExit("Unidentified report and CSV row counts differ; stop for owner review.")
    result = {
        "sourcePdf": pdf_path.name,
        "pdfSha256": sha256(pdf_path),
        "sourceCsv": csv_path.name,
        "csvSha256": sha256(csv_path),
        "unidentifiedCsvRows": len(products) - len(skus),
        "unidentifiedReportRows": unidentified,
        "rows": rows,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Extracted {len(rows)} SKU quantities; {sum(r['quantity'] is None for r in rows)} unknown, "
          f"{sum(r['quantity'] is not None and r['quantity'] < 0 for r in rows)} negative, "
          f"{sum(r['unit'].lower() != 'each' for r in rows)} missing/malformed units. "
          "These exceptions must NOT be made sellable automatically.")


if __name__ == "__main__":
    main()
