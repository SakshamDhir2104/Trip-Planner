const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const mongoose = require("mongoose");
const morgan = require("morgan");
const dotenv = require("dotenv");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { z } = require("zod");

dotenv.config();

const app = express();
app.use(helmet());
app.use(
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    credentials: false,
  })
);
app.use(morgan("dev"));
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

if (!MONGO_URI) {
  throw new Error("Missing MONGO_URI in environment.");
}
if (!JWT_SECRET) {
  throw new Error("Missing JWT_SECRET in environment.");
}

mongoose.set("strictQuery", true);

// -----------------------------
// Models (kept in one file)
// -----------------------------
const UserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["user", "admin"], default: "user" },
  },
  { timestamps: true }
);

const ListingSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["flight", "train", "bus", "hotel", "destination"],
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    images: { type: [String], default: [] },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    inventory: {
      totalAvailable: { type: Number, default: 0 },
      remainingAvailable: { type: Number, default: 0, index: true },
    },
    price: {
      amount: { type: Number, required: true, min: 0 },
      currency: { type: String, default: "INR" },
    },
    rating: { type: Number, default: 4.3 },
    provider: { type: String, default: "TripPlanner Demo" },
  },
  { timestamps: true }
);

const BookingSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    listingId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    listingType: { type: String, enum: ["flight", "train", "bus", "hotel", "destination"], required: true },
    quantity: { type: Number, required: true, min: 1 },
    passengerName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    notes: { type: String, default: "" },
    status: { type: String, enum: ["confirmed", "cancelled", "pending"], default: "confirmed", index: true },
    priceSnapshot: {
      amount: { type: Number, required: true },
      currency: { type: String, default: "INR" },
      title: { type: String, default: "" },
    },
    payment: {
      status: { type: String, enum: ["paid", "failed", "refunded"], default: "paid" },
      method: { type: String, default: "mock" },
      paidAmount: { type: Number, default: 0 },
      currency: { type: String, default: "INR" },
      paymentId: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

const User = mongoose.model("User", UserSchema);
const Listing = mongoose.model("Listing", ListingSchema);
const Booking = mongoose.model("Booking", BookingSchema);

// -----------------------------
// Helpers
// -----------------------------
function signToken(user) {
  return jwt.sign(
    { sub: String(user._id), role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function normalizeStr(v) {
  return String(v ?? "").trim().toLowerCase();
}

function dayBounds(yyyyMmDd) {
  const [y, m, d] = String(yyyyMmDd).split("-").map((x) => Number(x));
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d, 23, 59, 59, 999);
  return { start: dt, end };
}

function dateMatches(dt, yyyyMmDd) {
  if (!dt || !yyyyMmDd) return true;
  const { start, end } = dayBounds(yyyyMmDd);
  let x;
  // If we stored a plain `YYYY-MM-DD` string, ensure we interpret it as local midnight
  // (otherwise JS may treat it as UTC and shift the day).
  if (typeof dt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dt)) {
    const [y, m, d] = dt.split("-").map((n) => Number(n));
    x = new Date(y, m - 1, d, 0, 0, 0, 0);
  } else {
    x = dt instanceof Date ? dt : new Date(dt);
  }
  return x >= start && x <= end;
}

// Levenshtein distance for typo tolerance
function levenshteinDistance(a, b) {
  const aLen = a.length, bLen = b.length;
  const matrix = Array(aLen + 1).fill(null).map(() => Array(bLen + 1).fill(0));
  
  for (let i = 0; i <= aLen; i++) matrix[i][0] = i;
  for (let j = 0; j <= bLen; j++) matrix[0][j] = j;
  
  for (let i = 1; i <= aLen; i++) {
    for (let j = 1; j <= bLen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,     // deletion
        matrix[i][j - 1] + 1,     // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return matrix[aLen][bLen];
}

// Fuzzy match for typos (e.g., "banglore" matches "bangalore")
function fuzzyMatch(searchTerm, dbValue) {
  if (!searchTerm || !dbValue) return false;
  
  // Exact substring match
  if (dbValue.includes(searchTerm)) return true;
  
  // Allow up to 2 character differences (typos, common misspellings)
  const distance = levenshteinDistance(searchTerm, dbValue);
  return distance <= 2;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Missing auth" });
    if (req.user.role !== role) return res.status(403).json({ error: "Forbidden" });
    return next();
  };
}

function toPublicUser(u) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    role: u.role,
  };
}

function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// -----------------------------
// Auth
// -----------------------------
const RegisterSchema = z.object({
  name: z.string().min(2).max(60),
  email: z.string().email(),
  password: z.string().min(6).max(72),
});

app.post(
  "/api/auth/register",
  asyncHandler(async (req, res) => {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { name, email, password } = parsed.data;
    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) {
      return res.status(409).json({ error: "Email already registered. Please login to continue." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email: email.toLowerCase(), passwordHash, role: "user" });
    const token = signToken(user);
    res.json({ token, user: toPublicUser(user) });
  })
);

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).max(72),
});

app.post(
  "/api/auth/login",
  asyncHandler(async (req, res) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const { email, password } = parsed.data;

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const token = signToken(user);
    res.json({ token, user: toPublicUser(user) });
  })
);

app.get(
  "/api/auth/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.sub);
    if (!user) return res.status(401).json({ error: "Invalid token user" });
    res.json({ user: toPublicUser(user) });
  })
);

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/", (req, res) => {
  res.json({
    message: "Trip Planner API",
    version: "1.0.0",
    endpoints: {
      auth: "/api/auth/*",
      search: "/api/search",
      listings: "/api/listings/*",
      bookings: "/api/bookings/*",
      health: "/api/health"
    }
  });
});

// -----------------------------
// Search & Listings
// -----------------------------
app.get(
  "/api/listings/:id",
  asyncHandler(async (req, res) => {
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: "Not found" });
    res.json({ listing });
  })
);

app.get(
  "/api/search",
  asyncHandler(async (req, res) => {
    const type = String(req.query.type || "").trim();
    if (!type) return res.status(400).json({ error: "Missing query: type" });

    const allowed = ["flight", "train", "bus", "hotel", "destination"];
    if (!allowed.includes(type)) return res.status(400).json({ error: "Invalid type" });

    const q = normalizeStr(req.query.q);
    const from = normalizeStr(req.query.from);
    const to = normalizeStr(req.query.to);
    const date = req.query.date ? String(req.query.date) : "";

    const base = { type, "inventory.remainingAvailable": { $gt: 0 } };
    const candidatesQuery = { ...base };
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      candidatesQuery.$or = [{ title: rx }, { description: rx }];
    }

    const candidates = await Listing.find(candidatesQuery)
      .sort({ "price.amount": 1, rating: -1 })
      .limit(80);

    const filtered = candidates.filter((l) => {
      const meta = l.meta || {};
      if (type === "flight" || type === "train" || type === "bus") {
        if (from && !fuzzyMatch(from, normalizeStr(meta.from))) return false;
        if (to && !fuzzyMatch(to, normalizeStr(meta.to))) return false;
        if (date) return dateMatches(meta.departDate, date);
      }
      if (type === "hotel") {
        if (from && !fuzzyMatch(from, normalizeStr(meta.location))) return false;
        if (date) return dateMatches(meta.checkInDate, date);
      }
      if (type === "destination") {
        if (from && !fuzzyMatch(from, normalizeStr(meta.destinationCity))) return false;
        if (date) return dateMatches(meta.travelStartDate, date);
      }
      return true;
    });

    res.json({ results: filtered });
  })
);

// -----------------------------
// Booking (inventory decrement)
// -----------------------------
const CreateBookingSchema = z.object({
  listingId: z.string().min(1),
  quantity: z.number().int().min(1).max(12).default(1),
  passengerName: z.string().min(2).max(80),
  phone: z.string().min(6).max(30),
  notes: z.string().max(400).optional().default(""),
});

