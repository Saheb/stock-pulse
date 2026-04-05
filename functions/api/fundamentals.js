// Cloudflare Pages Function - Alpha Vantage Proxy with Finnhub Fallback
// Uses in-memory caching since Pages Functions don't support caches.default
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in ms
const RATE_LIMIT_TTL = 60 * 60 * 1000; // 1 hour for rate-limited responses
const inMemoryCache = new Map();

function msUntilMidnightUTC() {
    const now = new Date();
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return midnight.getTime() - now.getTime();
}

async function fetchFinnhubData(symbolUpper, finnhubApiKey) {
    const finnhubUrl = `https://finnhub.io/api/v1/stock/metric?symbol=${symbolUpper}&metric=all&token=${finnhubApiKey}`;
    const response = await fetch(finnhubUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
    });
    if (response.ok) {
        const data = await response.json();
        if (data.metric) {
            const metric = data.metric;
            return {
                PERatio: metric.peTTM ? metric.peTTM.toString() : 'None',
                PEGRatio: metric.pegRatio ? metric.pegRatio.toString() : 'None',
                ProfitMargin: metric.netMargin ? (metric.netMargin * 100).toString() : 'None'
            };
        }
    }
    throw new Error('Finnhub fetch failed');
}

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const symbol = url.searchParams.get('symbol');

    if (!symbol) {
        return new Response(JSON.stringify({ error: 'Missing symbol parameter' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const apiKey = env.ALPHA_VANTAGE_API_KEY;
    const finnhubApiKey = env.FINNHUB_API_KEY;
    if (!apiKey && !finnhubApiKey) {
        return new Response(JSON.stringify({ error: 'No API keys configured on server' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const symbolUpper = symbol.toUpperCase();
    const cacheKey = `av_${symbolUpper}`;

    // Check in-memory cache first
    const cached = inMemoryCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < cached.ttl) {
        return new Response(JSON.stringify(cached.data), {
            status: cached.status,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
        });
    }

    // Clean expired entries periodically
    if (inMemoryCache.size > 100) {
        const now = Date.now();
        for (const [key, val] of inMemoryCache) {
            if (now - val.timestamp > val.ttl) {
                inMemoryCache.delete(key);
            }
        }
    }

    try {
        // Fetch both APIs in parallel
        const promises = [];
        if (apiKey) {
            const avUrl = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${symbolUpper}&apikey=${apiKey}`;
            promises.push(fetch(avUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
            }).then(async response => {
                if (response.ok) {
                    const data = await response.json();
                    if (data.Note || data.Information) {
                        throw new Error('Alpha Vantage rate limited');
                    }
                    if (Object.keys(data).length === 0) {
                        throw new Error('Alpha Vantage no data');
                    }
                    return { source: 'av', data };
                }
                throw new Error('Alpha Vantage error');
            }));
        }
        if (finnhubApiKey) {
            promises.push(fetchFinnhubData(symbolUpper, finnhubApiKey).then(data => ({ source: 'finnhub', data })));
        }

        const results = await Promise.allSettled(promises);
        const fulfilled = results.filter(r => r.status === 'fulfilled').map(r => r.value);

        let finalData = null;
        if (fulfilled.length > 0) {
            // Prefer Alpha Vantage if available
            const avResult = fulfilled.find(r => r.source === 'av');
            if (avResult) {
                finalData = avResult.data;
            } else {
                finalData = fulfilled[0].data; // Finnhub
            }
        } else {
            // Both failed, check if rate limited
            const rejected = results.filter(r => r.status === 'rejected');
            const rateLimited = rejected.some(r => r.reason.message.includes('rate limited'));
            if (rateLimited) {
                const rateLimitedData = {
                    error: 'both_rate_limited',
                    message: 'Both APIs rate limited. Circuit breaker enabled.',
                    limit: 25
                };
                const ttl = Math.min(RATE_LIMIT_TTL, msUntilMidnightUTC());
                inMemoryCache.set(cacheKey, { data: rateLimitedData, status: 429, timestamp: Date.now(), ttl });
                return new Response(JSON.stringify(rateLimitedData), {
                    status: 429,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                    },
                });
            } else {
                return new Response(JSON.stringify({ error: 'Both APIs failed' }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        inMemoryCache.set(cacheKey, { data: finalData, status: 200, timestamp: Date.now(), ttl: CACHE_TTL });

        return new Response(JSON.stringify(finalData), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
        });
    } catch (error) {
        console.error('Alpha Vantage proxy error:', error);
        return new Response(JSON.stringify({ error: 'Fundamentals service error' }), {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
        });
    }
}
