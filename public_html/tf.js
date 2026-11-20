const DATA_URL = "https://addshore-wikibase-cloud-status.toolforge.org/data";
const OFFICIAL_STATUS_FEED = "https://wmde.github.io/wikibase-cloud-status/index.xml";
const DEFAULT_HISTORY_DAYS = 7;
const MAX_CSV_REQUESTS = 6;
const HISTORY_FETCH_SPACING_MS = 650;
const CSV_TIMEOUT_MS = 8000;
const BASIC_STALE_MS = 3 * 60 * 1000;
const ACTION_STALE_MS = 15 * 60 * 1000;
const INCIDENT_REFRESH_MS = 10 * 60 * 1000;
const BASIC_METRICS = ["cloud_home", "cloud_api", "cradle", "quickstatements", "wb_item"];
const SERVICE_METRICS = [...BASIC_METRICS, "query_response_time", "elastic_response_time"];
const RESPONSE_METRICS = [...BASIC_METRICS, "query_response_time", "elastic_response_time"];
const ACTION_METRICS = ["wb_item_create_time", "query_create_time", "elastic_create_time"];
const ALL_METRICS = [...new Set([...SERVICE_METRICS, ...ACTION_METRICS])];
const LABELS = {
    cloud_home: "Cloud homepage",
    cloud_api: "Platform API",
    cradle: "Cradle",
    quickstatements: "QuickStatements",
    wb_item: "Test item page",
    query_response_time: "Query service",
    elastic_response_time: "Search index",
    wb_item_create_time: "Item write",
    query_create_time: "Query visibility",
    elastic_create_time: "Search visibility",
};
const COLORS = {
    cloud_home: "#36c",
    cloud_api: "#a50",
    cradle: "#396",
    quickstatements: "#7253a3",
    wb_item: "#8b4b73",
    query_response_time: "#54595d",
    elastic_response_time: "#d33",
    wb_item_create_time: "#36c",
    query_create_time: "#396",
    elastic_create_time: "#a50",
};
const EXPECTED_INTERVAL = Object.fromEntries(ALL_METRICS.map(name => [
    name,
    BASIC_METRICS.includes(name) ? 60_000 : 5 * 60_000,
]));
const data = Object.fromEntries(ALL_METRICS.map(name => [name, []]));
const csvCache = new Map();
const missingFiles = new Set();
const fetchFailures = [];
let officialIncidents = [];
let incidentFeedError = "";
const waitingFetches = [];
let activeFetches = 0;
let nextHistoryFetchAt = 0;
let selectedDays = DEFAULT_HISTORY_DAYS;
let maxLoadedDays = 0;
let incidentFeedFetchedAt = null;