app.post(
  "/api/bookings",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = CreateBookingSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { listingId, quantity, passengerName, phone, notes } = parsed.data;
    const userId = req.user.sub;

    const listing = await Listing.findById(listingId);
    if (!listing) return res.status(404).json({ error: "Listing not found" });
    if ((listing.inventory?.remainingAvailable ?? 0) < quantity) {
      return res.status(409).json({ error: "Not enough availability" });
    }

    // Atomic stock decrement. This prevents overbooking under concurrency.
    const updated = await Listing.findOneAndUpdate(
      { _id: listingId, "inventory.remainingAvailable": { $gte: quantity } },
      { $inc: { "inventory.remainingAvailable": -quantity } },
      { new: true }
    );

    if (!updated) return res.status(409).json({ error: "Not enough availability" });

    const bookingId = new mongoose.Types.ObjectId();
    const paidAmount = (listing.price.amount || 0) * quantity;
    const paymentId = `mock_${String(bookingId).slice(-10)}_${Date.now()}`;

    const booking = await Booking.create({
      _id: bookingId,
      userId,
      listingId,
      listingType: listing.type,
      quantity,
      passengerName,
      phone,
      notes,
      status: "confirmed",
      priceSnapshot: {
        amount: listing.price.amount,
        currency: listing.price.currency,
        title: listing.title,
      },
      payment: {
        status: "paid",
        method: "mock",
        paidAmount,
        currency: listing.price.currency,
        paymentId,
      },
    });

    res.json({ booking });
  })
);

app.get(
  "/api/bookings/my",
  requireAuth,
  asyncHandler(async (req, res) => {
    const bookings = await Booking.find({ userId: req.user.sub })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ bookings });
  })
);

// -----------------------------
// Admin CRUD (listings)
// -----------------------------
app.get(
  "/api/admin/listings",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const listings = await Listing.find({}).sort({ createdAt: -1 }).limit(200);
    res.json({ listings });
  })
);

const ListingCreateSchema = z.object({
  type: z.enum(["flight", "train", "bus", "hotel", "destination"]),
  title: z.string().min(2).max(120),
  description: z.string().max(1200).optional().default(""),
  images: z.array(z.string()).optional().default([]),
  meta: z.record(z.any()).optional().default({}),
  inventory: z
    .object({
      totalAvailable: z.number().int().min(0).default(0),
      remainingAvailable: z.number().int().min(0).optional(),
    })
    .optional()
    .default({ totalAvailable: 0, remainingAvailable: 0 }),
  price: z.object({ amount: z.number().min(0), currency: z.string().default("INR") }).default({ amount: 0, currency: "INR" }),
  rating: z.number().min(0).max(5).optional(),
});

app.post(
  "/api/admin/listings",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const parsed = ListingCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const input = parsed.data;

    const inventory = input.inventory || {};
    const totalAvailable = inventory.totalAvailable ?? 0;
    const remainingAvailable = inventory.remainingAvailable ?? totalAvailable;

    const listing = await Listing.create({
      type: input.type,
      title: input.title,
      description: input.description,
      images: input.images,
      meta: input.meta,
      inventory: { totalAvailable, remainingAvailable },
      price: input.price,
      rating: input.rating ?? 4.3,
    });
    res.json({ listing });
  })
);

const ListingUpdateSchema = ListingCreateSchema.partial().extend({
  type: ListingCreateSchema.shape.type.optional(),
});

app.put(
  "/api/admin/listings/:id",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const parsed = ListingUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const input = parsed.data;

    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: "Not found" });

    if (input.type) listing.type = input.type;
    if (input.title !== undefined) listing.title = input.title;
    if (input.description !== undefined) listing.description = input.description;
    if (input.images !== undefined) listing.images = input.images;
    if (input.meta !== undefined) listing.meta = input.meta;
    if (input.price !== undefined) listing.price = input.price;
    if (input.rating !== undefined) listing.rating = input.rating;
    if (input.inventory !== undefined) {
      const inv = input.inventory;
      listing.inventory = {
        totalAvailable: inv.totalAvailable ?? listing.inventory.totalAvailable,
        remainingAvailable:
          inv.remainingAvailable ?? inv.totalAvailable ?? listing.inventory.remainingAvailable,
      };
    }

    await listing.save();
    res.json({ listing });
  })
);

app.delete(
  "/api/admin/listings/:id",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const listing = await Listing.findByIdAndDelete(req.params.id);
    if (!listing) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  })
);

// -----------------------------
// Seeding demo data
// -----------------------------
function addDays(base, days) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function atTime(date, hh, mm) {
  const d = new Date(date);
  d.setHours(hh, mm, 0, 0);
  return d;
}

