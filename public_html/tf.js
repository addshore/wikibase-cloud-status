const webserviceURL = "https://addshore-wikibase-cloud-status.toolforge.org/data"
const toolsStaticURL = "https://tools-static.wmflabs.org/addshore-wikibase-cloud-status/data"
const isBrowserTools = window.location.hostname == "addshore-wikibase-cloud-status.toolforge.org"

urlForDateDay = (date, name) => {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');

    isCurrentDay = date.toDateString() === new Date().toDateString();
    // I get CORS errors for these requests, even when making them from a toolforge hosted site..
    // if (!isCurrentDay && isBrowserTools) {
    //     return `${toolsStaticURL}/${year}/${month}/${day}/${name}.csv`;
    // }
    return `${webserviceURL}/${year}/${month}/${day}/${name}.csv`;
}

genUrls = (name, days = 7) => {
    let collection = [];
    for (let i = 0; i < days; i++) {
        const date = new Date();
        date.setUTCDate(date.getUTCDate() - i);
        // If the date is before 30 July 2024 ignore it as there is no data
        // XXX: and if we start having to retrieve all these file,s we hit 429s? D:
        if (date < new Date('2024-07-30')) {
            console.log(`Ignoring ${date.toISOString()} as it is before 30 July 2024`);
            continue;
        }
        // If the date is before 26th August, then we need to use the per day files
        if (date < new Date('2024-08-26')) {
            console.log(`Adding ${urlForDateDay(date, name)}`);
            collection.push(urlForDateDay(date, name));
            continue;
        }
        // If the date is the 26th august onwared, we use the weekly files, where the directory is url/year/weeknumber/name.csv
        // We only need to do this once per week
        const year = date.getUTCFullYear();
        const weekNumber = Math.ceil((date - new Date(year, 0, 1)) / 86400000 / 7);
        if (i === 0 || date.getUTCDay() === 1) {
            console.log(`Adding ${webserviceURL}/${year}/${weekNumber}/${name}.csv`);
            collection.push(`${webserviceURL}/${year}/${weekNumber}/${name}.csv`);
        }
    }
    return collection;
}// Wait for the DOM to load

const checkFiles = {
    cloud_home: genUrls('cloud_home'),
    cloud_api: genUrls('cloud_api'),
    cradle: genUrls('cradle'),
    elastic_response_time: genUrls('elastic_response_time'),
    query_response_time: genUrls('query_response_time'),
    quickstatements: genUrls('quickstatements'),
    wb_item: genUrls('wb_item')
};

let dataCache = {};
fetchCached = async (name) => {
    let retries = 0;
    while (!dataCache[name] && retries < 100) {
        console.log(`Waiting for ${name} data...`);
        await new Promise(resolve => setTimeout(resolve, 50));
        retries++;
    }
    if (dataCache[name]) {
        return dataCache[name];
    } else {
        throw new Error(`No data for ${name}`);
    }
};
fetchAndCache = async (name) => {
    const files = genUrls(name);
    const data = await Promise.all(files.map(async (file) => {
        // Add a random delay to avoid hitting the rate limit
        await new Promise(resolve => setTimeout(resolve, Math.random() * 100));
        attempts = 1;
        const response = await fetch(file);
        if (response.ok) {
            return response.text();
        } else if (response.status === 429) {
            // TODO, could retry here, but for now just return empty
            console.log(`429 for ${file}`);
            return "";
        } else {
            console.log(`Failed to fetch ${file}`);
            return "";
        }
    }));

    for (const [index, file] of files.entries()) {
        if (data[index] === "") {
            continue;
        }
        // Add the dates to each line
        const date = files[index].match(/\/(\d{4}\/\d{2}\/\d{2})\//)[1];
        data[index] = data[index].split('\n').filter(row => row.trim() !== "").map(row => `${date} ${row}`);
    }
    dataCache[name] = data.flat();
    // sort the lines by date
    dataCache[name].sort((a, b) => a.split(',')[0].localeCompare(b.split(',')[0]));
};

// Retrieve and cache the checkFiles
for (const [name, files] of Object.entries(checkFiles)) {
    fetchAndCache(name);
}
// Also check the non general check files that we need
fetchAndCache('query_create_time');
fetchAndCache('elastic_create_time');
fetchAndCache('wb_item_create_time');

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

document.addEventListener("DOMContentLoaded", function() {
    Plotly.newPlot('response_time', [], {
        title: {
            text: 'Response times',
        },
        xaxis: {},
        yaxis: {
            title: 'Time (ms)',
            rangemode: 'tozero',
            type: 'log',
        }
    });
    Plotly.newPlot('upornot_time', [], {
        title: {
            text: 'Status',
        },
        xaxis: {},
        yaxis: {
            ticktext: ['down', 'up'],
            tickvals: [-1, 1]
        }
    });
    populateGeneralServiceResponseTimeGraph();
    Plotly.newPlot('query_create_time', [], {
        title: {
            text: 'Item creation, to appearance in services',
        },
        xaxis: {},
        yaxis: {
            title: 'Time (ms)',
            rangemode: 'tozero',
            type: 'log',
        }
    });
    populateQueryServiceGraph();
    populateElasticGraph();
    Plotly.newPlot('item_create_time', [], {
        title: {
            text: 'Item creation',
        },
        xaxis: {},
        yaxis: {
            title: 'Time (ms)',
            rangemode: 'tozero',
            type: 'log',
        }
    });
    populateItemCreationGraph();
});