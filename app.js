// ===== Configuration =====
const CONFIG = {
    APP_VERSION: '1.1.0', // Increment on each deploy to bust caches
    YAHOO_API_BASE: 'https://query1.finance.yahoo.com/v8/finance/chart',
    YAHOO_SEARCH_BASE: 'https://query1.finance.yahoo.com/v1/finance/search',
    CORS_PROXY: '/api/proxy?url=',
    ALPHA_VANTAGE_ENDPOINT: '/api/fundamentals?symbol=',
    YAHOO_CACHE_TTL: 5 * 60 * 1000,
    AV_CACHE_TTL: 24 * 60 * 60 * 1000,
    EMPTY_RESPONSE_TTL: 7 * 24 * 60 * 60 * 1000,
    COLORS: {
        price: '#6366f1',
        priceGradient: 'rgba(99, 102, 241, 0.1)',
        ma200: '#f59e0b',
        ma365: '#ef4444',
        grid: 'rgba(255, 255, 255, 0.06)',
        text: 'rgba(255, 255, 255, 0.6)'
    },
    MA_PERIODS: [200, 365]
};

// ===== Request Deduplication =====
const pendingRequests = new Map();

function deduplicate(key, fn) {
    if (pendingRequests.has(key)) {
        return pendingRequests.get(key);
    }
    const promise = fn().finally(() => pendingRequests.delete(key));
    pendingRequests.set(key, promise);
    return promise;
}

// ===== State =====
let stockChart = null;
let currentTicker = null;

// ===== Usage Tracking =====
const DAILY_AV_LIMIT = 25;

function getUsageStats() {
    const today = new Date().toUTCString().split(' ')[0];
    const stored = localStorage.getItem('av_usage');
    if (stored) {
        const { date, count } = JSON.parse(stored);
        if (date === today) {
            return { date, count };
        }
    }
    return { date: today, count: 0 };
}

function incrementUsage() {
    const stats = getUsageStats();
    stats.count++;
    localStorage.setItem('av_usage', JSON.stringify(stats));
    updateUsageBadge();
}

function updateUsageBadge() {
    const badge = document.getElementById('apiStatusBadge');
    const text = document.getElementById('apiStatusText');
    const dot = badge.querySelector('.status-dot');
    if (!badge || !text || !dot) return;

    const { count } = getUsageStats();
    const remaining = Math.max(0, DAILY_AV_LIMIT - count);

    dot.classList.remove('status-dot-ok', 'status-dot-limited');
    if (remaining === 0) {
        dot.classList.add('status-dot-limited');
        text.textContent = 'API limit reached';
    } else {
        dot.classList.add('status-dot-ok');
        text.textContent = 'Fundamentals ready';
    }
}

// ===== DOM Elements =====
const elements = {
    tickerInput: document.getElementById('tickerInput'),
    searchBtn: document.getElementById('searchBtn'),
    stockName: document.getElementById('stockName'),
    priceInfo: document.getElementById('priceInfo'),
    currentPrice: document.getElementById('currentPrice'),
    priceChange: document.getElementById('priceChange'),
    chartPlaceholder: document.getElementById('chartPlaceholder'),
    chartLoading: document.getElementById('chartLoading'),
    chartError: document.getElementById('chartError'),
    errorMessage: document.getElementById('errorMessage'),
    retryBtn: document.getElementById('retryBtn'),
    statsSection: document.getElementById('statsSection'),
    flagsSection: document.getElementById('flagsSection'),
    statPrice: document.getElementById('statPrice'),
    statMA200: document.getElementById('statMA200'),
    statMA365: document.getElementById('statMA365'),
    statHigh: document.getElementById('statHigh'),
    statLow: document.getElementById('statLow'),
    statATH: document.getElementById('statATH'),
    athHint: document.getElementById('athHint'),
    statRSI: document.getElementById('statRSI'),
    rsiCard: document.getElementById('rsiCard'),
    rsiHint: document.getElementById('rsiHint'),
    statPE: document.getElementById('statPE'),
    peCard: document.getElementById('peCard'),
    peHint: document.getElementById('peHint'),
    statPEG: document.getElementById('statPEG'),
    pegCard: document.getElementById('pegCard'),
    pegHint: document.getElementById('pegHint'),
    statProfitMargin: document.getElementById('statProfitMargin'),
    profitMarginCard: document.getElementById('profitMarginCard'),
    profitMarginHint: document.getElementById('profitMarginHint'),
    statReturn1y: document.getElementById('statReturn1y'),
    statReturn3y: document.getElementById('statReturn3y'),
    statReturn5y: document.getElementById('statReturn5y'),
    return1yCard: document.getElementById('return1yCard'),
    return3yCard: document.getElementById('return3yCard'),
    return5yCard: document.getElementById('return5yCard'),
    tickerChips: document.querySelectorAll('.ticker-chip'),
    btnText: document.querySelector('.btn-text'),
    btnLoader: document.querySelector('.btn-loader')
};

