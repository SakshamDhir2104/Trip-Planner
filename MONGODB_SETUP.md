# MongoDB Setup Guide - Quick Start

## Option 1: MongoDB Atlas (Cloud - EASIEST - RECOMMENDED)

### Step 1: Create Free Account
1. Go to https://www.mongodb.com/cloud/atlas
2. Sign up (free tier includes 512 MB storage)
3. Create a cluster (free M0 tier)

### Step 2: Get Connection String
1. In Atlas Dashboard → Clusters → Connect
2. Choose "Drivers" → "Node.js"
3. Copy the connection string:
   ```
   mongodb+srv://username:password@cluster.mongodb.net/trip-planner?retryWrites=true&w=majority
   ```
4. Replace `username` and `password` with your credentials

### Step 3: Update .env
In root folder `.env`, replace:
```
MONGO_URI=mongodb+srv://username:password@cluster.mongodb.net/trip-planner?retryWrites=true&w=majority
```

### Step 4: Restart Server
```bash
cd server
npm run dev
```

---

## Option 2: Local MongoDB (Windows)

### Step 1: Install MongoDB Community Edition
1. Download: https://www.mongodb.com/try/download/community
2. Run installer (MSI file)
3. During installation:
   - ✅ Install MongoDB as Windows Service
   - ✅ Run as service

### Step 2: Verify Installation
```bash
mongod --version
```

### Step 3: Start MongoDB Service
```bash
# Start MongoDB
mongod

# OR use Windows Services (search "services.msc")
```

### Step 4: Verify Connection (keep MongoDB running)
```bash
mongosh
# Type: use trip-planner
# Type: db.version()
```

### Step 5: Restart App Servers
```bash
cd server
npm run dev
```

---

## What to Look For After Setup

Once MongoDB is connected, you should see:
```
Server listening on http://localhost:5000
Seeded demo data.
Admin login: admin@example.com / admin123
User login: user@example.com / user123
```

## Quick Verification

Open in browser: http://localhost:5000/api/health

Expected response:
```json
{"ok":true}
```

If you get "Connection refused" → MongoDB is not running

---

## Connection Troubleshooting

### "Missing MONGO_URI in environment"
- ✅ Check `.env` file exists in root folder
- ✅ Line should be: `MONGO_URI=mongodb://localhost:27017/trip-planner`
- ✅ Save and restart server

### "connect ECONNREFUSED 127.0.0.1:27017"
- ❌ MongoDB is not running
- ✅ **Local:** Start `mongod` in new terminal
- ✅ **Atlas:** Check internet connection & credentials

### "MongoServerSelectionError"
- ❌ Wrong MongoDB URI
- ✅ Double-check connection string in `.env`
- ✅ If Atlas: Ensure username/password are correct

---

## After MongoDB is Ready

1. ✅ Server will auto-seed demo data
2. ✅ Visit http://localhost:5173 (client)
3. ✅ Login with: user@example.com / user123
4. ✅ Search for "Goa" → Should see flights
5. ✅ Try booking a flight!

---

**Stuck? Check:**
- [ ] MongoDB is running (`mongod` or Windows Service)
- [ ] `.env` file has correct MONGO_URI
- [ ] Server restarted after `.env` change
- [ ] Port 5000 is not blocked by firewall
