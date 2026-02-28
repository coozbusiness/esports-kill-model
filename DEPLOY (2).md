# ESPORTS KILL MODEL — DEPLOYMENT GUIDE
# Complete step-by-step. Every command is exact. Copy-paste each one.
# Total time: ~25 minutes first time.

═══════════════════════════════════════════════════
STEP 1 — INSTALL TOOLS (do this once, never again)
═══════════════════════════════════════════════════

1a. Install Node.js
    → Go to: https://nodejs.org
    → Click the "LTS" download button (left button)
    → Run the installer, click Next through everything
    → When done, open Command Prompt and run:
        node --version
    → You should see something like: v20.11.0

1b. Install Git
    → Go to: https://git-scm.com/download/win
    → Download and run the installer
    → Click Next through everything (defaults are fine)
    → When done, open Command Prompt and run:
        git --version
    → You should see: git version 2.x.x

═══════════════════════════════════════════════════
STEP 2 — CREATE ACCOUNTS (free, no credit card)
═══════════════════════════════════════════════════

2a. GitHub account
    → Go to: https://github.com/signup
    → Create account with your email

2b. Railway account (backend hosting)
    → Go to: https://railway.app
    → Click "Login" → "Login with GitHub"
    → Authorize Railway

2c. Vercel account (frontend hosting)
    → Go to: https://vercel.com/signup
    → Click "Continue with GitHub"
    → Authorize Vercel

═══════════════════════════════════════════════════
STEP 3 — UPLOAD CODE TO GITHUB
═══════════════════════════════════════════════════

3a. Open Command Prompt (search "cmd" in Windows start menu)

3b. Navigate to the esports-app folder you downloaded:
    cd C:\Users\YourName\Downloads\esports-app

    (Replace YourName with your actual Windows username)

3c. Run these commands ONE AT A TIME:

    git init
    git add .
    git commit -m "initial deploy"

3d. Create a new repository on GitHub:
    → Go to: https://github.com/new
    → Repository name: esports-kill-model
    → Set to Private
    → Click "Create repository"

3e. GitHub will show you commands. Run the ones that look like this
    (your username will be different):

    git remote add origin https://github.com/YOURUSERNAME/esports-kill-model.git
    git branch -M main
    git push -u origin main

    → It will ask for your GitHub username and password
    → For password: use a Personal Access Token, not your real password
      → Go to: https://github.com/settings/tokens/new
      → Note: "deploy token"
      → Expiration: 90 days
      → Check "repo" checkbox
      → Click Generate token
      → COPY THE TOKEN (you won't see it again)
      → Paste it as your password when git asks

═══════════════════════════════════════════════════
STEP 4 — DEPLOY BACKEND TO RAILWAY
═══════════════════════════════════════════════════

4a. Go to: https://railway.app/new
    → Click "Deploy from GitHub repo"
    → Select "esports-kill-model"
    → When it asks which folder: type "backend"
    → Click Deploy

4b. Wait ~2 minutes for it to build

4c. Get your backend URL:
    → Click your deployment
    → Click "Settings"
    → Click "Generate Domain"
    → Copy the URL — it looks like: https://esports-backend-production.up.railway.app

4d. Test it works — open your browser and go to:
    https://YOUR-RAILWAY-URL/health
    → You should see: {"status":"ok","ts":"..."}
    → If you see that, backend is live. ✓

═══════════════════════════════════════════════════
STEP 5 — DEPLOY FRONTEND TO VERCEL
═══════════════════════════════════════════════════

5a. Go to: https://vercel.com/new
    → Click "Import Git Repository"
    → Select "esports-kill-model"
    → When it asks for Root Directory: type "frontend"

5b. Before clicking Deploy, set environment variable:
    → Click "Environment Variables"
    → Name: REACT_APP_BACKEND_URL
    → Value: https://YOUR-RAILWAY-URL (from Step 4c, no trailing slash)
    → Click Add

5c. Click "Deploy"
    → Wait ~3 minutes for build

5d. Vercel gives you a URL like: https://esports-kill-model.vercel.app
    → Open it — your app is live

═══════════════════════════════════════════════════
STEP 6 — TEST EVERYTHING WORKS
═══════════════════════════════════════════════════

6a. Open your Vercel URL
    → You should see the Esports Kill Model interface
    → Header should show "● STATS SERVER ONLINE" in green
    → If it shows "○ STATS SERVER OFFLINE" in red, the Railway URL
      in your environment variable is wrong — go back to Step 5b

6b. Import a PrizePicks board (same as before — copy JSON from Network tab)
    → After import, scout notes will AUTO-POPULATE within 30 seconds
    → Notes come from gol.gg (LoL), HLTV (CS2), or vlr.gg (Valorant)
    → Then click Analyze — model uses real stats

═══════════════════════════════════════════════════
DAILY USAGE (after setup)
═══════════════════════════════════════════════════

1. Go to your Vercel URL (bookmark it)
2. Open PrizePicks → Network tab → copy the projections JSON
3. Paste into Import tab → click Import
4. Stats auto-fetch in background (30-60 seconds for full board)
5. Click "Analyze All" or "★ PREMIER + T1"
6. Use parlay builder

═══════════════════════════════════════════════════
IF SOMETHING BREAKS
═══════════════════════════════════════════════════

Stats not loading:
→ Go to your Railway URL + /health in browser
→ If you get an error, Railway might have restarted — wait 30 seconds and try again
→ Railway free tier sleeps after 30 days of inactivity — just open the Railway dashboard
  and click "Wake" if needed

Selector changed on gol.gg / HLTV / vlr.gg:
→ Tell me which sport isn't pulling stats
→ I'll update server.js selectors in 10 minutes
→ You re-run: git add . && git commit -m "fix" && git push
→ Railway auto-redeploys

App looks broken after a PrizePicks update:
→ Same process — tell me what's wrong, I fix it, you push

═══════════════════════════════════════════════════
FREE TIER LIMITS (you won't hit these)
═══════════════════════════════════════════════════

Railway free tier: $5 credit/month — backend uses ~$0.50/month at your scale
Vercel free tier: 100GB bandwidth, unlimited deploys — more than enough
GitHub free: unlimited private repos

═══════════════════════════════════════════════════
FOLDER STRUCTURE (for reference)
═══════════════════════════════════════════════════

esports-app/
├── backend/
│   ├── server.js        ← scrapes gol.gg, HLTV, vlr.gg
│   ├── package.json
│   └── railway.json     ← Railway deployment config
├── frontend/
│   ├── src/
│   │   ├── App.jsx      ← full kill model (your existing model + backend wiring)
│   │   └── index.js
│   ├── public/
│   │   └── index.html
│   ├── package.json
│   └── vercel.json      ← Vercel deployment config
└── .gitignore
