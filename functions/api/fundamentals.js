// Cloudflare Pages Function - Alpha Vantage Proxy
// Uses in-memory caching since Pages Functions don't support caches.default
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in ms
const inMemoryCache = new Map();

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

    const symbolUpper = symbol.toUpperCase();
    const cacheKey = `av_${symbolUpper}`;

    // Check in-memory cache first
    const cached = inMemoryCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
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
            if (now - val.timestamp > CACHE_TTL) {
                inMemoryCache.delete(key);
            }
        }
    }

    const alphaVantageUrl = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${symbolUpper}&apikey=${apiKey}`;

    try {
        const response = await fetch(alphaVantageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
        });

        if (!response.ok) {
            return new Response(JSON.stringify({ error: 'Fundamentals service unavailable' }), {
                status: 503,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
            });
        }

        const data = await response.json();

        // Check for rate limiting (Alpha Vantage returns Note or Information field when rate limited)
        if (data.Note || data.Information) {
            console.warn('Alpha Vantage rate limit reached');
            const rateLimitedData = {
                error: 'rate_limited',
                message: 'Daily API limit reached. Resets at midnight UTC.'
            };
            inMemoryCache.set(cacheKey, { data: rateLimitedData, status: 429, timestamp: Date.now() });
            return new Response(JSON.stringify(rateLimitedData), {
                status: 429,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
            });
        }

        // Check for empty data (unsupported ticker)
        if (Object.keys(data).length === 0) {
            inMemoryCache.set(cacheKey, { data: {}, status: 200, timestamp: Date.now() });
            return new Response(JSON.stringify({}), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
            });
        }

        inMemoryCache.set(cacheKey, { data, status: 200, timestamp: Date.now() });

        return new Response(JSON.stringify(data), {
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
