from __future__ import annotations

import argparse
import json
import pathlib
import unicodedata
from datetime import datetime, timezone


SOURCE_DEFAULT = pathlib.Path("data/koeln_baumkataster.geojson")
JSON_TARGET_DEFAULT = pathlib.Path("data/koeln_kirschbaumkataster.json")
JS_TARGET_DEFAULT = pathlib.Path("data/koeln_kirschbaumkataster.js")


def normalize_text(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    return " ".join(text.split()).casefold()


def clean_text(value: object) -> str | None:
    text = " ".join(str(value or "").split())
    return text or None


def parse_number(value: object, *, as_int: bool = False) -> int | float | None:
    text = clean_text(value)
    if text is None:
        return None
    text = text.replace(",", ".")
    try:
        number = float(text)
    except ValueError:
        return None
    if as_int:
        return int(number)
    if number.is_integer():
        return int(number)
    return round(number, 2)


def build_record(record_id: int, feature: dict) -> dict | None:
    props = feature.get("properties") or {}
    geometry = feature.get("geometry") or {}
    botanical_name = clean_text(props.get("Botanischer_Name"))

    if botanical_name is None or "prunus" not in normalize_text(botanical_name):
        return None

    coordinates = geometry.get("coordinates") or []
    if len(coordinates) < 2:
        return None

    try:
        lon = round(float(coordinates[0]), 7)
        lat = round(float(coordinates[1]), 7)
    except (TypeError, ValueError):
        return None

    return {
        "id": f"prunus-{record_id:05d}",
        "lon": lon,
        "lat": lat,
        "commonName": clean_text(props.get("Deutscher_Name")),
        "botanicalName": botanical_name,
        "district": clean_text(props.get("Stadtteil")),
        "street": clean_text(props.get("Straße")),
        "treeNumber": clean_text(props.get("Baumnummer")),
        "plantedYear": parse_number(props.get("Pflanzjahr"), as_int=True),
        "heightM": parse_number(props.get("Höhe_-_m")),
        "crownDiameterM": parse_number(props.get("Kronendurchmesser_-_m")),
        "trunkDiameterCm": parse_number(props.get("Stammdurchmesser_-_cm")),
        "trunkCircumferenceCm": parse_number(props.get("Stammumfang_-_cm")),
    }


def extract_payload(source_path: pathlib.Path) -> dict:
    with source_path.open("r", encoding="utf-8") as handle:
        source_data = json.load(handle)

    records: list[dict] = []
    districts: set[str] = set()
    min_lon = min_lat = float("inf")
    max_lon = max_lat = float("-inf")

    for index, feature in enumerate(source_data.get("features") or []):
        record = build_record(len(records) + 1, feature)
        if record is None:
            continue

        records.append(record)
        if record["district"]:
            districts.add(record["district"])

        min_lon = min(min_lon, record["lon"])
        min_lat = min(min_lat, record["lat"])
        max_lon = max(max_lon, record["lon"])
        max_lat = max(max_lat, record["lat"])

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": source_path.as_posix(),
        "count": len(records),
        "bounds": [[round(min_lat, 7), round(min_lon, 7)], [round(max_lat, 7), round(max_lon, 7)]],
        "districts": sorted(districts, key=lambda value: value.casefold()),
        "records": records,
    }


def write_outputs(payload: dict, json_target: pathlib.Path, js_target: pathlib.Path) -> None:
    json_text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    json_target.write_text(json_text, encoding="utf-8")
    js_target.write_text(f"window.KIRSCHBAUM_DATA={json_text};\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract Koeln Prunus records into browser-friendly assets.")
    parser.add_argument("--source", default=str(SOURCE_DEFAULT))
    parser.add_argument("--json-target", default=str(JSON_TARGET_DEFAULT))
    parser.add_argument("--js-target", default=str(JS_TARGET_DEFAULT))
    args = parser.parse_args()

    source_path = pathlib.Path(args.source)
    json_target = pathlib.Path(args.json_target)
    js_target = pathlib.Path(args.js_target)

    payload = extract_payload(source_path)
    write_outputs(payload, json_target, js_target)

    print(
        f"Wrote {payload['count']} Prunus records to "
        f"{json_target.as_posix()} and {js_target.as_posix()}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
