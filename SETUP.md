# Bigasan Inventory — free setup

Total cost: ₱0. You need a free **Supabase** account (the database) and a free **GitHub** account (the website).
Time: about 20 minutes, once.

```
Stall phone ─┐                      ┌─ Supabase (free): stock, sales, history
             ├─ https://YOU.github.io/bigasan ─┤
Bodega PC ───┘   (GitHub Pages, free)          └─ live updates to every open device
```

---

## Step 1 — Create the database (Supabase)

1. Go to **supabase.com** → **Start your project** → sign up (free).
2. **New project**
   - Name: `bigasan`
   - Database password: make one up and save it somewhere (you rarely need it)
   - Region: **Southeast Asia (Singapore)**
   - Plan: **Free**
   - Wait about 2 minutes while it is created.
3. Left menu → **SQL Editor** → **New query**.
   Open `supabase-setup.sql` from this folder in Notepad, copy everything, paste it in, press **Run**.
   You should see "Success. No rows returned".
4. *(Optional — to try the app with sample rice first)* New query → paste all of `sample-data.sql` → **Run**.
   You can delete the sample later inside the app: **Settings → Start fresh**.
5. Create your login: left menu → **Authentication → Users → Add user → Create new user**
   - Email + a password you will remember
   - Tick **Auto Confirm User** → **Create user**
   - One shared business login is enough for both the phone and the computer. Use the app's
     "Recorded by" dropdown to track who did what.
6. Stop strangers from signing up: **Authentication → Sign In / Providers** → turn **off**
   "Allow new users to sign up" → **Save**.

## Step 2 — Connect the app to your database

1. In Supabase, click **Connect** (top of the project page) or go to **Project Settings → API Keys / Data API**.
2. Copy two things:
   - **Project URL** — looks like `https://abcdefghijkl.supabase.co`
   - **anon / publishable key** — long text starting with `eyJ…` or `sb_publishable_…`
     (never the *service_role* or *secret* key)
3. Open `config.js` in Notepad and paste them between the quotes:
   ```js
   SUPABASE_URL: 'https://abcdefghijkl.supabase.co',
   SUPABASE_ANON_KEY: 'eyJ...your key...'
   ```
   Save.

The anon key is designed to be public. Your stock is protected because nothing can be read or
changed without signing in.

## Step 3 — Put the app online (GitHub Pages)

1. Go to **github.com** → sign up (free).
2. Top right **+** → **New repository**
   - Name: `bigasan`
   - **Public** (free GitHub Pages needs a public repository; your *data* stays private in Supabase)
   - Create repository.
3. On the new repository page click **uploading an existing file**.
   Open this folder in File Explorer, select **everything inside it** (including the `icons` and
   `vendor` folders) and drag it onto the page. Wait for all files to upload → **Commit changes**.
4. **Settings → Pages** → Source: **Deploy from a branch** → Branch: **main**, folder **/ (root)** → **Save**.
5. Wait 1–2 minutes and refresh that page. Your address appears at the top:
   **`https://YOUR-USERNAME.github.io/bigasan/`**

## Step 4 — Open it on the Stall phone (Android)

1. Open **Chrome** on the phone and type your address from Step 3.
2. Sign in with the email and password from Step 1.5. You stay signed in.
3. Install it: Chrome menu **⋮** → **Add to home screen** → **Install**
   (or in the app: **More → Settings → Install app**).
4. A green **Bigasan** icon appears on the home screen. It opens full screen like a normal app.
   Long-press the icon for shortcuts: **Record sale**, **Stock in**, **Transfer**.

## Step 5 — Open it on the Bodega computer

Open the same address in Chrome or Edge and sign in.
To install: click the install icon at the right end of the address bar.

Both devices now share one inventory. A sale on the phone appears on the computer within a second or
two, without reloading.

---

## Everyday notes

- **Internet is needed to record.** Without signal the app still opens and shows a yellow "No internet"
  bar, but it will not save, so stock can never go wrong because of an offline phone.
- **Two people selling the last sack at the same time:** the database accepts the first and refuses the
  second with "Insufficient stock. Only … available."
- **Back up weekly:** Settings → **Download backup** (a .json file). Restore with Settings → **Restore from backup**.
- **Moving data from the claude.ai version:** open the old link → Settings → Download backup, then in the
  new app → Settings → Restore from backup.
- **Supabase free tier pauses a project after 7 days with no use.** Daily use keeps it awake. If it ever
  pauses, open supabase.com → your project → **Restore project**. Your data is kept.
- **Free limits:** 500 MB database (years of rice sales), unlimited page views on GitHub Pages.

## Changing the app later

Edit the file, then on GitHub open the repository → **Add file → Upload files** → drop the changed
file(s) → **Commit changes**. In `sw.js`, change `bigasan-v1` to `bigasan-v2` (and so on) whenever you
upload changes, so phones pick up the new version the next time the app is opened.

## Files in this folder

| File | What it is |
|---|---|
| `index.html` | The app (unchanged features) |
| `config.js` | Your Supabase address and key — **edit this** |
| `db-supabase.js` | Connects the app to Supabase: login, live updates, downloads, install |
| `supabase-setup.sql` | Creates the database table, security rules and the stock-safe save function |
| `sample-data.sql` | Optional sample rice, suppliers and 2 weeks of history |
| `manifest.webmanifest`, `sw.js`, `icons/` | Make it installable on the phone home screen |
| `vendor/` | The Supabase library, stored locally so the app opens fast |