// ===== Initialize =====
document.addEventListener('DOMContentLoaded', () => {
    checkVersionAndClearCache();
    init();
    updateUsageBadge();
});

function checkVersionAndClearCache() {
    const storedVersion = localStorage.getItem('app_version');
    if (storedVersion !== CONFIG.APP_VERSION) {
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith('yahoo_chart_') || key.startsWith('av_overview_') || key.startsWith('av_')) {
                keysToRemove.push(key);
            }
        }
        keysToRemove.forEach(key => localStorage.removeItem(key));
        localStorage.setItem('app_version', CONFIG.APP_VERSION);
        console.log('App version updated to', CONFIG.APP_VERSION, '- cleared stale caches');
    }
}

function init() {
    elements.searchBtn.addEventListener('click', handleSearch);
    elements.tickerInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleSearch();
    });
    elements.retryBtn.addEventListener('click', handleSearch);

    elements.tickerChips.forEach(chip => {
        chip.addEventListener('click', () => {
            const ticker = chip.dataset.ticker;
            elements.tickerInput.value = ticker;
            loadStockData(ticker);
        });
    });
}

// ===== Search Handler =====
async function handleSearch() {
    const query = elements.tickerInput.value.trim();
    if (!query) {
        showError('Please enter a ticker symbol or stock name');
        return;
    }

    const TICKER_ALIASES = {
        'VWRP': 'VWRP.L',
        'VUAG': 'VUAG.L'
    };

    let searchString = query;
    let upperQuery = query.toUpperCase();
    if (TICKER_ALIASES[upperQuery]) {
        searchString = TICKER_ALIASES[upperQuery];
    }

    const isLikelyTicker = /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(searchString.toUpperCase());

    let ticker = searchString.toUpperCase();
    let stockName = ticker;

    if (!isLikelyTicker || searchString.includes(' ')) {
        showLoading();
        const searchResult = await searchStock(searchString);
        if (searchResult) {
            ticker = searchResult.symbol;
            stockName = searchResult.name;
            elements.tickerInput.value = ticker;
        } else {
            ticker = searchString.toUpperCase().replace(/[^A-Z.]/g, '');
        }
    } else if (TICKER_ALIASES[upperQuery]) {
        elements.tickerInput.value = ticker;
    }

    await loadStockData(ticker, stockName);
}

// ===== Search for Stock by Name =====
async function searchStock(query) {
    try {
        const searchUrl = `${CONFIG.YAHOO_SEARCH_BASE}?q=${encodeURIComponent(query)}&quotesCount=1&newsCount=0`;
        const url = `${CONFIG.CORS_PROXY}${encodeURIComponent(searchUrl)}`;

        const response = await fetch(url);
        if (!response.ok) return null;

        const data = await response.json();
        if (data.quotes && data.quotes.length > 0) {
            const quote = data.quotes[0];
            return {
                symbol: quote.symbol,
                name: quote.shortname || quote.longname || quote.symbol
            };
        }
    } catch (error) {
        console.error('Search error:', error);
    }
    return null;
}

