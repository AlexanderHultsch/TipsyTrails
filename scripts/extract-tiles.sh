#!/usr/bin/env bash
# Produces the PMTiles tile extract for a city, into data/tiles/ (SPEC.md
# Sections 4.2, 11.4, 13.2). This is the last script in the city data
# pipeline chain (11.4's script table) and the only one written in shell
# rather than TypeScript, because its actual work is invoking Planetiler
# (a Java jar), not something Node adds value wrapping.
#
# Network-required (downloads a regional extract from Geofabrik) and needs a
# Java runtime and a local Planetiler jar - none of which this sandbox has,
# so this script has never been run end to end here. It follows the other
# scripts in scripts/ as closely as a shell script reasonably can:
# --city=<slug>, reading everything else from data/cities/<slug>.json (the
# single seam, Section 11.4), a clear failure when that config is missing,
# a summary of what it wrote, and an atomic write - Planetiler is given a
# temporary output path and the result is renamed into place only once it
# exits successfully, so a failed run never leaves a half-written extract
# next to the real filename (Section 11.4: "fail loudly and leave nothing
# half-written").
#
# Usage:
#   scripts/extract-tiles.sh --city=karlsruhe --planetiler-jar=./planetiler.jar
#   scripts/extract-tiles.sh --city=karlsruhe --planetiler-jar=./planetiler.jar --dry-run
#   PLANETILER_JAR=./planetiler.jar scripts/extract-tiles.sh --city=karlsruhe
#
# --dry-run reads and validates the city config, runs every prerequisite
# check below, and prints the Planetiler command that would run - the same
# "compute everything, write nothing" contract build-grid.ts's --dry-run
# uses - without downloading anything or invoking Java.
#
# The Planetiler jar's location is not something this script guesses at
# (unlike an Overpass URL or a city slug, there is no sane repository-wide
# default for it): pass --planetiler-jar=<path> or set PLANETILER_JAR. Get
# the jar from https://github.com/onthegomap/planetiler/releases.
#
# Karlsruhe's extract measured 9.4 MB at zoom 0-14 (Section 13.2) - a
# regenerated extract for the same city and bounding box should land in the
# same range.
#
# A hint, not baked into the command below because it is specific to one
# environment, not general: if Java's download from Geofabrik fails with a
# TLS/certificate error, that is commonly a corporate-managed Windows
# laptop whose TLS-inspecting root certificate the JVM does not trust. Add
# -Djavax.net.ssl.trustStoreType=Windows-ROOT to the java invocation in that
# situation so it trusts the OS certificate store instead of Java's own.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

city=""
dry_run=0
planetiler_jar="${PLANETILER_JAR:-}"

usage() {
  echo "Usage: $0 --city=<slug> --planetiler-jar=<path> [--dry-run]" >&2
  echo "       (--planetiler-jar can also be given via the PLANETILER_JAR env var)" >&2
}

for arg in "$@"; do
  case "$arg" in
    --city=*)
      city="${arg#--city=}"
      ;;
    --dry-run)
      dry_run=1
      ;;
    --planetiler-jar=*)
      planetiler_jar="${arg#--planetiler-jar=}"
      ;;
    *)
      echo "extract-tiles: unrecognised argument \"$arg\"." >&2
      usage
      exit 1
      ;;
  esac
done

if [ -z "$city" ]; then
  echo "extract-tiles: missing required --city=<slug> argument." >&2
  usage
  exit 1
fi

config_path="$repo_root/data/cities/$city.json"
if [ ! -f "$config_path" ]; then
  echo "extract-tiles: no city config found at \"$config_path\". Expected data/cities/$city.json — check the --city slug and that the file exists." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "extract-tiles: node is required (to read $config_path) but was not found on PATH." >&2
  exit 1
fi

