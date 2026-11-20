const webserviceURL = "https://addshore-wikibase-cloud-status.toolforge.org/data"
const DAYS_TO_SHOW = 7;
const BASIC_CHECK_NAMES = ['cloud_home', 'cloud_api', 'cradle', 'quickstatements', 'wb_item'];

const urlForDateDay = (date, name) => {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${webserviceURL}/${year}/${month}/${day}/${name}.csv`;
}

const genUrls = (name, days = DAYS_TO_SHOW) => {
    const collection = [];
    for (let i = 0; i < days; i++) {
        const date = new Date();
        date.setUTCDate(date.getUTCDate() - i);
        if (date < new Date(Date.UTC(2024, 6, 30))) {
            console.log(`Ignoring ${date.toISOString()} as it is before 30 July 2024`);
            continue;
        }
        collection.push(urlForDateDay(date, name));
    }
    return collection;
}

const checkFiles = {
    cloud_home: genUrls('cloud_home'),
    cloud_api: genUrls('cloud_api'),
    cradle: genUrls('cradle'),
    elastic_response_time: genUrls('elastic_response_time'),
    query_response_time: genUrls('query_response_time'),
    quickstatements: genUrls('quickstatements'),
    wb_item: genUrls('wb_item')
};

const dataCache = {};
const dataLoadPromises = {};
const dataFetchFailures = [];

const fetchCsv = async (file) => {
    let lastError = "unknown error";
    for (let attempt = 0; attempt < 3; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
            const response = await fetch(file, { cache: 'no-store', signal: controller.signal });
            if (response.ok) {
                return await response.text();
            }
            if (response.status === 404) {
                return "";
            }
            lastError = `HTTP ${response.status}`;
            if (response.status < 500 && response.status !== 429) {
                break;
            }
        } catch (error) {
            lastError = error.message || String(error);
        } finally {
            clearTimeout(timeout);
        }
        if (attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 250 * (2 ** attempt)));
        }
    }
    dataFetchFailures.push(`${file}: ${lastError}`);
    console.error(`Unable to fetch ${file}: ${lastError}`);
    return "";
};

const fetchAndCache = async (name) => {
    const files = genUrls(name);
    const data = await Promise.all(files.map(async (file) => {
        await new Promise(resolve => setTimeout(resolve, Math.random() * 100));
        return fetchCsv(file);
    }));

    for (const [index, file] of files.entries()) {
        if (data[index] === "") {
            continue;
        }
        const dateMatch = file.match(/\/(\d{4}\/\d{2}\/\d{2})\//);
        if (!dateMatch) {
            dataFetchFailures.push(`Unexpected CSV path: ${file}`);
            continue;
        }
        const date = dateMatch[1];
        data[index] = data[index].split('\n').filter(row => row.trim() !== "").map(row => `${date} ${row}`);
    }
    dataCache[name] = data.flat();
    dataCache[name].sort((a, b) => a.split(',')[0].localeCompare(b.split(',')[0]));
};

const fetchCached = (name) => {
    if (!dataLoadPromises[name]) {
        dataLoadPromises[name] = fetchAndCache(name);
    }
    return dataLoadPromises[name].then(() => dataCache[name] || []);
};

parseRowTimestamp = (row) => {
    const [date, time] = row.split(',')[0].split(' ');
    if (!date || !time) {
        return null;
    }
    const [year, month, day] = date.split('/').map(Number);
    const [hour, minute, second] = time.split(':').map(Number);
    if (![year, month, day, hour, minute, second].every(Number.isFinite)) {
        return null;
    }
    return Date.UTC(year, month - 1, day, hour, minute, second);
};

formatAge = (milliseconds) => {
    const minutes = Math.max(0, Math.floor(milliseconds / 60000));
    if (minutes < 60) {
        return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    }
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (hours < 48) {
        return `${hours} hour${hours === 1 ? '' : 's'} ${remainingMinutes} min`;
    }
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ${hours % 24} hr`;
};

updateDataFreshness = () => {
    const status = document.getElementById('data_status');
    if (!status) {
        return;
    }

    const latestFor = (name) => {
        const timestamps = (dataCache[name] || []).map(parseRowTimestamp).filter(Number.isFinite);
        return timestamps.length ? Math.max(...timestamps) : null;
    };
    const now = Date.now();
    const basicSamples = BASIC_CHECK_NAMES.map(name => ({ name, timestamp: latestFor(name) }));
    const presentBasicSamples = basicSamples.filter(sample => sample.timestamp !== null);
    const latestBasic = presentBasicSamples.length
        ? Math.max(...presentBasicSamples.map(sample => sample.timestamp))
        : null;
    const staleBasic = basicSamples.filter(sample => sample.timestamp === null || now - sample.timestamp > 3 * 60 * 1000);
    const actionNames = ['wb_item_create_time', 'query_create_time', 'elastic_create_time'];
    const actionSamples = actionNames.map(name => ({ name, timestamp: latestFor(name) }));
    const presentActionSamples = actionSamples.filter(sample => sample.timestamp !== null);
    const latestAction = presentActionSamples.length
        ? Math.max(...presentActionSamples.map(sample => sample.timestamp))
        : null;
    const staleAction = actionSamples.filter(sample => sample.timestamp === null || now - sample.timestamp > 20 * 60 * 1000);

    const messages = [];
    if (latestBasic === null) {
        messages.push('No basic endpoint-check data is available.');
    } else {
        messages.push(`Latest basic endpoint check: ${formatAge(now - latestBasic)} ago (${new Date(latestBasic).toLocaleString()}).`);
    }
    if (latestAction === null) {
        messages.push('No item/action-check data is available.');
    } else {
        messages.push(`Latest item/action check: ${formatAge(now - latestAction)} ago (${new Date(latestAction).toLocaleString()}).`);
    }
    if (staleBasic.length || staleAction.length) {
        status.dataset.state = 'stale';
        messages.unshift('STALE DATA — green points are historical and do not show current service health.');
    } else {
        status.dataset.state = dataFetchFailures.length ? 'error' : 'ok';
    }
    if (dataFetchFailures.length) {
        messages.push(`${dataFetchFailures.length} CSV request(s) failed; see the browser console for details.`);
    }
    status.textContent = messages.join(' ');
};

