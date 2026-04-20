// HomeBase Pocket — ABS Proxy Server
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "https://homebaseproperty.com.au",
  "https://www.homebaseproperty.com.au",
];
app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error("Not allowed by CORS"));
  }
}));
app.use(express.json());

app.get("/api/abs/population", async (req, res) => {
  const { suburb } = req.query;
  if (!suburb) return res.status(400).json({ error: "suburb required" });

  try {
    const where = "UPPER(sa2_name_2021) LIKE UPPER('" + suburb + "%')";
    const encoded = encodeURIComponent(where);
    const url = "https://geo.abs.gov.au/arcgis/rest/services/Hosted/SA2_RP_2024/FeatureServer/0/query?where=" + encoded + "&outFields=sa2_name_2021,Pop_yr2,Chg_y_to_y,Net_intrnl_mi,Net_ovrses_mi,Naturl_incrse&returnGeometry=false&f=json&resultRecordCount=1";

    console.log("Fetching:", url);
    const response = await fetch(url);
    const data = await response.json();
    console.log("ABS response:", JSON.stringify(data).substring(0, 500));

    if (!data.features || data.features.length === 0) {
      return res.json({ found: false, suburb });
    }

    const f = data.features[0].attributes;
    res.json({
      found: true,
      suburb: f.sa2_name_2021,
      population2024: f.Pop_yr2,
      populationChangePct: f.Chg_y_to_y ? (f.Chg_y_to_y > 0 ? "+" : "") + Number(f.Chg_y_to_y).toFixed(2) + "%" : null,
      netInternalMigration: f.Net_intrnl_mi,
      internalMigrationLabel: f.Net_intrnl_mi > 0
        ? "+" + f.Net_intrnl_mi + " net internal arrivals"
        : f.Net_intrnl_mi + " net internal departures",
    });
  } catch (err) {
    console.error("ABS error:", err.message);
    res.status(500).json({ error: "ABS fetch failed", detail: err.message });
  }
});

app.get("/api/abs/approvals", async (req, res) => {
  const { state } = req.query;
  if (!state) return res.status(400).json({ error: "state required" });

  const stateCodes = { NSW: "1", VIC: "2", QLD: "3", SA: "4", WA: "5", TAS: "6", NT: "7", ACT: "8" };
  const code = stateCodes[state.toUpperCase()];
  if (!code) return res.status(400).json({ error: "invalid state" });

  try {
    const url = "https://data.api.abs.gov.au/rest/data/ABS,BUILDING_APPROVALS,1.0.0/1." + code + "..A?startPeriod=2022&endPeriod=2024&detail=dataonly";
    const response = await fetch(url, { headers: { Accept: "application/vnd.sdmx.data+json" } });
    const data = await response.json();

    const series = data && data.data && data.data.dataSets && data.data.dataSets[0] && data.data.dataSets[0].series;
    if (!series) return res.json({ found: false, state });

    const values = Object.values(series).map(function(s) {
      const obs = s.observations;
      const keys = Object.keys(obs).sort();
      return Number(obs[keys[keys.length - 1]][0]);
    });

    const totalApprovals = values.reduce(function(a, b) { return a + b; }, 0);
    res.json({
      found: true,
      state,
      totalDwellingApprovals: totalApprovals,
      supplyPressureLabel: totalApprovals > 50000 ? "High supply pipeline" : totalApprovals > 20000 ? "Moderate supply pipeline" : "Low supply pipeline",
    });
  } catch (err) {
    console.error("ABS approvals error:", err.message);
    res.status(500).json({ error: "ABS approvals fetch failed", detail: err.message });
  }
});

// ── HTAG ─────────────────────────────────────────────────────────────────────
const HTAG_CLIENT_ID = process.env.HTAG_CLIENT_ID || "e4a941244cf447aba7bfa5508a789731";
const HTAG_CLIENT_SECRET = process.env.HTAG_CLIENT_SECRET || "ulj7SF73zyTltkohSfet9ggYbT1z97OHlgeLF2d2k62JXYCxOLW9qesHBiGgah9c";
const HTAG_API_KEY = process.env.HTAG_API_KEY || "sk-org--8PfCuFvxKEHuKO8prXcpqi40blRwu7Wl-HedZCcDnnm3t0ipMfrrzF8RgjSI0r20E67lIYYAa";
const HTAG_BASE = "https://api.htagai.com/v1";

// OAuth token cache
let htagToken = null;
let htagTokenExpiry = 0;

async function getHtagToken() {
  // Return cached token if still valid
  if (htagToken && Date.now() < htagTokenExpiry) return htagToken;
  try {
    // Try Cognito OAuth token endpoint
    const tokenUrl = "https://auth.htagai.com/oauth2/token";
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: HTAG_CLIENT_ID,
      client_secret: HTAG_CLIENT_SECRET,
      scope: "htag/read",
    });
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const data = await res.json();
    console.log("HTAG OAuth response:", JSON.stringify(data).substring(0, 200));
    if (data.access_token) {
      htagToken = data.access_token;
      htagTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000 - 60000;
      console.log("HTAG OAuth token obtained successfully");
      return htagToken;
    }
  } catch (e) {
    console.error("HTAG OAuth error:", e.message);
  }
  // Fall back to API key
  console.log("Falling back to API key auth");
  return null;
}