// ===== Load Stock Data =====
async function loadStockData(ticker, stockName = null) {
    showLoading();
    currentTicker = ticker;

    try {
        const [data, fundamentals] = await Promise.all([
            fetchStockData(ticker),
            fetchFundamentalsAlphaVantage(ticker)
        ]);

        if (fundamentals?.rateLimited) {
            showError('Rate limit reached. Alpha Vantage daily limit hit. Data may be incomplete.');
            return;
        }
        if (fundamentals?.apiError) {
            showError('Error fetching fundamentals. Please try again later.');
            return;
        }
        if (fundamentals?.unsupportedTicker) {
            showError('Fundamentals data not available for this ticker.');
            return;
        }

        if (data.error) {
            showError(data.error);
            return;
        }

        const { dates, prices, volumes } = parseTimeSeriesData(data);

        const minDays = Math.min(...CONFIG.MA_PERIODS);
        if (prices.length < minDays) {
            showError(`Not enough data to calculate moving averages. Need at least ${minDays} days of data.`);
            return;
        }

        const movingAverages = {};
        CONFIG.MA_PERIODS.forEach(period => {
            movingAverages[period] = calculateMovingAverage(prices, period);
        });

        const displayDays = Math.min(500, prices.length);
        const displayDates = dates.slice(-displayDays);
        const displayPrices = prices.slice(-displayDays);
        const displayMAs = {};
        CONFIG.MA_PERIODS.forEach(period => {
            displayMAs[period] = movingAverages[period].slice(-displayDays);
        });

        const stats = calculateStats(prices, movingAverages);
        stats.peRatio = fundamentals.peRatio;
        stats.pegRatio = fundamentals.pegRatio;
        stats.profitMargin = fundamentals.profitMargin;
        stats.rateLimited = fundamentals.rateLimited;
        stats.unsupportedTicker = fundamentals.unsupportedTicker;
        stats.apiError = fundamentals.apiError;

        const displayName = stockName || ticker;

        updateUI(ticker, displayName, stats, fundamentals);
        renderChart(displayDates, displayPrices, displayMAs);

    } catch (error) {
        console.error('Error loading stock data:', error);
        showError('Failed to fetch stock data. Please try again later.');
    }
}

function setRateLimitCircuitBreaker() {
    const now = new Date();
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    localStorage.setItem('av_circuit_breaker', JSON.stringify({
        until: tomorrow.getTime()
    }));
}

