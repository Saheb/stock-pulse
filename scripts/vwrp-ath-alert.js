#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CONFIG = {
    ticker: 'VWRP.L',
    displayTicker: 'VWRP',
    thresholds: [5, 10, 15, 20],
    marketTimeZone: 'Europe/London',
    marketCheckHour: 16,
    marketCheckMinuteWindow: 30,
    yahooChartBase: 'https://query1.finance.yahoo.com/v8/finance/chart',
    statePath: path.join(os.homedir(), 'Library', 'Application Support', 'StockPulse', 'vwrp-ath-alert-state.json'),
    userAgent: 'Mozilla/5.0 StockPulse ATH Alert',
};

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const forceNotify = args.has('--force-notify');
const ignoreMarketWindow = args.has('--ignore-market-window');

function ensureDir(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readState() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG.statePath, 'utf8'));
    } catch {
        return {
            ath: null,
            notifiedThresholds: [],
            lastCheckedAt: null,
        };
    }
}

function writeState(state) {
    ensureDir(CONFIG.statePath);
    fs.writeFileSync(CONFIG.statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function appleScriptString(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function notify(title, subtitle, body) {
    const script = [
        'display notification',
        appleScriptString(body),
        'with title',
        appleScriptString(title),
        'subtitle',
        appleScriptString(subtitle),
    ].join(' ');

    const result = spawnSync('/usr/bin/osascript', ['-e', script], { encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`osascript failed: ${result.stderr || result.stdout}`);
    }
}

function formatPrice(value, currency) {
    if (!Number.isFinite(value)) return 'n/a';

    if (currency === 'GBp' || currency === 'GBX') {
        return `${value.toFixed(2)}p`;
    }

    try {
        return new Intl.NumberFormat('en-GB', {
            style: 'currency',
            currency: currency || 'GBP',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        }).format(value);
    } catch {
        return `${value.toFixed(2)} ${currency || ''}`.trim();
    }
}

function getLondonParts(date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: CONFIG.marketTimeZone,
        weekday: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(date);

    return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function getMarketDate(parts) {
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function isMarketCheckWindow(date, state) {
    const parts = getLondonParts(date);
    const weekday = parts.weekday;
    const hour = Number(parts.hour);
    const minute = Number(parts.minute);
    const marketDate = getMarketDate(parts);
    const isWeekday = weekday !== 'Sat' && weekday !== 'Sun';
    const isCheckWindow = hour === CONFIG.marketCheckHour && minute < CONFIG.marketCheckMinuteWindow;
    const alreadyChecked = state.lastMarketWindowDate === marketDate;

    return {
        shouldCheck: isWeekday && isCheckWindow && !alreadyChecked,
        marketDate,
        londonTime: `${marketDate} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
        alreadyChecked,
    };
}

function parseChart(data) {
    const result = data?.chart?.result?.[0];
    if (!result) {
        const message = data?.chart?.error?.description || 'Yahoo Finance returned no chart data';
        throw new Error(message);
    }

    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const entries = [];

    for (let i = 0; i < timestamps.length; i += 1) {
        const close = closes[i];
        if (Number.isFinite(close)) {
            entries.push({
                date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
                close,
            });
        }
    }

    if (entries.length === 0) {
        throw new Error('Yahoo Finance returned no valid closing prices');
    }

    let ath = entries[0];
    for (const entry of entries) {
        if (entry.close > ath.close) {
            ath = entry;
        }
    }

    return {
        latest: entries[entries.length - 1],
        ath,
        currency: result.meta?.currency || 'GBP',
        longName: result.meta?.longName || result.meta?.shortName || CONFIG.displayTicker,
    };
}

async function fetchChart() {
    const period2 = Math.floor(Date.now() / 1000);
    const url = `${CONFIG.yahooChartBase}/${CONFIG.ticker}?period1=0&period2=${period2}&interval=1d&includePrePost=false&events=div%2Csplits`;
    const response = await fetch(url, {
        headers: {
            'User-Agent': CONFIG.userAgent,
            Accept: 'application/json',
        },
    });

    if (!response.ok) {
        throw new Error(`Yahoo Finance request failed with HTTP ${response.status}`);
    }

    return response.json();
}

function calculateAlert(chart, state) {
    const drawdown = (1 - chart.latest.close / chart.ath.close) * 100;
    const reachedThresholds = CONFIG.thresholds.filter(threshold => drawdown >= threshold);

    const previousAth = Number(state.ath);
    const athChanged = !Number.isFinite(previousAth) || Math.abs(previousAth - chart.ath.close) > 0.0001;
    const alreadyNotified = athChanged ? [] : state.notifiedThresholds || [];
    const newThresholds = reachedThresholds.filter(threshold => !alreadyNotified.includes(threshold));

    return {
        drawdown,
        reachedThresholds,
        newThresholds,
        athChanged,
    };
}

async function main() {
    const state = readState();
    const marketWindow = isMarketCheckWindow(new Date(), state);

    if (!dryRun && !forceNotify && !ignoreMarketWindow && !marketWindow.shouldCheck) {
        const reason = marketWindow.alreadyChecked ? 'already checked this London trading day' : 'outside the 16:00-16:29 London check window';
        console.log(`Skipping VWRP alert check: ${reason}. London time: ${marketWindow.londonTime}.`);
        return;
    }

    const chart = parseChart(await fetchChart());
    const alert = calculateAlert(chart, state);
    const checkedAt = new Date().toISOString();
    const recordMarketWindow = !forceNotify && !ignoreMarketWindow && marketWindow.shouldCheck;

    const nextState = {
        ath: chart.ath.close,
        athDate: chart.ath.date,
        notifiedThresholds: alert.athChanged ? alert.reachedThresholds : [
            ...new Set([...(state.notifiedThresholds || []), ...alert.newThresholds]),
        ].sort((a, b) => a - b),
        lastCheckedAt: checkedAt,
        lastClose: chart.latest.close,
        lastCloseDate: chart.latest.date,
        lastDrawdown: alert.drawdown,
        lastMarketWindowDate: recordMarketWindow ? marketWindow.marketDate : state.lastMarketWindowDate,
    };

    const shouldNotify = forceNotify || alert.newThresholds.length > 0;
    const title = 'StockPulse';
    const subtitle = `${CONFIG.displayTicker} ATH alert`;
    const reached = (forceNotify ? alert.reachedThresholds : alert.newThresholds).join('%, ');
    const body = shouldNotify
        ? `${CONFIG.displayTicker} is ${alert.drawdown.toFixed(2)}% below ATH. Threshold${reached.includes(',') ? 's' : ''}: ${reached || 'test'}%. Latest ${formatPrice(chart.latest.close, chart.currency)} on ${chart.latest.date}; ATH ${formatPrice(chart.ath.close, chart.currency)} on ${chart.ath.date}.`
        : `${CONFIG.displayTicker}: ${alert.drawdown.toFixed(2)}% below ATH. Latest ${formatPrice(chart.latest.close, chart.currency)}; ATH ${formatPrice(chart.ath.close, chart.currency)}. No new threshold.`;

    console.log(body);

    if (shouldNotify && !dryRun) {
        notify(title, subtitle, body);
    }

    if (!dryRun) {
        writeState(nextState);
    }
}

main().catch(error => {
    const message = `VWRP ATH alert check failed: ${error.message}`;
    console.error(message);
    if (!dryRun) {
        notify('StockPulse', 'VWRP alert error', message);
    }
    process.exitCode = 1;
});
