# Instructions

Setup (one-time) and day-to-day operations. See [ARCHITECTURE.md](ARCHITECTURE.md)
for how the pieces fit together.

---

## One-time setup

### 1. Enable GitHub Pages

1. On GitHub, open `apineschi/meal-tracker` > **Settings** > **Pages**.
2. Under **Build and deployment**, set **Source** to "Deploy from a branch",
   branch `main`, folder `/docs`. Save.
3. After the first push (step 6 below), your dashboard will be live at
   `https://apineschi.github.io/meal-tracker/`.

### 2. (Nothing to do here)

Calorie parsing runs on Cloudflare Workers AI, which is bound directly into
the Worker in step 5 — no separate account, key, or billing needed. This is
what keeps the whole app at $0.

### 3. Create a GitHub fine-grained token (so the Worker can write to your repo)

1. On GitHub: **Settings** (your account, not the repo) > **Developer
   settings** > **Personal access tokens** > **Fine-grained tokens** >
   **Generate new token**.
2. **Repository access**: "Only select repositories" > `meal-tracker`.
3. **Permissions**: **Repository permissions** > **Contents** > **Read and
   write**. Leave everything else at no access.
4. Generate, copy the token for step 5.

### 4. Pick an ntfy topic and app password

- **ntfy topic**: any unguessable string, e.g. `apineschi-meals-8f2a1c`. This
  is how push notifications reach your phone (same idea as job-scraper's
  ntfy setup) — install the [ntfy app](https://ntfy.sh/) and subscribe to
  this exact topic name.
- **App password**: any password you'll remember — this is what stops
  strangers from calling your Worker. You'll type it once on your phone.

### 4b. (Optional but recommended) Get a free USDA nutrition API key

This meaningfully improves calorie accuracy by grounding the model in real
nutrition data instead of pure memory — see ARCHITECTURE.md's "USDA
grounding" section for how it works. Everything still works without this
step, just with less accurate estimates.

1. Sign up at [fdc.nal.usda.gov/api-key-signup](https://fdc.nal.usda.gov/api-key-signup) —
   free, no card, near-instant.
2. Keep the key for step 5.

### 5. Deploy the Worker

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com), sign up free
   (no card needed), go to **Workers & Pages** > **Create** > **Create
   Worker**. Give it a name like `meal-tracker` and deploy the default
   template.
2. Click **Edit code** (the in-browser editor). Delete the placeholder
   content and paste in the contents of this project's `worker/worker.js`.
   Click **Deploy**.
3. Go to the Worker's **Settings** > **Bindings** > **Add** > **Workers AI**.
   Set the variable name to `AI` exactly. Save. This is what runs the
   calorie parsing, free, with no separate account or key.
4. Go to the Worker's **Settings** > **Variables and Secrets**. Add:
   - `GITHUB_TOKEN` — from step 3. Encrypt it.
   - `NTFY_TOPIC` — from step 4. Encrypt it.
   - `APP_SECRET` — from step 4. Encrypt it.
   - `USDA_API_KEY` — from step 4b, if you got one. Encrypt it. (Skip this
     one if you'd rather not bother — everything still works, just with
     less accurate estimates.)
   - `GITHUB_OWNER` — `apineschi`
   - `GITHUB_REPO` — `meal-tracker`
   - `ALLOWED_ORIGIN` — `https://apineschi.github.io`
   Save/deploy after adding these.
5. Note your Worker's URL, shown at the top of its page — something like
   `https://meal-tracker.<your-subdomain>.workers.dev`.

### 6. Wire the Worker URL into the front end and push

1. In this local folder, open `docs/index.html`.
2. Find the line `const WORKER_URL = "REPLACE_WITH_YOUR_WORKER_URL";` and
   replace the placeholder with your actual Worker URL from step 5.5 (keep
   the quotes).
3. In **GitHub Desktop**, you'll see the new files listed as changes. Write
   a commit message (e.g. "Initial setup") and click **Commit to main**,
   then **Push origin**.
4. Wait a minute for GitHub Pages to build, then visit
   `https://apineschi.github.io/meal-tracker/` on your phone.

### 7. Add the app to your phone's home screen

1. Open `https://apineschi.github.io/meal-tracker/` in Chrome on your phone.
2. Menu (⋮) > **Add to Home screen**. This is your "tap a button" launcher —
   it opens as its own app window, no browser bar.
3. The first time you log a meal, it'll ask for your app password (the
   `APP_SECRET` from step 4) and remember it after that.

You're set up. The calendar is the whole app now — tap **+ Log a meal** at
the top to jump straight to today's entry box, or tap any day to log against
that date instead.

---

## Day-to-day operations

### Log a meal

Tap **+ Log a meal** at the top of the calendar — this jumps straight to
today's entry box, whatever month you happen to be viewing. Tap a meal-type
button (Breakfast/Lunch/Dinner/Snack/Drink) and/or a diet-type button
(Meat/Vegetarian/Vegan) if you want one, type something like:

> 2 eggs, 1 slice of toast with butter, small orange juice

and add any other tags (e.g. "spicy") in the separate tags box. Portions and
fractions work per-item — "1/3 of 200g blueberries, one empanada" applies the
1/3 only to the blueberries, not the empanada. To log against a different
day, tap that day on the calendar instead and use its own entry box — it's
the same feature, just scoped to that date.

### Log a meal from a photo

In the entry box, tap the 📷 button to attach a photo of a **nutrition
label** or a **restaurant menu**, then tap **Log meal** (a caption is
optional but helps — e.g. name the dish if the menu has several). Label
photos are read directly (reliable, it's just reading printed numbers). Menu
photos: if the menu lists a calorie count next to the dish, that's used
directly; if it only shows an ingredient list, calories are estimated the
same way as typed text. This isn't meant for photos of an actual plated
meal — there's no reliable way to judge real portion size or hidden
ingredients (oil, sauce) from a picture of food itself, so that case isn't
supported.

### Change your daily calorie limit

On the calendar dashboard, use the **Daily calorie limit** box at the bottom
and click **Save**. It'll ask for your app password the first time.

### Fix a mis-logged meal

Click the day, then **Edit** on the meal. Each item is a description field
(e.g. "300g blueberries") plus a calories field — type your own number, or
edit the description and tap ↻ to recalculate; the total updates
automatically. **+ Add item** / **×** add or remove ingredients; **Delete**
removes the whole entry. All of these ask for your app password the first
time.

If a USDA-grounded number looks wrong, a small picker appears right under
that item showing what it matched — accept it, reject it in favor of the
model's own estimate, type an exact value, or pick a different USDA match if
more than one plausible one was found.

### Add a forgotten meal to a past day

Click the day on the calendar, then use the **"Add a meal to this day"** box
at the bottom of the day view — same feature as **+ Log a meal**, just
logged against that date instead of today.

### Turn off push notifications

Simplest way for now: unsubscribe from your ntfy topic in the ntfy app. To
remove it from the Worker entirely, delete the `NTFY_TOPIC` variable in the
Worker's Settings — it silently skips sending if that variable is unset.

### Search past meals

Use the search box on the calendar dashboard — it matches against
ingredients, tags, and your original message text, and highlights matching
days in the calendar grid. Click a day to see its full meal breakdown.

### Change the app password

Update `APP_SECRET` in the Worker's Settings > Variables. Then on your
phone, just try logging a meal or saving a setting — it'll fail once with
"wrong password" and automatically clear the old one, prompting you for the
new one right after.
