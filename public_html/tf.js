const dataFiles = [];

// Load the last 7 days of data
for (let i = 0; i < 7; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const file = `https://addshore-wikibase-cloud-status.toolforge.org/data/${year}/${month}/${day}/query_create_time.csv`;
    dataFiles.push(file);
}

Promise.all(dataFiles.map(file => fetch(file)
    .then(response => {
        if (response.ok) {
            return response.text();
        } else {
            console.log(`Failed to fetch ${file}`);
            return "";
        }
    }))
).then(data => {
    const allData = data.map((fileData, index) => {
        // File contains rows like 21:22:39,59176,1
        // So we need to add the date to the start of each row, for easier plotting
        const date = dataFiles[index].match(/\/(\d{4}\/\d{2}\/\d{2})\//)[1];
        return fileData.split('\n').filter(row => row.trim() !== "").map(row => {
            const [time, timeTaken, success] = row.split(',');
            return `${date} ${time},${timeTaken},${success}`;
        });
    }).flat();

    const query_create_time = {
        x: allData.map(row => new Date(row.split(',')[0])),
        y: allData.map(row => row.split(',')[1]),
        mode: 'line',
        name: 'actual',
        type: 'scatter'
    };

    const layout = {
        title: {
            text: 'Item creation, to appearance in query service',
        },
        xaxis: {},
        yaxis: {
            title: 'Time (ms)',
            rangemode: 'tozero',
        }
    };

    Plotly.newPlot('query_create_time', [query_create_time], layout);

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
    
}).catch(error => {
    console.error(error);
});