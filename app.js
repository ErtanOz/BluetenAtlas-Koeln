const DATA_PAYLOAD = window.KIRSCHBAUM_DATA;
const NUMBER_FORMAT = new Intl.NumberFormat("de-DE");
const METRIC_FORMAT = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const BASEMAP_LABELS = {
  gray: "Grau",
  street: "OSM Straße",
  satellite: "Satellit",
};
const MOBILE_LAYOUT_QUERY = window.matchMedia("(max-width: 720px)");

const elements = {
  mobileSheet: document.getElementById("mobileSheet"),
  mobileSheetContent: document.getElementById("mobileSheetContent"),
  mobileSheetHandle: document.getElementById("mobileSheetHandle"),
  mobileSheetHandleLabel: document.getElementById("mobileSheetHandleLabel"),
  totalTrees: document.getElementById("totalTrees"),
  visibleTrees: document.getElementById("visibleTrees"),
  districtCount: document.getElementById("districtCount"),
  statusText: document.getElementById("statusText"),
  focusLabel: document.getElementById("focusLabel"),
  districtSelect: document.getElementById("districtSelect"),
  searchInput: document.getElementById("searchInput"),
  searchClear: document.getElementById("searchClear"),
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
  basemapLayers: {},
  activeBasemapKey: "gray",
  basemapControl: null,
  mobileSheetState: "peek",
};

const blossomMarkerIcon = L.divIcon({
  className: "blossom-icon",
  html: createBlossomSvg("blossom-icon__svg"),
  iconSize: [38, 38],
  iconAnchor: [19, 19],
  popupAnchor: [0, -14],
});

async function bootstrap() {
  injectGlobalSvgDefs(); /* SVG-Gradienten einmalig im DOM registrieren (verhindert ID-Konflikt) */
  await setupMap();
  bindEvents();

  if (!DATA_PAYLOAD || !Array.isArray(DATA_PAYLOAD.records)) {
    showError("Daten-Asset nicht gefunden. Führe zuerst das Extractor-Skript aus.");
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
    maxZoom: 19, // Aşırı yakınlaşıldığında haritanın kaybolmasını engeller
    // Animasyonu daha geniş zoom aralığında bile çalıştır
    zoomAnimationThreshold: 4,
  });

  L.control.zoom({ position: "bottomright" }).addTo(map);
  map.attributionControl.setPrefix(false);

  createBaseLayer(map);

  const clusterLayer = L.markerClusterGroup({
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    maxClusterRadius: 48,
    iconCreateFunction: createClusterIcon,
    // Cluster üzerine çift tıklama ile zoom yap
    zoomToBoundsOnClick: true,
  });

  // Cluster'lar üzerindeki çift-tıklamayı haritaya ilet (zoom’u açık bırak)
  clusterLayer.on("clusterclick", function (e) {
    // Tek tıklamada cluster zoom’u zaten çalışıyor (zoomToBoundsOnClick).
    // Burada sadece event'in haritaya ulaşmasını engellememek yeterli.
  });

  map.addLayer(clusterLayer);

  // Stable Leaflet container recalculation after two render frames
  requestAnimationFrame(() => requestAnimationFrame(() => map.invalidateSize()));

  appState.map = map;
  appState.clusterLayer = clusterLayer;
}

function createBaseLayer(map) {
  const osmAttribution =
    '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors';
  const esriAttribution =
    "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community";

  appState.basemapLayers = {
    gray: {
      label: BASEMAP_LABELS.gray,
      layer: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        className: "basemap-grayscale",
        attribution: osmAttribution,
      }),
    },
    street: {
      label: BASEMAP_LABELS.street,
      layer: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: osmAttribution,
      }),
    },
    satellite: {
      label: BASEMAP_LABELS.satellite,
      layer: L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        {
          maxZoom: 19,
          attribution: esriAttribution,
        }
      ),
    },
  };

  const layerControlMap = {};
  Object.values(appState.basemapLayers).forEach((entry) => {
    layerControlMap[entry.label] = entry.layer;
  });

  appState.basemapLayers.gray.layer.addTo(map);
  appState.activeBasemapKey = "gray";
  appState.basemapControl = L.control.layers(layerControlMap, null, {
    position: "topright",
  }).addTo(map);

  map.on("baselayerchange", (event) => {
    const activeEntry = Object.entries(appState.basemapLayers).find(
      ([, basemap]) => basemap.layer === event.layer
    );

    if (activeEntry) {
      appState.activeBasemapKey = activeEntry[0];
      updateBasemapNote(activeEntry[0]);
    }
  });

  updateBasemapNote(appState.activeBasemapKey);
}