function dayUrl(date, metric) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${DATA_URL}/${year}/${month}/${day}/${metric}.csv`;
}

function metricUrls(metric, days = selectedDays) {
    const current = new Date();
    const utcToday = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate());
    const urls = [];
    for (let offset = 0; offset < days; offset++) {
        const date = new Date(utcToday - offset * 86_400_000);
        if (date.getTime() >= Date.UTC(2024, 6, 30)) {
            urls.push(dayUrl(date, metric));
        }
    }
    return urls;
}

async function runFetch(task, paceRequest = false) {
    if (activeFetches >= MAX_CSV_REQUESTS) {
        await new Promise(resolve => waitingFetches.push(resolve));
    } else {
        activeFetches++;
    }
    try {
        if (paceRequest) {
            const waitMs = Math.max(0, nextHistoryFetchAt - Date.now());
            if (waitMs > 0) {
                await new Promise(resolve => setTimeout(resolve, waitMs));
            }
            nextHistoryFetchAt = Math.max(Date.now(), nextHistoryFetchAt) + HISTORY_FETCH_SPACING_MS;
        }
        return await task();
    } finally {
        const next = waitingFetches.shift();
        if (next) {
            next();
        } else {
            activeFetches--;
        }
    }
}

async function fetchCsv(url) {
    let lastError = "unknown network error";
    for (let attempt = 0; attempt < 3; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CSV_TIMEOUT_MS);
        let retryDelay = 300 * (2 ** attempt);
        try {
            const response = await fetch(url, { cache: "no-store", signal: controller.signal });
            if (response.status === 404) {
                missingFiles.add(url);
                return "";
            }
            if (response.ok) {
                return await response.text();
            }
            lastError = `HTTP ${response.status}`;
            if (response.status === 429) {
                const retryAfter = Number(response.headers.get("Retry-After"));
                retryDelay = Number.isFinite(retryAfter) && retryAfter > 0
                    ? Math.min(60_000, retryAfter * 1000)
                    : Math.max(1500, retryDelay);
            }
            if (response.status < 500 && response.status !== 429) {
                break;
            }
        } catch (error) {
            lastError = error.message || String(error);
        } finally {
            clearTimeout(timeout);
        }
        if (attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }
    fetchFailures.push(`${url}: ${lastError}`);
    console.warn(`Could not load CSV: ${url} (${lastError})`);
    return "";
}

async function fetchCsvCached(url, paceRequest = false) {
    if (csvCache.has(url)) {
        return csvCache.get(url);
    }
    const content = await runFetch(() => fetchCsv(url), paceRequest);
    if (content) {
        csvCache.set(url, content);
    }
    return content;
}

function parseRow(date, line) {
    const fields = line.split(",");
    if (fields.length < 2) {
        return null;
    }
    const [year, month, day] = date.split("/").map(Number);
    const [hour, minute, second] = fields[0].split(":").map(Number);
    const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
    const duration = Number(fields[1]);
    const status = fields.length > 2 && fields[2] !== "" ? Number(fields[2]) : null;
    if (!Number.isFinite(timestamp) || !Number.isFinite(duration)) {
        return null;
    }
    return { timestamp, duration, status };
}

async function loadMetric(metric, days = selectedDays) {
    const urls = metricUrls(metric, days);
    const current = new Date();
    const utcToday = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate());
    const firstExtendedDay = utcToday - (DEFAULT_HISTORY_DAYS - 1) * 86_400_000;
    const contents = await Promise.all(urls.map(url => {
        const match = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
        const day = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : utcToday;
        return fetchCsvCached(url, days > DEFAULT_HISTORY_DAYS && day < firstExtendedDay);
    }));
    const rows = [];
    for (const [index, content] of contents.entries()) {
        if (!content) {
            continue;
        }
        const match = urls[index].match(/\/(\d{4}\/\d{2}\/\d{2})\//);
        if (!match) {
            fetchFailures.push(`Unexpected CSV path: ${urls[index]}`);
            continue;
        }
        for (const line of content.split(/\r?\n/)) {
            if (line.trim()) {
                const row = parseRow(match[1], line);
                if (row) {
                    rows.push(row);
                }
            }
        }
    }
    data[metric] = rows.sort((a, b) => a.timestamp - b.timestamp);
}

function parseResolutionDate(item) {
    const category = item.querySelector("category")?.textContent?.trim() || "";
    const match = category.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})$/);
    return match ? Date.parse(`${match[1]}T${match[2]}Z`) : null;
}

function parseIncidentDescription(item) {
    const description = item.querySelector("description")?.textContent || "";
    const parsed = new DOMParser().parseFromString(description, "text/html");
    const paragraphs = [...parsed.querySelectorAll("p")]
        .map(paragraph => (paragraph.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
    const descriptionLabel = paragraphs.findIndex(paragraph => /^description:?$/i.test(paragraph));
    const summary = descriptionLabel >= 0
        ? paragraphs.slice(descriptionLabel + 1).find(paragraph => paragraph.trim())
        : paragraphs.find(paragraph => !/^(expected severity|impact|links|update\d*):?$/i.test(paragraph));
    const text = summary || parsed.body.textContent || "";
    return text
        .replace(/^\s*description\s*/i, "")
        .replace(/https?:\/\/\S+/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 240);
}

function parseIncidentItem(item) {
    const rawTitle = item.querySelector("title")?.textContent?.trim() || "";
    const linkText = item.querySelector("link")?.textContent?.trim() || "";
    const rawDescription = item.querySelector("description")?.textContent || "";
    const descriptionText = new DOMParser().parseFromString(rawDescription, "text/html").body.textContent || rawDescription;
    const publishedAt = Date.parse(item.querySelector("pubDate")?.textContent || "");
    const resolvedAt = parseResolutionDate(item);
    let url;
    try {
        url = new URL(linkText);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || url.hostname !== "wmde.github.io" || !rawTitle || !Number.isFinite(publishedAt)) {
        return null;
    }
    const resolved = /^\[resolved\]/i.test(rawTitle) || Number.isFinite(resolvedAt);
    return {
        title: rawTitle.replace(/^\[(?:resolved|ongoing)\]\s*/i, ""),
        url: url.href,
        publishedAt,
        resolvedAt: Number.isFinite(resolvedAt) ? resolvedAt : null,
        resolved,
        fullPlatformOffline: /\bwhole platform is offline\b/i.test(descriptionText),
        description: parseIncidentDescription(item),
    };
}

async function loadOfficialIncidents() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CSV_TIMEOUT_MS);
    try {
        const response = await fetch(OFFICIAL_STATUS_FEED, { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
            throw new Error(`Official status feed returned HTTP ${response.status}`);
        }
        const xml = new DOMParser().parseFromString(await response.text(), "application/xml");
        if (xml.querySelector("parsererror")) {
            throw new Error("Official status feed returned invalid XML");
        }
        const items = [...xml.querySelectorAll("channel > item")]
            .map(parseIncidentItem)
            .filter(Boolean)
            .sort((a, b) => b.publishedAt - a.publishedAt);
        if (!items.length) {
            throw new Error("Official status feed contained no readable incident reports");
        }
        officialIncidents = items;
        incidentFeedFetchedAt = Date.now();
        incidentFeedError = "";
        return true;
    } catch (error) {
        incidentFeedError = error.message || String(error);
        console.warn("Could not load official status incidents", incidentFeedError);
        return false;
    } finally {
        clearTimeout(timeout);
    }
}

function formatIncidentDate(timestamp) {
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
    }).format(timestamp) + " UTC";
}

function renderIncidentList() {
    const status = document.getElementById("incident_feed_status");
    const list = document.getElementById("incident_list");
    list.replaceChildren();
    if (incidentFeedError) {
        status.textContent = "Official incident history could not be loaded. Probe health above is independent of this feed.";
        const link = document.createElement("a");
        link.href = "https://wmde.github.io/wikibase-cloud-status/";
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Open the official status page ↗";
        list.append(link);
        return;
    }

    const ongoing = officialIncidents.find(incident => !incident.resolved);
    const latestResolved = officialIncidents.find(incident => incident.resolved);
    const featured = [ongoing, latestResolved].filter(Boolean);
    if (featured.length < 2) {
        for (const incident of officialIncidents) {
            if (!featured.includes(incident)) featured.push(incident);
            if (featured.length === 2) break;
        }
    }
    const older = officialIncidents.filter(incident => !featured.includes(incident));
    const updated = incidentFeedFetchedAt
        ? ` Feed fetched ${formatIncidentDate(incidentFeedFetchedAt)}.`
        : "";
    status.textContent = `Official status feed · ${officialIncidents.length} reports.${updated} Feed may be cached for up to 10 minutes.`;
    const renderIncident = (incident, destination) => {
        const article = document.createElement("article");
        article.className = "incident";
        article.dataset.state = incident.resolved ? "resolved" : "ongoing";

        const topline = document.createElement("div");
        topline.className = "incident-topline";
        const meta = document.createElement("span");
        meta.className = "incident-meta";
        meta.textContent = incident.resolvedAt
            ? `${formatIncidentDate(incident.publishedAt)} · Resolved ${formatIncidentDate(incident.resolvedAt)}`
            : formatIncidentDate(incident.publishedAt);
        const state = document.createElement("span");
        state.className = "incident-state";
        state.textContent = incident.resolved ? "Resolved" : "Ongoing";
        topline.append(meta, state);

        const title = document.createElement("h3");
        title.textContent = incident.title;
        article.append(topline, title);
        if (incident.description) {
            const description = document.createElement("p");
            description.textContent = incident.description;
            article.append(description);
        }
        const link = document.createElement("a");
        link.href = incident.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Official incident details ↗";
        article.append(link);
        destination.append(article);
    };
    for (const incident of featured) {
        renderIncident(incident, list);
    }
    if (older.length) {
        const archive = document.createElement("details");
        archive.className = "incident-archive";
        const summary = document.createElement("summary");
        summary.textContent = `Older incidents (${older.length})`;
        const archiveList = document.createElement("div");
        archiveList.className = "incident-list";
        for (const incident of older) {
            renderIncident(incident, archiveList);
        }
        archive.append(summary, archiveList);
        list.append(archive);
    }
}

function incidentEndTime(incident, now = Date.now()) {
    if (Number.isFinite(incident.resolvedAt)) {
        return incident.resolvedAt;
    }
    return incident.resolved ? incident.publishedAt : now;
}

function mergedIncidentClusters() {
    const intervals = officialIncidents.map(incident => ({
        start: incident.publishedAt,
        end: incidentEndTime(incident),
        reports: [incident],
        fullPlatformOffline: incident.fullPlatformOffline,
    })).sort((a, b) => a.start - b.start);
    const clusters = [];
    for (const interval of intervals) {
        const previous = clusters[clusters.length - 1];
        if (previous && interval.start <= previous.end) {
            previous.end = Math.max(previous.end, interval.end);
            previous.reports.push(...interval.reports);
            previous.fullPlatformOffline ||= interval.fullPlatformOffline;
        } else {
            clusters.push(interval);
        }
    }
    return clusters;
}

function selectedHistoryStart(now = Date.now()) {
    return now - selectedDays * 24 * 60 * 60 * 1000;
}

function isUnreliableOutageSample(timestamp) {
    return officialIncidents.some(incident =>
        incident.fullPlatformOffline &&
        timestamp >= incident.publishedAt &&
        timestamp <= incidentEndTime(incident)
    );
}

function latest(metric) {
    const rows = data[metric];
    for (let index = rows.length - 1; index >= 0; index--) {
        if (!isUnreliableOutageSample(rows[index].timestamp)) {
            return rows[index];
        }
    }
    return null;
}

function age(ms) {
    if (ms < 60_000) return "just now";
    const minutes = Math.max(0, Math.floor(ms / 60_000));
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h ${minutes % 60}m`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function duration(ms) {
    if (!Number.isFinite(ms)) return "—";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
    return `${(ms / 60_000).toFixed(1)} min`;
}