function mmddyyyy(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function seed() {
  // Clear only if user explicitly chooses --seed (so you can keep your own DB).
  await User.deleteMany({});
  await Listing.deleteMany({});
  await Booking.deleteMany({});

  const adminPassword = "admin123";
  const adminHash = await bcrypt.hash(adminPassword, 10);

  const admin = await User.create({
    name: "Admin",
    email: "admin@example.com",
    passwordHash: adminHash,
    role: "admin",
  });

  await User.create({
    name: "Demo User",
    email: "user@example.com",
    passwordHash: await bcrypt.hash("user123", 10),
    role: "user",
  });

  const now = new Date();
  const in30 = atTime(addDays(now, 30), 10, 20);
  const in34 = atTime(addDays(now, 34), 18, 10);
  const in60 = atTime(addDays(now, 60), 9, 30);
  const in75 = atTime(addDays(now, 75), 14, 0);

  const hotelCheck1 = atTime(addDays(now, 32), 13, 0);
  const hotelCheck2 = atTime(addDays(now, 40), 13, 0);
  const hotelCheck3 = atTime(addDays(now, 70), 13, 0);

  const destinationStart1 = atTime(addDays(now, 45), 8, 0);
  const destinationStart2 = atTime(addDays(now, 65), 8, 0);

  const listings = [
    // Flights - 25 entries
    {
      type: "flight",
      title: "Delhi -> Mumbai (Non-stop) - Indigo",
      description: "Direct flight with great service.",
      images: [],
      meta: { from: "Delhi", to: "Mumbai", departDate: in30, returnDate: null, stops: 0 },
      inventory: { totalAvailable: 20, remainingAvailable: 20 },
      price: { amount: 8999, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "flight",
      title: "Delhi -> Mumbai (Non-stop) - Air India",
      description: "Comfortable journey.",
      images: [],
      meta: { from: "Delhi", to: "Mumbai", departDate: in30, returnDate: null, stops: 0 },
      inventory: { totalAvailable: 15, remainingAvailable: 15 },
      price: { amount: 9999, currency: "INR" },
      rating: 4.3,
    },
    {
      type: "flight",
      title: "Delhi -> Mumbai (1 stop) - Vistara",
      description: "One stop with meals.",
      images: [],
      meta: { from: "Delhi", to: "Mumbai", departDate: in30, returnDate: null, stops: 1 },
      inventory: { totalAvailable: 18, remainingAvailable: 18 },
      price: { amount: 7999, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "flight",
      title: "Delhi -> Bangalore (Non-stop) - Indigo",
      description: "Quick direct flight.",
      images: [],
      meta: { from: "Delhi", to: "Bangalore", departDate: in30, returnDate: null, stops: 0 },
      inventory: { totalAvailable: 22, remainingAvailable: 22 },
      price: { amount: 12999, currency: "INR" },
      rating: 4.6,
    },
    {
      type: "flight",
      title: "Delhi -> Bangalore (1 stop) - Air India",
      description: "Comfortable with stopover.",
      images: [],
      meta: { from: "Delhi", to: "Bangalore", departDate: in30, returnDate: null, stops: 1 },
      inventory: { totalAvailable: 16, remainingAvailable: 16 },
      price: { amount: 11999, currency: "INR" },
      rating: 4.2,
    },
    {
      type: "flight",
      title: "Delhi -> Bangalore (Non-stop) - SpiceJet",
      description: "Budget friendly.",
      images: [],
      meta: { from: "Delhi", to: "Bangalore", departDate: in30, returnDate: null, stops: 0 },
      inventory: { totalAvailable: 25, remainingAvailable: 25 },
      price: { amount: 10999, currency: "INR" },
      rating: 4.1,
    },
    {
      type: "flight",
      title: "Delhi -> Chennai (Non-stop) - Indigo",
      description: "Smooth flight.",
      images: [],
      meta: { from: "Delhi", to: "Chennai", departDate: in30, returnDate: null, stops: 0 },
      inventory: { totalAvailable: 20, remainingAvailable: 20 },
      price: { amount: 14999, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "flight",
      title: "Delhi -> Chennai (1 stop) - Vistara",
      description: "Premium service.",
      images: [],
      meta: { from: "Delhi", to: "Chennai", departDate: in30, returnDate: null, stops: 1 },
      inventory: { totalAvailable: 14, remainingAvailable: 14 },
      price: { amount: 15999, currency: "INR" },
      rating: 4.7,
    },
    {
      type: "flight",
      title: "Delhi -> Chennai (Non-stop) - Air India",
      description: "Reliable airline.",
      images: [],
      meta: { from: "Delhi", to: "Chennai", departDate: in30, returnDate: null, stops: 0 },
      inventory: { totalAvailable: 18, remainingAvailable: 18 },
      price: { amount: 13999, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "flight",
      title: "Delhi -> Hyderabad (Non-stop) - Indigo",
      description: "Direct and efficient.",
      images: [],
      meta: { from: "Delhi", to: "Hyderabad", departDate: in30, returnDate: null, stops: 0 },
      inventory: { totalAvailable: 21, remainingAvailable: 21 },
      price: { amount: 11999, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "flight",
      title: "Delhi -> Hyderabad (1 stop) - SpiceJet",
      description: "Affordable option.",
      images: [],
      meta: { from: "Delhi", to: "Hyderabad", departDate: in30, returnDate: null, stops: 1 },
      inventory: { totalAvailable: 19, remainingAvailable: 19 },
      price: { amount: 10999, currency: "INR" },
      rating: 4.2,
    },
    {
      type: "flight",
      title: "Delhi -> Hyderabad (Non-stop) - GoAir",
      description: "Comfortable seats.",
      images: [],
      meta: { from: "Delhi", to: "Hyderabad", departDate: in30, returnDate: null, stops: 0 },
      inventory: { totalAvailable: 17, remainingAvailable: 17 },
      price: { amount: 12999, currency: "INR" },
      rating: 4.3,
    },
    {
      type: "flight",
      title: "Delhi -> Kolkata (Non-stop) - Indigo",
      description: "Quick connection.",
      images: [],
      meta: { from: "Delhi", to: "Kolkata", departDate: in30, returnDate: null, stops: 0 },
      inventory: { totalAvailable: 23, remainingAvailable: 23 },
      price: { amount: 13999, currency: "INR" },
      rating: 4.6,
    },
    {
      type: "flight",
      title: "Delhi -> Kolkata (1 stop) - Air India",
      description: "With meals.",
      images: [],
      meta: { from: "Delhi", to: "Kolkata", departDate: in30, returnDate: null, stops: 1 },
      inventory: { totalAvailable: 16, remainingAvailable: 16 },
      price: { amount: 14999, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "flight",
      title: "Delhi -> Kolkata (Non-stop) - Vistara",
      description: "Business class feel.",
      images: [],
      meta: { from: "Delhi", to: "Kolkata", departDate: in30, returnDate: null, stops: 0 },
      inventory: { totalAvailable: 12, remainingAvailable: 12 },
      price: { amount: 16999, currency: "INR" },
      rating: 4.8,
    },
    {
      type: "flight",
      title: "Delhi -> Pune (Non-stop) - Indigo",
      description: "Short flight.",
      images: [],
      meta: { from: "Delhi", to: "Pune", departDate: in30, returnDate: null, stops: 0 },
      inventory: { totalAvailable: 24, remainingAvailable: 24 },
      price: { amount: 7999, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "flight",
      title: "Delhi -> Pune (Non-stop) - SpiceJet",
      description: "Budget option.",
      images: [],
      meta: { from: "Delhi", to: "Pune", departDate: in30, returnDate: null, stops: 0 },
      inventory: { totalAvailable: 20, remainingAvailable: 20 },
      price: { amount: 6999, currency: "INR" },
      rating: 4.1,
    },
    {
      type: "flight",
      title: "Delhi -> Jaipur (Non-stop) - Indigo",
      description: "Local flight.",
      images: [],
      meta: { from: "Delhi", to: "Jaipur", departDate: in30, returnDate: null, stops: 0 },
      inventory: { totalAvailable: 25, remainingAvailable: 25 },
      price: { amount: 5999, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "flight",
      title: "Delhi -> Goa (Non-stop) - Indigo",
      description: "Beach destination flight.",
      images: [],
      meta: { from: "Delhi", to: "Goa", departDate: in30, returnDate: null, stops: 0 },
      inventory: { totalAvailable: 22, remainingAvailable: 22 },
      price: { amount: 12999, currency: "INR" },
      rating: 4.7,
    },
    {
      type: "flight",
      title: "Delhi -> Goa (Non-stop) - SpiceJet",
      description: "Affordable to Goa.",
      images: [],
      meta: { from: "Delhi", to: "Goa", departDate: in30, returnDate: null, stops: 0 },
      inventory: { totalAvailable: 18, remainingAvailable: 18 },
      price: { amount: 11999, currency: "INR" },
      rating: 4.3,
    },
    {
      type: "flight",
      title: "Delhi -> Goa (1 stop) - Air India",
      description: "With stopover.",
      images: [],
      meta: { from: "Delhi", to: "Goa", departDate: in30, returnDate: null, stops: 1 },
      inventory: { totalAvailable: 15, remainingAvailable: 15 },
      price: { amount: 13999, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "flight",
      title: "Delhi -> Kerala (Non-stop) - Indigo",
      description: "To backwaters.",
      images: [],
      meta: { from: "Delhi", to: "Kerala", departDate: in30, returnDate: null, stops: 0 },
      inventory: { totalAvailable: 20, remainingAvailable: 20 },
      price: { amount: 15999, currency: "INR" },
      rating: 4.6,
    },
    {
      type: "flight",
      title: "Delhi -> Kerala (1 stop) - Vistara",
      description: "Premium to Kerala.",
      images: [],
      meta: { from: "Delhi", to: "Kerala", departDate: in30, returnDate: null, stops: 1 },
      inventory: { totalAvailable: 14, remainingAvailable: 14 },
      price: { amount: 16999, currency: "INR" },
      rating: 4.8,
    },
    {
      type: "flight",
      title: "Delhi -> Kerala (Non-stop) - Air India",
      description: "Direct to Kerala.",
      images: [],
      meta: { from: "Delhi", to: "Kerala", departDate: in30, returnDate: null, stops: 0 },
      inventory: { totalAvailable: 16, remainingAvailable: 16 },
      price: { amount: 14999, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "flight",
      title: "Mumbai -> Bangalore (Non-stop) - Indigo",
      description: "Direct flight.",
      images: [],
      meta: { from: "Mumbai", to: "Bangalore", departDate: in30, returnDate: null, stops: 0 },
      inventory: { totalAvailable: 21, remainingAvailable: 21 },
      price: { amount: 7999, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "flight",
      title: "Mumbai -> Bangalore (Non-stop) - Air India",
      description: "Reliable.",
      images: [],
      meta: { from: "Mumbai", to: "Bangalore", departDate: in30, returnDate: null, stops: 0 },
      inventory: { totalAvailable: 19, remainingAvailable: 19 },
      price: { amount: 8999, currency: "INR" },
      rating: 4.3,
    },

    // Trains - 25 entries
    {
      type: "train",
      title: "Delhi -> Mumbai - Rajdhani Express",
      description: "Fast train with AC.",
      images: [],
      meta: { from: "Delhi", to: "Mumbai", departDate: in30, durationMins: 1020 },
      inventory: { totalAvailable: 50, remainingAvailable: 50 },
      price: { amount: 2999, currency: "INR" },
      rating: 4.6,
    },
    {
      type: "train",
      title: "Delhi -> Mumbai - Shatabdi Express",
      description: "Day train.",
      images: [],
      meta: { from: "Delhi", to: "Mumbai", departDate: in30, durationMins: 960 },
      inventory: { totalAvailable: 40, remainingAvailable: 40 },
      price: { amount: 2499, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "train",
      title: "Delhi -> Mumbai - Garib Rath",
      description: "Budget option.",
      images: [],
      meta: { from: "Delhi", to: "Mumbai", departDate: in30, durationMins: 1080 },
      inventory: { totalAvailable: 60, remainingAvailable: 60 },
      price: { amount: 1999, currency: "INR" },
      rating: 4.2,
    },
    {
      type: "train",
      title: "Delhi -> Bangalore - Karnataka Express",
      description: "Long distance.",
      images: [],
      meta: { from: "Delhi", to: "Bangalore", departDate: in30, durationMins: 2400 },
      inventory: { totalAvailable: 45, remainingAvailable: 45 },
      price: { amount: 3999, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "train",
      title: "Delhi -> Bangalore - Udyan Express",
      description: "Overnight.",
      images: [],
      meta: { from: "Delhi", to: "Bangalore", departDate: in30, durationMins: 2280 },
      inventory: { totalAvailable: 35, remainingAvailable: 35 },
      price: { amount: 3499, currency: "INR" },
      rating: 4.3,
    },
    {
      type: "train",
      title: "Delhi -> Chennai - Coromandel Express",
      description: "To south.",
      images: [],
      meta: { from: "Delhi", to: "Chennai", departDate: in30, durationMins: 2160 },
      inventory: { totalAvailable: 40, remainingAvailable: 40 },
      price: { amount: 3799, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "train",
      title: "Delhi -> Chennai - Grand Trunk Express",
      description: "Historic route.",
      images: [],
      meta: { from: "Delhi", to: "Chennai", departDate: in30, durationMins: 2220 },
      inventory: { totalAvailable: 38, remainingAvailable: 38 },
      price: { amount: 3599, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "train",
      title: "Delhi -> Hyderabad - Hyderabad Express",
      description: "Direct.",
      images: [],
      meta: { from: "Delhi", to: "Hyderabad", departDate: in30, durationMins: 1800 },
      inventory: { totalAvailable: 42, remainingAvailable: 42 },
      price: { amount: 3299, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "train",
      title: "Delhi -> Kolkata - Poorva Express",
      description: "East bound.",
      images: [],
      meta: { from: "Delhi", to: "Kolkata", departDate: in30, durationMins: 1560 },
      inventory: { totalAvailable: 48, remainingAvailable: 48 },
      price: { amount: 2999, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "train",
      title: "Delhi -> Kolkata - Sealdah Express",
      description: "To Sealdah.",
      images: [],
      meta: { from: "Delhi", to: "Kolkata", departDate: in30, durationMins: 1620 },
      inventory: { totalAvailable: 44, remainingAvailable: 44 },
      price: { amount: 3199, currency: "INR" },
      rating: 4.3,
    },
    {
      type: "train",
      title: "Delhi -> Pune - Pune Express",
      description: "To Pune.",
      images: [],
      meta: { from: "Delhi", to: "Pune", departDate: in30, durationMins: 1320 },
      inventory: { totalAvailable: 50, remainingAvailable: 50 },
      price: { amount: 2799, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "train",
      title: "Delhi -> Jaipur - Jaipur Express",
      description: "Short trip.",
      images: [],
      meta: { from: "Delhi", to: "Jaipur", departDate: in30, durationMins: 300 },
      inventory: { totalAvailable: 55, remainingAvailable: 55 },
      price: { amount: 999, currency: "INR" },
      rating: 4.2,
    },
    {
      type: "train",
      title: "Delhi -> Goa - Goa Express",
      description: "To beach.",
      images: [],
      meta: { from: "Delhi", to: "Goa", departDate: in30, durationMins: 1800 },
      inventory: { totalAvailable: 40, remainingAvailable: 40 },
      price: { amount: 3499, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "train",
      title: "Delhi -> Kerala - Kerala Express",
      description: "South.",
      images: [],
      meta: { from: "Delhi", to: "Kerala", departDate: in30, durationMins: 2400 },
      inventory: { totalAvailable: 38, remainingAvailable: 38 },
      price: { amount: 3999, currency: "INR" },
      rating: 4.6,
    },
    {
      type: "train",
      title: "Mumbai -> Bangalore - Udyan Express",
      description: "From Mumbai.",
      images: [],
      meta: { from: "Mumbai", to: "Bangalore", departDate: in30, durationMins: 1200 },
      inventory: { totalAvailable: 45, remainingAvailable: 45 },
      price: { amount: 2499, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "train",
      title: "Mumbai -> Chennai - Chennai Express",
      description: "To Chennai.",
      images: [],
      meta: { from: "Mumbai", to: "Chennai", departDate: in30, durationMins: 1320 },
      inventory: { totalAvailable: 42, remainingAvailable: 42 },
      price: { amount: 2799, currency: "INR" },
      rating: 4.3,
    },
    {
      type: "train",
      title: "Mumbai -> Hyderabad - Hyderabad Express",
      description: "Direct.",
      images: [],
      meta: { from: "Mumbai", to: "Hyderabad", departDate: in30, durationMins: 900 },
      inventory: { totalAvailable: 48, remainingAvailable: 48 },
      price: { amount: 1999, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "train",
      title: "Mumbai -> Kolkata - Ganga Kaveri Express",
      description: "Long route.",
      images: [],
      meta: { from: "Mumbai", to: "Kolkata", departDate: in30, durationMins: 2400 },
      inventory: { totalAvailable: 40, remainingAvailable: 40 },
      price: { amount: 3999, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "train",
      title: "Mumbai -> Pune - Deccan Queen",
      description: "Famous train.",
      images: [],
      meta: { from: "Mumbai", to: "Pune", departDate: in30, durationMins: 180 },
      inventory: { totalAvailable: 60, remainingAvailable: 60 },
      price: { amount: 599, currency: "INR" },
      rating: 4.6,
    },
    {
      type: "train",
      title: "Mumbai -> Jaipur - Jaipur Express",
      description: "To Jaipur.",
      images: [],
      meta: { from: "Mumbai", to: "Jaipur", departDate: in30, durationMins: 1200 },
      inventory: { totalAvailable: 45, remainingAvailable: 45 },
      price: { amount: 2499, currency: "INR" },
      rating: 4.3,
    },
    {
      type: "train",
      title: "Mumbai -> Goa - Konkan Kanya Express",
      description: "Scenic route.",
      images: [],
      meta: { from: "Mumbai", to: "Goa", departDate: in30, durationMins: 600 },
      inventory: { totalAvailable: 50, remainingAvailable: 50 },
      price: { amount: 1499, currency: "INR" },
      rating: 4.7,
    },
    {
      type: "train",
      title: "Mumbai -> Kerala - Kerala Express",
      description: "To south.",
      images: [],
      meta: { from: "Mumbai", to: "Kerala", departDate: in30, durationMins: 1500 },
      inventory: { totalAvailable: 42, remainingAvailable: 42 },
      price: { amount: 2999, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "train",
      title: "Bangalore -> Chennai - Shatabdi Express",
      description: "Fast.",
      images: [],
      meta: { from: "Bangalore", to: "Chennai", departDate: in30, durationMins: 360 },
      inventory: { totalAvailable: 55, remainingAvailable: 55 },
      price: { amount: 1299, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "train",
      title: "Bangalore -> Hyderabad - Rayalaseema Express",
      description: "To Hyderabad.",
      images: [],
      meta: { from: "Bangalore", to: "Hyderabad", departDate: in30, durationMins: 720 },
      inventory: { totalAvailable: 48, remainingAvailable: 48 },
      price: { amount: 1799, currency: "INR" },
      rating: 4.3,
    },
    {
      type: "train",
      title: "Chennai -> Hyderabad - Charminar Express",
      description: "Direct.",
      images: [],
      meta: { from: "Chennai", to: "Hyderabad", departDate: in30, durationMins: 780 },
      inventory: { totalAvailable: 50, remainingAvailable: 50 },
      price: { amount: 1899, currency: "INR" },
      rating: 4.4,
    },

    // Buses - 25 entries
    {
      type: "bus",
      title: "Delhi -> Mumbai - AC Volvo",
      description: "Luxury bus.",
      images: [],
      meta: { from: "Delhi", to: "Mumbai", departDate: in30, durationMins: 1440 },
      inventory: { totalAvailable: 40, remainingAvailable: 40 },
      price: { amount: 2499, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "bus",
      title: "Delhi -> Mumbai - Sleeper",
      description: "Overnight.",
      images: [],
      meta: { from: "Delhi", to: "Mumbai", departDate: in30, durationMins: 1440 },
      inventory: { totalAvailable: 35, remainingAvailable: 35 },
      price: { amount: 1999, currency: "INR" },
      rating: 4.3,
    },
    {
      type: "bus",
      title: "Delhi -> Mumbai - Semi Sleeper",
      description: "Comfortable.",
      images: [],
      meta: { from: "Delhi", to: "Mumbai", departDate: in30, durationMins: 1440 },
      inventory: { totalAvailable: 45, remainingAvailable: 45 },
      price: { amount: 1799, currency: "INR" },
      rating: 4.2,
    },
    {
      type: "bus",
      title: "Delhi -> Bangalore - AC Sleeper",
      description: "Long distance.",
      images: [],
      meta: { from: "Delhi", to: "Bangalore", departDate: in30, durationMins: 2400 },
      inventory: { totalAvailable: 30, remainingAvailable: 30 },
      price: { amount: 3499, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "bus",
      title: "Delhi -> Bangalore - Volvo",
      description: "Premium.",
      images: [],
      meta: { from: "Delhi", to: "Bangalore", departDate: in30, durationMins: 2400 },
      inventory: { totalAvailable: 25, remainingAvailable: 25 },
      price: { amount: 3999, currency: "INR" },
      rating: 4.6,
    },
    {
      type: "bus",
      title: "Delhi -> Chennai - AC Sleeper",
      description: "To south.",
      images: [],
      meta: { from: "Delhi", to: "Chennai", departDate: in30, durationMins: 2160 },
      inventory: { totalAvailable: 32, remainingAvailable: 32 },
      price: { amount: 3299, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "bus",
      title: "Delhi -> Hyderabad - Sleeper",
      description: "Overnight.",
      images: [],
      meta: { from: "Delhi", to: "Hyderabad", departDate: in30, durationMins: 1800 },
      inventory: { totalAvailable: 38, remainingAvailable: 38 },
      price: { amount: 2799, currency: "INR" },
      rating: 4.3,
    },
    {
      type: "bus",
      title: "Delhi -> Kolkata - AC Volvo",
      description: "East.",
      images: [],
      meta: { from: "Delhi", to: "Kolkata", departDate: in30, durationMins: 1680 },
      inventory: { totalAvailable: 28, remainingAvailable: 28 },
      price: { amount: 2999, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "bus",
      title: "Delhi -> Pune - Semi Sleeper",
      description: "Short.",
      images: [],
      meta: { from: "Delhi", to: "Pune", departDate: in30, durationMins: 1320 },
      inventory: { totalAvailable: 42, remainingAvailable: 42 },
      price: { amount: 1999, currency: "INR" },
      rating: 4.2,
    },
    {
      type: "bus",
      title: "Delhi -> Jaipur - AC Seater",
      description: "Local.",
      images: [],
      meta: { from: "Delhi", to: "Jaipur", departDate: in30, durationMins: 300 },
      inventory: { totalAvailable: 50, remainingAvailable: 50 },
      price: { amount: 799, currency: "INR" },
      rating: 4.1,
    },
    {
      type: "bus",
      title: "Delhi -> Goa - AC Sleeper",
      description: "To beach.",
      images: [],
      meta: { from: "Delhi", to: "Goa", departDate: in30, durationMins: 1800 },
      inventory: { totalAvailable: 30, remainingAvailable: 30 },
      price: { amount: 3499, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "bus",
      title: "Delhi -> Kerala - Volvo",
      description: "South.",
      images: [],
      meta: { from: "Delhi", to: "Kerala", departDate: in30, durationMins: 2400 },
      inventory: { totalAvailable: 25, remainingAvailable: 25 },
      price: { amount: 3999, currency: "INR" },
      rating: 4.6,
    },
    {
      type: "bus",
      title: "Mumbai -> Bangalore - AC Sleeper",
      description: "Direct.",
      images: [],
      meta: { from: "Mumbai", to: "Bangalore", departDate: in30, durationMins: 1200 },
      inventory: { totalAvailable: 35, remainingAvailable: 35 },
      price: { amount: 2499, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "bus",
      title: "Mumbai -> Chennai - Sleeper",
      description: "To Chennai.",
      images: [],
      meta: { from: "Mumbai", to: "Chennai", departDate: in30, durationMins: 1320 },
      inventory: { totalAvailable: 40, remainingAvailable: 40 },
      price: { amount: 2299, currency: "INR" },
      rating: 4.3,
    },
    {
      type: "bus",
      title: "Mumbai -> Hyderabad - AC Volvo",
      description: "Premium.",
      images: [],
      meta: { from: "Mumbai", to: "Hyderabad", departDate: in30, durationMins: 900 },
      inventory: { totalAvailable: 32, remainingAvailable: 32 },
      price: { amount: 1999, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "bus",
      title: "Mumbai -> Kolkata - Sleeper",
      description: "Long.",
      images: [],
      meta: { from: "Mumbai", to: "Kolkata", departDate: in30, durationMins: 2400 },
      inventory: { totalAvailable: 28, remainingAvailable: 28 },
      price: { amount: 3499, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "bus",
      title: "Mumbai -> Pune - AC Seater",
      description: "Frequent.",
      images: [],
      meta: { from: "Mumbai", to: "Pune", departDate: in30, durationMins: 180 },
      inventory: { totalAvailable: 55, remainingAvailable: 55 },
      price: { amount: 599, currency: "INR" },
      rating: 4.2,
    },
    {
      type: "bus",
      title: "Mumbai -> Jaipur - AC Sleeper",
      description: "To Jaipur.",
      images: [],
      meta: { from: "Mumbai", to: "Jaipur", departDate: in30, durationMins: 1200 },
      inventory: { totalAvailable: 35, remainingAvailable: 35 },
      price: { amount: 2499, currency: "INR" },
      rating: 4.3,
    },
    {
      type: "bus",
      title: "Mumbai -> Goa - Semi Sleeper",
      description: "Beach trip.",
      images: [],
      meta: { from: "Mumbai", to: "Goa", departDate: in30, durationMins: 600 },
      inventory: { totalAvailable: 45, remainingAvailable: 45 },
      price: { amount: 1499, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "bus",
      title: "Mumbai -> Kerala - AC Volvo",
      description: "Luxury south.",
      images: [],
      meta: { from: "Mumbai", to: "Kerala", departDate: in30, durationMins: 1500 },
      inventory: { totalAvailable: 30, remainingAvailable: 30 },
      price: { amount: 2999, currency: "INR" },
      rating: 4.6,
    },
    {
      type: "bus",
      title: "Bangalore -> Chennai - AC Seater",
      description: "Short.",
      images: [],
      meta: { from: "Bangalore", to: "Chennai", departDate: in30, durationMins: 360 },
      inventory: { totalAvailable: 50, remainingAvailable: 50 },
      price: { amount: 999, currency: "INR" },
      rating: 4.3,
    },
    {
      type: "bus",
      title: "Bangalore -> Hyderabad - Sleeper",
      description: "Overnight.",
      images: [],
      meta: { from: "Bangalore", to: "Hyderabad", departDate: in30, durationMins: 720 },
      inventory: { totalAvailable: 40, remainingAvailable: 40 },
      price: { amount: 1799, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "bus",
      title: "Chennai -> Hyderabad - AC Volvo",
      description: "Direct.",
      images: [],
      meta: { from: "Chennai", to: "Hyderabad", departDate: in30, durationMins: 780 },
      inventory: { totalAvailable: 38, remainingAvailable: 38 },
      price: { amount: 1899, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "bus",
      title: "Hyderabad -> Kolkata - Sleeper",
      description: "East.",
      images: [],
      meta: { from: "Hyderabad", to: "Kolkata", departDate: in30, durationMins: 1800 },
      inventory: { totalAvailable: 32, remainingAvailable: 32 },
      price: { amount: 2999, currency: "INR" },
      rating: 4.3,
    },
    {
      type: "bus",
      title: "Pune -> Jaipur - AC Seater",
      description: "To Jaipur.",
      images: [],
      meta: { from: "Pune", to: "Jaipur", departDate: in30, durationMins: 1080 },
      inventory: { totalAvailable: 42, remainingAvailable: 42 },
      price: { amount: 1999, currency: "INR" },
      rating: 4.2,
    },

    // Hotels - 25 entries (2-3 per city)
    {
      type: "hotel",
      title: "Delhi - Taj Mahal Palace",
      description: "Luxury in Delhi.",
      images: [],
      meta: { location: "Delhi", checkInDate: in30, nights: 2 },
      inventory: { totalAvailable: 20, remainingAvailable: 20 },
      price: { amount: 15999, currency: "INR" },
      rating: 4.8,
    },
    {
      type: "hotel",
      title: "Delhi - The Oberoi",
      description: "Heritage hotel.",
      images: [],
      meta: { location: "Delhi", checkInDate: in30, nights: 2 },
      inventory: { totalAvailable: 18, remainingAvailable: 18 },
      price: { amount: 14999, currency: "INR" },
      rating: 4.7,
    },
    {
      type: "hotel",
      title: "Delhi - Radisson Blu",
      description: "Modern comfort.",
      images: [],
      meta: { location: "Delhi", checkInDate: in30, nights: 2 },
      inventory: { totalAvailable: 25, remainingAvailable: 25 },
      price: { amount: 8999, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "hotel",
      title: "Mumbai - The Leela",
      description: "Beachfront luxury.",
      images: [],
      meta: { location: "Mumbai", checkInDate: in30, nights: 3 },
      inventory: { totalAvailable: 15, remainingAvailable: 15 },
      price: { amount: 19999, currency: "INR" },
      rating: 4.9,
    },
    {
      type: "hotel",
      title: "Mumbai - Taj Mahal Palace",
      description: "Iconic hotel.",
      images: [],
      meta: { location: "Mumbai", checkInDate: in30, nights: 3 },
      inventory: { totalAvailable: 12, remainingAvailable: 12 },
      price: { amount: 24999, currency: "INR" },
      rating: 4.8,
    },
    {
      type: "hotel",
      title: "Mumbai - JW Marriott",
      description: "Business luxury.",
      images: [],
      meta: { location: "Mumbai", checkInDate: in30, nights: 3 },
      inventory: { totalAvailable: 20, remainingAvailable: 20 },
      price: { amount: 17999, currency: "INR" },
      rating: 4.6,
    },
    {
      type: "hotel",
      title: "Bangalore - ITC Gardenia",
      description: "Business hotel.",
      images: [],
      meta: { location: "Bangalore", checkInDate: in30, nights: 2 },
      inventory: { totalAvailable: 22, remainingAvailable: 22 },
      price: { amount: 12999, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "hotel",
      title: "Bangalore - The Leela Palace",
      description: "Palace hotel.",
      images: [],
      meta: { location: "Bangalore", checkInDate: in30, nights: 2 },
      inventory: { totalAvailable: 10, remainingAvailable: 10 },
      price: { amount: 29999, currency: "INR" },
      rating: 4.9,
    },
    {
      type: "hotel",
      title: "Bangalore - Radisson Blu",
      description: "Comfortable stay.",
      images: [],
      meta: { location: "Bangalore", checkInDate: in30, nights: 2 },
      inventory: { totalAvailable: 25, remainingAvailable: 25 },
      price: { amount: 9999, currency: "INR" },
      rating: 4.3,
    },
    {
      type: "hotel",
      title: "Chennai - ITC Grand Chola",
      description: "Grand hotel.",
      images: [],
      meta: { location: "Chennai", checkInDate: in30, nights: 3 },
      inventory: { totalAvailable: 18, remainingAvailable: 18 },
      price: { amount: 16999, currency: "INR" },
      rating: 4.7,
    },
    {
      type: "hotel",
      title: "Chennai - Taj Coromandel",
      description: "City center.",
      images: [],
      meta: { location: "Chennai", checkInDate: in30, nights: 3 },
      inventory: { totalAvailable: 20, remainingAvailable: 20 },
      price: { amount: 14999, currency: "INR" },
      rating: 4.6,
    },
    {
      type: "hotel",
      title: "Chennai - Hyatt Regency",
      description: "Modern.",
      images: [],
      meta: { location: "Chennai", checkInDate: in30, nights: 3 },
      inventory: { totalAvailable: 22, remainingAvailable: 22 },
      price: { amount: 12999, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "hotel",
      title: "Hyderabad - Taj Falaknuma Palace",
      description: "Palace stay.",
      images: [],
      meta: { location: "Hyderabad", checkInDate: in30, nights: 2 },
      inventory: { totalAvailable: 8, remainingAvailable: 8 },
      price: { amount: 39999, currency: "INR" },
      rating: 4.9,
    },
    {
      type: "hotel",
      title: "Hyderabad - ITC Kakatiya",
      description: "Heritage.",
      images: [],
      meta: { location: "Hyderabad", checkInDate: in30, nights: 2 },
      inventory: { totalAvailable: 15, remainingAvailable: 15 },
      price: { amount: 13999, currency: "INR" },
      rating: 4.6,
    },
    {
      type: "hotel",
      title: "Hyderabad - Novotel",
      description: "Comfort.",
      images: [],
      meta: { location: "Hyderabad", checkInDate: in30, nights: 2 },
      inventory: { totalAvailable: 25, remainingAvailable: 25 },
      price: { amount: 8999, currency: "INR" },
      rating: 4.3,
    },
    {
      type: "hotel",
      title: "Kolkata - The Astor",
      description: "Historic.",
      images: [],
      meta: { location: "Kolkata", checkInDate: in30, nights: 2 },
      inventory: { totalAvailable: 12, remainingAvailable: 12 },
      price: { amount: 11999, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "hotel",
      title: "Kolkata - ITC Sonar",
      description: "Luxury.",
      images: [],
      meta: { location: "Kolkata", checkInDate: in30, nights: 2 },
      inventory: { totalAvailable: 10, remainingAvailable: 10 },
      price: { amount: 15999, currency: "INR" },
      rating: 4.7,
    },
    {
      type: "hotel",
      title: "Kolkata - Holiday Inn",
      description: "Modern.",
      images: [],
      meta: { location: "Kolkata", checkInDate: in30, nights: 2 },
      inventory: { totalAvailable: 20, remainingAvailable: 20 },
      price: { amount: 7999, currency: "INR" },
      rating: 4.2,
    },
    {
      type: "hotel",
      title: "Pune - JW Marriott",
      description: "Premium.",
      images: [],
      meta: { location: "Pune", checkInDate: in30, nights: 2 },
      inventory: { totalAvailable: 18, remainingAvailable: 18 },
      price: { amount: 13999, currency: "INR" },
      rating: 4.6,
    },
    {
      type: "hotel",
      title: "Pune - Hyatt Regency",
      description: "Business.",
      images: [],
      meta: { location: "Pune", checkInDate: in30, nights: 2 },
      inventory: { totalAvailable: 22, remainingAvailable: 22 },
      price: { amount: 11999, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "hotel",
      title: "Pune - Novotel",
      description: "Comfortable.",
      images: [],
      meta: { location: "Pune", checkInDate: in30, nights: 2 },
      inventory: { totalAvailable: 25, remainingAvailable: 25 },
      price: { amount: 8999, currency: "INR" },
      rating: 4.3,
    },
    {
      type: "hotel",
      title: "Jaipur - Taj Rambagh Palace",
      description: "Palace.",
      images: [],
      meta: { location: "Jaipur", checkInDate: in30, nights: 2 },
      inventory: { totalAvailable: 10, remainingAvailable: 10 },
      price: { amount: 24999, currency: "INR" },
      rating: 4.9,
    },
    {
      type: "hotel",
      title: "Jaipur - The Oberoi Rajvilas",
      description: "Luxury tents.",
      images: [],
      meta: { location: "Jaipur", checkInDate: in30, nights: 2 },
      inventory: { totalAvailable: 8, remainingAvailable: 8 },
      price: { amount: 29999, currency: "INR" },
      rating: 4.8,
    },
    {
      type: "hotel",
      title: "Jaipur - Radisson Blu",
      description: "City hotel.",
      images: [],
      meta: { location: "Jaipur", checkInDate: in30, nights: 2 },
      inventory: { totalAvailable: 20, remainingAvailable: 20 },
      price: { amount: 9999, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "hotel",
      title: "Goa - The Leela Goa",
      description: "Beach resort.",
      images: [],
      meta: { location: "Goa", checkInDate: in30, nights: 3 },
      inventory: { totalAvailable: 15, remainingAvailable: 15 },
      price: { amount: 19999, currency: "INR" },
      rating: 4.8,
    },
    {
      type: "hotel",
      title: "Goa - Taj Exotica",
      description: "Luxury beach.",
      images: [],
      meta: { location: "Goa", checkInDate: in30, nights: 3 },
      inventory: { totalAvailable: 12, remainingAvailable: 12 },
      price: { amount: 24999, currency: "INR" },
      rating: 4.9,
    },
    {
      type: "hotel",
      title: "Goa - Radisson Blu",
      description: "Resort.",
      images: [],
      meta: { location: "Goa", checkInDate: in30, nights: 3 },
      inventory: { totalAvailable: 18, remainingAvailable: 18 },
      price: { amount: 14999, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "hotel",
      title: "Kerala - The Leela Kovalam",
      description: "Beach resort.",
      images: [],
      meta: { location: "Kerala", checkInDate: in30, nights: 3 },
      inventory: { totalAvailable: 14, remainingAvailable: 14 },
      price: { amount: 17999, currency: "INR" },
      rating: 4.7,
    },
    {
      type: "hotel",
      title: "Kerala - Taj Malabar",
      description: "Heritage.",
      images: [],
      meta: { location: "Kerala", checkInDate: in30, nights: 3 },
      inventory: { totalAvailable: 16, remainingAvailable: 16 },
      price: { amount: 15999, currency: "INR" },
      rating: 4.6,
    },
    {
      type: "hotel",
      title: "Kerala - Hyatt Regency",
      description: "Modern.",
      images: [],
      meta: { location: "Kerala", checkInDate: in30, nights: 3 },
      inventory: { totalAvailable: 20, remainingAvailable: 20 },
      price: { amount: 12999, currency: "INR" },
      rating: 4.4,
    },

    // Destinations - 25 entries (2-3 per city)
    {
      type: "destination",
      title: "Delhi Heritage Tour (3 days)",
      description: "Red Fort, India Gate, Qutub Minar.",
      images: [],
      meta: { destinationCity: "Delhi", travelStartDate: in30, days: 3, includes: ["Hotel", "Guided Tours"] },
      inventory: { totalAvailable: 15, remainingAvailable: 15 },
      price: { amount: 8999, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "destination",
      title: "Delhi Cultural Experience (4 days)",
      description: "Museums and markets.",
      images: [],
      meta: { destinationCity: "Delhi", travelStartDate: in30, days: 4, includes: ["Stay", "Meals"] },
      inventory: { totalAvailable: 12, remainingAvailable: 12 },
      price: { amount: 11999, currency: "INR" },
      rating: 4.6,
    },
    {
      type: "destination",
      title: "Delhi Adventure Package (5 days)",
      description: "City and nearby.",
      images: [],
      meta: { destinationCity: "Delhi", travelStartDate: in30, days: 5, includes: ["Hotel", "Activities"] },
      inventory: { totalAvailable: 10, remainingAvailable: 10 },
      price: { amount: 14999, currency: "INR" },
      rating: 4.7,
    },
    {
      type: "destination",
      title: "Mumbai City Lights (3 days)",
      description: "Gateway, Marine Drive.",
      images: [],
      meta: { destinationCity: "Mumbai", travelStartDate: in30, days: 3, includes: ["Hotel", "Tours"] },
      inventory: { totalAvailable: 18, remainingAvailable: 18 },
      price: { amount: 10999, currency: "INR" },
      rating: 4.6,
    },
    {
      type: "destination",
      title: "Mumbai Bollywood Tour (4 days)",
      description: "Film city and studios.",
      images: [],
      meta: { destinationCity: "Mumbai", travelStartDate: in30, days: 4, includes: ["Stay", "Film City"] },
      inventory: { totalAvailable: 14, remainingAvailable: 14 },
      price: { amount: 15999, currency: "INR" },
      rating: 4.8,
    },
    {
      type: "destination",
      title: "Mumbai Beach Escape (5 days)",
      description: "Beaches and nightlife.",
      images: [],
      meta: { destinationCity: "Mumbai", travelStartDate: in30, days: 5, includes: ["Hotel", "Transfers"] },
      inventory: { totalAvailable: 12, remainingAvailable: 12 },
      price: { amount: 18999, currency: "INR" },
      rating: 4.7,
    },
    {
      type: "destination",
      title: "Bangalore Tech Tour (3 days)",
      description: "IT hubs and gardens.",
      images: [],
      meta: { destinationCity: "Bangalore", travelStartDate: in30, days: 3, includes: ["Hotel", "Guided"] },
      inventory: { totalAvailable: 20, remainingAvailable: 20 },
      price: { amount: 7999, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "destination",
      title: "Bangalore Nature Retreat (4 days)",
      description: "Gardens and temples.",
      images: [],
      meta: { destinationCity: "Bangalore", travelStartDate: in30, days: 4, includes: ["Stay", "Tours"] },
      inventory: { totalAvailable: 16, remainingAvailable: 16 },
      price: { amount: 10999, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "destination",
      title: "Bangalore Adventure Package (5 days)",
      description: "City and outskirts.",
      images: [],
      meta: { destinationCity: "Bangalore", travelStartDate: in30, days: 5, includes: ["Hotel", "Activities"] },
      inventory: { totalAvailable: 14, remainingAvailable: 14 },
      price: { amount: 13999, currency: "INR" },
      rating: 4.6,
    },
    {
      type: "destination",
      title: "Chennai Heritage Walk (3 days)",
      description: "Temples and forts.",
      images: [],
      meta: { destinationCity: "Chennai", travelStartDate: in30, days: 3, includes: ["Hotel", "Guided"] },
      inventory: { totalAvailable: 18, remainingAvailable: 18 },
      price: { amount: 8999, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "destination",
      title: "Chennai Beach Tour (4 days)",
      description: "Marina and temples.",
      images: [],
      meta: { destinationCity: "Chennai", travelStartDate: in30, days: 4, includes: ["Stay", "Tours"] },
      inventory: { totalAvailable: 15, remainingAvailable: 15 },
      price: { amount: 11999, currency: "INR" },
      rating: 4.6,
    },
    {
      type: "destination",
      title: "Chennai Cultural Package (5 days)",
      description: "Full experience.",
      images: [],
      meta: { destinationCity: "Chennai", travelStartDate: in30, days: 5, includes: ["Hotel", "Meals"] },
      inventory: { totalAvailable: 12, remainingAvailable: 12 },
      price: { amount: 14999, currency: "INR" },
      rating: 4.7,
    },
    {
      type: "destination",
      title: "Hyderabad Biryani Tour (3 days)",
      description: "Food and Charminar.",
      images: [],
      meta: { destinationCity: "Hyderabad", travelStartDate: in30, days: 3, includes: ["Hotel", "Meals"] },
      inventory: { totalAvailable: 20, remainingAvailable: 20 },
      price: { amount: 9999, currency: "INR" },
      rating: 4.6,
    },
    {
      type: "destination",
      title: "Hyderabad Heritage Package (4 days)",
      description: "Golconda and palaces.",
      images: [],
      meta: { destinationCity: "Hyderabad", travelStartDate: in30, days: 4, includes: ["Stay", "Tours"] },
      inventory: { totalAvailable: 16, remainingAvailable: 16 },
      price: { amount: 12999, currency: "INR" },
      rating: 4.7,
    },
    {
      type: "destination",
      title: "Hyderabad Adventure (5 days)",
      description: "City and nearby.",
      images: [],
      meta: { destinationCity: "Hyderabad", travelStartDate: in30, days: 5, includes: ["Hotel", "Activities"] },
      inventory: { totalAvailable: 14, remainingAvailable: 14 },
      price: { amount: 15999, currency: "INR" },
      rating: 4.8,
    },
    {
      type: "destination",
      title: "Kolkata Colonial Tour (3 days)",
      description: "Victoria Memorial.",
      images: [],
      meta: { destinationCity: "Kolkata", travelStartDate: in30, days: 3, includes: ["Hotel", "Guided"] },
      inventory: { totalAvailable: 18, remainingAvailable: 18 },
      price: { amount: 7999, currency: "INR" },
      rating: 4.4,
    },
    {
      type: "destination",
      title: "Kolkata Cultural Experience (4 days)",
      description: "Temples and museums.",
      images: [],
      meta: { destinationCity: "Kolkata", travelStartDate: in30, days: 4, includes: ["Stay", "Tours"] },
      inventory: { totalAvailable: 15, remainingAvailable: 15 },
      price: { amount: 10999, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "destination",
      title: "Kolkata River Cruise (5 days)",
      description: "Ganges and city.",
      images: [],
      meta: { destinationCity: "Kolkata", travelStartDate: in30, days: 5, includes: ["Hotel", "Cruise"] },
      inventory: { totalAvailable: 12, remainingAvailable: 12 },
      price: { amount: 13999, currency: "INR" },
      rating: 4.6,
    },
    {
      type: "destination",
      title: "Pune Hill Stations (3 days)",
      description: "Lonavala and Khandala.",
      images: [],
      meta: { destinationCity: "Pune", travelStartDate: in30, days: 3, includes: ["Hotel", "Transfers"] },
      inventory: { totalAvailable: 20, remainingAvailable: 20 },
      price: { amount: 8999, currency: "INR" },
      rating: 4.5,
    },
    {
      type: "destination",
      title: "Pune Heritage Tour (4 days)",
      description: "Forts and museums.",
      images: [],
      meta: { destinationCity: "Pune", travelStartDate: in30, days: 4, includes: ["Stay", "Guided"] },
      inventory: { totalAvailable: 16, remainingAvailable: 16 },
      price: { amount: 11999, currency: "INR" },
      rating: 4.6,
    },
    {
      type: "destination",
      title: "Pune Adventure Package (5 days)",
      description: "Trekking and city.",
      images: [],
      meta: { destinationCity: "Pune", travelStartDate: in30, days: 5, includes: ["Hotel", "Activities"] },
      inventory: { totalAvailable: 14, remainingAvailable: 14 },
      price: { amount: 14999, currency: "INR" },
      rating: 4.7,
    },
    {
      type: "destination",
      title: "Jaipur Palace Tour (3 days)",
      description: "City Palace, Hawa Mahal.",
      images: [],
      meta: { destinationCity: "Jaipur", travelStartDate: in30, days: 3, includes: ["Hotel", "Guided"] },
      inventory: { totalAvailable: 18, remainingAvailable: 18 },
      price: { amount: 9999, currency: "INR" },
      rating: 4.7,
    },
    {
      type: "destination",
      title: "Jaipur Desert Safari (4 days)",
      description: "Palaces and desert.",
      images: [],
      meta: { destinationCity: "Jaipur", travelStartDate: in30, days: 4, includes: ["Stay", "Safari"] },
      inventory: { totalAvailable: 15, remainingAvailable: 15 },
      price: { amount: 12999, currency: "INR" },
      rating: 4.8,
    },
    {
      type: "destination",
      title: "Jaipur Royal Experience (5 days)",
      description: "Full royal tour.",
      images: [],
      meta: { destinationCity: "Jaipur", travelStartDate: in30, days: 5, includes: ["Hotel", "Tours"] },
      inventory: { totalAvailable: 12, remainingAvailable: 12 },
      price: { amount: 15999, currency: "INR" },
      rating: 4.9,
    },
    {
      type: "destination",
      title: "Goa Beach Bliss (3 days)",
      description: "Beaches and relaxation.",
      images: [],
      meta: { destinationCity: "Goa", travelStartDate: in30, days: 3, includes: ["Hotel", "Transfers"] },
      inventory: { totalAvailable: 20, remainingAvailable: 20 },
      price: { amount: 12999, currency: "INR" },
      rating: 4.8,
    },
    {
      type: "destination",
      title: "Goa Adventure Package (4 days)",
      description: "Water sports and beaches.",
      images: [],
      meta: { destinationCity: "Goa", travelStartDate: in30, days: 4, includes: ["Stay", "Activities"] },
      inventory: { totalAvailable: 16, remainingAvailable: 16 },
      price: { amount: 15999, currency: "INR" },
      rating: 4.9,
    },
    {
      type: "destination",
      title: "Goa Luxury Escape (5 days)",
      description: "Resorts and spas.",
      images: [],
      meta: { destinationCity: "Goa", travelStartDate: in30, days: 5, includes: ["Hotel", "Spa"] },
      inventory: { totalAvailable: 10, remainingAvailable: 10 },
      price: { amount: 19999, currency: "INR" },
      rating: 4.9,
    },
    {
      type: "destination",
      title: "Kerala Backwaters (3 days)",
      description: "Houseboat and temples.",
      images: [],
      meta: { destinationCity: "Kerala", travelStartDate: in30, days: 3, includes: ["Hotel", "Boat"] },
      inventory: { totalAvailable: 18, remainingAvailable: 18 },
      price: { amount: 14999, currency: "INR" },
      rating: 4.8,
    },
    {
      type: "destination",
      title: "Kerala Ayurveda Retreat (4 days)",
      description: "Spa and nature.",
      images: [],
      meta: { destinationCity: "Kerala", travelStartDate: in30, days: 4, includes: ["Stay", "Ayurveda"] },
      inventory: { totalAvailable: 14, remainingAvailable: 14 },
      price: { amount: 17999, currency: "INR" },
      rating: 4.9,
    },
    {
      type: "destination",
      title: "Kerala Cultural Tour (5 days)",
      description: "Temples and wildlife.",
      images: [],
      meta: { destinationCity: "Kerala", travelStartDate: in30, days: 5, includes: ["Hotel", "Tours"] },
      inventory: { totalAvailable: 12, remainingAvailable: 12 },
      price: { amount: 20999, currency: "INR" },
      rating: 4.9,
    },
  ];

  await Listing.insertMany(listings);

  // eslint-disable-next-line no-console
  console.log("Seeded demo data.");
  // eslint-disable-next-line no-console
  console.log("Admin login: admin@example.com / admin123");
  // eslint-disable-next-line no-console
  console.log("User login: user@example.com / user123");
}

// -----------------------------
// Boot
// -----------------------------
async function start() {
  try {
    await mongoose.connect(MONGO_URI);
    // eslint-disable-next-line no-console
    console.log("Database connected successfully");
    const shouldSeed = process.argv.includes("--seed") || String(process.env.SEED_ON_START) === "true";
    if (shouldSeed) {
      await seed();
      process.exit(0);
    }
    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`Server listening on http://localhost:${PORT}`);
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

start().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start server:", e);
  process.exit(1);
});

