/**
 * StockPulse Alerts Worker
 *
 * Responsibilities:
 *   1. fetch()  — REST API for the watchlist UI (GET/POST/DELETE) + manual check trigger.
 *   2. scheduled() — runs on a cron (weekdays after market close), fetches each watchlisted
 *      ticker from Yahoo Finance, computes 200d/365d moving averages, detects crossovers
 *      below the MAs, and emails alerts via MailChannels.
 *
 * State is kept in two KV namespaces:
 *   - WATCHLIST:   single key "tickers" -> JSON string[] of ticker symbols.
 *   - ALERT_STATE: key "<TICKER>" -> JSON { wasAbove:{200,365}, lastClose, lastDate }.
 */

// ===== Config =====
const MA_PERIODS = [200, 365];
const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 StockPulseAlerts';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

// ===== Entry point =====
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        try {
            // Manual cron trigger (for testing / on-demand checks).
            if (url.pathname === '/api/alerts/check') {
                if (!authorize(request, env)) {
                    return json({ error: 'Unauthorized' }, 401);
                }
                const results = await runAlertCheck(env);
                return json({ ok: true, results });
            }

            // Watchlist management.
            if (url.pathname === '/api/alerts' || url.pathname === '/api/alerts/') {
                if (request.method === 'GET') {
                    const tickers = await getWatchlist(env);
                    return json({ tickers, email: maskEmail(env.RECIPIENT_EMAIL) });
                }
                if (request.method === 'POST') {
                    if (!authorize(request, env)) {
                        return json({ error: 'Unauthorized' }, 401);
                    }
                    const body = await request.json().catch(() => ({}));
                    const ticker = normalizeTicker(body.ticker);
                    if (!ticker) {
                        return json({ error: 'Invalid ticker' }, 400);
                    }
                    const tickers = await addToWatchlist(env, ticker);
                    return json({ ok: true, tickers });
                }
                if (request.method === 'DELETE') {
                    if (!authorize(request, env)) {
                        return json({ error: 'Unauthorized' }, 401);
                    }
                    const ticker = normalizeTicker(url.searchParams.get('ticker'));
                    const tickers = await removeFromWatchlist(env, ticker);
                    return json({ ok: true, tickers });
                }
            }

            return json({ error: 'Not found', endpoints: ['/api/alerts', '/api/alerts/check'] }, 404);
        } catch (error) {
            console.error('Worker fetch error:', error);
            return json({ error: error.message }, 500);
        }
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(runAlertCheck(env));
    },
};

// ===== Auth =====
function authorize(request, env) {
    // No token configured = open access (fine for a single-user local setup).
    if (!env.ALERT_API_TOKEN) return true;
    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    const qs = new URL(request.url).searchParams.get('token');
    return token === env.ALERT_API_TOKEN || qs === env.ALERT_API_TOKEN;
}