function serviceFreshLimit(metric) {
    return BASIC_METRICS.includes(metric)
        ? BASIC_STALE_MS
        : Math.max(ACTION_STALE_MS, EXPECTED_INTERVAL[metric] * 3);
}

function getServiceState(metric, now = Date.now()) {
    const row = latest(metric);
    if (!row || now - row.timestamp > serviceFreshLimit(metric) || (row.status !== 0 && row.status !== 1)) {
        return { state: "unknown", label: "No recent result", row };
    }
    return row.status === 1
        ? { state: "up", label: "Operational", row }
        : { state: "down", label: "Check failed", row };
}

function renderServiceTrend(metric) {
    const trend = document.createElement("span");
    trend.className = "service-trend";
    const now = Date.now();
    const recent = data[metric]
        .filter(row => row.duration > 0 && row.timestamp >= now - 6 * 60 * 60 * 1000)
        .slice(-80);

    if (recent.length < 2) {
        const empty = document.createElement("span");
        empty.textContent = "—";
        empty.setAttribute("aria-label", "Not enough samples for a trend");
        trend.append(empty);
    } else {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "service-sparkline");
        svg.setAttribute("viewBox", "0 0 96 26");
        svg.setAttribute("role", "img");
        svg.setAttribute("aria-label", `${LABELS[metric]} response time trend over the last six hours`);
        const logs = recent.map(row => Math.log10(Math.max(1, row.duration)));
        const min = Math.min(...logs);
        const max = Math.max(...logs);
        const span = max - min || 1;
        const first = recent[0].timestamp;
        const last = recent[recent.length - 1].timestamp;
        const timeSpan = last - first || 1;
        const gapLimit = Math.max(EXPECTED_INTERVAL[metric] * 4, 3 * 60_000);
        let pathData = "";
        for (let index = 0; index < recent.length; index++) {
            const row = recent[index];
            const previous = recent[index - 1];
            const x = 3 + ((row.timestamp - first) / timeSpan) * 90;
            const y = 22 - ((logs[index] - min) / span) * 18;
            pathData += !previous || row.timestamp - previous.timestamp > gapLimit ? `M ${x} ${y} ` : `L ${x} ${y} `;
        }
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", pathData.trim());
        svg.append(path);
        trend.append(svg);
    }

    const current = latest(metric);
    const latency = document.createElement("span");
    latency.textContent = current ? duration(current.duration) : "—";
    trend.append(latency);
    return trend;
}

