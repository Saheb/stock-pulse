// Cloudflare Pages Function - Alpha Vantage Proxy
const CACHE_TTL = 86400; // 24 hours in seconds

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

    if (!apiKey) {
        return new Response(JSON.stringify({ error: 'API key not configured on server' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Check Cloudflare cache first
    const cacheKey = new Request(`https://stock-pulse-cache/av-overview/${symbol.toUpperCase()}`, request);
    const cache = caches.default;
    let cachedResponse = await cache.match(cacheKey);

    if (cachedResponse) {
        return cachedResponse;
    }

    const alphaVantageUrl = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${symbol}&apikey=${apiKey}`;

    try {
        const response = await fetch(alphaVantageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            cf: { cacheTtl: CACHE_TTL, cacheEverything: true }
        });

        if (!response.ok) {
            const errorResponse = new Response(JSON.stringify({ error: 'Fundamentals service unavailable' }), {
                status: 503,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
            });
            return errorResponse;
        }

        const data = await response.json();

        // Check for rate limiting (Alpha Vantage returns Note or Information field when rate limited)
        if (data.Note || data.Information) {
            console.warn('Alpha Vantage rate limit reached');
            const rateLimitedResponse = new Response(JSON.stringify({
                error: 'rate_limited',
                message: 'Daily API limit reached. Resets at midnight UTC.'
            }), {
                status: 429,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
            });
            return rateLimitedResponse;
        }

        // Check for empty data (unsupported ticker) - use Object.keys for robustness
        if (Object.keys(data).length === 0) {
            const emptyResponse = new Response(JSON.stringify({}), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': `public, max-age=${CACHE_TTL}`
                },
            });
            await cache.put(cacheKey, emptyResponse.clone());
            return emptyResponse;
        }

        // Build cacheable response
        const cacheableResponse = new Response(JSON.stringify(data), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': `public, max-age=${CACHE_TTL}`
            },
        });

        // Store in Cloudflare cache
        await cache.put(cacheKey, cacheableResponse.clone());

        return cacheableResponse;
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

    const apiKey = env.ALPHA_VANTAGE_API_KEY;

    if (!apiKey) {
        return new Response(JSON.stringify({ error: 'API key not configured on server' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Check Cloudflare cache first
    const cacheKey = new Request(`https://stock-pulse-cache/av-overview/${symbol.toUpperCase()}`, request);
    const cache = caches.default;
    let cachedResponse = await cache.match(cacheKey);

    if (cachedResponse) {
        return cachedResponse;
    }

    const alphaVantageUrl = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${symbol}&apikey=${apiKey}`;

    try {
        const response = await fetch(alphaVantageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            cf: { cacheTtl: CACHE_TTL, cacheEverything: true }
        });

        if (!response.ok) {
            const errorResponse = new Response(JSON.stringify({ error: 'Fundamentals service unavailable' }), {
                status: 503,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
            });
            return errorResponse;
        }

        const data = await response.json();

        // Check for rate limiting (Alpha Vantage returns Note or Information field when rate limited)
        if (data.Note || data.Information) {
            console.warn('Alpha Vantage rate limit reached');
            const rateLimitedResponse = new Response(JSON.stringify({
                error: 'rate_limited',
                message: 'Daily API limit reached. Resets at midnight UTC.'
            }), {
                status: 429,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
            });
            return rateLimitedResponse;
        }

        // Check for empty data (unsupported ticker) - use Object.keys for robustness
        if (Object.keys(data).length === 0) {
            const emptyResponse = new Response(JSON.stringify({}), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': `public, max-age=${CACHE_TTL}`
                },
            });
            await cache.put(cacheKey, emptyResponse.clone());
            return emptyResponse;
        }

        // Build cacheable response
        const cacheableResponse = new Response(JSON.stringify(data), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': `public, max-age=${CACHE_TTL}`
            },
        });

        // Store in Cloudflare cache
        await cache.put(cacheKey, cacheableResponse.clone());

        return cacheableResponse;
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
