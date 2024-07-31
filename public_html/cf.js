// Old cloudflare stored data
fetch('https://wikibase-cloud-status.addshore.workers.dev/data')
    .then(response => response.json())
    .then(data => {
        // Data looks like a list of these entries
        // {timestamp: '2024-07-29 23:29:00', check: 'http://something-that-was-checked', status: 200, bytes: 0, time: 101, extra: 0}

        // Pre graph processing
        {
            for (let entry of data) {
                // Decide if we consider each thing to be up or not, based on the data
                if (entry.check === 'https://potato.wikibase.cloud/query/sparql?query=SELECT%20*%20WHERE%20%7B%3Fa%20%3Fb%20%3Fc%7D') {
                    // if before 2024-07-30 17:00, just count it as up due to a bug
                    if (entry.timestamp < '2024-07-30 17:00:00') {
                        entry.upOrNot = "up";
                        // also convert the status to 200
                        entry.status = 200;
                    } else {
                        // extra is 1 if the query was successful
                        entry.upOrNot = entry.extra === 1 ? "up" : "degraded";
                    }
                } else if (entry.check === 'https://potato.wikibase.cloud/w/index.php?search=haslabel%3Aen') {
                    // extra is 1 if the search was successful
                    entry.upOrNot = entry.extra === 1 ? "up" : "degraded";
                } else if (entry.check === 'https://potato.wikibase.cloud/w/api.php?action=query&titles=MediaWiki&format=json&maxlag=-1') {
                    // maxlag below 10 is considered up
                    entry.upOrNot = entry.extra <= 10 ? "up" : "degraded";
                } else {
                    // everything else, we just want a 200 response
                    entry.upOrNot = entry.status === 200 ? "up" : "degraded";
                }

            }

        }

        // system-status is General status of all sites
        {
            const systemUpOrNot = {
                x: data.map(entry => entry.timestamp),
                y: data.map(entry => entry.upOrNot),
                mode: 'markers',
                name: 'Overall',
                type: 'scatter'
            };
            const layout = {
                title: 'General status of all systems',
                xaxis: { title: 'Time' },
                yaxis: { title: 'Status' }
            };
            Plotly.newPlot('system-status', [systemUpOrNot], layout);

            // Also add a plot for each system
            const systems = {};
            data.forEach(entry => {
                if (!systems[entry.check]) {
                    systems[entry.check] = {
                        x: [],
                        y: [],
                        mode: 'markers',
                        name: entry.check,
                        type: 'scatter'
                    };
                }
                systems[entry.check].x.push(entry.timestamp);
                systems[entry.check].y.push(entry.upOrNot);
            });
            Object.values(systems).forEach(system => {
                Plotly.addTraces('system-status', system);
            });

            // Just show the overall plot
            const numPlots = document.getElementById('system-status').data.length;
            for (let i = 0; i < numPlots; i++) {
                if (i !== 0) {
                    Plotly.restyle('system-status', 'visible', 'legendonly', i);
                }
            }
        }                

        // system-response is Overall average response time of all sites
        {
            const systemStatus = {
                x: data.map(entry => entry.timestamp),
                y: data.map(entry => entry.time),
                mode: 'lines',
                name: 'Overall 1 min',
                type: 'scatter'
            };
            const layout = {
                title: 'Average response times',
                xaxis: { title: 'Time' },
                yaxis: { title: 'Response time (ms)', range: [0, null] }
            };
            Plotly.newPlot('system-response', [systemStatus], layout);

            const maxTime = Math.max(...data.map(entry => entry.time));
            const maxTimeEntry = data.find(entry => entry.time === maxTime);
            const minTime = Math.min(...data.map(entry => entry.time));
            const minTimeEntry = data.find(entry => entry.time === minTime);
            Plotly.relayout('system-response', {
                annotations: [{
                    x: minTimeEntry.timestamp,
                    y: minTimeEntry.time,
                    xref: 'x',
                    yref: 'y',
                    text: `${minTimeEntry.check} min: ${minTimeEntry.time}ms`,
                    showarrow: true,
                    arrowhead: 7,
                    ax: 0,
                    ay: -40
                },
                {
                    x: maxTimeEntry.timestamp,
                    y: maxTimeEntry.time,
                    xref: 'x',
                    yref: 'y',
                    text: `${maxTimeEntry.check} max: ${maxTimeEntry.time}ms`,
                    showarrow: true,
                    arrowhead: 7,
                    ax: 0,
                    ay: -40
                }
            ]
            });

            const movingAverage = {
                x: data.map(entry => entry.timestamp),
                y: data.map((entry, i) => {
                    if (i < 5) {
                        return null;
                    }
                    return data.slice(i - 5, i).reduce((acc, entry) => acc + entry.time, 0) / 5;
                }),
                mode: 'lines',
                name: 'Overall 5 min avg',
                type: 'scatter'
            };
            Plotly.addTraces('system-response', movingAverage);

            const movingAverage15 = {
                x: data.map(entry => entry.timestamp),
                y: data.map((entry, i) => {
                    if (i < 15) {
                        return null;
                    }
                    return data.slice(i - 15, i).reduce((acc, entry) => acc + entry.time, 0) / 15;
                }),
                mode: 'lines',
                name: 'Overall 15 min avg',
                type: 'scatter'
            };
            Plotly.addTraces('system-response', movingAverage15);

            const movingAverage60 = {
                x: data.map(entry => entry.timestamp),
                y: data.map((entry, i) => {
                    if (i < 60) {
                        return null;
                    }
                    return data.slice(i - 60, i).reduce((acc, entry) => acc + entry.time, 0) / 60;
                }),
                mode: 'lines',
                name: 'Overall 1 hour avg',
                type: 'scatter'
            };
            Plotly.addTraces('system-response', movingAverage60);

            const movingAverage360 = {
                x: data.map(entry => entry.timestamp),
                y: data.map((entry, i) => {
                    if (i < 360) {
                        return null;
                    }
                    return data.slice(i - 360, i).reduce((acc, entry) => acc + entry.time, 0) / 360;
                }),
                mode: 'lines',
                name: 'Overall 6 hours avg',
                type: 'scatter'
            };
            Plotly.addTraces('system-response', movingAverage360);

            // Also add each system to the plot
            const systems = {};
            data.forEach(entry => {
                if (!systems[entry.check]) {
                    systems[entry.check] = {
                        x: [],
                        y: [],
                        mode: 'lines',
                        name: entry.check,
                        type: 'scatter'
                    };
                }
                systems[entry.check].x.push(entry.timestamp);
                systems[entry.check].y.push(entry.time);
            });
            Object.values(systems).forEach(system => {
                Plotly.addTraces('system-response', system);
            });

            // hide everything except the 3rd plt (15 min avg)
            const numPlots = document.getElementById('system-response').data.length;
            for (let i = 0; i < numPlots; i++) {
                if (i !== 2) {
                    Plotly.restyle('system-response', 'visible', 'legendonly', i);
                }
            }
        }

        // Remove the loading text
        document.getElementById('cf-loading').remove();

    })
    .catch(error => console.error(error));