function renderServiceList() {
    const list = document.getElementById("service_list");
    list.replaceChildren();
    for (const metric of SERVICE_METRICS) {
        const result = getServiceState(metric);
        const row = document.createElement("div");
        row.className = "service-row";
        row.dataset.state = result.state;

        const name = document.createElement("span");
        name.className = "service-name";
        name.textContent = LABELS[metric];

        const state = document.createElement("span");
        state.className = "service-state";
        const dot = document.createElement("span");
        dot.className = "service-dot";
        dot.setAttribute("aria-hidden", "true");
        const stateText = document.createElement("span");
        stateText.textContent = result.label;
        state.append(dot, stateText);

        const trend = renderServiceTrend(metric);
        const time = document.createElement("span");
        time.className = "service-time";
        time.textContent = result.row
            ? `Last checked ${age(Date.now() - result.row.timestamp)}`
            : "No observation in this range";
        row.append(name, state, trend, time);
        list.append(row);
    }
}

function updateStatus() {
    const now = Date.now();
    const states = SERVICE_METRICS.map(metric => ({ metric, ...getServiceState(metric, now) }));
    const down = states.filter(item => item.state === "down");
    const unknown = states.filter(item => item.state === "unknown");
    const lastBasic = BASIC_METRICS.map(latest).filter(Boolean).reduce((max, row) => Math.max(max, row.timestamp), 0);
    const banner = document.getElementById("monitoring_badge");
    const statusText = document.getElementById("monitoring_state");
    const updatedText = document.getElementById("last_updated");
    const notice = document.getElementById("data_status");
    const title = notice.querySelector(".notice-title");
    const detail = notice.querySelector(".notice-detail");

    let state;
    let headline;
    if (down.length) {
        state = "down";
        headline = "Some checks are failing";
        title.textContent = `${down.length} service check(s) failed recently`;
        detail.textContent = `${down.map(item => LABELS[item.metric]).join(", ")}. Check timestamps and the timeline below.`;
    } else if (unknown.length || fetchFailures.length) {
        state = "stale";
        headline = "Monitoring data incomplete";
        title.textContent = "Some services have unknown status";
        detail.textContent = `${unknown.length} service check(s) have no recent result. Missing CSVs are collection gaps, not evidence of uptime or downtime.`;
    } else {
        state = "healthy";
        headline = "All monitored checks passing";
        title.textContent = "All recent checks are green";
        detail.textContent = `${states.length} independent probes have fresh successful results.`;
    }

    banner.dataset.state = state;
    notice.dataset.state = state;
    statusText.textContent = headline;
    updatedText.textContent = lastBasic ? `Last basic check ${age(now - lastBasic)} ago` : "No recent basic checks";
    if (missingFiles.size) {
        const missingDates = new Set([...missingFiles].map(url => url.match(/\/(\d{4}\/\d{2}\/\d{2})\//)?.[1]).filter(Boolean));
        const dayLabel = missingDates.size === 1 ? "day" : "days";
        detail.textContent += ` No monitoring records for ${missingFiles.size} service checks across ${missingDates.size} ${dayLabel}; their status during that time is unknown.`;
    }
    if (fetchFailures.length) {
        detail.textContent += ` ${fetchFailures.length} CSV request(s) failed; see browser console.`;
    }

}

function rowsInRange(metric) {
    const cutoff = selectedHistoryStart();
    return data[metric].filter(row => row.timestamp >= cutoff && !isUnreliableOutageSample(row.timestamp));
}

function monitorOnlyGaps(start, end, upstreamClusters) {
    const sampleTimes = [...new Set(BASIC_METRICS.flatMap(metric => data[metric])
        .map(row => Math.floor(row.timestamp / 60_000) * 60_000)
        .filter(timestamp => timestamp >= start && timestamp <= end))].sort((a, b) => a - b);
    if (!sampleTimes.length) return [];

    const gaps = [];
    const threshold = 4 * 60_000;
    const expectedStep = 60_000;
    for (let index = 1; index < sampleTimes.length; index++) {
        const previous = sampleTimes[index - 1];
        const current = sampleTimes[index];
        if (current - previous > threshold) {
            gaps.push({ start: previous + expectedStep, end: current - expectedStep });
        }
    }
    const latestSample = sampleTimes[sampleTimes.length - 1];
    if (end - latestSample > threshold) {
        gaps.push({ start: latestSample + expectedStep, end });
    }

    const visibleGaps = [];
    for (const gap of gaps) {
        let cursor = gap.start;
        for (const incident of upstreamClusters.filter(item => item.fullPlatformOffline)) {
            if (incident.end <= cursor || incident.start >= gap.end) continue;
            if (incident.start > cursor) {
                visibleGaps.push({ start: cursor, end: Math.min(incident.start, gap.end) });
            }
            cursor = Math.max(cursor, incident.end);
            if (cursor >= gap.end) break;
        }
        if (cursor < gap.end) {
            visibleGaps.push({ start: cursor, end: gap.end });
        }
    }
    return visibleGaps.filter(gap => gap.end > gap.start);
}

function layout(yaxis = {}) {
    const now = Date.now();
    const start = selectedHistoryStart(now);
    const incidents = mergedIncidentClusters().filter(item => item.end >= start && item.start <= now);
    const monitorGaps = monitorOnlyGaps(start, now, incidents);
    return {
        autosize: true,
        margin: { l: 58, r: 16, t: 12, b: 62 },
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
        font: { family: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif", color: "#54595d", size: 11 },
        hovermode: "x unified",
        xaxis: {
            type: "date",
            range: [new Date(start).toISOString(), new Date(now).toISOString()],
            gridcolor: "#eaecf0",
            linecolor: "#c8ccd1",
            hoverformat: "%a, %b %d %H:%M UTC",
            tickfont: { color: "#54595d" },
            zeroline: false,
        },
        yaxis: { gridcolor: "#eaecf0", tickfont: { color: "#54595d" }, zeroline: false, ...yaxis },
        legend: { orientation: "h", x: 0, y: -0.28, font: { size: 10, color: "#54595d" } },
        shapes: [
            ...incidents.map(item => ({
                type: "rect", xref: "x", yref: "paper",
                x0: new Date(item.start).toISOString(), x1: new Date(item.end).toISOString(),
                y0: 0, y1: 1,
                fillcolor: item.fullPlatformOffline ? "rgba(179, 36, 36, 0.08)" : "rgba(172, 102, 0, 0.07)",
                line: { width: 0 }, layer: "below",
            })),
            ...monitorGaps.map(gap => ({
                type: "rect", xref: "x", yref: "paper",
                x0: new Date(gap.start).toISOString(), x1: new Date(gap.end).toISOString(),
                y0: 0, y1: 1, fillcolor: "rgba(84, 89, 93, 0.08)",
                line: { color: "rgba(84, 89, 93, 0.45)", width: 1, dash: "dot" }, layer: "below",
            })),
        ],
        annotations: [
            ...incidents.map(item => ({
                x: new Date(item.start).toISOString(), y: 1, xref: "x", yref: "paper",
                text: `${item.fullPlatformOffline ? "Official outage" : "Official incident"} (${item.reports.length} reports)`, showarrow: false, xanchor: "left", yanchor: "bottom",
                font: { size: 10, color: item.fullPlatformOffline ? "#8a1f11" : "#8a5a00" }, bgcolor: "rgba(255,255,255,0.9)", borderpad: 2,
            })),
            ...monitorGaps.map(gap => ({
                x: new Date((gap.start + gap.end) / 2).toISOString(), y: 0.04, xref: "x", yref: "paper",
                text: "Monitor gap · no samples", showarrow: false, xanchor: "center", yanchor: "bottom",
                font: { size: 11, color: "#3f454a" }, bgcolor: "rgba(255,255,255,0.96)",
                bordercolor: "rgba(84,89,93,0.5)", borderwidth: 1, borderpad: 3,
            })),
        ],
    };
}

function responseTrace(metric) {
    const rows = rowsInRange(metric).filter(row => row.duration > 0);
    if (!rows.length) return null;
    const expected = EXPECTED_INTERVAL[metric];
    const x = [];
    const y = [];
    let previous = null;
    for (const row of rows) {
        if (previous && row.timestamp - previous.timestamp > Math.max(expected * 4, 3 * 60_000)) {
            x.push(null);
            y.push(null);
        }
        x.push(new Date(row.timestamp));
        y.push(row.duration);
        previous = row;
    }
    return {
        x, y, type: "scatter", mode: "lines",
        connectgaps: false,
        name: LABELS[metric],
        line: { color: COLORS[metric], width: 2 },
        hovertemplate: "%{x|%b %d %H:%M:%S}<br>%{y:.0f} ms<extra>%{fullData.name}</extra>",
    };
}

function availabilityTrace(metric, serviceIndex) {
    const rows = rowsInRange(metric).filter(row => row.status === 0 || row.status === 1);
    if (!rows.length) return null;
    return {
        x: rows.map(row => new Date(row.timestamp)),
        y: rows.map(() => serviceIndex),
        type: "scatter", mode: "markers", name: LABELS[metric],
        marker: { size: 8, color: rows.map(row => row.status ? "#14866d" : "#b32424") },
        customdata: rows.map(row => row.status ? "Successful probe" : "Failed probe"),
        hovertemplate: "%{x|%b %d %H:%M:%S}<br>%{customdata}<extra>%{fullData.name}</extra>",
    };
}

function renderCharts(initial = false) {
    const plots = [
        [
            "availability_chart",
            SERVICE_METRICS.map((metric, index) => availabilityTrace(metric, index)).filter(Boolean),
            layout({
                tickmode: "array",
                tickvals: SERVICE_METRICS.map((_, index) => index),
                ticktext: SERVICE_METRICS.map(metric => LABELS[metric]),
                range: [SERVICE_METRICS.length - 0.5, -0.5],
            }),
        ],
        ["latency_chart", RESPONSE_METRICS.map(responseTrace).filter(Boolean), layout({ title: "Milliseconds", type: "log", rangemode: "tozero" })],
        ["item_chart", [responseTrace("wb_item_create_time")].filter(Boolean), layout({ title: "Milliseconds", type: "log", rangemode: "tozero" })],
        ["propagation_chart", [responseTrace("query_create_time"), responseTrace("elastic_create_time")].filter(Boolean), layout({ title: "Milliseconds", type: "log", rangemode: "tozero" })],
    ];
    const config = { responsive: true, displayModeBar: false };
    return Promise.all(plots.map(([id, traces, chartLayout]) => initial
        ? Plotly.newPlot(id, traces, chartLayout, config)
        : Plotly.react(id, traces, chartLayout, config)));
}

async function setRange(days, button) {
    selectedDays = Number(days);
    for (const control of document.querySelectorAll("[data-range]")) {
        control.setAttribute("aria-pressed", String(control === button));
    }
    const historyStatus = document.getElementById("history_load_status");
    if (selectedDays > maxLoadedDays) {
        historyStatus.textContent = `Loading ${selectedDays} days of samples…`;
        await Promise.all(ALL_METRICS.map(metric => loadMetric(metric, selectedDays)));
        maxLoadedDays = selectedDays;
        renderServiceList();
    }
    historyStatus.textContent = `Showing the last ${selectedDays} days`;
    updateStatus();
    await renderCharts(false);
}

async function initialize() {
    await Promise.all([
        loadOfficialIncidents(),
        ...ALL_METRICS.map(metric => loadMetric(metric, selectedDays)),
    ]);
    maxLoadedDays = selectedDays;
    renderServiceList();
    renderIncidentList();
    updateStatus();
    document.getElementById("history_load_status").textContent = `Showing the last ${selectedDays} days`;
    await renderCharts(true);
    for (const button of document.querySelectorAll("[data-range]")) {
        button.addEventListener("click", () => setRange(button.dataset.range, button));
    }
    setInterval(async () => {
        await loadOfficialIncidents();
        renderIncidentList();
        updateStatus();
        await renderCharts(false);
    }, INCIDENT_REFRESH_MS);
}

document.addEventListener("DOMContentLoaded", () => {
    initialize().catch(error => {
        console.error("Status page failed to initialize", error);
        document.getElementById("monitoring_badge").dataset.state = "stale";
        document.getElementById("monitoring_state").textContent = "Monitor data unavailable";
        const notice = document.getElementById("data_status");
        notice.dataset.state = "stale";
        notice.querySelector(".notice-title").textContent = "Unable to load monitor data";
        notice.querySelector(".notice-detail").textContent = error.message || String(error);
    });
});
