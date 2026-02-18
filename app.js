// ===== Configuration =====
const CONFIG = {
    // Yahoo Finance APIs (no API key needed)
    YAHOO_API_BASE: 'https://query1.finance.yahoo.com/v8/finance/chart',
    YAHOO_SEARCH_BASE: 'https://query1.finance.yahoo.com/v1/finance/search',
    YAHOO_QUOTE_SUMMARY: 'https://query1.finance.yahoo.com/v10/finance/quoteSummary',
    // Use our own Cloudflare Pages Function as proxy
    CORS_PROXY: '/api/proxy?url=',

    // Chart colors
    COLORS: {
        price: '#6366f1',
        priceGradient: 'rgba(99, 102, 241, 0.1)',
        ma200: '#f59e0b',   // Orange - 200 day
        ma365: '#ef4444',   // Red - 365 day (1 year)
        grid: 'rgba(255, 255, 255, 0.06)',
        text: 'rgba(255, 255, 255, 0.6)'
    },

    // Moving average periods
    MA_PERIODS: [200, 365]
};

// ===== State =====
let stockChart = null;
let currentTicker = null;

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
    statPrice: document.getElementById('statPrice'),
    statMA200: document.getElementById('statMA200'),
    statMA365: document.getElementById('statMA365'),
    statHigh: document.getElementById('statHigh'),
    statLow: document.getElementById('statLow'),
    statRSI: document.getElementById('statRSI'),
    rsiCard: document.getElementById('rsiCard'),
    rsiHint: document.getElementById('rsiHint'),
    statPE: document.getElementById('statPE'),
    statPEG: document.getElementById('statPEG'),
    statProfitMargin: document.getElementById('statProfitMargin'),
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
document.addEventListener('DOMContentLoaded', init);

function init() {
    // Event listeners
    elements.searchBtn.addEventListener('click', handleSearch);
    elements.tickerInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleSearch();
    });
    elements.retryBtn.addEventListener('click', handleSearch);

    // Popular ticker chips
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

    // A ticker is typically 1-5 uppercase letters only (user types "AAPL" not "Apple")
    // If query has lowercase letters, it's likely a stock name to search for
    const isLikelyTicker = /^[A-Z]{1,5}$/.test(query);

    let ticker = query.toUpperCase();
    let stockName = ticker;

    // If it doesn't look like a ticker, search for the stock
    if (!isLikelyTicker || query.includes(' ')) {
        showLoading();
        const searchResult = await searchStock(query);
        if (searchResult) {
            ticker = searchResult.symbol;
            stockName = searchResult.name;
            elements.tickerInput.value = ticker;
        } else {
            // Try as ticker anyway
            ticker = query.toUpperCase().replace(/[^A-Z]/g, '');
        }
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
        // Fetch chart data and fundamentals in parallel
        const [data, fundamentals] = await Promise.all([
            fetchStockData(ticker),
            fetchFundamentals(ticker)
        ]);

        if (data.error) {
            showError(data.error);
            return;
        }

        const { dates, prices, volumes } = parseTimeSeriesData(data);

        // Need at least 365 days for the longest MA
        const minDays = Math.max(...CONFIG.MA_PERIODS);
        if (prices.length < minDays) {
            showError(`Not enough data to calculate ${minDays}-day moving average. Need at least ${minDays} days of data.`);
            return;
        }

        // Calculate all moving averages on FULL data
        const movingAverages = {};
        CONFIG.MA_PERIODS.forEach(period => {
            movingAverages[period] = calculateMovingAverage(prices, period);
        });

        // Now slice to last 500 trading days (~2 years) for display
        const displayDays = 500;
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

        // Use stockName if provided, otherwise use ticker
        const displayName = stockName || ticker;

        updateUI(ticker, displayName, stats);
        renderChart(displayDates, displayPrices, displayMAs);

    } catch (error) {
        console.error('Error loading stock data:', error);
        showError('Failed to fetch stock data. Please try again later.');
    }
}

