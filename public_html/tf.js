const data1 = "https://addshore-wikibase-cloud-status.toolforge.org/data/2024/07/31/query_create_time.csv"
// file contains rows like 21:22:39,59176,1
// time of reading, time taken, general success
// The date can be inferred from the filename

let thingsToLoad = 1;

fetch(data1).then(response => response.text()).then(text => {
    // load the CSV into plotly and graph the response times
    const rows = text.split('\n').map(row => row.split(','));
    const times = rows.map(row => row[0]);
    const timesTaken = rows.map(row => row[1]);
    const success = rows.map(row => row[2]);

    // Calculate the 15 min moving average
    const movingAverage = [];
    for (let i = 0; i < timesTaken.length; i++) {
        let sum = 0;
        let count = 0;
        for (let j = Math.max(0, i - 14); j <= i; j++) {
            sum += parseInt(timesTaken[j]);
            count++;
        }
        movingAverage.push(sum / count);
    }

    const query_create_time = {
        x: times,
        y: timesTaken,
        mode: 'line',
        name: 'Query Create Time',
        type: 'scatter'
    };

    const moving_average_line = {
        x: times,
        y: movingAverage,
        mode: 'line',
        name: 'Moving Average',
        type: 'scatter'
    };

    const layout = {
        title: 'Item creation, to query service appearance',
        xaxis: {},
        yaxis: { title: 'Time Taken', rangemode: 'tozero' } // set rangemode to 'tozero'
    };

    Plotly.newPlot('query_create_time', [query_create_time, moving_average_line], layout);
    thingsToLoad--;
})

// Wait for things to load to be 0, then remove the loading id
const interval = setInterval(() => {
    if (thingsToLoad === 0) {
        clearInterval(interval);
        document.getElementById('tf-loading').remove();
    }
}, 250);
