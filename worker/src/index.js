/**
 * StockPulse Alerts Worker
 *
 * Responsibilities:
 *   1. fetch()  — REST API for the watchlist UI (GET/POST/DELETE) + manual check trigger.
 *   2. scheduled() — runs on a cron (weekdays after market close), fetches each watchlisted
 *      ticker from Yahoo Finance, computes 200d/365d moving averages, detects crossovers
 *      below the MAs, and emails each subscriber about the tickers on their list.
 *
 * There is no login: an email address is the identity. The browser remembers it in
 * localStorage, and every watchlist request carries it. The owner (RECIPIENT_EMAIL) is
 * emailed whenever a new address adds its first stock.
 *
 * State is kept in two KV namespaces:
 *   - WATCHLIST:   key "user:<email>" -> JSON string[] of ticker symbols (kept even when empty).
 *                  (Legacy single-user key "tickers" is migrated to RECIPIENT_EMAIL on first use.)
 *   - ALERT_STATE: key "<TICKER>" -> JSON { wasAbove:{200,365}, lastClose, lastDate }.
 *                  Shared across users, since a crossover is a property of the ticker.
 *
 * Email goes out through Gmail SMTP (GMAIL_USER + GMAIL_APP_PASSWORD), falling back to Resend.
 */

import { WorkerMailer } from 'worker-mailer';

// ===== Config =====
const MA_PERIODS = [200, 365];
const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const GMAIL_SMTP_HOST = 'smtp.gmail.com';
const GMAIL_SMTP_PORT = 465;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 StockPulseAlerts';
const APP_URL = 'https://stock-pulse-7ok.pages.dev';
const USER_PREFIX = 'user:';
const LEGACY_WATCHLIST_KEY = 'tickers';
const MAX_TICKERS_PER_USER = 25;

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
            await migrateLegacyWatchlist(env);

            // Manual cron trigger (for testing / on-demand checks).
            if (url.pathname === '/api/alerts/check') {
                if (!authorize(request, env)) {
                    return json({ error: 'Unauthorized' }, 401);
                }
                const summary = await runAlertCheck(env);
                return json({ ok: true, ...summary });
            }

            // Watchlist management, scoped to an email address.
            if (url.pathname === '/api/alerts' || url.pathname === '/api/alerts/') {
                if (request.method === 'GET') {
                    const email = normalizeEmail(url.searchParams.get('email'));
                    if (!email) {
                        return json({ error: 'A valid email is required' }, 400);
                    }
                    const tickers = await getUserTickers(env, email);
                    return json({ email, tickers });
                }
                if (request.method === 'POST') {
                    const body = await request.json().catch(() => ({}));
                    const email = normalizeEmail(body.email);
                    const ticker = normalizeTicker(body.ticker);
                    if (!email) {
                        return json({ error: 'A valid email is required' }, 400);
                    }
                    if (!ticker) {
                        return json({ error: 'Invalid ticker' }, 400);
                    }
                    return json(await addToWatchlist(env, email, ticker));
                }
                if (request.method === 'DELETE') {
                    const email = normalizeEmail(url.searchParams.get('email'));
                    const ticker = normalizeTicker(url.searchParams.get('ticker'));
                    if (!email) {
                        return json({ error: 'A valid email is required' }, 400);
                    }
                    const tickers = await removeFromWatchlist(env, email, ticker);
                    return json({ ok: true, tickers });
                }
            }

            return json({ error: 'Not found', endpoints: ['/api/alerts', '/api/alerts/check'] }, 404);
        } catch (error) {
            if (error instanceof HttpError) {
                return json({ error: error.message }, error.status);
            }
            console.error('Worker fetch error:', error);
            return json({ error: error.message }, 500);
        }
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(migrateLegacyWatchlist(env).then(() => runAlertCheck(env)));
    },
};

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// ===== Auth =====
// Only guards the manual /check trigger; watchlist endpoints are open and keyed by email.
function authorize(request, env) {
    if (!env.ALERT_API_TOKEN) return true;
    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    const qs = new URL(request.url).searchParams.get('token');
    return token === env.ALERT_API_TOKEN || qs === env.ALERT_API_TOKEN;
}

// ===== KV helpers =====
function userKey(email) {
    return `${USER_PREFIX}${email}`;
}