function updateBasemapNote(key) {
  const label = BASEMAP_LABELS[key] || BASEMAP_LABELS.gray;
  elements.basemapNote.textContent = `Basemap aktiv: ${label}.`;
}

function bindEvents() {
  bindMobileSheet();

  elements.districtSelect.addEventListener("change", () => {
    applyFilters({ refit: true });
  });

  const debouncedSearch = debounce(() => applyFilters({ refit: false }), 280);

  elements.searchInput.addEventListener("input", () => {
    updateSearchClear();
    debouncedSearch();
  });

  elements.searchClear.addEventListener("click", () => {
    elements.searchInput.value = "";
    updateSearchClear();
    applyFilters({ refit: false });
    elements.searchInput.focus();
  });

  elements.resetButton.addEventListener("click", () => {
    elements.districtSelect.value = "";
    elements.searchInput.value = "";
    updateSearchClear();
    applyFilters({ refit: true });
  });

  elements.focusButton.addEventListener("click", () => {
    fitToRecords(appState.filteredRecords.length ? appState.filteredRecords : appState.allRecords);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && elements.searchInput.value) {
      elements.searchInput.value = "";
      updateSearchClear();
      applyFilters({ refit: false });
    }
  });
}

function bindMobileSheet() {
  syncMobileSheet();

  elements.mobileSheetHandle.addEventListener("click", () => {
    if (!isMobileLayout()) {
      return;
    }

    appState.mobileSheetState = appState.mobileSheetState === "peek" ? "hidden" : "peek";
    syncMobileSheet();
    refreshMapLayout();
  });

  MOBILE_LAYOUT_QUERY.addEventListener("change", () => {
    syncMobileSheet();
    refreshMapLayout();
  });
}

function syncMobileSheet() {
  const mobile = isMobileLayout();
  const expanded = !mobile || appState.mobileSheetState === "peek";
  const toggleLabel = expanded ? "Nur Karte anzeigen" : "Filter und Informationen anzeigen";

  elements.mobileSheet.classList.toggle("is-map-only", mobile && !expanded);
  elements.mobileSheet.classList.toggle("is-peek", mobile && expanded);
  elements.mobileSheetHandle.setAttribute("aria-expanded", String(expanded));
  elements.mobileSheetHandle.setAttribute("aria-label", toggleLabel);
  elements.mobileSheetHandleLabel.textContent = toggleLabel;
  elements.mobileSheetContent.setAttribute("aria-hidden", String(mobile && !expanded));
}

function isMobileLayout() {
  return MOBILE_LAYOUT_QUERY.matches;
}

function refreshMapLayout() {
  if (!appState.map) {
    return;
  }

  requestAnimationFrame(() => {
    appState.map.invalidateSize({ pan: false, animate: false });
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

    // Çift tıklamayı (dblclick) haritaya ilet: Leaflet marker'ları bu olayı
    // varsayılan olarak tüketir (stopPropagation) — bu sayede
    // marker üzerinde çift tıklayınca da harita zoom yapılabilir.
    enriched.marker.on("dblclick", function (e) {
      appState.map.zoomIn(1, { animate: true });
      L.DomEvent.stop(e); // popup açılmasını önle, sadece zoom
    });

    return enriched;
  });

  animateCounter(elements.totalTrees, appState.allRecords.length);
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
  animateCounter(elements.districtCount, districts.length);
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
  const focusLabel = selectedDistrict || (rawQuery ? "Suchergebnis" : "Ganz Köln");

  animateCounter(elements.visibleTrees, records.length);
  animateCounter(elements.districtCount, districtSet.size || DATA_PAYLOAD.districts.length);
  elements.focusLabel.textContent = focusLabel;
  elements.focusButton.disabled = records.length === 0;

  if (!records.length) {
    elements.statusText.textContent = "Keine passenden Kirschbäume gefunden. Erweitere die Filter.";
    return;
  }

  const headline = selectedDistrict
    ? `${selectedDistrict}: ${NUMBER_FORMAT.format(records.length)} Bäume sichtbar.`
    : `${NUMBER_FORMAT.format(records.length)} Kirschbäume aktiv.`;

  if (rawQuery) {
    elements.statusText.textContent = `${headline} Suche: "${rawQuery}".`;
    return;
  }

  elements.statusText.textContent = headline;
}

function fitToRecords(records) {
  if (!records.length) {
    if (appState.allBounds) {
      appState.map.fitBounds(appState.allBounds.pad(0.05), {
        ...getMapPadding(),
        animate: true,
        duration: 0.8,
      });
    }
    return;
  }

  const bounds = L.latLngBounds(records.map((record) => [record.lat, record.lon]));
  appState.map.fitBounds(bounds.pad(0.12), {
    ...getMapPadding(),
    animate: true,
    duration: 0.8,
  });
}

