# Koeln PMTiles Basemap

`koeln.pmtiles` is a clipped Protomaps basemap archive for the Cologne area, generated for `BluetenAtlas Koeln`.

Regenerate it with:

```bash
python scripts/build_protomaps_basemap.py
```

Notes:
- Source archive: recent Protomaps daily build from `https://build.protomaps.com/`
- Extract scope: padded bounds of the filtered `Prunus` tree dataset
- Default detail: `--maxzoom 14`
- Attribution remains required for Protomaps and OpenStreetMap
