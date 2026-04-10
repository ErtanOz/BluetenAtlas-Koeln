const APP_CONFIG = window.APP_CONFIG || {};
const DATA_PAYLOAD = window.KIRSCHBAUM_DATA;
const NUMBER_FORMAT = new Intl.NumberFormat("de-DE");
const METRIC_FORMAT = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const STADIA_PROBE_TILE = { z: 11, x: 1064, y: 685 };
const BASEMAP_MESSAGES = {
  checking: "Basemap-Pruefung: Stadia Maps Stamen Toner wird verifiziert.",
  active: "Basemap aktiv: Stadia Maps Stamen Toner.",
  activeWithKey: "Basemap aktiv: Stadia Maps Stamen Toner ueber API-Key.",
  needsDomainAuth:
    "Stadia Maps Stamen Toner braucht Domain-Auth auf diesem Host. OSM in Graustufen ist aktiv.",
  unavailableFallback:
    "Stadia Maps Stamen Toner ist derzeit nicht verfuegbar. OSM in Graustufen ist aktiv.",
  runtimeFallback:
    "Stadia Maps Stamen Toner ist waehrend der Laufzeit ausgefallen. OSM in Graustufen ist aktiv.",
};

const elements = {
  totalTrees: document.getElementById("totalTrees"),
  visibleTrees: document.getElementById("visibleTrees"),
  districtCount: document.getElementById("districtCount"),
  statusText: document.getElementById("statusText"),
  focusLabel: document.getElementById("focusLabel"),
  districtSelect: document.getElementById("districtSelect"),
  searchInput: document.getElementById("searchInput"),
  resetButton: document.getElementById("resetButton"),
  focusButton: document.getElementById("focusButton"),
  loadingBadge: document.getElementById("loadingBadge"),
  basemapNote: document.getElementById("basemapNote"),
};

const appState = {
  allRecords: [],
  filteredRecords: [],
  allBounds: null,
  map: null,
  clusterLayer: null,
};

const blossomMarkerIcon = L.divIcon({
  className: "blossom-icon",
  html: createBlossomSvg("blossom-icon__svg"),
  iconSize: [38, 38],
  iconAnchor: [19, 19],
  popupAnchor: [0, -14],
});

async function bootstrap() {
  await setupMap();
  bindEvents();

  if (!DATA_PAYLOAD || !Array.isArray(DATA_PAYLOAD.records)) {
    showError("Daten-Asset nicht gefunden. Fuehre zuerst das Extractor-Skript aus.");
    return;
  }

  hydrateRecords(DATA_PAYLOAD);
  populateDistricts(DATA_PAYLOAD.districts || []);
  applyFilters({ refit: true });
  setLoading(false);
}

bootstrap().catch((error) => {
  console.error(error);
  showError("Die Karte konnte nicht initialisiert werden.");
});

async function setupMap() {
  const map = L.map("map", {
    preferCanvas: true,
    zoomControl: false,
    minZoom: 11,
  });

  L.control.zoom({ position: "bottomright" }).addTo(map);
  map.attributionControl.setPrefix(false);

  await createBaseLayer(map);

  const clusterLayer = L.markerClusterGroup({
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    maxClusterRadius: 48,
    iconCreateFunction: createClusterIcon,
  });

  map.addLayer(clusterLayer);

  appState.map = map;
  appState.clusterLayer = clusterLayer;
}

async function createBaseLayer(map) {
  const stadiaApiKey = String(APP_CONFIG.stadiaMapsApiKey || "").trim();
  const stadiaAttribution =
    '&copy; <a href="https://stadiamaps.com/" target="_blank">Stadia Maps</a> ' +
    '&copy; <a href="https://stamen.com/" target="_blank">Stamen Design</a> ' +
    '&copy; <a href="https://openmaptiles.org/" target="_blank">OpenMapTiles</a> ' +
    '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';
  const osmAttribution =
    '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors';
  const stadiaLayer = L.tileLayer(buildStadiaTileUrl(stadiaApiKey), {
    maxZoom: 20,
    attribution: stadiaAttribution,
  });
  const fallbackLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    className: "basemap-grayscale",
    attribution: osmAttribution,
  });

  let activeLayer = null;
  let fallbackActivated = false;
  elements.basemapNote.textContent = BASEMAP_MESSAGES.checking;

  const activateFallback = (message) => {
    if (fallbackActivated) {
      return;
    }

    fallbackActivated = true;
    if (activeLayer && map.hasLayer(activeLayer)) {
      map.removeLayer(activeLayer);
    }
    if (!map.hasLayer(fallbackLayer)) {
      fallbackLayer.addTo(map);
    }
    activeLayer = fallbackLayer;
    elements.basemapNote.textContent = message;
  };

  const activateStadia = () => {
    if (!map.hasLayer(stadiaLayer)) {
      stadiaLayer.addTo(map);
    }
    activeLayer = stadiaLayer;
    elements.basemapNote.textContent = stadiaApiKey
      ? BASEMAP_MESSAGES.activeWithKey
      : BASEMAP_MESSAGES.active;
  };

  stadiaLayer.on("tileerror", () => {
    activateFallback(BASEMAP_MESSAGES.runtimeFallback);
  });

  const probeResult = await probeStadiaAvailability(stadiaApiKey);
  if (probeResult.ok) {
    activateStadia();
    return;
  }

  if (probeResult.reason === "auth" && !stadiaApiKey) {
    activateFallback(BASEMAP_MESSAGES.needsDomainAuth);
    return;
  }

  activateFallback(BASEMAP_MESSAGES.unavailableFallback);
}