// ===== KV helpers =====
async function getWatchlist(env) {
    const raw = await env.WATCHLIST.get('tickers');
    if (!raw) return [];
    try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

async function setWatchlist(env, tickers) {
    await env.WATCHLIST.put('tickers', JSON.stringify(tickers));
}

async function addToWatchlist(env, ticker) {
    const tickers = await getWatchlist(env);
    if (!tickers.includes(ticker)) {
        tickers.push(ticker);
        await setWatchlist(env, tickers);
    }
    return tickers;
}

async function removeFromWatchlist(env, ticker) {
    let tickers = await getWatchlist(env);
    tickers = tickers.filter((t) => t !== ticker);
    await setWatchlist(env, tickers);
    // Clean up stored state too.
    await env.ALERT_STATE.delete(ticker);
    return tickers;
}

async function getState(env, ticker) {
    const raw = await env.ALERT_STATE.get(ticker);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function setState(env, ticker, state) {
    await env.ALERT_STATE.put(ticker, JSON.stringify(state));
}

// ===== Core alert check =====
async function runAlertCheck(env) {
    const tickers = await getWatchlist(env);
    const results = [];
    const triggered = [];

    for (const ticker of tickers) {
        const result = { ticker, status: 'ok', crossovers: [] };
        try {
            const data = await fetchYahooChart(ticker);
            const parsed = parseChart(data);
            const crossovers = detectCrossovers(parsed, await getState(env, ticker));

            result.price = parsed.price;
            result.date = parsed.date;
            result.ma200 = parsed.ma200;
            result.ma365 = parsed.ma365;
            result.crossovers = crossovers;

            if (crossovers.length > 0) {
                triggered.push({ ticker, parsed, crossovers });
            }

            // Persist state for next run.
            await setState(env, ticker, {
                wasAbove: {
                    200: parsed.price > parsed.ma200,
                    365: parsed.price > parsed.ma365,
                },
                lastClose: parsed.price,
                lastDate: parsed.date,
                lastChecked: new Date().toISOString(),
            });
        } catch (error) {
            result.status = 'error';
            result.message = error.message;
            console.error(`Alert check failed for ${ticker}:`, error.message);
        }
        results.push(result);
    }

    if (triggered.length > 0) {
        await sendAlertEmail(env, triggered);
    }

    return results;
}

// ===== Yahoo Finance =====
async function fetchYahooChart(ticker) {
    const period2 = Math.floor(Date.now() / 1000);
    const url = `${YAHOO_CHART_BASE}/${ticker}?period1=0&period2=${period2}&interval=1d&includePrePost=false&events=div%2Csplits`;
    const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok) {
        throw new Error(`Yahoo request failed: HTTP ${response.status}`);
    }
    return response.json();
}

function parseChart(data) {
    const result = data?.chart?.result?.[0];
    if (!result) {
        throw new Error(data?.chart?.error?.description || 'No chart data from Yahoo');
    }
    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const entries = [];
    for (let i = 0; i < timestamps.length; i++) {
        const close = closes[i];
        if (Number.isFinite(close)) {
            entries.push({ date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10), close });
        }
    }
    if (entries.length === 0) {
        throw new Error('No valid closing prices');
    }

    const prices = entries.map((e) => e.close);
    const latest = entries[entries.length - 1];

    const ma = {};
    for (const period of MA_PERIODS) {
        ma[period] = prices.length >= period ? movingAverage(prices, period) : null;
    }

    return {
        price: latest.close,
        date: latest.date,
        ma200: ma[200],
        ma365: ma[365],
        longName: result.meta?.longName || result.meta?.shortName || result.meta?.symbol || '',
        currency: result.meta?.currency || 'USD',
        prices,
    };
}

// Sliding-window moving average; returns the last value (or null if not enough data).
function movingAverage(prices, period) {
    if (prices.length < period) return null;
    let sum = 0;
    for (let i = prices.length - period; i < prices.length; i++) {
        sum += prices[i];
    }
    return sum / period;
}

// ===== Crossover detection =====
// A crossover-below happens when: previously the price was above the MA (per stored state)
// and now it is below. First run (no stored state) seeds the baseline without alerting.
function detectCrossovers(parsed, prevState) {
    const crossovers = [];
    const isAbove = (period) => {
        const ma = period === 200 ? parsed.ma200 : parsed.ma365;
        if (ma == null) return null;
        return parsed.price > ma;
    };

    for (const period of MA_PERIODS) {
        const nowAbove = isAbove(period);
        const ma = period === 200 ? parsed.ma200 : parsed.ma365;
        if (nowAbove === null) continue;

        const wasAbove = prevState?.wasAbove?.[period];

        if (wasAbove === true && nowAbove === false) {
            crossovers.push({
                period,
                price: parsed.price,
                ma,
                date: parsed.date,
            });
        }
    }
    return crossovers;
}

