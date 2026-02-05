export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // Get the target URL from the query parameter
        const targetUrl = url.searchParams.get('url');

        if (!targetUrl) {
            return new Response('Missing url parameter', {
                status: 400,
                headers: { 'Access-Control-Allow-Origin': '*' }
            });
        }

        // Handle preflight requests
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type',
                    'Access-Control-Max-Age': '86400',
                },
            });
        }

        try {
            // Fetch the target URL
            const response = await fetch(targetUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
            });

            // Create new response with CORS headers
            const newResponse = new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Content-Type': response.headers.get('Content-Type') || 'application/json',
                },
            });

            return newResponse;
        } catch (error) {
            return new Response(JSON.stringify({ error: error.message }), {
                status: 500,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': 'application/json',
                },
            });
        }
    },
};