async function probeStadiaAvailability(stadiaApiKey) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 5000);
  const probeUrl = buildStadiaTileUrl(
    stadiaApiKey,
    STADIA_PROBE_TILE.z,
    STADIA_PROBE_TILE.x,
    STADIA_PROBE_TILE.y,
    ""
  );

  try {
    const response = await fetch(probeUrl, {
      method: "HEAD",
      mode: "cors",
      cache: "no-store",
      signal: controller.signal,
    });

    if (response.ok) {
      return { ok: true, status: response.status };
    }

    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "auth", status: response.status };
    }

    return { ok: false, reason: "http", status: response.status };
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ok: false, reason: "network", error: "timeout" };
    }

    return { ok: false, reason: "network", error: String(error) };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function buildStadiaTileUrl(stadiaApiKey, z = "{z}", x = "{x}", y = "{y}", retina = "{r}") {
  const suffix = retina ? `${retina}.png` : ".png";
  const baseUrl = `https://tiles.stadiamaps.com/tiles/stamen_toner/${z}/${x}/${y}${suffix}`;
  return stadiaApiKey ? `${baseUrl}?api_key=${encodeURIComponent(stadiaApiKey)}` : baseUrl;
}

function bindEvents() {
  elements.districtSelect.addEventListener("change", () => {
    applyFilters({ refit: true });
  });

  elements.searchInput.addEventListener("input", () => {
    applyFilters({ refit: false });
  });

  elements.resetButton.addEventListener("click", () => {
    elements.districtSelect.value = "";
    elements.searchInput.value = "";
    applyFilters({ refit: true });
  });

  elements.focusButton.addEventListener("click", () => {
    fitToRecords(appState.filteredRecords.length ? appState.filteredRecords : appState.allRecords);
  });
}

function hydrateRecords(payload) {
  const bounds = payload.bounds || [];
  if (bounds.length === 2) {
    appState.allBounds = L.latLngBounds(bounds);
  }

  appState.allRecords = payload.records.map((record) => {
    const enriched = {
      ...record,
      searchIndex: buildSearchIndex(record),
    };

    enriched.marker = L.marker([record.lat, record.lon], {
      icon: blossomMarkerIcon,
      keyboard: true,
      title: record.commonName || record.botanicalName || "Kirschbaum",
      riseOnHover: true,
    }).bindPopup(createPopupMarkup(record), {
      closeButton: false,
      offset: [0, -4],
      maxWidth: 320,
    });

    return enriched;
  });

  elements.totalTrees.textContent = NUMBER_FORMAT.format(appState.allRecords.length);
}

function populateDistricts(districts) {
  const fragment = document.createDocumentFragment();

  districts.forEach((district) => {
    const option = document.createElement("option");
    option.value = district;
    option.textContent = district;
    fragment.appendChild(option);
  });

  elements.districtSelect.appendChild(fragment);
  elements.districtCount.textContent = NUMBER_FORMAT.format(districts.length);
}

function applyFilters({ refit }) {
  const selectedDistrict = elements.districtSelect.value;
  const rawQuery = elements.searchInput.value.trim();
  const query = rawQuery.toLocaleLowerCase();

  const filtered = appState.allRecords.filter((record) => {
    const districtMatches = !selectedDistrict || record.district === selectedDistrict;
    const queryMatches = !query || record.searchIndex.includes(query);
    return districtMatches && queryMatches;
  });

  appState.filteredRecords = filtered;
  renderMarkers(filtered);
  updateDashboard(filtered, selectedDistrict, rawQuery);

  if (refit && filtered.length) {
    fitToRecords(filtered);
  } else if (refit && !selectedDistrict && !query) {
    fitToRecords(appState.allRecords);
  }
}

function renderMarkers(records) {
  appState.clusterLayer.clearLayers();
  if (!records.length) {
    return;
  }
  appState.clusterLayer.addLayers(records.map((record) => record.marker));
}