function parseTickerArray(raw) {
    if (!raw) return [];
    try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

async function getUserTickers(env, email) {
    return parseTickerArray(await env.WATCHLIST.get(userKey(email)));
}

// Emptied lists are kept (not deleted) so a returning user isn't reported as new.
async function setUserTickers(env, email, tickers) {
    await env.WATCHLIST.put(userKey(email), JSON.stringify(tickers));
}

// Returns [{ email, tickers }] for every subscriber.
async function listUsers(env) {
    const users = [];
    let cursor;
    do {
        const page = await env.WATCHLIST.list({ prefix: USER_PREFIX, cursor });
        for (const { name } of page.keys) {
            const email = name.slice(USER_PREFIX.length);
            const tickers = await getUserTickers(env, email);
            if (tickers.length > 0) users.push({ email, tickers });
        }
        cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return users;
}

// One-time move of the old single-user watchlist into the owner's per-email list.
async function migrateLegacyWatchlist(env) {
    const legacy = parseTickerArray(await env.WATCHLIST.get(LEGACY_WATCHLIST_KEY));
    if (legacy.length === 0) return;
    const owner = normalizeEmail(env.RECIPIENT_EMAIL);
    if (!owner) return;
    const current = await getUserTickers(env, owner);
    const merged = [...new Set([...current, ...legacy])];
    await setUserTickers(env, owner, merged);
    await env.WATCHLIST.delete(LEGACY_WATCHLIST_KEY);
    console.log(`Migrated legacy watchlist (${legacy.join(', ')}) to ${owner}`);
}

async function addToWatchlist(env, email, ticker) {
    const raw = await env.WATCHLIST.get(userKey(email));
    const isNewUser = raw === null;
    const tickers = parseTickerArray(raw);
    if (tickers.includes(ticker)) {
        return { ok: true, tickers, alreadyWatching: true, notified: false };
    }
    if (tickers.length >= MAX_TICKERS_PER_USER) {
        throw new HttpError(400, `Alert list is full (max ${MAX_TICKERS_PER_USER} stocks)`);
    }

    // Fetching up front validates the ticker and gives the confirmation email real numbers.
    let parsed;
    try {
        parsed = parseChart(await fetchYahooChart(ticker));
    } catch (error) {
        throw new HttpError(400, `No price data found for ${ticker}`);
    }

    tickers.push(ticker);
    await setUserTickers(env, email, tickers);

    // Seed the baseline so the very next cron run can detect a crossover.
    if (!(await getState(env, ticker))) {
        await setState(env, ticker, stateFromParsed(parsed));
    }

    let notified = false;
    let notifyError = null;
    try {
        await sendWatchConfirmationEmail(env, email, ticker, parsed, tickers);
        notified = true;
    } catch (error) {
        notifyError = error.message;
        console.error(`Confirmation email to ${email} failed:`, error.message);
    }

    if (isNewUser) {
        await notifyOwnerOfNewUser(env, email, ticker);
    }

    return { ok: true, tickers, notified, notifyError };
}

// Tells the app owner (RECIPIENT_EMAIL) whenever a new email address starts using alerts.
async function notifyOwnerOfNewUser(env, email, ticker) {
    const owner = normalizeEmail(env.RECIPIENT_EMAIL);
    if (!owner || owner === email) return;
    try {
        const users = await listUsers(env);
        const others = users.filter((u) => u.email !== owner).map((u) => u.email);
        const text = [
            `${email} just started using StockPulse alerts (first stock: ${ticker}).`,
            '',
            `Users with active alerts (${users.length}):`,
            ...users.map((u) => `  ${u.email}: ${u.tickers.join(', ')}`),
        ].join('\n');
        const rows = users.map((u) => `
            <tr>
                <td style="padding:8px 32px;color:${u.email === email ? '#a5b4fc' : '#fff'};font-size:13px;border-bottom:1px solid rgba(255,255,255,0.06);">${escapeHtml(u.email)}</td>
                <td style="padding:8px 32px;color:rgba(255,255,255,0.6);font-size:13px;text-align:right;border-bottom:1px solid rgba(255,255,255,0.06);">${u.tickers.map(escapeHtml).join(', ')}</td>
            </tr>`).join('');
        const html = emailLayout({
            title: '👋 New StockPulse user',
            subtitle: `${escapeHtml(email)} added ${escapeHtml(ticker)}`,
            email: owner,
            bodyHtml: `
                <p style="padding:16px 32px 4px;margin:0;color:rgba(255,255,255,0.5);font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Users with active alerts (${users.length})</p>
                <table style="width:100%;border-collapse:collapse;">${rows}</table>`,
        });
        await sendEmail(env, {
            to: owner,
            subject: `StockPulse: new user ${email}${others.length ? ` (${others.length} besides you)` : ''}`,
            html,
            text,
        });
    } catch (error) {
        console.error('Owner new-user notification failed:', error.message);
    }
}

async function removeFromWatchlist(env, email, ticker) {
    let tickers = await getUserTickers(env, email);
    tickers = tickers.filter((t) => t !== ticker);
    await setUserTickers(env, email, tickers);

    // Drop the shared crossover state once nobody watches the ticker, so a later
    // re-add starts from a fresh baseline instead of a stale one.
    const users = await listUsers(env);
    const stillWatched = users.some((u) => u.email !== email && u.tickers.includes(ticker));
    if (ticker && !stillWatched) {
        await env.ALERT_STATE.delete(ticker);
    }
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

function stateFromParsed(parsed) {
    return {
        wasAbove: {
            200: parsed.ma200 == null ? null : parsed.price > parsed.ma200,
            365: parsed.ma365 == null ? null : parsed.price > parsed.ma365,
        },
        lastClose: parsed.price,
        lastDate: parsed.date,
        lastChecked: new Date().toISOString(),
    };
}

// ===== Core alert check =====
async function runAlertCheck(env) {
    const users = await listUsers(env);

    // ticker -> [emails], so each ticker is fetched once no matter how many people watch it.
    const subscribers = new Map();
    for (const { email, tickers } of users) {
        for (const ticker of tickers) {
            if (!subscribers.has(ticker)) subscribers.set(ticker, []);
            subscribers.get(ticker).push(email);
        }
    }

    const results = [];
    const triggeredByEmail = new Map();

    for (const [ticker, emails] of subscribers) {
        const result = { ticker, subscribers: emails.length, status: 'ok', crossovers: [] };
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
                for (const email of emails) {
                    if (!triggeredByEmail.has(email)) triggeredByEmail.set(email, []);
                    triggeredByEmail.get(email).push({ ticker, parsed, crossovers });
                }
            }

            // Persist state for next run.
            await setState(env, ticker, stateFromParsed(parsed));
        } catch (error) {
            result.status = 'error';
            result.message = error.message;
            console.error(`Alert check failed for ${ticker}:`, error.message);
        }
        results.push(result);
    }

    // One email per subscriber; a failure for one address doesn't block the others.
    const emails = [];
    for (const [email, triggered] of triggeredByEmail) {
        try {
            await sendAlertEmail(env, email, triggered);
            emails.push({ email, alerts: triggered.length, sent: true });
        } catch (error) {
            console.error(`Alert email to ${email} failed:`, error.message);
            emails.push({ email, alerts: triggered.length, sent: false, error: error.message });
        }
    }

    return { users: users.length, results, emails };
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

// ===== Email (Gmail SMTP, Resend fallback) =====
async function sendEmail(env, message) {
    const errors = [];
    if (env.GMAIL_USER && env.GMAIL_APP_PASSWORD) {
        try {
            return await sendViaGmail(env, message);
        } catch (error) {
            errors.push(`Gmail: ${error.message}`);
            console.error(`Gmail send to ${message.to} failed:`, error.message);
        }
    }
    if (env.RESEND_API_KEY) {
        try {
            return await sendViaResend(env, message);
        } catch (error) {
            errors.push(`Resend: ${error.message}`);
        }
    }
    throw new Error(errors.join(' | ') || 'No email provider configured');
}

async function sendViaGmail(env, { to, subject, html, text }) {
    const mailer = await WorkerMailer.connect({
        host: GMAIL_SMTP_HOST,
        port: GMAIL_SMTP_PORT,
        secure: true,
        credentials: {
            username: env.GMAIL_USER,
            // Google displays app passwords in groups of four; SMTP wants them without spaces.
            password: env.GMAIL_APP_PASSWORD.replace(/\s+/g, ''),
        },
        authType: 'plain',
    });
    try {
        await mailer.send({
            from: { name: env.FROM_NAME || 'StockPulse Alerts', email: env.GMAIL_USER },
            to,
            subject,
            html,
            text,
        });
    } finally {
        await mailer.close().catch(() => {});
    }
}

async function sendViaResend(env, { to, subject, html, text }) {
    const response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: `${env.FROM_NAME || 'StockPulse Alerts'} <${env.FROM_EMAIL || 'onboarding@resend.dev'}>`,
            to,
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

async function sendAlertEmail(env, email, triggered) {
    const subject = `StockPulse: ${triggered.length} stock${triggered.length > 1 ? 's' : ''} crossed below moving average`;
    const { text, html } = buildAlertEmailContent(triggered, email);
    await sendEmail(env, { to: email, subject, html, text });
}

async function sendWatchConfirmationEmail(env, email, ticker, parsed, tickers) {
    const subject = `StockPulse: now watching ${ticker}`;
    const { text, html } = buildConfirmationEmailContent(ticker, parsed, tickers, email);
    await sendEmail(env, { to: email, subject, html, text });
}

function manageUrl(email) {
    return `${APP_URL}/?email=${encodeURIComponent(email)}`;
}

function emailLayout({ title, subtitle, bodyHtml, email }) {
    return `
        <div style="background:#0a0a0f;padding:32px;font-family:'Inter',-apple-system,sans-serif;">
            <div style="max-width:600px;margin:0 auto;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;">
                <div style="padding:24px 32px;background:linear-gradient(135deg,#6366f1,#8b5cf6);">
                    <h1 style="margin:0;color:#fff;font-size:20px;">${title}</h1>
                    <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:14px;">${subtitle}</p>
                </div>
                ${bodyHtml}
                <div style="padding:24px 32px;text-align:center;">
                    <a href="${manageUrl(email)}" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;padding:12px 32px;border-radius:8px;font-weight:600;font-size:14px;">View Charts &amp; Manage Alerts</a>
                </div>
                <div style="padding:0 32px 24px;color:rgba(255,255,255,0.3);font-size:11px;text-align:center;">
                    Sent to ${escapeHtml(email)} · Daily check after US market close
                </div>
            </div>
        </div>`;
}

function buildAlertEmailContent(triggered, email) {
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

    const text = `StockPulse Alert — ${triggered.length} crossover${triggered.length > 1 ? 's' : ''} detected\n\n${lines.join('\n')}\nView charts and manage alerts: ${manageUrl(email)}`;

    const html = emailLayout({
        title: '📈 StockPulse Alert',
        subtitle: `${triggered.length} stock${triggered.length > 1 ? 's crossed' : ' crossed'} below a moving average`,
        email,
        bodyHtml: `
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
                </table>`,
    });

    return { text, html };
}

function buildConfirmationEmailContent(ticker, parsed, tickers, email) {
    const name = parsed.longName || ticker;
    const describe = (ma) => {
        if (ma == null) return { label: 'not enough history yet', color: 'rgba(255,255,255,0.5)' };
        return parsed.price > ma
            ? { label: `${formatPrice(ma, parsed.currency)} · price above`, color: '#10b981' }
            : { label: `${formatPrice(ma, parsed.currency)} · price already below`, color: '#ef4444' };
    };
    const ma200 = describe(parsed.ma200);
    const ma365 = describe(parsed.ma365);
    const alreadyBelow = [parsed.ma200, parsed.ma365].some((ma) => ma != null && parsed.price <= ma);
    const note = alreadyBelow
        ? 'It is already below at least one average, so you will be alerted after it recovers above and then crosses below again.'
        : 'You will get an email the day it closes below either average.';

    const text = [
        `You're now watching ${name} (${ticker}).`,
        '',
        `Price:  ${formatPrice(parsed.price, parsed.currency)} on ${parsed.date}`,
        `MA200:  ${ma200.label}`,
        `MA365:  ${ma365.label}`,
        '',
        note,
        '',
        `Your alert list: ${tickers.join(', ')}`,
        `Manage alerts: ${manageUrl(email)}`,
    ].join('\n');

    const row = (label, value, color) => `
        <tr>
            <td style="padding:10px 32px;color:rgba(255,255,255,0.5);font-size:13px;border-bottom:1px solid rgba(255,255,255,0.06);">${label}</td>
            <td style="padding:10px 32px;color:${color};font-size:14px;font-weight:600;text-align:right;border-bottom:1px solid rgba(255,255,255,0.06);">${value}</td>
        </tr>`;

    const html = emailLayout({
        title: `🔔 Now watching ${escapeHtml(ticker)}`,
        subtitle: escapeHtml(name),
        email,
        bodyHtml: `
                <table style="width:100%;border-collapse:collapse;margin-top:8px;">
                    ${row('Price', `${formatPrice(parsed.price, parsed.currency)} <span style="color:rgba(255,255,255,0.4);font-weight:400;font-size:12px;">${escapeHtml(parsed.date)}</span>`, '#fff')}
                    ${row('200-day MA', ma200.label, ma200.color)}
                    ${row('365-day MA', ma365.label, ma365.color)}
                </table>
                <p style="padding:16px 32px 0;margin:0;color:rgba(255,255,255,0.7);font-size:14px;line-height:1.5;">${note}</p>
                <p style="padding:12px 32px 0;margin:0;color:rgba(255,255,255,0.5);font-size:13px;">Your alert list: <strong style="color:#a5b4fc;">${tickers.map(escapeHtml).join(', ')}</strong></p>`,
    });

    return { text, html };
}

// ===== Utilities =====
function normalizeTicker(input) {
    if (!input || typeof input !== 'string') return null;
    const cleaned = input.trim().toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z]{1,6}(\.[A-Z]{1,3})?$/.test(cleaned)) return null;
    return cleaned;
}

function normalizeEmail(input) {
    if (!input || typeof input !== 'string') return null;
    const cleaned = input.trim().toLowerCase();
    if (cleaned.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return null;
    return cleaned;
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