const metricNames = [...new Set([
    ...Object.keys(checkFiles),
    'query_create_time',
    'elastic_create_time',
    'wb_item_create_time',
])];
for (const name of metricNames) {
    dataLoadPromises[name] = fetchAndCache(name);
}
Promise.all(Object.values(dataLoadPromises)).then(updateDataFreshness);

populateGeneralServiceResponseTimeGraph = async () => {
    let minuites = [];
    let sumPerMinute = {};
    let countPerMinute = {};

    // For each of the checkFiles, fetch the data and plot it
    for (const [name, files] of Object.entries(checkFiles)) {
        const allData = await fetchCached(name);

        const response_time = {
            x: allData.map(row => new Date(row.split(',')[0])),
            y: allData.map(row => row.split(',')[1]),
            mode: 'line',
            name,
            type: 'scatter'
        };
        Plotly.addTraces('response_time', [response_time]);

        // Add a point whenever the check fails
        const checkFailures = allData.filter(row => row.split(',')[2] === '0');
        const checkSuccess = allData.filter(row => row.split(',')[2] === '1');
        const checkFailurePoints = {
            x: checkFailures.map(row => new Date(row.split(',')[0])),
            y: checkFailures.map(row => -1),
            mode: 'markers',
            name: name,
            type: 'bar',
            marker: {
                color: 'red'
            },
        };
        const checkSuccessPoints = {
            x: checkSuccess.map(row => new Date(row.split(',')[0])),
            y: checkSuccess.map(row => 1),
            mode: 'markers',
            name: name,
            type: 'bar',
            marker: {
                color: 'lightgreen'
            },
        };
        Plotly.addTraces('upornot_time', [checkFailurePoints]);
        Plotly.addTraces('upornot_time', [checkSuccessPoints]);

        // Calculate the sum and count per minute
        for (const row of allData) {
            const minute = row.split(',')[0].slice(0, 16);
            minuites.push(minute);
            if (!sumPerMinute[minute]) {
                sumPerMinute[minute] = 0;
                countPerMinute[minute] = 0;
            }
            sumPerMinute[minute] += parseInt(row.split(',')[1]);
            countPerMinute[minute]++;
        }
    }

    // Calculate and plot the average per minute
    const averagePerMinute = [];
    for (const minute of [...new Set(minuites)]) {
        averagePerMinute.push(sumPerMinute[minute] / countPerMinute[minute]);
    }
    const average_response_time = {
        x: [...new Set(minuites)].map(minute => new Date(minute)),
        y: averagePerMinute,
        mode: 'line',
        name: 'overall average',
        type: 'scatter'
    };
    Plotly.addTraces('response_time', [average_response_time]);

    // Also plot the 15 minute moving average of the average
    const movingAverage = [];
    for (let i = 0; i < averagePerMinute.length; i++) {
        let sum = 0;
        let count = 0;
        for (let j = Math.max(0, i - 14); j <= i; j++) {
            sum += averagePerMinute[j];
            count++;
        }
        movingAverage.push(sum / count);
    }
    const moving_average_line = {
        x: [...new Set(minuites)].map(minute => new Date(minute)),
        y: movingAverage,
        mode: 'line',
        name: '15min avg',
        type: 'scatter'
    };
    Plotly.addTraces('response_time', [moving_average_line]);
};