# Reads the same data/cities/<slug>.json every other pipeline script reads
# (Section 11.4's config-field table: bounding_box and geofabrik_region are
# this script's two fields) and prints the fields this script needs, one
# per line, so the shell can pick them up below - the plain-JSON.parse
# equivalent of build-grid.ts's/import-osm-bars.ts's loadCityConfig, kept
# inline here rather than pulled in from packages/shared/src/city.ts, which
# is compiled TypeScript this shell script has no build step to reach.
config_fields="$(node -e '
  const fs = require("fs");
  const path = process.argv[1];
  let raw;
  try {
    raw = fs.readFileSync(path, "utf-8");
  } catch (err) {
    console.error(`extract-tiles: could not read "${path}": ${err.message}`);
    process.exit(1);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    console.error(`extract-tiles: "${path}" is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  const required = ["slug", "name", "geofabrik_region", "tiles_filename", "bounding_box"];
  for (const field of required) {
    if (config[field] === undefined) {
      console.error(`extract-tiles: "${path}" is missing required field "${field}".`);
      process.exit(1);
    }
  }
  const bbox = config.bounding_box;
  for (const field of ["south", "west", "north", "east"]) {
    if (typeof bbox[field] !== "number") {
      console.error(`extract-tiles: "${path}".bounding_box.${field} must be a number.`);
      process.exit(1);
    }
  }
  process.stdout.write(
    [config.slug, config.name, config.geofabrik_region, config.tiles_filename,
     bbox.west, bbox.south, bbox.east, bbox.north].join("\n") + "\n",
  );
' "$config_path")"

slug="$(sed -n '1p' <<<"$config_fields")"
name="$(sed -n '2p' <<<"$config_fields")"
geofabrik_region="$(sed -n '3p' <<<"$config_fields")"
tiles_filename="$(sed -n '4p' <<<"$config_fields")"
west="$(sed -n '5p' <<<"$config_fields")"
south="$(sed -n '6p' <<<"$config_fields")"
east="$(sed -n '7p' <<<"$config_fields")"
north="$(sed -n '8p' <<<"$config_fields")"

if [ -z "$planetiler_jar" ]; then
  echo "extract-tiles: no Planetiler jar given. Pass --planetiler-jar=<path> or set PLANETILER_JAR." >&2
  echo "  Get it from https://github.com/onthegomap/planetiler/releases." >&2
  exit 1
fi

if ! command -v java >/dev/null 2>&1; then
  echo "extract-tiles: java is required to run Planetiler but was not found on PATH. Install a JRE (17+) and try again." >&2
  exit 1
fi

if [ ! -f "$planetiler_jar" ]; then
  echo "extract-tiles: no Planetiler jar found at \"$planetiler_jar\" (--planetiler-jar/PLANETILER_JAR). Get it from https://github.com/onthegomap/planetiler/releases." >&2
  exit 1
fi

output_dir="$repo_root/data/tiles"
output_path="$output_dir/$tiles_filename"

# geofabrik_region in the city config holds the full Geofabrik path (e.g.
# "europe/germany/baden-wuerttemberg") because that is the more useful
# thing to have on record - it is also the path segment of the actual
# download URL, used below for the reachability probe. Planetiler's
# --area, however, only ever ran successfully with the last path segment
# alone ("baden-wuerttemberg") - its own log showed it resolving that
# short form to the full download URL itself. Do not "fix" this back to
# the full path; it is untested and the one confirmed working value is the
# segment.
area_segment="${geofabrik_region##*/}"
download_url="https://download.geofabrik.de/${geofabrik_region}-latest.osm.pbf"

cmd=(java -Xmx4g -jar "$planetiler_jar"
  --download --area="$area_segment"
  --bounds="$west,$south,$east,$north"
  --force)

echo "extract-tiles: city=\"$name\" ($slug), region=$geofabrik_region (area=$area_segment), bounds=$west,$south,$east,$north"
echo "extract-tiles: output $output_path"
echo "extract-tiles: command: ${cmd[*]} --output=<temporary path, renamed to $tiles_filename on success>"
echo "extract-tiles: hint — a TLS/certificate error from Java during --download usually means a"
echo "  TLS-inspecting network (e.g. a corporate-managed Windows laptop); add"
echo "  -Djavax.net.ssl.trustStoreType=Windows-ROOT to the java invocation in that situation."

if [ "$dry_run" = "1" ]; then
  echo "Dry run: nothing downloaded, nothing written."
  exit 0
fi

# A HEAD request against the actual extract file - not just the Geofabrik
# host - so this catches a wrong/renamed region as well as no network,
# before the multi-hundred-MB download Planetiler would otherwise start.
if command -v curl >/dev/null 2>&1; then
  if ! curl -fsSL --max-time 20 -o /dev/null -I "$download_url"; then
    echo "extract-tiles: could not reach $download_url over the network (region \"$geofabrik_region\" via Geofabrik). Check connectivity and the region name, then try again." >&2
    exit 1
  fi
elif command -v wget >/dev/null 2>&1; then
  if ! wget -q --spider --timeout=20 "$download_url"; then
    echo "extract-tiles: could not reach $download_url over the network (region \"$geofabrik_region\" via Geofabrik). Check connectivity and the region name, then try again." >&2
    exit 1
  fi
else
  echo "extract-tiles: warning — neither curl nor wget found; skipping the Geofabrik reachability check. Planetiler will fail on its own if it cannot reach the network." >&2
fi

mkdir -p "$output_dir"
# The PID marker goes before the real filename, not after: Planetiler infers
# its output format from the path's own extension (TileArchiveConfig), so a
# temp path ending in anything other than .pmtiles - such as the previous
# ".$tiles_filename.tmp-$$", whose final extension was "tmp-$$" - fails with
# "Unsupported format tmp-<pid>" before Planetiler writes a single tile.
tmp_path="$output_dir/.tmp-$$-$tiles_filename"
cleanup() {
  rm -f "$tmp_path"
}
trap cleanup EXIT

"${cmd[@]}" --output="$tmp_path"

if [ ! -s "$tmp_path" ]; then
  echo "extract-tiles: Planetiler exited successfully but \"$tmp_path\" is missing or empty." >&2
  exit 1
fi

mv "$tmp_path" "$output_path"
trap - EXIT

bytes="$(wc -c <"$output_path" | tr -d ' ')"
echo "Wrote $name: $output_path ($bytes bytes)"