// ===== Fetch Fundamentals from Yahoo Finance =====
async function fetchFundamentals(ticker) {
    try {
        // Use quoteSummary endpoint for fundamental data
        const modules = 'defaultKeyStatistics,summaryDetail';
        const yahooUrl = `${CONFIG.YAHOO_QUOTE_SUMMARY}/${ticker}?modules=${modules}`;
        const url = `${CONFIG.CORS_PROXY}${encodeURIComponent(yahooUrl)}`;

        const response = await fetch(url);

        if (!response.ok) {
            console.warn('Yahoo Finance fundamentals error:', response.status);
            return { peRatio: null, pegRatio: null, profitMargin: null };
        }

        const data = await response.json();

        // Check for API errors
        if (data.quoteSummary?.error) {
            console.warn('Yahoo Finance:', data.quoteSummary.error);
            return { peRatio: null, pegRatio: null, profitMargin: null };
        }

        const result = data.quoteSummary?.result?.[0];
        if (!result) {
            return { peRatio: null, pegRatio: null, profitMargin: null };
        }

        // Extract P/E ratio (trailing P/E from summaryDetail)
        const pe = result.summaryDetail?.trailingPE;
        // Extract PEG ratio from defaultKeyStatistics
        const peg = result.defaultKeyStatistics?.pegRatio;
        // Extract profit margins from defaultKeyStatistics
        const margin = result.defaultKeyStatistics?.profitMargins;

        return {
            peRatio: pe != null && !isNaN(pe) ? pe : null,
            pegRatio: peg != null && !isNaN(peg) ? peg : null,
            profitMargin: margin != null && !isNaN(margin) ? margin * 100 : null  // Convert to percentage
        };
    } catch (error) {
        console.error('Error fetching fundamentals:', error);
        return { peRatio: null, pegRatio: null, profitMargin: null };
    }
}


// ===== Fetch Stock Data =====
async function fetchStockData(ticker) {
    // Fetch 5 years of data (to ensure 365-day MA has enough points to display)
    const range = '5y';
    const interval = '1d';
    const yahooUrl = `${CONFIG.YAHOO_API_BASE}/${ticker}?range=${range}&interval=${interval}`;
    // Use CORS proxy to bypass browser restrictions
    const url = `${CONFIG.CORS_PROXY}${encodeURIComponent(yahooUrl)}`;

    try {
        const response = await fetch(url);

        if (!response.ok) {
            if (response.status === 404) {
                return { error: 'Invalid ticker symbol. Please check and try again.' };
            }
            return { error: `Server error (${response.status}). Please try again later.` };
        }

        const data = await response.json();

        // Check for API errors
        if (data.chart?.error) {
            return { error: data.chart.error.description || 'Failed to fetch data.' };
        }

        if (!data.chart?.result?.[0]) {
            return { error: 'No data available for this ticker.' };
        }

        return data;
    } catch (error) {
        console.error('Fetch error:', error);
        return { error: 'Network error. Please check your connection and try again.' };
    }
}

// ===== Parse Time Series Data =====
function parseTimeSeriesData(data) {
    const result = data.chart.result[0];
    const timestamps = result.timestamp;
    const quotes = result.indicators.quote[0];

    // Convert timestamps to dates and pair with close prices
    const entries = [];
    for (let i = 0; i < timestamps.length; i++) {
        const closePrice = quotes.close[i];
        // Skip days with null/undefined prices (weekends, holidays already filtered by Yahoo)
        if (closePrice != null) {
            const date = new Date(timestamps[i] * 1000);
            const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD format
            entries.push({
                date: dateStr,
                close: closePrice,
                volume: quotes.volume[i] || 0
            });
        }
    }

    // Return ALL data - slicing happens after MA calculation
    const dates = entries.map(e => e.date);
    const prices = entries.map(e => e.close);
    const volumes = entries.map(e => e.volume);

    return { dates, prices, volumes };
}

// ===== Calculate Moving Average =====
function calculateMovingAverage(prices, period) {
    const ma = [];

    for (let i = 0; i < prices.length; i++) {
        if (i < period - 1) {
            // Not enough data points yet
            ma.push(null);
        } else {
            // Calculate average of last 'period' prices
            const slice = prices.slice(i - period + 1, i + 1);
            const avg = slice.reduce((sum, p) => sum + p, 0) / period;
            ma.push(avg);
        }
    }

    return ma;
}