populateQueryServiceGraph = async () => {
    const allData = await fetchCached('query_create_time');
    const query_create_time = {
        x: allData.map(row => new Date(row.split(',')[0])),
        y: allData.map(row => row.split(',')[1]),
        mode: 'line',
        name: 'queryservice',
        type: 'scatter'
    };
    Plotly.addTraces('query_create_time', [query_create_time]);

    // add a 15 min moving average
    const movingAverage = [];
    for (let i = 0; i < allData.length; i++) {
        let sum = 0;
        let count = 0;
        for (let j = Math.max(0, i - 14); j <= i; j++) {
            sum += parseInt(allData[j].split(',')[1]);
            count++;
        }
        movingAverage.push(sum / count);
    }
    const moving_average_line = {
        x: allData.map(row => new Date(row.split(',')[0])),
        y: movingAverage,
        mode: 'line',
        name: 'queryservice 15min AVG',
        type: 'scatter'
    };
    Plotly.addTraces('query_create_time', [moving_average_line]);

    // Add a point whenever the query service is down
    const queryServiceDown = allData.filter(row => row.split(',')[2] === '0');
    const queryServiceDownPoints = {
        x: queryServiceDown.map(row => new Date(row.split(',')[0])),
        y: queryServiceDown.map(row => 1000), /// 100 seems a good height?
        mode: 'markers',
        name: 'Failed to find queryservice',
        type: 'scatter',
        marker: {
            size: 15,
            color: 'red'
        }
    };
    Plotly.addTraces('query_create_time', [queryServiceDownPoints]);
}


populateElasticGraph = async () => {
    const allData = await fetchCached('elastic_create_time');
    const elastic_create_time = {
        x: allData.map(row => new Date(row.split(',')[0])),
        y: allData.map(row => row.split(',')[1]),
        mode: 'line',
        name: 'elastic',
        type: 'scatter'
    };
    Plotly.addTraces('query_create_time', [elastic_create_time]);

    // add a 15 min moving average
    const movingAverage = [];
    for (let i = 0; i < allData.length; i++) {
        let sum = 0;
        let count = 0;
        for (let j = Math.max(0, i - 14); j <= i; j++) {
            sum += parseInt(allData[j].split(',')[1]);
            count++;
        }
        movingAverage.push(sum / count);
    }
    const moving_average_line = {
        x: allData.map(row => new Date(row.split(',')[0])),
        y: movingAverage,
        mode: 'line',
        name: 'elastic 15min AVG',
        type: 'scatter'
    };
    Plotly.addTraces('query_create_time', [moving_average_line]);

    // Add a point whenever the elastic service is down
    const elasticServiceDown = allData.filter(row => row.split(',')[2] === '0');
    const elasticServiceDownPoints = {
        x: elasticServiceDown.map(row => new Date(row.split(',')[0])),
        y: elasticServiceDown.map(row => 1000), /// 100 seems a good height?
        mode: 'markers',
        name: 'Failed to find elastic',
        type: 'scatter',
        marker: {
            size: 15,
            color: 'red'
        }
    };
    Plotly.addTraces('query_create_time', [elasticServiceDownPoints]);
}

populateItemCreationGraph = async () => {
    const allData = await fetchCached('wb_item_create_time');
    const item_create_time = {
        x: allData.map(row => new Date(row.split(',')[0])),
        y: allData.map(row => row.split(',')[1]),
        mode: 'line',
        name: 'actual',
        type: 'scatter'
    };
    Plotly.addTraces('item_create_time', [item_create_time]);

    // add a 15 min moving average
    const movingAverage = [];
    for (let i = 0; i < allData.length; i++) {
        let sum = 0;
        let count = 0;
        for (let j = Math.max(0, i - 14); j <= i; j++) {
            sum += parseInt(allData[j].split(',')[1]);
            count++;
        }
        movingAverage.push(sum / count);
    }
    const moving_average_line = {
        x: allData.map(row => new Date(row.split(',')[0])),
        y: movingAverage,
        mode: 'line',
        name: '15min AVG',
        type: 'scatter'
    };
    Plotly.addTraces('item_create_time', [moving_average_line]);

    // Add a point whenever the item creation is down
    const itemCreationDown = allData.filter(row => row.split(',')[2] === '0');
    const itemCreationDownPoints = {
        x: itemCreationDown.map(row => new Date(row.split(',')[0])),
        y: itemCreationDown.map(row => 1000), /// 100 seems a good height?
        mode: 'markers',
        name: 'Failed to create',
        type: 'scatter',
        marker: {
            size: 15,
            color: 'red'
        }
    };
    Plotly.addTraces('item_create_time', [itemCreationDownPoints]);
}

document.addEventListener("DOMContentLoaded", async function() {
    await Promise.all([
        Plotly.newPlot('response_time', [], {
            title: { text: 'Response times' },
            xaxis: {},
            yaxis: { title: 'Time (ms)', rangemode: 'tozero', type: 'log' }
        }),
        Plotly.newPlot('upornot_time', [], {
            title: { text: 'Status' },
            xaxis: {},
            yaxis: { ticktext: ['down', 'up'], tickvals: [-1, 1] }
        }),
        Plotly.newPlot('query_create_time', [], {
            title: { text: 'Item creation, to appearance in services' },
            xaxis: {},
            yaxis: { title: 'Time (ms)', rangemode: 'tozero', type: 'log' }
        }),
        Plotly.newPlot('item_create_time', [], {
            title: { text: 'Item creation' },
            xaxis: {},
            yaxis: { title: 'Time (ms)', rangemode: 'tozero', type: 'log' }
        })
    ]);
    await Promise.all([
        populateGeneralServiceResponseTimeGraph(),
        populateQueryServiceGraph(),
        populateElasticGraph(),
        populateItemCreationGraph()
    ]);
    updateDataFreshness();
});