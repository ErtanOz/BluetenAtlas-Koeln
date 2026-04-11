from __future__ import annotations

import argparse
import json
import pathlib
import platform
import shutil
import subprocess
import tarfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import UTC, datetime, timedelta


PAYLOAD_DEFAULT = pathlib.Path("data/koeln_kirschbaumkataster.json")
OUTPUT_DEFAULT = pathlib.Path("tiles/koeln.pmtiles")
DEFAULT_PADDING = 0.08
DEFAULT_MAXZOOM = 14
DEFAULT_LOOKBACK_DAYS = 7
DEFAULT_BUILD_BASE_URL = "https://build.protomaps.com"
PMTILES_RELEASES_API = "https://api.github.com/repos/protomaps/go-pmtiles/releases/latest"


def request(url: str, *, method: str = "GET") -> urllib.request.Request:
    return urllib.request.Request(
        url,
        method=method,
        headers={"User-Agent": "BluetenAtlas-Koeln/1.0"},
    )


def load_payload_bounds(payload_path: pathlib.Path) -> tuple[float, float, float, float]:
    payload = json.loads(payload_path.read_text(encoding="utf-8"))
    bounds = payload.get("bounds") or []
    if len(bounds) != 2:
        raise ValueError(f"Missing bounds in {payload_path.as_posix()}")

    (min_lat, min_lon), (max_lat, max_lon) = bounds
    return float(min_lon), float(min_lat), float(max_lon), float(max_lat)


def pad_bbox(bbox: tuple[float, float, float, float], padding: float) -> tuple[float, float, float, float]:
    min_lon, min_lat, max_lon, max_lat = bbox
    return (
        round(min_lon - padding, 6),
        round(min_lat - padding, 6),
        round(max_lon + padding, 6),
        round(max_lat + padding, 6),
    )


def discover_build_url(base_url: str, lookback_days: int) -> str:
    today = datetime.now(UTC).date()
    errors: list[str] = []

    for offset in range(lookback_days + 1):
        candidate_date = today - timedelta(days=offset)
        candidate_url = f"{base_url.rstrip('/')}/{candidate_date.strftime('%Y%m%d')}.pmtiles"

        try:
            with urllib.request.urlopen(request(candidate_url, method="HEAD"), timeout=10) as response:
                if response.status == 200:
                    return candidate_url
        except urllib.error.HTTPError as error:
            errors.append(f"{candidate_url} -> HTTP {error.code}")
        except urllib.error.URLError as error:
            errors.append(f"{candidate_url} -> {error.reason}")

    joined = "\n".join(errors[-3:])
    raise RuntimeError(f"Could not discover a recent Protomaps daily build.\n{joined}")


def resolve_release_asset_name() -> tuple[str, str]:
    system = platform.system()
    machine = platform.machine().lower()

    if machine in {"amd64", "x86_64", "x64"}:
        arch = "x86_64"
    elif machine in {"arm64", "aarch64"}:
        arch = "arm64"
    else:
        raise RuntimeError(f"Unsupported architecture: {machine}")

    if system == "Windows":
        return f"go-pmtiles_*_Windows_{arch}.zip", "zip"
    if system == "Linux":
        return f"go-pmtiles_*_Linux_{arch}.tar.gz", "tar.gz"
    if system == "Darwin":
        suffix = "Darwin_arm64.zip" if arch == "arm64" else "Darwin_x86_64.zip"
        return f"go-pmtiles-*_{suffix}", "zip"

    raise RuntimeError(f"Unsupported platform: {system}")


def ensure_pmtiles_cli(repo_root: pathlib.Path, explicit_cli: str | None) -> pathlib.Path:
    if explicit_cli:
        cli_path = pathlib.Path(explicit_cli)
        if cli_path.exists():
            return cli_path.resolve()
        raise FileNotFoundError(f"pmtiles CLI not found: {cli_path}")

    discovered = shutil.which("pmtiles")
    if discovered:
        return pathlib.Path(discovered).resolve()

    tools_dir = repo_root / ".tools" / "pmtiles"
    tools_dir.mkdir(parents=True, exist_ok=True)
    executable_name = "pmtiles.exe" if platform.system() == "Windows" else "pmtiles"
    cached_binary = next(tools_dir.rglob(executable_name), None)
    if cached_binary:
        return cached_binary.resolve()

    asset_pattern, archive_type = resolve_release_asset_name()
    release_data = json.loads(urllib.request.urlopen(request(PMTILES_RELEASES_API), timeout=20).read().decode("utf-8"))
    asset = find_release_asset(release_data.get("assets") or [], asset_pattern)
    if asset is None:
        raise RuntimeError(f"No matching pmtiles release asset found for pattern {asset_pattern}")

    tag_name = release_data["tag_name"]
    destination_dir = tools_dir / tag_name
    destination_dir.mkdir(parents=True, exist_ok=True)
    archive_name = pathlib.Path(urllib.parse.urlparse(asset["browser_download_url"]).path).name
    archive_path = destination_dir / archive_name
    if not archive_path.exists():
        download_file(asset["browser_download_url"], archive_path)

    extract_archive(archive_path, destination_dir, archive_type)
    binary_path = destination_dir / executable_name
    if not binary_path.exists():
        raise RuntimeError(f"Downloaded archive did not contain {executable_name}")

    if platform.system() != "Windows":
        binary_path.chmod(binary_path.stat().st_mode | 0o111)

    return binary_path.resolve()


