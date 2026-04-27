# Trip Planner - Setup & Troubleshooting Guide

## Prerequisites
- Node.js v18+ installed
- MongoDB running locally (or MongoDB Atlas connection string)
- npm or yarn

## Quick Start

### 1. Install Dependencies

**Server:**
```bash
cd server
npm install
```

**Client:**
```bash
cd client
npm install
```

### 2. Set Up MongoDB

**Option A: Local MongoDB**
```bash
# Make sure MongoDB is running
mongod
```

**Option B: MongoDB Atlas (Cloud)**
Update `.env` in the root folder:
```
MONGO_URI=mongodb+srv://username:password@cluster.mongodb.net/trip-planner
```

### 3. Start the Server

From the `server` folder:
```bash
npm run dev
```

Expected output:
```
Server listening on http://localhost:5000
Seeded demo data.
Admin login: admin@example.com / admin123
User login: user@example.com / user123
```

### 4. Start the Client

From the `client` folder:
```bash
npm run dev
```

Visit: `http://localhost:5173` (or the URL shown in terminal)

---

## Troubleshooting

### Issue: "No results" when searching

**Cause:** Database is empty or not connected

**Fix:**
1. Check MongoDB is running: `mongod` (or verify MongoDB Atlas connection)
2. Restart server with seed: `npm run dev`
3. Clear browser cache (Ctrl+Shift+Delete)
4. Try searching for "Goa" (demo flights include Goa as destination)

### Issue: Login fails

**Error:** "Invalid credentials" or "Login failed"

**Fix:**
1. Verify server is running (check http://localhost:5000/api/health)
2. Use demo credentials:
   - Email: `admin@example.com`, Password: `admin123`
   - Email: `user@example.com`, Password: `user123`
3. If custom account, ensure you registered first

### Issue: CORS errors in browser console

**Error:** "No 'Access-Control-Allow-Origin' header is present"

**Fix:**
1. Ensure `VITE_API_URL=http://localhost:5000` in `client/.env`
2. Restart both server and client
3. Check server is on port 5000 (not 3000)

### Issue: "MONGO_URI in environment" error

**Fix:**
1. Ensure `.env` file exists in root folder
2. Contains: `MONGO_URI=mongodb://localhost:27017/trip-planner`
3. Restart server

### Issue: Client keeps redirecting to /login

**Cause:** Token is invalid or expired

**Fix:**
1. Clear localStorage: Open DevTools (F12) → Application → Local Storage → Clear All
2. Log in again
3. Check browser console for errors

---

## Database Seeding

The app automatically seeds demo data on startup (if `SEED_ON_START=true`).

**Manual seed:**
```bash
cd server
npm run seed
```

This creates:
- ✅ 3 demo flights (Delhi→Goa, Mumbai→Bangalore, Chennai→Hyderabad)
- ✅ 2 demo trains
- ✅ 2 demo buses
- ✅ 3 demo hotels
- ✅ 2 demo destination packages
- ✅ 2 user accounts (admin & user)

---

## Demo Credentials

### Admin Account
- Email: `admin@example.com`
- Password: `admin123`
- Access: Full admin panel to create/delete listings

### User Account
- Email: `user@example.com`
- Password: `user123`
- Access: Search, book, view bookings

---

## Port Reference

- **Server:** `http://localhost:5000`
- **Client:** `http://localhost:5173` (Vite default)
- **MongoDB:** `localhost:27017` (default)

---

## Project Structure

```
Trip Planner/
├── server/              # Express + MongoDB backend
│   ├── index.js         # Main server file (all routes included)
│   ├── package.json
│   └── .env            # Add your environment variables
│
├── client/              # React + Vite frontend
│   ├── src/
│   │   ├── App.jsx      # All routes & pages
│   │   ├── main.jsx
│   │   └── styles.css
│   ├── vite.config.js
│   ├── package.json
│   └── .env            # VITE_API_URL=http://localhost:5000
│
└── SETUP.md             # This file
```

---

## Features

✅ **Authentication:** Register/Login with JWT  
✅ **Search:** Filter flights, trains, buses, hotels, destinations  
✅ **Listings:** View details with real Unsplash images  
✅ **Bookings:** Mock payment system (instant confirmation)  
✅ **Admin Panel:** Create & manage listings  
✅ **Inventory:** Automatic stock decrement on booking  
✅ **UI:** Neon glassmorphism design with React Router  

---

## Common Commands

```bash
# Server
cd server && npm install
cd server && npm run dev        # Start with auto-reload
cd server && npm run seed       # Manually seed database
cd server && npm start          # Production start

# Client
cd client && npm install
cd client && npm run dev        # Start Vite dev server
cd client && npm run build      # Build for production
cd client && npm run preview    # Preview production build
```

---

## Next Steps

1. ✅ Install dependencies
2. ✅ Set up MongoDB
3. ✅ Start server (should seed automatically)
4. ✅ Start client
5. ✅ Login with demo account
6. ✅ Search for flights/hotels
7. ✅ Make a booking!

Happy booking! 🚀