function updateDashboard(records, selectedDistrict, rawQuery) {
  const districtSet = new Set(records.map((record) => record.district).filter(Boolean));
  const focusLabel = selectedDistrict || (rawQuery ? "Suchergebnis" : "Ganz Koeln");

  elements.visibleTrees.textContent = NUMBER_FORMAT.format(records.length);
  elements.districtCount.textContent = NUMBER_FORMAT.format(districtSet.size || DATA_PAYLOAD.districts.length);
  elements.focusLabel.textContent = focusLabel;

  if (!records.length) {
    elements.statusText.textContent = "Keine passenden Kirschbaeume gefunden. Erweitere die Filter.";
    return;
  }

  const headline = selectedDistrict
    ? `${selectedDistrict}: ${NUMBER_FORMAT.format(records.length)} Baeume sichtbar.`
    : `${NUMBER_FORMAT.format(records.length)} Kirschbaeume aktiv.`;

  if (rawQuery) {
    elements.statusText.textContent = `${headline} Suche: "${rawQuery}".`;
    return;
  }

  elements.statusText.textContent = headline;
}

function fitToRecords(records) {
  if (!records.length && appState.allBounds) {
    appState.map.fitBounds(appState.allBounds.pad(0.05));
    return;
  }

  const bounds = L.latLngBounds(records.map((record) => [record.lat, record.lon]));
  appState.map.fitBounds(bounds.pad(0.12), {
    animate: true,
    duration: 0.8,
  });
}

function createClusterIcon(cluster) {
  const count = cluster.getChildCount();
  const size = count < 25 ? 62 : count < 100 ? 72 : 84;

  return L.divIcon({
    className: "cluster-icon",
    iconSize: [size, size],
    html: `
      <div class="cluster-shell" style="width:${size}px;height:${size}px">
        ${createBlossomSvg("")}
        <span class="cluster-count">${NUMBER_FORMAT.format(count)}</span>
      </div>
    `,
  });
}

function createPopupMarkup(record) {
  const rows = [
    popupRow("Stadtteil", record.district),
    popupRow("Strasse", record.street),
    popupRow("Baumnummer", record.treeNumber),
    popupRow("Pflanzjahr", record.plantedYear),
    popupRow("Hoehe", formatMetric(record.heightM, "m")),
    popupRow("Kronendurchmesser", formatMetric(record.crownDiameterM, "m")),
    popupRow("Stammdurchmesser", formatMetric(record.trunkDiameterCm, "cm")),
    popupRow("Stammumfang", formatMetric(record.trunkCircumferenceCm, "cm")),
  ].filter(Boolean);

  const kicker = escapeHtml(record.commonName || "Kirschbaum");
  const title = escapeHtml(record.botanicalName || "Prunus");

  return `
    <article class="popup-card">
      <p class="popup-kicker">${kicker}</p>
      <h3>${title}</h3>
      <ul class="popup-meta">${rows.join("")}</ul>
    </article>
  `;
}

function popupRow(label, value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  return `<li><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></li>`;
}

function formatMetric(value, unit) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return `${METRIC_FORMAT.format(value)} ${unit}`;
}

function buildSearchIndex(record) {
  return [
    record.commonName,
    record.botanicalName,
    record.district,
    record.street,
    record.treeNumber,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

function setLoading(isLoading) {
  elements.loadingBadge.classList.toggle("is-visible", isLoading);
}

function showError(message) {
  setLoading(false);
  elements.statusText.textContent = message;
  elements.visibleTrees.textContent = "0";
  elements.focusLabel.textContent = "Fehler";
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function createBlossomSvg(className) {
  return `
    <svg class="${className}" viewBox="0 0 72 72" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="petalFill" cx="50%" cy="38%" r="68%">
          <stop offset="0%" stop-color="#fff8fb"></stop>
          <stop offset="62%" stop-color="#ffc8de"></stop>
          <stop offset="100%" stop-color="#eb6d9f"></stop>
        </radialGradient>
        <radialGradient id="centerFill" cx="50%" cy="50%" r="70%">
          <stop offset="0%" stop-color="#fff5cf"></stop>
          <stop offset="100%" stop-color="#f0bb41"></stop>
        </radialGradient>
      </defs>
      <g transform="translate(36 36)">
        <ellipse rx="12" ry="19" transform="rotate(0) translate(0 -15)" fill="url(#petalFill)"></ellipse>
        <ellipse rx="12" ry="19" transform="rotate(72) translate(0 -15)" fill="url(#petalFill)"></ellipse>
        <ellipse rx="12" ry="19" transform="rotate(144) translate(0 -15)" fill="url(#petalFill)"></ellipse>
        <ellipse rx="12" ry="19" transform="rotate(216) translate(0 -15)" fill="url(#petalFill)"></ellipse>
        <ellipse rx="12" ry="19" transform="rotate(288) translate(0 -15)" fill="url(#petalFill)"></ellipse>
        <circle r="11" fill="url(#centerFill)"></circle>
        <circle r="2.3" cx="-4.5" cy="-1.8" fill="#8e5d0f"></circle>
        <circle r="2.3" cx="0" cy="3.2" fill="#8e5d0f"></circle>
        <circle r="2.3" cx="4.8" cy="-1.4" fill="#8e5d0f"></circle>
        <path
          d="M13 20 C22 19, 26 24, 29 30 C22 30, 17 28, 13 20 Z"
          fill="#6ca78a"
          opacity="0.9"
        ></path>
      </g>
    </svg>
  `;
}