// ===== Email (Resend) =====
async function sendAlertEmail(env, triggered) {
    const subject = `StockPulse: ${triggered.length} stock${triggered.length > 1 ? 's' : ''} crossed below moving average`;
    const { text, html } = buildEmailContent(triggered, env);

    const response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: `${env.FROM_NAME || 'StockPulse Alerts'} <${env.FROM_EMAIL || 'onboarding@resend.dev'}>`,
            to: env.RECIPIENT_EMAIL,
            subject,
            html,
            text,
        }),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Resend send failed: HTTP ${response.status} — ${body}`);
    }
}

function buildEmailContent(triggered, env) {
    const appUrl = 'https://stock-pulse-7ok.pages.dev';
    const lines = [];
    const rows = [];

    for (const { ticker, parsed, crossovers } of triggered) {
        const periods = crossovers.map((c) => `${c.period}-day`).join(' & ');
        lines.push(`• ${parsed.longName || ticker} (${ticker}) dropped below its ${periods} moving average.`);
        lines.push(`  Price: ${formatPrice(parsed.price, parsed.currency)} on ${parsed.date}`);
        lines.push(`  MA200: ${formatPrice(parsed.ma200, parsed.currency)} | MA365: ${formatPrice(parsed.ma365, parsed.currency)}`);
        lines.push('');

        rows.push(`
            <tr>
                <td style="padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.06);">
                    <div style="font-size:16px;font-weight:600;color:#fff;">${escapeHtml(parsed.longName || ticker)}</div>
                    <div style="font-size:13px;color:rgba(255,255,255,0.5);">${escapeHtml(ticker)}</div>
                </td>
                <td style="padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.06);color:#f59e0b;font-weight:600;">
                    ${periods.replace(/&/g, '<br>')}
                </td>
                <td style="padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.06);color:#ef4444;font-weight:600;">
                    ${formatPrice(parsed.price, parsed.currency)}
                </td>
                <td style="padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.06);color:rgba(255,255,255,0.6);font-size:13px;">
                    MA200: ${formatPrice(parsed.ma200, parsed.currency)}<br>MA365: ${formatPrice(parsed.ma365, parsed.currency)}
                </td>
            </tr>
        `);
    }

    const text = `StockPulse Alert — ${triggered.length} crossover${triggered.length > 1 ? 's' : ''} detected\n\n${lines.join('\n')}\nView charts at ${appUrl}`;

    const html = `
        <div style="background:#0a0a0f;padding:32px;font-family:'Inter',-apple-system,sans-serif;">
            <div style="max-width:600px;margin:0 auto;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;">
                <div style="padding:24px 32px;background:linear-gradient(135deg,#6366f1,#8b5cf6);">
                    <h1 style="margin:0;color:#fff;font-size:20px;">📈 StockPulse Alert</h1>
                    <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:14px;">${triggered.length} stock${triggered.length > 1 ? 's crossed' : ' crossed'} below a moving average</p>
                </div>
                <table style="width:100%;border-collapse:collapse;">
                    <thead>
                        <tr style="color:rgba(255,255,255,0.4);font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">
                            <th style="padding:12px 16px;text-align:left;">Stock</th>
                            <th style="padding:12px 16px;text-align:left;">Crossed</th>
                            <th style="padding:12px 16px;text-align:left;">Price</th>
                            <th style="padding:12px 16px;text-align:left;">MAs</th>
                        </tr>
                    </thead>
                    <tbody>${rows.join('')}</tbody>
                </table>
                <div style="padding:24px 32px;text-align:center;">
                    <a href="${appUrl}" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;padding:12px 32px;border-radius:8px;font-weight:600;font-size:14px;">View Charts</a>
                </div>
                <div style="padding:0 32px 24px;color:rgba(255,255,255,0.3);font-size:11px;text-align:center;">
                    Alert sent to ${escapeHtml(env.RECIPIENT_EMAIL)} · Daily check after market close
                </div>
            </div>
        </div>`;

    return { text, html };
}

// ===== Utilities =====
function normalizeTicker(input) {
    if (!input || typeof input !== 'string') return null;
    const cleaned = input.trim().toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z]{1,6}(\.[A-Z]{1,3})?$/.test(cleaned)) return null;
    return cleaned;
}

function maskEmail(email) {
    if (!email) return null;
    const [user, domain] = email.split('@');
    if (!domain) return email;
    return `${user[0]}***@${domain}`;
}

function formatPrice(value, currency) {
    if (!Number.isFinite(value)) return 'n/a';
    if (currency === 'GBp' || currency === 'GBX') return `${value.toFixed(2)}p`;
    try {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currency || 'USD',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        }).format(value);
    } catch {
        return `${value.toFixed(2)} ${currency || ''}`.trim();
    }
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
}