/**
 * Berechnet das Karten-Padding basierend auf dem aktuellen Viewport.
 * Auf Desktop ist das Sidebar-Panel links (420px breit).
 * Auf Mobile richtet sich das Padding nach dem Bottom-Sheet-Zustand.
 */
function getMapPadding() {
  const isMobile = window.matchMedia("(max-width: 720px)").matches;
  if (isMobile) {
    const panelH =
      appState.mobileSheetState === "hidden" ? 28 : Math.min(window.innerHeight * 0.33, 260);
    return {
      paddingTopLeft: [16, 16],
      paddingBottomRight: [16, panelH],
    };
  }
  return {
    paddingTopLeft: [430, 24],
    paddingBottomRight: [24, 24],
  };
}

function createClusterIcon(cluster) {
  const count = cluster.getChildCount();
  const size = count < 25 ? 62 : count < 100 ? 72 : 84;

  return L.divIcon({
    className: "cluster-icon",
    iconSize: [size, size],
    html: `
      <div class="cluster-shell" style="width:${size}px;height:${size}px">
        ${createBlossomSvg("", "-c")}
        <span class="cluster-count">${NUMBER_FORMAT.format(count)}</span>
      </div>
    `,
  });
}

function createPopupMarkup(record) {
  const rows = [
    popupRow("Stadtteil", record.district),
    popupRow("Straße", record.street),
    popupRow("Baumnummer", record.treeNumber),
    popupRow("Pflanzjahr", record.plantedYear),
    popupRow("Höhe", formatMetric(record.heightM, "m")),
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

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function animateCounter(element, toValue, duration = 520) {
  const raw = element.textContent.replace(/[\s.]/g, "");
  const fromParsed = parseInt(raw, 10);
  /* Beim ersten Load ist textContent "-" → NaN → von 0 starten für Animation */
  const from = isNaN(fromParsed) ? 0 : fromParsed;
  if (from === toValue) {
    element.textContent = NUMBER_FORMAT.format(toValue);
    return;
  }
  const start = performance.now();
  element.style.animation = "none";
  void element.offsetHeight; // force reflow
  element.style.animation = "metric-pop 0.38s cubic-bezier(0.34, 1.56, 0.64, 1)";
  const step = (now) => {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(from + (toValue - from) * eased);
    element.textContent = NUMBER_FORMAT.format(current);
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function updateSearchClear() {
  const hasValue = elements.searchInput.value.length > 0;
  elements.searchClear.classList.toggle("is-visible", hasValue);
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

function createBlossomSvg(className, idSuffix = "") {
  /* Referenziert globale SVG-Defs (via injectGlobalSvgDefs) — kein
     ID-Konflikt mehr, wenn tausende Marker im DOM sind. */
  return `
    <svg class="${className}" viewBox="0 0 72 72" aria-hidden="true" focusable="false">
      <g transform="translate(36 36)">
        <ellipse rx="12" ry="19" transform="rotate(0) translate(0 -15)" fill="url(#gPetalFill)"></ellipse>
        <ellipse rx="12" ry="19" transform="rotate(72) translate(0 -15)" fill="url(#gPetalFill)"></ellipse>
        <ellipse rx="12" ry="19" transform="rotate(144) translate(0 -15)" fill="url(#gPetalFill)"></ellipse>
        <ellipse rx="12" ry="19" transform="rotate(216) translate(0 -15)" fill="url(#gPetalFill)"></ellipse>
        <ellipse rx="12" ry="19" transform="rotate(288) translate(0 -15)" fill="url(#gPetalFill)"></ellipse>
        <circle r="11" fill="url(#gCenterFill)"></circle>
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

/**
 * Injiziert einmalig globale SVG-Gradienten-Definitionen in den DOM-Body.
 * Dadurch können alle Marker und Cluster-Icons dieselben Gradient-IDs
 * verwenden, ohne Browser-Konflikte durch doppelte IDs im DOM.
 */
function injectGlobalSvgDefs() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
  svg.innerHTML = `
    <defs>
      <radialGradient id="gPetalFill" cx="50%" cy="38%" r="68%">
        <stop offset="0%" stop-color="#fff8fb"/>
        <stop offset="62%" stop-color="#ffc8de"/>
        <stop offset="100%" stop-color="#eb6d9f"/>
      </radialGradient>
      <radialGradient id="gCenterFill" cx="50%" cy="50%" r="70%">
        <stop offset="0%" stop-color="#fff5cf"/>
        <stop offset="100%" stop-color="#f0bb41"/>
      </radialGradient>
    </defs>
  `;
  document.body.prepend(svg);
}