// ===== Fetch Fundamentals from Alpha Vantage with Caching =====
async function fetchFundamentalsAlphaVantage(ticker) {
    const internationalSuffixes = [
        '.L', '.LON', '.TO', '.V', '.AX', '.HK', '.SI', '.TW', '.KS', '.T',
        '.PA', '.DE', '.MI', '.BR', '.AS', '.ST', '.CO', '.OL', '.HE',
        '.SW', '.MC', '.LS', '.AT', '.PR', '.SA', '.CR', '.BO', '.NS',
        '.NZ', '.KL', '.BK', '.JK', '.SR', '.PS', '.SZ', '.SS', '.MX',
        '.BA', '.CA', '.LM',
    ];

    const tickerUpper = ticker.toUpperCase();
    const isInternationalTicker = internationalSuffixes.some(suffix =>
        tickerUpper.endsWith(suffix) || tickerUpper.endsWith(suffix + '.')
    );

    if (isInternationalTicker) {
        console.log('Skipping Alpha Vantage for international ticker:', ticker);
        return { peRatio: null, pegRatio: null, profitMargin: null, unsupportedTicker: true };
    }

    // Circuit breaker removed to allow fallback API usage

    const cacheKey = `av_overview_${ticker}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
        const { data, timestamp } = JSON.parse(cached);
        const age = Date.now() - timestamp;
        const ttl = data.unsupportedTicker ? CONFIG.EMPTY_RESPONSE_TTL : CONFIG.AV_CACHE_TTL;
        if (age < ttl) {
            console.log('Using cached Alpha Vantage data for', ticker);
            return data;
        }
    }

    return deduplicate(`av_${ticker}`, async () => {
        incrementUsage();
        try {
            const url = `${CONFIG.ALPHA_VANTAGE_ENDPOINT}${ticker}`;
            const response = await fetch(url);

            if (response.status === 429) {
                console.warn('Alpha Vantage API limit reached');
                return { peRatio: null, pegRatio: null, profitMargin: null, rateLimited: true };
            }

            if (!response.ok) {
                console.warn('Backend API error:', response.status);
                return { peRatio: null, pegRatio: null, profitMargin: null, apiError: true };
            }

            const data = await response.json();

            if (data.error === 'rate_limited' || data.error === 'both_rate_limited') {
                console.warn('API limit reached');
                if (data.error === 'both_rate_limited') {
                    setRateLimitCircuitBreaker();
                }
                return { peRatio: null, pegRatio: null, profitMargin: null, rateLimited: true };
            }

            if (Object.keys(data).length === 0) {
                console.log('Alpha Vantage returned empty data for', ticker);
                const result = { peRatio: null, pegRatio: null, profitMargin: null, unsupportedTicker: true };
                localStorage.setItem(cacheKey, JSON.stringify({
                    data: result,
                    timestamp: Date.now()
                }));
                return result;
            }

            const result = {
                peRatio: data.PERatio && data.PERatio !== 'None' ? parseFloat(data.PERatio) : null,
                pegRatio: data.PEGRatio && data.PEGRatio !== 'None' ? parseFloat(data.PEGRatio) : null,
                profitMargin: data.ProfitMargin && data.ProfitMargin !== 'None' ? parseFloat(data.ProfitMargin) : null,
                roe: data.ROE && data.ROE !== 'None' ? parseFloat(data.ROE) : null,
                debtToEquity: data.DebtToEquity && data.DebtToEquity !== 'None' ? parseFloat(data.DebtToEquity) : null,
                pb: data.PB && data.PB !== 'None' ? parseFloat(data.PB) : null,
                epsGrowth: data.EPSGrowth && data.EPSGrowth !== 'None' ? parseFloat(data.EPSGrowth) : null,
                dividendYield: data.DividendYield && data.DividendYield !== 'None' ? parseFloat(data.DividendYield) : null,
                marketCap: data.MarketCap && data.MarketCap !== 'None' ? parseFloat(data.MarketCap) : null
            };

            localStorage.setItem(cacheKey, JSON.stringify({
                data: result,
                timestamp: Date.now()
            }));

            return result;
        } catch (error) {
            console.error('Error fetching fundamentals from Alpha Vantage:', error);
            return { peRatio: null, pegRatio: null, profitMargin: null, apiError: true };
        }
    });
}



function clearOldCaches() {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith('yahoo_chart_') || key.startsWith('av_overview_')) {
            keysToRemove.push(key);
        }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
}

// ===== Fetch Stock Data with Caching =====
async function fetchStockData(ticker) {
    const range = 'max';
    const interval = '1d';
    const yahooUrl = `${CONFIG.YAHOO_API_BASE}/${ticker}?range=${range}&interval=${interval}`;
    const url = `${CONFIG.CORS_PROXY}${encodeURIComponent(yahooUrl)}`;
    const cacheKey = `yahoo_chart_${ticker}`;

    const cached = localStorage.getItem(cacheKey);
    if (cached) {
        try {
            const { data, timestamp } = JSON.parse(cached);
            const age = Date.now() - timestamp;
            if (age < CONFIG.YAHOO_CACHE_TTL) {
                console.log('Using cached Yahoo data for', ticker);
                return data;
            }
        } catch (e) {
            localStorage.removeItem(cacheKey);
        }
    }

    return deduplicate(`yahoo_${ticker}`, async () => {
        try {
            const response = await fetch(url);

            if (!response.ok) {
                if (response.status === 404) {
                    return { error: 'Invalid ticker symbol. Please check and try again.' };
                }
                return { error: `Server error (${response.status}). Please try again later.` };
            }

            const data = await response.json();

            if (data.chart?.error) {
                return { error: data.chart.error.description || 'Failed to fetch data.' };
            }

            if (!data.chart?.result?.[0]) {
                return { error: 'No data available for this ticker.' };
            }

            try {
                localStorage.setItem(cacheKey, JSON.stringify({
                    data,
                    timestamp: Date.now()
                }));
            } catch (e) {
                clearOldCaches();
            }

            return data;
        } catch (error) {
            console.error('Fetch error:', error);
            return { error: 'Network error. Please check your connection and try again.' };
        }
    });
}

// ===== Parse Time Series Data =====
function parseTimeSeriesData(data) {
    const result = data.chart.result[0];
    const timestamps = result.timestamp;
    const quotes = result.indicators.quote[0];

    const entries = [];
    for (let i = 0; i < timestamps.length; i++) {
        const closePrice = quotes.close[i];
        if (closePrice != null) {
            const date = new Date(timestamps[i] * 1000);
            const dateStr = date.toISOString().split('T')[0];
            entries.push({
                date: dateStr,
                close: closePrice,
                volume: quotes.volume[i] || 0
            });
        }
    }

    const dates = entries.map(e => e.date);
    const prices = entries.map(e => e.close);
    const volumes = entries.map(e => e.volume);

    return { dates, prices, volumes };
}

// ===== Calculate Moving Average (sliding window O(n)) =====
function calculateMovingAverage(prices, period) {
    const ma = [];
    let sum = 0;

    for (let i = 0; i < prices.length; i++) {
        sum += prices[i];

        if (i >= period) {
            sum -= prices[i - period];
        }

        if (i < period - 1) {
            ma.push(null);
        } else {
            ma.push(sum / period);
        }
    }

    return ma;
}

// ===== Calculate RSI =====
function calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) {
        return null;
    }

    const changes = [];
    for (let i = 1; i < prices.length; i++) {
        changes.push(prices[i] - prices[i - 1]);
    }

    let avgGain = 0;
    let avgLoss = 0;

    for (let i = 0; i < period; i++) {
        if (changes[i] > 0) {
            avgGain += changes[i];
        } else {
            avgLoss += Math.abs(changes[i]);
        }
    }
    avgGain /= period;
    avgLoss /= period;

    for (let i = period; i < changes.length; i++) {
        const change = changes[i];
        if (change > 0) {
            avgGain = (avgGain * (period - 1) + change) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
        }
    }

    if (avgLoss === 0) {
        return 100;
    }
    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));

    return rsi;
}

// ===== Calculate Statistics =====
function calculateStats(prices, movingAverages) {
    const currentPrice = prices[prices.length - 1];
    const previousPrice = prices[prices.length - 2];
    const priceChange = currentPrice - previousPrice;
    const priceChangePercent = (priceChange / previousPrice) * 100;

    const currentMAs = {};
    CONFIG.MA_PERIODS.forEach(period => {
        const maArray = movingAverages[period];
        currentMAs[period] = maArray[maArray.length - 1];
    });

    const high52Week = Math.max(...prices.slice(-252));
    const low52Week = Math.min(...prices.slice(-252));

    const allTimeHigh = Math.max(...prices);
    const dropFromATH = ((currentPrice - allTimeHigh) / allTimeHigh) * 100;

    const rsi = calculateRSI(prices, 14);

    const calculateReturn = (yearsAgo, annualize = false) => {
        const daysAgo = yearsAgo * 250;
        const minRequired = Math.floor(daysAgo * 0.95);
        if (prices.length < minRequired) return null;
        const actualIndex = Math.max(0, prices.length - daysAgo);
        const pastPrice = prices[actualIndex];

        if (pastPrice <= 0 || currentPrice <= 0) return null;
        if (!isFinite(pastPrice) || !isFinite(currentPrice)) return null;

        const ratio = currentPrice / pastPrice;
        if (ratio > 20 || ratio < 0.05) return null;

        if (annualize && yearsAgo > 1) {
            const cagr = (Math.pow(ratio, 1 / yearsAgo) - 1) * 100;
            if (!isFinite(cagr) || Math.abs(cagr) > 1000) return null;
            return cagr;
        }
        const simpleReturn = (ratio - 1) * 100;
        if (!isFinite(simpleReturn) || Math.abs(simpleReturn) > 1000) return null;
        return simpleReturn;
    };

    const return1y = calculateReturn(1, false);
    const return3y = calculateReturn(3, true);
    const return5y = calculateReturn(5, true);

    return {
        currentPrice,
        priceChange,
        priceChangePercent,
        currentMAs,
        high52Week,
        low52Week,
        allTimeHigh,
        dropFromATH,
        rsi,
        return1y,
        return3y,
        return5y
    };
}

// ===== Update UI =====
function renderFlags(fundamentals) {
    const flagsContainer = elements.flagsSection.querySelector('.flags-container');
    flagsContainer.innerHTML = '';

    const lynchCriteria = [
        { label: 'Trailing P/E < 25', value: fundamentals.peRatio, threshold: 25, operator: '<', unit: '' },
        { label: 'Debt/Equity < 35%', value: fundamentals.debtToEquity, threshold: 35, operator: '<', unit: '%' },
        { label: 'EPS Growth > 15%', value: fundamentals.epsGrowth, threshold: 15, operator: '>', unit: '%' },
        { label: 'PEG Ratio < 2', value: fundamentals.pegRatio, threshold: 2, operator: '<', unit: '' },
        { label: 'Market Cap > $5B', value: fundamentals.marketCap, threshold: 5e9, operator: '>', unit: '$', format: 'currency' }
    ];

    const buffettCriteria = [
        { label: 'ROE > 15%', value: fundamentals.roe, threshold: 15, operator: '>', unit: '%' },
        { label: 'Debt/Equity < 50%', value: fundamentals.debtToEquity, threshold: 50, operator: '<', unit: '%' },
        { label: 'P/E < 20', value: fundamentals.peRatio, threshold: 20, operator: '<', unit: '' },
        { label: 'P/B < 1.5', value: fundamentals.pb, threshold: 1.5, operator: '<', unit: '' },
        { label: 'Dividend Yield > 2%', value: fundamentals.dividendYield, threshold: 2, operator: '>', unit: '%' },
        { label: 'Market Cap > $10B', value: fundamentals.marketCap, threshold: 10e9, operator: '>', unit: '$', format: 'currency' }
    ];

    function createFlagCategory(title, criteria) {
        const categoryDiv = document.createElement('div');
        categoryDiv.className = 'flag-category';
        categoryDiv.innerHTML = `<h4>${title}</h4><ul></ul>`;
        const ul = categoryDiv.querySelector('ul');
        criteria.forEach(criterion => {
            const li = document.createElement('li');
            let displayText;
            let color = 'gray';
            if (criterion.value === null || criterion.value === undefined) {
                displayText = `${criterion.label.split(' ')[0]} ${criterion.label.split(' ')[1]}: N/A`;
            } else {
                const formattedValue = criterion.format === 'currency' ?
                    formatCurrency(criterion.value) :
                    `${criterion.value.toFixed(criterion.unit === '%' ? 1 : 2)}${criterion.unit}`;
                const condition = criterion.operator === '>' ?
                    criterion.value > criterion.threshold :
                    criterion.value < criterion.threshold;
                const icon = condition ? '✓' : '✗';
                color = condition ? 'green' : 'red';
                displayText = `${criterion.label.split(' ')[0]} ${criterion.label.split(' ')[1]}: ${formattedValue} ${criterion.operator} ${criterion.threshold}${criterion.unit} ${icon}`;
            }
            li.innerHTML = `<span style="color: ${color};">${displayText}</span>`;
            ul.appendChild(li);
        });
        return categoryDiv;
    }

    flagsContainer.appendChild(createFlagCategory("Peter Lynch's Multi-Bagger Rules", lynchCriteria));
    flagsContainer.appendChild(createFlagCategory("Warren Buffett's Value Investing Criteria", buffettCriteria));
}

function updateUI(ticker, displayName, stats, fundamentals) {
    elements.stockName.textContent = displayName !== ticker ? `${displayName} (${ticker})` : ticker;

    elements.priceInfo.hidden = false;
    elements.currentPrice.textContent = formatCurrency(stats.currentPrice);

    const changeSign = stats.priceChange >= 0 ? '+' : '';
    elements.priceChange.textContent = `${changeSign}${formatCurrency(stats.priceChange)} (${changeSign}${stats.priceChangePercent.toFixed(2)}%)`;
    elements.priceChange.className = `price-change ${stats.priceChange >= 0 ? 'positive' : 'negative'}`;

    elements.statsSection.hidden = false;
    elements.flagsSection.hidden = false;
    renderFlags(fundamentals);
    elements.statPrice.textContent = formatCurrency(stats.currentPrice);
    elements.statMA200.textContent = formatCurrency(stats.currentMAs[200]);
    elements.statMA365.textContent = formatCurrency(stats.currentMAs[365]);
    elements.statHigh.textContent = formatCurrency(stats.high52Week);
    elements.statLow.textContent = formatCurrency(stats.low52Week);

    if (elements.statATH) {
        elements.statATH.textContent = formatCurrency(stats.allTimeHigh);
        if (elements.athHint) {
            if (stats.dropFromATH >= 0) {
                elements.athHint.textContent = 'At ATH';
                elements.athHint.className = 'stat-hint positive';
            } else {
                elements.athHint.textContent = `${stats.dropFromATH.toFixed(1)}% from ATH`;
                elements.athHint.className = 'stat-hint negative';
            }
        }
    }

    if (stats.rsi !== null) {
        elements.statRSI.textContent = stats.rsi.toFixed(1);
        elements.rsiCard.classList.remove('rsi-overbought', 'rsi-oversold');

        if (stats.rsi >= 70) {
            elements.rsiCard.classList.add('rsi-overbought');
            elements.rsiHint.textContent = 'Overbought';
        } else if (stats.rsi <= 30) {
            elements.rsiCard.classList.add('rsi-oversold');
            elements.rsiHint.textContent = 'Oversold';
        } else {
            elements.rsiHint.textContent = 'Neutral';
        }
    } else {
        elements.statRSI.textContent = '--';
        elements.rsiHint.textContent = '';
    }

    updateFundamentalCard(stats.peRatio, elements.peCard, elements.statPE, elements.peHint, stats);
    updateFundamentalCard(stats.pegRatio, elements.pegCard, elements.statPEG, elements.pegHint, stats);
    updateFundamentalCard(stats.profitMargin, elements.profitMarginCard, elements.statProfitMargin, elements.profitMarginHint, stats, true);

    const updateReturn = (value, element, card) => {
        card.classList.remove('return-positive', 'return-negative');
        if (value !== null) {
            const sign = value >= 0 ? '+' : '';
            element.textContent = `${sign}${value.toFixed(1)}%`;
            card.classList.add(value >= 0 ? 'return-positive' : 'return-negative');
        } else {
            element.textContent = '--';
        }
    };

    updateReturn(stats.return1y, elements.statReturn1y, elements.return1yCard);
    updateReturn(stats.return3y, elements.statReturn3y, elements.return3yCard);
    updateReturn(stats.return5y, elements.statReturn5y, elements.return5yCard);
}

function updateFundamentalCard(value, card, valueEl, hintEl, stats, isPercent = false) {
    if (value !== null && value !== undefined) {
        valueEl.textContent = isPercent ? `${value.toFixed(1)}%` : value.toFixed(isPercent ? 1 : (value < 10 ? 2 : 1));
        hintEl.textContent = '';
        card.hidden = false;
    } else {
        if (stats.rateLimited) {
            valueEl.textContent = '--';
            hintEl.textContent = 'API limit reached';
            hintEl.className = 'stat-hint negative';
            card.hidden = false;
        } else if (stats.unsupportedTicker) {
            valueEl.textContent = '--';
            hintEl.textContent = 'Not available';
            hintEl.className = 'stat-hint';
            card.hidden = false;
        } else if (stats.apiError) {
            valueEl.textContent = '--';
            hintEl.textContent = 'Failed to load';
            hintEl.className = 'stat-hint negative';
            card.hidden = false;
        } else {
            card.hidden = true;
        }
    }
}

// ===== Render Chart =====
function renderChart(dates, prices, movingAverages) {
    const ctx = document.getElementById('stockChart').getContext('2d');

    if (stockChart) {
        stockChart.destroy();
    }

    elements.chartPlaceholder.hidden = true;
    elements.chartLoading.hidden = true;
    elements.chartError.hidden = true;
    elements.searchBtn.disabled = false;
    elements.btnText.hidden = false;
    elements.btnLoader.hidden = true;

    const gradient = ctx.createLinearGradient(0, 0, 0, 400);
    gradient.addColorStop(0, 'rgba(99, 102, 241, 0.3)');
    gradient.addColorStop(1, 'rgba(99, 102, 241, 0)');

    const maConfigs = [
        { period: 200, label: '200-Day MA', color: CONFIG.COLORS.ma200, dash: [8, 4], width: 2 },
        { period: 365, label: '365-Day MA', color: CONFIG.COLORS.ma365, dash: [4, 2], width: 3 }
    ];

    const datasets = [
        {
            label: 'Price',
            data: prices,
            borderColor: CONFIG.COLORS.price,
            backgroundColor: gradient,
            borderWidth: 2,
            fill: true,
            tension: 0.1,
            pointRadius: 0,
            pointHoverRadius: 6,
            pointHoverBackgroundColor: CONFIG.COLORS.price,
            pointHoverBorderColor: '#fff',
            pointHoverBorderWidth: 2
        }
    ];

    maConfigs.forEach(config => {
        datasets.push({
            label: config.label,
            data: movingAverages[config.period],
            borderColor: config.color,
            borderWidth: config.width || 2,
            borderDash: config.dash,
            fill: false,
            tension: 0.1,
            pointRadius: 0,
            pointHoverRadius: 6,
            pointHoverBackgroundColor: config.color,
            pointHoverBorderColor: '#fff',
            pointHoverBorderWidth: 2
        });
    });

    stockChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: dates,
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: 'rgba(18, 18, 26, 0.95)',
                    titleColor: '#fff',
                    bodyColor: 'rgba(255, 255, 255, 0.8)',
                    borderColor: 'rgba(255, 255, 255, 0.1)',
                    borderWidth: 1,
                    padding: 12,
                    cornerRadius: 8,
                    displayColors: true,
                    callbacks: {
                        title: (items) => {
                            const date = new Date(items[0].label);
                            return date.toLocaleDateString('en-US', {
                                weekday: 'short',
                                year: 'numeric',
                                month: 'short',
                                day: 'numeric'
                            });
                        },
                        label: (item) => {
                            const label = item.dataset.label;
                            const value = item.parsed.y;
                            if (value === null) return null;
                            return `${label}: ${formatCurrency(value)}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: {
                        color: CONFIG.COLORS.grid,
                        drawBorder: false
                    },
                    ticks: {
                        color: CONFIG.COLORS.text,
                        maxRotation: 0,
                        maxTicksLimit: 8,
                        callback: function (value, index) {
                            const date = new Date(this.getLabelForValue(value));
                            return date.toLocaleDateString('en-US', {
                                month: 'short',
                                year: '2-digit'
                            });
                        }
                    }
                },
                y: {
                    position: 'right',
                    grid: {
                        color: CONFIG.COLORS.grid,
                        drawBorder: false
                    },
                    ticks: {
                        color: CONFIG.COLORS.text,
                        callback: (value) => formatCurrency(value)
                    }
                }
            }
        }
    });
}

