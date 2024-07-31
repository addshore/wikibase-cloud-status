genUrls = (name, days = 7) => {
    let collection = [];
    for (let i = 0; i < days; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const file = `https://addshore-wikibase-cloud-status.toolforge.org/data/${year}/${month}/${day}/${name}.csv`;
        collection.push(file);
    }
    return collection;
}// Wait for the DOM to load

const checkFiles = {
    cloud_home: genUrls('cloud_home'),
    cradle: genUrls('cradle'),
    elastic_check: genUrls('elastic_check'),
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
    const data = await Promise.all(files.map(file => fetch(file)
        .then(response => {
            if (response.ok) {
                return response.text();
            } else {
                console.log(`Failed to fetch ${file}`);
                return "";
            }
        }))
    );
    for (const [index, file] of files.entries()) {
        if (data[index] === "") {
            continue;
        }
        // Add the dates to each line
        const date = files[index].match(/\/(\d{4}\/\d{2}\/\d{2})\//)[1];
        data[index] = data[index].split('\n').filter(row => row.trim() !== "").map(row => `${date} ${row}`);
    }
    dataCache[name] = data.flat();
};

// Retrieve and cache the checkFiles
for (const [name, files] of Object.entries(checkFiles)) {
    fetchAndCache(name);
}
// Also check the non general check files that we need
fetchAndCache('query_create_time');
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
            y: checkFailures.map(row => name),
            mode: 'markers',
            name: name,
            type: 'scatter',
            marker: {
                size: 15,
                color: 'lightred'
            }
        };
        const checkSuccessPoints = {
            x: checkSuccess.map(row => new Date(row.split(',')[0])),
            y: checkSuccess.map(row => name),
            mode: 'markers',
            name: name,
            type: 'scatter',
            marker: {
                size: 15,
                color: 'lightgreen'
            }
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
        name: 'actual',
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
        name: '15min AVG',
        type: 'scatter'
    };
    Plotly.addTraces('query_create_time', [moving_average_line]);

    // Add a point whenever the query service is down
    const queryServiceDown = allData.filter(row => row.split(',')[2] === '0');
    const queryServiceDownPoints = {
        x: queryServiceDown.map(row => new Date(row.split(',')[0])),
        y: queryServiceDown.map(row => 1000), /// 100 seems a good height?
        mode: 'markers',
        name: 'Failed to query',
        type: 'scatter',
        marker: {
            size: 15,
            color: 'red'
        }
    };
    Plotly.addTraces('query_create_time', [queryServiceDownPoints]);
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
        }
    });
    Plotly.newPlot('upornot_time', [], {
        title: {
            text: 'Status',
        },
        xaxis: {},
        yaxis: {}
    });
    populateGeneralServiceResponseTimeGraph();
    Plotly.newPlot('query_create_time', [], {
        title: {
            text: 'Item creation, to appearance in query service',
        },
        xaxis: {},
        yaxis: {
            title: 'Time (ms)',
            rangemode: 'tozero',
        }
    });
    populateQueryServiceGraph();
});