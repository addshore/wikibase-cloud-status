/**
 * Welcome to Cloudflare Workers!
 *
 * This is a template for a Scheduled Worker: a Worker that can run on a
 * configurable interval:
 * https://developers.cloudflare.com/workers/platform/triggers/cron-triggers/
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Run `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"` to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.toml`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

const CACHE_HTML_BROWSER = 60*60;;
const CACHE_HTML_EDGE = 60*60;
const CACHE_DATA_BROWSER = 60;
const CACHE_DATA_EDGE = 60;

export default {
	async fetch(event, env: Env, ctx): Promise<Response> {
		const url = new URL(event.url);
		if (url.pathname === '/') {
			return servePage(event, env, ctx);
		}

		if (url.pathname === '/data') {
			return serveData(event, env, ctx);
		}

		// Serve 404 as a default
		return new Response('Not found', { status: 404 });
	},
	// The scheduled handler is invoked at the interval set in our wrangler.toml's
	// [[triggers]] configuration.
	async scheduled(event, env: Env, ctx): Promise<void> {
		await doChecks(env)
	}
} satisfies ExportedHandler<Env>;

async function servePage(event: Request<unknown, IncomingRequestCfProperties<unknown>>, env: Env, ctx: ExecutionContext) : Promise<Response> {
	const cache = caches.default;
	const url = new URL(event.url);
	let response = await cache.match(url);
	if (!response) {
		// redirect people to https://addshore.github.io/wikibase-cloud-status/
		response = new Response('', {
			status: 302,
			headers: {
				'Location': 'https://addshore.github.io/wikibase-cloud-status/',
				'cache-control': `public, max-age=${CACHE_HTML_BROWSER}, s-maxage=${CACHE_HTML_EDGE}`,
			},
		});
		// Store the response in the cache for 60 seconds
		ctx.waitUntil(cache.put(url, response.clone()));
	}
	return response || new Response('An error occurred!', { status: 500 });
}

async function serveData(event: Request<unknown, IncomingRequestCfProperties<unknown>>, env: Env, ctx: ExecutionContext) : Promise<Response> {
	const url = new URL(event.url);
	const cache = caches.default;
	// Check if the request is in the cache
	let response = await cache.match(url);
	if (!response) {
		// If not in the cache, get the response from the origin
		response = await freshData(env);
		// Store the response in the cache for 60 seconds
		ctx.waitUntil(cache.put(url, response.clone()));
	}
	return response || new Response('An error occurred!', { status: 500 });
}

async function freshData(env: Env) : Promise<Response> {
	// The following query will get 1 weeks worth of data from the store
	const query = `SELECT toStartOfInterval(timestamp, INTERVAL '1' MINUTE) as timestamp, index1 as check, double1 as status, double2 as bytes, double3 as time, double4 as extra
	from wbc_status
	where blob1 = 'dev_wbc_check_0001'
	and timestamp >= toDateTime(toUnixTimestamp(now()) - 7*24*60*60) and timestamp <= now()
	ORDER BY timestamp desc`
	
	const API = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/analytics_engine/sql`;
	const queryResponse = await fetch(API, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${env.API_TOKEN}`,
		},
		body: query,
	});

	// The API will return a 200 status code if the query succeeded.
	// In case of failure we log the error message and return a failure message.
	if (queryResponse.status != 200) {
		console.error('Error querying:', await queryResponse.text());
		return new Response('An error occurred!', {status: 500});
	}

	// Read the JSON data from the query response and render the data as HTML.
	const queryJSON = await queryResponse.json() as { data: any[] };
	const jsonString = JSON.stringify(queryJSON.data);
	return new Response(
		jsonString,
		{
			headers: {
				'content-type': 'application/json',
				'cache-control': `public, max-age=${CACHE_DATA_BROWSER}, s-maxage=${CACHE_DATA_EDGE}`,
				'Access-Control-Allow-Origin': '*',
			},
		}
	);
}


async function doChecks(env: Env) {
	const simple200Checks = [
		"https://potato.wikibase.cloud/wiki/Item:Q1",
		"https://www.wikibase.cloud/",
		"https://potato.wikibase.cloud/query/",
		"https://potato.wikibase.cloud/tools/cradle/",
		"https://potato.wikibase.cloud/tools/quickstatements/",
	]

	// It's around 1500ms to do all these checks one by one, or ~200-400 or so at once
	// Doing them all at once shouldnt cause any damage, as each request is to a different service (other than going via ingress / nginx)
	await Promise.all([
		checkSPARQL(env),
		checkElastic(env),
		checkMaxlag(env),
		...simple200Checks.map(url => check200(env, url))
	]);
	
}

async function checkSPARQL (env: Env) {
	const url = "https://potato.wikibase.cloud/query/sparql?query=SELECT%20*%20WHERE%20%7B%3Fa%20%3Fb%20%3Fc%7D";
	const start = Date.now();
	const response = await f(url);
	const responseTime = Date.now() - start;
	const bytes = parseInt(response.headers.get("content-length") ?? '0')
	// Ensure that the page includes "https://potato.wikibase.cloud/entity/Q1" which should appear in the results
	const body = await response.text();
	const success = body.includes("https://potato.wikibase.cloud/entity/Q1") ? 1 : 0;
	writeData(env, ["dev_wbc_check_0001", url], [response.status, bytes, responseTime, success], [url]);
}

async function checkElastic (env: Env) {
	const url = "https://potato.wikibase.cloud/w/index.php?search=haslabel%3Aen";
	const start = Date.now();
	const response = await f(url);
	const responseTime = Date.now() - start;
	const bytes = parseInt(response.headers.get("content-length") ?? '0')
	// Ensure that the page includes "wiki/Item:Q1" on it, to indicate that the search succeeded
	const body = await response.text();
	const success = body.includes("wiki/Item:Q1") ? 1 : 0;
	writeData(env, ["dev_wbc_check_0001", url], [response.status, bytes, responseTime, success], [url]);
}

async function checkMaxlag (env: Env) {
	const url = "https://potato.wikibase.cloud/w/api.php?action=query&titles=MediaWiki&format=json&maxlag=-1";
	const start = Date.now();
	const response = await f(url);
	const responseTime = Date.now() - start;
	const bytes = parseInt(response.headers.get("content-length") ?? '0')
	// Response will be someting like this
	// {
	// 	"error": {
	// 	"code": "maxlag",
	// 	"info": "Waiting for a database server: 0 seconds lagged.",
	// 	"host": "sql-mariadb-primary.default.svc.cluster.local",
	// 	"lag": 0,
	// 	"type": "db",
	// 	"*": "See https://potato.wikibase.cloud/w/api.php for API usage. Subscribe to the mediawiki-api-announce mailing list at &lt;https://lists.wikimedia.org/postorius/lists/mediawiki-api-announce.lists.wikimedia.org/&gt; for notice of API deprecations and breaking changes."
	// 	}
	// }
	const lag = response.status === 200 ? (await response.json() as any).error.lag : 0;
	writeData(env, ["dev_wbc_check_0001", url], [response.status, bytes, responseTime, lag], [url]);
}

async function check200 (env: Env, url: string) {
	const start = Date.now();
	const response = await f(url);
	const responseTime = Date.now() - start;
	const bytes = parseInt(response.headers.get("content-length") ?? '0')
	writeData(env, ["dev_wbc_check_0001", url], [response.status, bytes, responseTime], [url]);
}

async function f(url: string) {
	return fetch(url, {
		headers: {
			"User-Agent": "addshore/wikibase-cloud-status-checker"
		}
	});
}

async function writeData(env: Env, blobs : string[], doubles: number[], indexes: string[]) {
	// If we are in wrangler dev
	if (env.WBCLOUD_STATUS) {
		env.WBCLOUD_STATUS.writeDataPoint({ 'blobs': blobs, 'doubles': doubles, 'indexes': indexes});
	} else {
		// Analytics engine not currently supported locally
		// https://github.com/cloudflare/workers-sdk/issues/4383
		console.log("Not in wrangler dev, skipping writeDataPoint");
		console.log({ 'blobs': blobs, 'doubles': doubles, 'indexes': indexes});
	}
}