def find_release_asset(assets: list[dict], asset_pattern: str) -> dict | None:
    import fnmatch

    for asset in assets:
        if fnmatch.fnmatch(asset.get("name") or "", asset_pattern):
            return asset
    return None


def download_file(url: str, destination: pathlib.Path) -> None:
    with urllib.request.urlopen(request(url), timeout=60) as response, destination.open("wb") as handle:
        shutil.copyfileobj(response, handle)


def extract_archive(archive_path: pathlib.Path, destination_dir: pathlib.Path, archive_type: str) -> None:
    if archive_type == "zip":
        with zipfile.ZipFile(archive_path) as archive:
            archive.extractall(destination_dir)
        return

    if archive_type == "tar.gz":
        with tarfile.open(archive_path, "r:gz") as archive:
            archive.extractall(destination_dir)
        return

    raise RuntimeError(f"Unsupported archive format: {archive_type}")


def run_extract(
    pmtiles_cli: pathlib.Path,
    source_url: str,
    output_path: pathlib.Path,
    bbox: tuple[float, float, float, float],
    maxzoom: int,
    download_threads: int,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    bbox_arg = ",".join(f"{value:.6f}" for value in bbox)

    command = [
        str(pmtiles_cli),
        "extract",
        source_url,
        str(output_path),
        f"--bbox={bbox_arg}",
        f"--maxzoom={maxzoom}",
        f"--download-threads={download_threads}",
    ]

    subprocess.run(command, check=True)


def run_upload(
    pmtiles_cli: pathlib.Path,
    output_path: pathlib.Path,
    bucket_url: str,
    remote_name: str,
) -> None:
    command = [
        str(pmtiles_cli),
        "upload",
        str(output_path),
        remote_name,
        f"--bucket={bucket_url}",
    ]
    subprocess.run(command, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build a clipped Koeln Protomaps PMTiles basemap for BluetenAtlas Koeln."
    )
    parser.add_argument("--payload", default=str(PAYLOAD_DEFAULT))
    parser.add_argument("--output", default=str(OUTPUT_DEFAULT))
    parser.add_argument("--padding", type=float, default=DEFAULT_PADDING)
    parser.add_argument("--maxzoom", type=int, default=DEFAULT_MAXZOOM)
    parser.add_argument("--lookback-days", type=int, default=DEFAULT_LOOKBACK_DAYS)
    parser.add_argument("--download-threads", type=int, default=16)
    parser.add_argument("--source-url", help="Explicit Protomaps PMTiles source URL.")
    parser.add_argument("--pmtiles-cli", help="Path to an existing pmtiles executable.")
    parser.add_argument(
        "--upload-bucket",
        help="Optional S3-compatible bucket URL, e.g. s3://BUCKET?endpoint=https://ACCOUNT.r2.cloudflarestorage.com&region=auto",
    )
    parser.add_argument("--remote-name", help="Optional remote PMTiles object name for uploads.")
    args = parser.parse_args()

    repo_root = pathlib.Path(__file__).resolve().parent.parent
    payload_path = (repo_root / args.payload).resolve()
    output_path = (repo_root / args.output).resolve()

    bbox = pad_bbox(load_payload_bounds(payload_path), args.padding)
    source_url = args.source_url or discover_build_url(DEFAULT_BUILD_BASE_URL, args.lookback_days)
    pmtiles_cli = ensure_pmtiles_cli(repo_root, args.pmtiles_cli)

    print(f"Using source: {source_url}")
    print(f"Using bbox: {','.join(f'{value:.6f}' for value in bbox)}")
    print(f"Using pmtiles CLI: {pmtiles_cli}")

    run_extract(pmtiles_cli, source_url, output_path, bbox, args.maxzoom, args.download_threads)

    size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"Wrote {output_path.as_posix()} ({size_mb:.2f} MB)")

    if args.upload_bucket:
        if not args.remote_name:
            raise SystemExit("--remote-name is required when --upload-bucket is provided.")
        run_upload(pmtiles_cli, output_path, args.upload_bucket, args.remote_name)
        print(f"Uploaded {output_path.name} to {args.upload_bucket} as {args.remote_name}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
