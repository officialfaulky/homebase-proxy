const express = require("express");
const cors = require("cors");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3001;
const HTAG_API_KEY = process.env.HTAG_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || "hbp-secret-key-change-in-prod";
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || "price_1TdKnVAGLF60ncecgjb1wy2C";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

// ── Database ─────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        first_name VARCHAR(100),
        last_name VARCHAR(100),
        email VARCHAR(255) UNIQUE NOT NULL,
        phone VARCHAR(50),
        password_hash VARCHAR(255) NOT NULL,
        is_premium BOOLEAN DEFAULT FALSE,
        stripe_customer_id VARCHAR(255),
        stripe_subscription_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
      -- Add columns if they dont exist (for existing tables)
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_premium BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255);

      CREATE TABLE IF NOT EXISTS user_data (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        profile JSONB DEFAULT '{}',
        intake JSONB DEFAULT '{}',
        properties JSONB DEFAULT '[]',
        fin JSONB DEFAULT '{}',
        strategy JSONB DEFAULT NULL,
        suburbs JSONB DEFAULT NULL,
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id)
      );
    `);
    console.log("Database initialised");
  } catch (e) {
    console.error("DB init error:", e.message);
  }
};

initDB();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: ["https://homebaseproperty.com.au", "http://localhost:5173"],
  credentials: true,
}));
app.use(express.json());

const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
};

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ── Auth: Signup ──────────────────────────────────────────────────────────────
app.post("/auth/signup", async (req, res) => {
  const { firstName, lastName, email, phone, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  try {
    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
    if (existing.rows.length) return res.status(409).json({ error: "Email already registered" });
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO users (first_name, last_name, email, phone, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id, first_name, last_name, email, phone",
      [firstName, lastName, email.toLowerCase(), phone, hash]
    );
    const user = result.rows[0];
    await pool.query("INSERT INTO user_data (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [user.id]);
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user });
  } catch (e) {
    console.error("Signup error:", e.message);
    res.status(500).json({ error: "Signup failed" });
  }
});

// ── Auth: Login ───────────────────────────────────────────────────────────────
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase()]);
    if (!result.rows.length) return res.status(401).json({ error: "Invalid email or password" });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid email or password" });
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, first_name: user.first_name, last_name: user.last_name, email: user.email, phone: user.phone } });
  } catch (e) {
    console.error("Login error:", e.message);
    res.status(500).json({ error: "Login failed" });
  }
});

// ── Auth: Me ──────────────────────────────────────────────────────────────────
app.get("/auth/me", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, first_name, last_name, email, phone FROM users WHERE id = $1", [req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: "User not found" });
    res.json({ user: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// ── User Data: Load ───────────────────────────────────────────────────────────
app.get("/user/data", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM user_data WHERE user_id = $1", [req.user.id]);
    if (!result.rows.length) {
      await pool.query("INSERT INTO user_data (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [req.user.id]);
      return res.json({ profile: {}, intake: {}, properties: [], fin: {}, strategy: null, suburbs: null });
    }
    const d = result.rows[0];
    res.json({
      profile: d.profile || {},
      intake: d.intake || {},
      properties: d.properties || [],
      fin: d.fin || {},
      strategy: d.strategy || null,
      suburbs: d.suburbs || null,
    });
  } catch (e) {
    console.error("Load data error:", e.message);
    res.status(500).json({ error: "Failed to load data" });
  }
});

// ── User Data: Save ───────────────────────────────────────────────────────────
app.post("/user/data", authMiddleware, async (req, res) => {
  const { profile, intake, properties, fin, strategy, suburbs } = req.body;
  try {
    await pool.query(`
      INSERT INTO user_data (user_id, profile, intake, properties, fin, strategy, suburbs, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        profile = COALESCE($2, user_data.profile),
        intake = COALESCE($3, user_data.intake),
        properties = COALESCE($4, user_data.properties),
        fin = COALESCE($5, user_data.fin),
        strategy = COALESCE($6, user_data.strategy),
        suburbs = COALESCE($7, user_data.suburbs),
        updated_at = NOW()
    `, [
      req.user.id,
      profile ? JSON.stringify(profile) : null,
      intake ? JSON.stringify(intake) : null,
      properties ? JSON.stringify(properties) : null,
      fin ? JSON.stringify(fin) : null,
      strategy ? JSON.stringify(strategy) : null,
      suburbs ? JSON.stringify(suburbs) : null,
    ]);
    res.json({ success: true });
  } catch (e) {
    console.error("Save data error:", e.message);
    res.status(500).json({ error: "Failed to save data" });
  }
});

// ── Stripe: Create Checkout Session ──────────────────────────────────────────
app.post("/stripe/create-checkout", authMiddleware, async (req, res) => {
  try {
    const userResult = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
    const user = userResult.rows[0];

    // Create or retrieve Stripe customer
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: (user.first_name || "") + " " + (user.last_name || ""),
        metadata: { user_id: String(user.id) }
      });
      customerId = customer.id;
      await pool.query("UPDATE users SET stripe_customer_id = $1 WHERE id = $2", [customerId, user.id]);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ["card"],
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      mode: "subscription",
      success_url: "https://homebaseproperty.com.au/pocket?upgraded=true",
      cancel_url: "https://homebaseproperty.com.au/pocket?cancelled=true",
      metadata: { user_id: String(user.id) }
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("Stripe checkout error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Stripe: Cancel Subscription ───────────────────────────────────────────────
app.post("/stripe/cancel", authMiddleware, async (req, res) => {
  try {
    const userResult = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
    const user = userResult.rows[0];
    if (user.stripe_subscription_id) {
      await stripe.subscriptions.update(user.stripe_subscription_id, { cancel_at_period_end: true });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Stripe: Webhook ───────────────────────────────────────────────────────────
app.post("/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = STRIPE_WEBHOOK_SECRET
      ? stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET)
      : JSON.parse(req.body);
  } catch (e) {
    console.error("Webhook error:", e.message);
    return res.status(400).send("Webhook Error: " + e.message);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId = session.metadata?.user_id;
      if (userId) {
        await pool.query(
          "UPDATE users SET is_premium = TRUE, stripe_subscription_id = $1 WHERE id = $2",
          [session.subscription, userId]
        );
        console.log("User", userId, "upgraded to premium");
      }
    }
    if (event.type === "customer.subscription.deleted" || event.type === "customer.subscription.paused") {
      const sub = event.data.object;
      await pool.query(
        "UPDATE users SET is_premium = FALSE WHERE stripe_subscription_id = $1",
        [sub.id]
      );
      console.log("Subscription cancelled for", sub.id);
    }
    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object;
      await pool.query(
        "UPDATE users SET is_premium = TRUE WHERE stripe_customer_id = $1",
        [invoice.customer]
      );
    }
    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      await pool.query(
        "UPDATE users SET is_premium = FALSE WHERE stripe_customer_id = $1",
        [invoice.customer]
      );
    }
  } catch (e) {
    console.error("Webhook processing error:", e.message);
  }

  res.json({ received: true });
});

// ── User Premium Status ───────────────────────────────────────────────────────
app.get("/user/premium", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query("SELECT is_premium FROM users WHERE id = $1", [req.user.id]);
    res.json({ isPremium: result.rows[0]?.is_premium || false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HTAG Proxy ────────────────────────────────────────────────────────────────
const HTAG_BASE = "https://api.htagai.com/v1";
const htagHeaders = () => ({ "x-api-key": HTAG_API_KEY, "Content-Type": "application/json" });

app.get("/api/htag/geocode", async (req, res) => {
  try {
    const { address } = req.query;
    console.log("Geocoding:", address);

    // Try full address first
    let r = await fetch(`${HTAG_BASE}/address/geocode?address=${encodeURIComponent(address)}`, { headers: htagHeaders() });
    let d = await r.json();
    console.log("HTAG geocode response:", JSON.stringify(d).substring(0, 300));

    // If not found, try stripping to just suburb + state
    if (!d.results || d.results.length === 0) {
      const stateMatch = address.match(/\b(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b/i);
      const words = address.split(/\s+/);
      // Try to find suburb by taking words between street type and state
      const streetTypes = ['street','drive','road','avenue','place','court','crescent','way','parade','close','boulevard','terrace','lane','circuit','st','dr','rd','ave'];
      let suburbStart = -1;
      for (let i = 0; i < words.length; i++) {
        if (streetTypes.includes(words[i].toLowerCase())) { suburbStart = i + 1; break; }
      }
      if (suburbStart > 0 && stateMatch) {
        const suburbWords = words.slice(suburbStart).filter(w => !w.match(/^\d{4}$/) && !w.match(/^(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)$/i));
        const suburbQuery = suburbWords.join(' ').trim() + ' ' + stateMatch[0].toUpperCase();
        console.log("Trying suburb fallback:", suburbQuery);
        r = await fetch(`${HTAG_BASE}/address/geocode?address=${encodeURIComponent(suburbQuery)}`, { headers: htagHeaders() });
        d = await r.json();
        console.log("Suburb fallback response:", JSON.stringify(d).substring(0, 200));
      }
    }

    if (d.results && d.results.length > 0) {
      const g = d.results[0];
      res.json({ found: true, address_key: g.address_key, loc_pid: g.loc_pid, locality: g.locality, state: g.state, postcode: g.postcode, lat: g.lat, lon: g.lon });
    } else {
      res.json({ found: false });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/htag/property/estimates", async (req, res) => {
  try {
    const { address_key } = req.query;
    const r = await fetch(`${HTAG_BASE}/property/estimates?address_key=${encodeURIComponent(address_key)}`, { headers: htagHeaders() });
    const d = await r.json();
    res.json({ found: true, ...d });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/htag/property/summary", async (req, res) => {
  try {
    const { address_key } = req.query;
    const r = await fetch(`${HTAG_BASE}/property/summary?address_key=${encodeURIComponent(address_key)}`, { headers: htagHeaders() });
    const d = await r.json();
    res.json({ found: true, ...d });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/htag/property/sold", async (req, res) => {
  try {
    const { address_key } = req.query;
    const r = await fetch(`${HTAG_BASE}/property/sold/search?address_key=${encodeURIComponent(address_key)}`, { headers: htagHeaders() });
    const d = await r.json();
    res.json({ found: true, ...d });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/htag/suburb", async (req, res) => {
  try {
    const { suburb, state, property_type } = req.query;
    const locRes = await fetch(`${HTAG_BASE}/reference/locality?locality=${encodeURIComponent(suburb.toLowerCase())}&state_name=${encodeURIComponent(state.toLowerCase())}`, { headers: htagHeaders() });
    const locData = await locRes.json();
    if (!locData.results || locData.results.length === 0) return res.json({ found: false });
    const loc_pid = locData.results[0].loc_pid;
    const propType = (property_type || "house").toLowerCase().includes("unit") ? "unit" : "house";
    const [mktRes, rcsRes] = await Promise.all([
      fetch(`${HTAG_BASE}/markets/locality/summary?loc_pid=${loc_pid}&property_type=${propType}`, { headers: htagHeaders() }),
      fetch(`${HTAG_BASE}/markets/locality/rcs?loc_pid=${loc_pid}&property_type=${propType}`, { headers: htagHeaders() }),
    ]);
    const [mkt, rcs] = await Promise.all([mktRes.json(), rcsRes.json()]);
    res.json({
      found: true, loc_pid,
      typicalPrice: mkt.typical_price ? "$" + Math.round(mkt.typical_price).toLocaleString() : null,
      grossYield: mkt.gross_yield ? (mkt.gross_yield * 100).toFixed(2) + "%" : null,
      vacancyRate: mkt.vacancy_rate ? (mkt.vacancy_rate * 100).toFixed(2) + "%" : null,
      daysOnMarket: mkt.days_on_market ? Math.round(mkt.days_on_market) + " days" : null,
      stockOnMarket: mkt.stock_on_market || null,
      growth1y: mkt.growth_1y ? (mkt.growth_1y > 0 ? "+" : "") + (mkt.growth_1y * 100).toFixed(1) + "%" : null,
      growth3y: mkt.growth_3y ? (mkt.growth_3y > 0 ? "+" : "") + (mkt.growth_3y * 100).toFixed(1) + "%" : null,
      growth5y: mkt.growth_5y ? (mkt.growth_5y > 0 ? "+" : "") + (mkt.growth_5y * 100).toFixed(1) + "%" : null,
      rcsOverall: rcs.overall || null,
      rcsCashflow: rcs.cashflow || null,
      rcsGrowth: rcs.growth || null,
      inventory: mkt.inventory || null,
      confidence: mkt.confidence || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
