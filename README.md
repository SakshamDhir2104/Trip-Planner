# Trip Planner (MakeMyTrip-style) - MERN Demo

This is a fully runnable holiday planner demo:
- React frontend (crazy neon UI)
- Node/Express backend
- MongoDB (seeded with flights, trains, buses, hotels, and destination packages)
- JWT auth + booking flow with mock payment

## Prerequisites
1. Install/start **MongoDB** locally (or update `server/.env` with your Mongo URI).
2. Node.js (recent LTS recommended).

## Run

### 1) Backend (seed + start)
In `server/`:
1. Create/update env: `server/.env` (already included in this workspace)
2. Seed + start (first time only, or whenever you want reset seed):
   - `npm run seed`
   
If you already seeded and just want to start:
- `npm start`

Backend runs on: `http://localhost:5000`

### 2) Frontend (React)
In `client/`:
- `npm run dev`

Open: `http://localhost:5173`

## Demo login
- Admin: `admin@example.com` / `admin123`
- User: `user@example.com` / `user123`

## Notes
- Payment is mocked (no Stripe integration yet).
- Booking decrements `inventory.remainingAvailable` atomically to prevent overbooking.