async function getHtagHeaders() {
  return { "x-api-key": HTAG_API_KEY, "Content-Type": "application/json" };
}

// Helper: resolve suburb name + state to HTAG area_id (loc_pid)
async function resolveAreaId(suburb, state) {
  const url = HTAG_BASE + "/reference/locality?name=" + encodeURIComponent(suburb) + "&state_name=" + encodeURIComponent(state) + "&limit=5";
  const headers = await getHtagHeaders();
  const res = await fetch(url, { headers });
  const data = await res.json();
  if (!data.results || data.results.length === 0) return null;
  // Prefer exact match, fall back to first result
  const exact = data.results.find(function(r) {
    return r.locality.toLowerCase() === suburb.toLowerCase();
  });
  return exact ? exact.loc_pid : data.results[0].loc_pid;
}

// Main HTAG suburb data endpoint — called once per suburb from the app
app.get("/api/htag/suburb", async (req, res) => {
  const { suburb, state, property_type } = req.query;
  if (!suburb || !state) return res.status(400).json({ error: "suburb and state required" });

  const propType = property_type || "house";

  try {
    // Step 1: resolve area_id
    const areaId = await resolveAreaId(suburb, state);
    if (!areaId) return res.json({ found: false, suburb, state });

    const params = "level=suburb&area_id=" + areaId + "&property_type=" + propType;

    // Step 2: fetch all endpoints in parallel
    const htagH = await getHtagHeaders();
    const [summaryRes, demandRes, supplyRes, growthRes, scoresRes] = await Promise.all([
      fetch(HTAG_BASE + "/markets/summary?" + params, { headers: htagH }),
      fetch(HTAG_BASE + "/markets/demand?" + params, { headers: htagH }),
      fetch(HTAG_BASE + "/markets/supply?" + params, { headers: htagH }),
      fetch(HTAG_BASE + "/markets/growth/annualised?" + params, { headers: htagH }),
      fetch(HTAG_BASE + "/markets/scores?" + params, { headers: htagH }),
    ]);

    const [summary, demand, supply, growth, scores] = await Promise.all([
      summaryRes.json(),
      demandRes.json(),
      supplyRes.json(),
      growthRes.json(),
      scoresRes.json(),
    ]);

    const s = summary.results && summary.results[0];
    const d = demand.results && demand.results[0];
    const su = supply.results && supply.results[0];
    const g = growth.results && growth.results[0];
    const sc = scores.results && scores.results[0];

    if (!s) return res.json({ found: false, suburb, state, areaId });

    const fmt = function(n, decimals) {
      if (n == null) return null;
      return Number(n).toFixed(decimals != null ? decimals : 1);
    };

    res.json({
      found: true,
      suburb,
      state,
      areaId,
      // Summary
      typicalPrice: s.typical_price ? "$" + Math.round(s.typical_price).toLocaleString() : null,
      weeklyRent: s.rent ? "$" + Math.round(s.rent) + "/wk" : null,
      grossYield: s.gross_yield ? fmt(s.gross_yield * 100) + "%" : null,
      confidence: s.confidence || null,
      // Demand
      vacancyRate: d && d.vacancy_rate != null ? fmt(d.vacancy_rate * 100) + "%" : null,
      daysOnMarket: d && d.dom != null ? Math.round(d.dom) + " days" : null,
      discounting: d && d.discounting != null ? fmt(d.discounting * 100) + "%" : null,
      // Supply
      stockOnMarket: su && su.som_percent != null ? fmt(su.som_percent * 100) + "%" : null,
      inventory: su && su.inventory != null ? fmt(su.inventory) + " months" : null,
      // Growth
      growth1y: g && g.price_1y_growth_annualised != null ? (g.price_1y_growth_annualised > 0 ? "+" : "") + fmt(g.price_1y_growth_annualised * 100) + "%" : null,
      growth3y: g && g.price_3y_growth_annualised != null ? (g.price_3y_growth_annualised > 0 ? "+" : "") + fmt(g.price_3y_growth_annualised * 100) + "%" : null,
      growth5y: g && g.price_5y_growth_annualised != null ? (g.price_5y_growth_annualised > 0 ? "+" : "") + fmt(g.price_5y_growth_annualised * 100) + "%" : null,
      // Scores
      rcsOverall: sc && sc.rcs_overall != null ? sc.rcs_overall : null,
      rcsCashflow: sc && sc.rcs_cashflow != null ? sc.rcs_cashflow : null,
      rcsGrowth: sc && sc.rcs_capital_growth != null ? sc.rcs_capital_growth : null,
    });

  } catch (err) {
    console.error("HTAG error:", err.message);
    res.status(500).json({ error: "HTAG fetch failed", detail: err.message });
  }
});