// ===== Calculate RSI (Relative Strength Index) =====
function calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) {
        return null;
    }

    // Calculate daily price changes
    const changes = [];
    for (let i = 1; i < prices.length; i++) {
        changes.push(prices[i] - prices[i - 1]);
    }

    // Separate gains and losses
    let avgGain = 0;
    let avgLoss = 0;

    // Initial average (first 'period' days)
    for (let i = 0; i < period; i++) {
        if (changes[i] > 0) {
            avgGain += changes[i];
        } else {
            avgLoss += Math.abs(changes[i]);
        }
    }
    avgGain /= period;
    avgLoss /= period;

    // Calculate RSI using smoothed averages for remaining days
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

    // Calculate RSI
    if (avgLoss === 0) {
        return 100; // No losses means RSI is 100
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

    // Get latest MA values
    const currentMAs = {};
    CONFIG.MA_PERIODS.forEach(period => {
        const maArray = movingAverages[period];
        currentMAs[period] = maArray[maArray.length - 1];
    });

    const high52Week = Math.max(...prices.slice(-252)); // ~252 trading days in a year
    const low52Week = Math.min(...prices.slice(-252));

    // Calculate RSI (14-day)
    const rsi = calculateRSI(prices, 14);

    // Calculate multi-year returns (250 trading days ≈ 1 year, allowing slight tolerance)
    // For multi-year, use CAGR (Compound Annual Growth Rate) to normalize to yearly
    const calculateReturn = (yearsAgo, annualize = false) => {
        const daysAgo = yearsAgo * 250; // Use 250 instead of 252 for tolerance
        // Allow 5% tolerance in case of slight data variance
        const minRequired = Math.floor(daysAgo * 0.95);
        if (prices.length < minRequired) return null;
        // Use the closest available data point
        const actualIndex = Math.max(0, prices.length - daysAgo);
        const pastPrice = prices[actualIndex];

        if (annualize && yearsAgo > 1) {
            // CAGR formula: (endValue/startValue)^(1/years) - 1
            const cagr = (Math.pow(currentPrice / pastPrice, 1 / yearsAgo) - 1) * 100;
            return cagr;
        }
        return ((currentPrice - pastPrice) / pastPrice) * 100;
    };

    const return1y = calculateReturn(1, false);  // 1-year is already annual
    const return3y = calculateReturn(3, true);   // Annualized (CAGR)
    const return5y = calculateReturn(5, true);   // Annualized (CAGR)

    return {
        currentPrice,
        priceChange,
        priceChangePercent,
        currentMAs,
        high52Week,
        low52Week,
        rsi,
        return1y,
        return3y,
        return5y
    };
}

// ===== Update UI =====
function updateUI(ticker, displayName, stats) {
    // Update stock name - show name with ticker
    elements.stockName.textContent = displayName !== ticker ? `${displayName} (${ticker})` : ticker;

    // Update price info
    elements.priceInfo.hidden = false;
    elements.currentPrice.textContent = formatCurrency(stats.currentPrice);

    const changeSign = stats.priceChange >= 0 ? '+' : '';
    elements.priceChange.textContent = `${changeSign}${formatCurrency(stats.priceChange)} (${changeSign}${stats.priceChangePercent.toFixed(2)}%)`;
    elements.priceChange.className = `price-change ${stats.priceChange >= 0 ? 'positive' : 'negative'}`;

    // Update stats section
    elements.statsSection.hidden = false;
    elements.statPrice.textContent = formatCurrency(stats.currentPrice);
    elements.statMA200.textContent = formatCurrency(stats.currentMAs[200]);
    elements.statMA365.textContent = formatCurrency(stats.currentMAs[365]);
    elements.statHigh.textContent = formatCurrency(stats.high52Week);
    elements.statLow.textContent = formatCurrency(stats.low52Week);

    // Update RSI with overbought/oversold indicators
    if (stats.rsi !== null) {
        elements.statRSI.textContent = stats.rsi.toFixed(1);

        // Remove previous classes
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

    // Update P/E ratio
    if (stats.peRatio !== null && stats.peRatio !== undefined) {
        elements.statPE.textContent = stats.peRatio.toFixed(1);
    } else {
        elements.statPE.textContent = '--';
    }

    // Update PEG Ratio
    if (stats.pegRatio !== null && stats.pegRatio !== undefined) {
        elements.statPEG.textContent = stats.pegRatio.toFixed(2);
    } else {
        elements.statPEG.textContent = '--';
    }

    // Update Profit Margin
    if (stats.profitMargin !== null && stats.profitMargin !== undefined) {
        elements.statProfitMargin.textContent = `${stats.profitMargin.toFixed(1)}%`;
    } else {
        elements.statProfitMargin.textContent = '--';
    }

    // Update multi-year returns
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

// ===== Render Chart =====
function renderChart(dates, prices, movingAverages) {
    const ctx = document.getElementById('stockChart').getContext('2d');

    // Destroy existing chart
    if (stockChart) {
        stockChart.destroy();
    }

    // Hide placeholder/loading/error and reset button states
    elements.chartPlaceholder.hidden = true;
    elements.chartLoading.hidden = true;
    elements.chartError.hidden = true;
    elements.searchBtn.disabled = false;
    elements.btnText.hidden = false;
    elements.btnLoader.hidden = true;

    // Create gradient for price line
    const gradient = ctx.createLinearGradient(0, 0, 0, 400);
    gradient.addColorStop(0, 'rgba(99, 102, 241, 0.3)');
    gradient.addColorStop(1, 'rgba(99, 102, 241, 0)');

    // Define MA line configs - only 200 and 365 day
    const maConfigs = [
        { period: 200, label: '200-Day MA', color: CONFIG.COLORS.ma200, dash: [8, 4], width: 2 },
        { period: 365, label: '365-Day MA', color: CONFIG.COLORS.ma365, dash: [4, 2], width: 3 }
    ];

    // Build datasets array
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

    // Add MA datasets
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
                    display: false // Using custom legend
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

    // Destroy existing chart during loading
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
