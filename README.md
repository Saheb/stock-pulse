# StockPulse 📈

A beautiful stock tracker webapp with 200-day and 365-day moving averages.

![StockPulse Screenshot](preview.png)

## Features

- 📊 **Interactive Charts** - Real-time stock data with smooth visualizations
- 📈 **Moving Averages** - 200-day (orange) and 365-day (red) MA lines
- 🔍 **Smart Search** - Search by stock name ("Apple") or ticker ("AAPL")
- 📱 **Responsive Design** - Works on desktop and mobile
- 🎨 **Dark Theme** - Modern glassmorphism UI
- 📈 **Fundamentals** - P/E Ratio, PEG Ratio, Profit Margin

## Live Demo

🚀 **[stock-pulse-7ok.pages.dev](https://stock-pulse-7ok.pages.dev)**

## How to Run Locally

Open `index.html` in your browser, or run a local server:

```bash
npx serve .
```

Then visit http://localhost:3000

## Deployment (Cloudflare Pages)

This project is deployed on Cloudflare Pages. To deploy your own instance:

### Option 1: Connect GitHub Repository

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Navigate to **Workers & Pages** → **Create application** → **Pages**
3. Select **Connect to Git** and choose your repository
4. Configure build settings:
   - **Build command**: Leave empty (static site)
   - **Build output directory**: `/`
5. Click **Save and Deploy**

### Option 2: Direct Upload

```bash
# Install Wrangler CLI (if not already installed)
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Deploy to Pages
wrangler pages deploy . --project-name=stock-pulse
```

### Auto-Deploy

Once connected to GitHub, Cloudflare Pages will automatically deploy on every push to the main branch:

```bash
git add .
git commit -m "Your changes"
git push origin main
```

## How It Works

- Fetches 5 years of historical data from Yahoo Finance
- Calculates moving averages on full dataset for accuracy
- Displays last 500 trading days (~2 years) on the chart
- Uses CORS proxy for browser-side API access
- Fetches fundamental data (P/E, PEG, Profit Margin) from Yahoo Finance

## Tech Stack

- **Vanilla JavaScript** - No frameworks
- **Chart.js** - Interactive chart rendering
- **Yahoo Finance API** - Stock data, search, and fundamentals
- **Cloudflare Pages** - Hosting and serverless functions

## Files

```
stock-pulse/
├── index.html           # Main HTML structure
├── index.css            # Styling (dark theme, glassmorphism)
├── app.js               # API logic, chart rendering
├── functions/
│   └── api/
│       └── proxy.js     # CORS proxy for API calls
└── README.md            # This file
```

## License

MIT