// HTAG Geocode endpoint
app.get("/api/htag/geocode", async (req, res) => {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: "address required" });
  try {
    const url = HTAG_BASE + "/address/geocode?address=" + encodeURIComponent(address);
    console.log("HTAG geocode:", url);
    const htagH2 = await getHtagHeaders();
    const response = await fetch(url, { headers: htagH2 });
    const data = await response.json();
    console.log("HTAG geocode status:", response.status);
    console.log("HTAG geocode response:", JSON.stringify(data).substring(0, 500));
    if (!data.results || data.results.length === 0) return res.json({ found: false, status: response.status, raw: data });
    const r = data.results[0];
    res.json({
      found: true,
      address_key: r.address_key,
      loc_pid: r.loc_pid,
      locality: r.locality_name,
      state: r.state,
      postcode: r.postcode,
      lat: r.lat,
      lon: r.lon,
    });
  } catch (err) {
    console.error("HTAG geocode error:", err.message);
    res.status(500).json({ error: "geocode failed", detail: err.message });
  }
});

// HTAG Property Estimates
app.get("/api/htag/property/estimates", async (req, res) => {
  const { address_key } = req.query;
  if (!address_key) return res.status(400).json({ error: "address_key required" });
  try {
    const url = HTAG_BASE + "/property/estimates?address_key=" + encodeURIComponent(address_key);
    const htagH3 = await getHtagHeaders();
    const response = await fetch(url, { headers: htagH3 });
    const data = await response.json();
    if (!data.results || data.results.length === 0) return res.json({ found: false });
    res.json({ found: true, ...data.results[0] });
  } catch (err) {
    res.status(500).json({ error: "estimates failed", detail: err.message });
  }
});

// HTAG Property Summary
app.get("/api/htag/property/summary", async (req, res) => {
  const { address_key } = req.query;
  if (!address_key) return res.status(400).json({ error: "address_key required" });
  try {
    const url = HTAG_BASE + "/property/summary?address_key=" + encodeURIComponent(address_key);
    const htagH4 = await getHtagHeaders();
    const response = await fetch(url, { headers: htagH4 });
    const data = await response.json();
    if (!data.results || data.results.length === 0) return res.json({ found: false });
    res.json({ found: true, ...data.results[0] });
  } catch (err) {
    res.status(500).json({ error: "property summary failed", detail: err.message });
  }
});

// HTAG Sold Search
app.get("/api/htag/property/sold", async (req, res) => {
  const { address_key } = req.query;
  if (!address_key) return res.status(400).json({ error: "address_key required" });
  try {
    const url = HTAG_BASE + "/property/sold/search?address_key=" + encodeURIComponent(address_key) + "&radius=1&limit=10&proximity=sameSuburb";
    const htagH5 = await getHtagHeaders();
    const response = await fetch(url, { headers: htagH5 });
    const data = await response.json();
    res.json({ found: true, sales: data.results || [] });
  } catch (err) {
    res.status(500).json({ error: "sold search failed", detail: err.message });
  }
});


// MCP Property Lookup — calls Claude API server-side with HTAG MCP attached
app.post("/api/mcp/property", async (req, res) => {
  const { address, apiKey } = req.body;
  if (!address) return res.status(400).json({ error: "address required" });
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(400).json({ error: "api key required" });
  try {
    console.log("MCP property lookup:", address);
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "mcp-client-2025-04-04",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 1000,
        system: "You are a property data assistant. Use the HTAG tools to look up the given property address and return a JSON object. Return ONLY valid JSON, no markdown. Include these fields if available: locality, state, postcode, address_key, price_estimate, last_sold_price, last_sold_date, rent_estimate, beds, baths, property_type, lot_size, recent_sales (array of up to 5 nearby sold properties each with address, sale_price, sale_date, distance_km).",
        messages: [{ role: "user", content: "Look up this Australian property address using HTAG and return all available data as JSON: " + address }],
        mcp_servers: [{
          type: "url",
          url: "https://api.htagai.com/mcp/v1/servers/htag/sse",
          name: "htag",
          authorization_token: HTAG_API_KEY,
        }],
      }),
    });
    const data = await response.json();
    console.log("MCP response status:", response.status);
    if (!response.ok) {
      console.log("MCP error:", JSON.stringify(data).substring(0, 200));
      return res.status(response.status).json({ error: "Claude API error", detail: data });
    }
    const textBlocks = (data.content || []).filter(b => b.type === "text");
    const text = textBlocks.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
    console.log("MCP text result:", text.substring(0, 200));
    try {
      const parsed = JSON.parse(text);
      res.json({ found: true, ...parsed });
    } catch {
      res.json({ found: false, raw: text });
    }
  } catch (err) {
    console.error("MCP property error:", err.message);
    res.status(500).json({ error: "MCP lookup failed", detail: err.message });
  }
});

app.get("/health", function(req, res) { res.json({ status: "ok" }); });

app.listen(PORT, function() {
  console.log("HomeBase ABS + HTAG Proxy running at http://localhost:" + PORT);
});
