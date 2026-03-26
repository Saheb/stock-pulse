// Cloudflare Pages Function - Alpha Vantage Proxy
export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    // Get the ticker symbol from the query parameter
    const symbol = url.searchParams.get('symbol');

    if (!symbol) {
        return new Response(JSON.stringify({ error: 'Missing symbol parameter' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Use environment variable for the API key
    const apiKey = env.ALPHA_VANTAGE_API_KEY;

    if (!apiKey) {
        return new Response(JSON.stringify({ error: 'API key not configured on server' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Alpha Vantage OVERVIEW endpoint
    const alphaVantageUrl = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${symbol}&apikey=${apiKey}`;

    try {
        const response = await fetch(alphaVantageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
        });

        if (!response.ok) {
            return new Response(JSON.stringify({ error: `Alpha Vantage API error: ${response.status}` }), {
                status: response.status,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
            });
        }

        const data = await response.json();

        // Check for rate limiting (Alpha Vantage returns a Note field when rate limited)
        if (data.Note) {
            console.warn('Alpha Vantage rate limit:', data.Note);
            // Return the data as-is (client will handle the Note field)
        }
        
        // Check for empty data (unsupported ticker)
        if (JSON.stringify(data) === '{}') {
            console.log('Alpha Vantage returned empty data for symbol:', symbol);
            // Return empty data (client will handle)
        }

        // Create new response with CORS headers
        return new Response(JSON.stringify(data), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
        });
    }
}