// ===== UI State Helpers =====
function showLoading() {
    elements.chartPlaceholder.hidden = true;
    elements.chartLoading.hidden = false;
    elements.chartError.hidden = true;
    elements.searchBtn.disabled = true;
    elements.btnText.hidden = true;
    elements.btnLoader.hidden = false;
    elements.statsSection.hidden = true;
    elements.flagsSection.hidden = true;

    if (stockChart) {
        stockChart.destroy();
        stockChart = null;
    }
}

function showError(message) {
    elements.chartPlaceholder.hidden = true;
    elements.chartLoading.hidden = true;
    elements.chartError.hidden = false;
    elements.errorMessage.textContent = message;
    elements.searchBtn.disabled = false;
    elements.btnText.hidden = false;
    elements.btnLoader.hidden = true;
    elements.statsSection.hidden = true;
    elements.flagsSection.hidden = true;
}

function hideAllStates() {
    elements.chartPlaceholder.hidden = true;
    elements.chartLoading.hidden = true;
    elements.chartError.hidden = true;
    elements.searchBtn.disabled = false;
    elements.btnText.hidden = false;
    elements.btnLoader.hidden = true;
}

// ===== Utility Functions =====
function formatCurrency(value) {
    if (value === null || value === undefined) return '--';
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(value);
}
