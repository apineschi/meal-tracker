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

### 2. Create your Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com), sign in,
   and create an API key under **API Keys**.
2. Add billing/credit — calorie parsing costs a fraction of a cent per meal
   logged (a few thousand tokens on a cheap model), so this will be pennies
   a month for personal use, but the key won't work with $0 credit.
3. Keep the key value somewhere safe for step 5 — don't paste it into any
   chat, issue, or commit.

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

### 5. Deploy the Worker

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com), sign up free
   (no card needed), go to **Workers & Pages** > **Create** > **Create
   Worker**. Give it a name like `meal-tracker` and deploy the default
   template.
2. Click **Edit code** (the in-browser editor). Delete the placeholder
   content and paste in the contents of this project's `worker/worker.js`.
   Click **Deploy**.
3. Go to the Worker's **Settings** > **Variables and Secrets**. Add:
   - `ANTHROPIC_API_KEY` — from step 2. Encrypt it.
   - `GITHUB_TOKEN` — from step 3. Encrypt it.
   - `NTFY_TOPIC` — from step 4. Encrypt it.
   - `APP_SECRET` — from step 4. Encrypt it.
   - `GITHUB_OWNER` — `apineschi`
   - `GITHUB_REPO` — `meal-tracker`
   - `ALLOWED_ORIGIN` — `https://apineschi.github.io`
   Save/deploy after adding these.
4. Note your Worker's URL, shown at the top of its page — something like
   `https://meal-tracker.<your-subdomain>.workers.dev`.

### 6. Wire the Worker URL into the front end and push

1. In this local folder, open `docs/chat.html` and `docs/index.html`.
2. In each, find the line `const WORKER_URL = "REPLACE_WITH_YOUR_WORKER_URL";`
   and replace the placeholder with your actual Worker URL from step 5.4
   (keep the quotes).
3. In **GitHub Desktop**, you'll see all the new files listed as changes.
   Write a commit message (e.g. "Initial setup") and click **Commit to
   main**, then **Push origin**.
4. Wait a minute for GitHub Pages to build, then visit
   `https://apineschi.github.io/meal-tracker/chat.html` on your phone.

### 7. Add the chat page to your phone's home screen

1. Open `https://apineschi.github.io/meal-tracker/chat.html` in Chrome on
   your phone.
2. Menu (⋮) > **Add to Home screen**. This is your "tap a button" launcher —
   it opens as its own app window, no browser bar.
3. The first time you send a message, it'll ask for your app password (the
   `APP_SECRET` from step 4) and remember it after that.

You're set up. Logging a meal from the home-screen icon should get you a
reply from Claude with the calorie breakdown within a second or two, and the
calendar at `https://apineschi.github.io/meal-tracker/` will show it.

---

## Day-to-day operations

### Log a meal

Open the home-screen chat icon, type something like:

> 2 eggs, 1 slice of toast with butter, small orange juice — tags: breakfast

Tags are just words you include naturally (after "tags:" or anywhere in the
message) — Claude picks up on words like meal names ("lunch", "dinner") or
diet descriptors ("vegetarian") on its own too.

### Change your daily calorie limit

On the calendar dashboard, use the **Daily calorie limit** box at the bottom
and click **Save**. It'll ask for your app password the first time.

### Fix a mis-logged meal

There's no edit UI yet (see ARCHITECTURE.md's known limitations). To fix one:

1. On GitHub, open `docs/log.json` and click the pencil (edit) icon.
2. Find the date, edit the meal entry directly (or delete it from the
   `meals` array), and update that day's `total_calories` to match.
3. Commit directly to `main` (or ask Claude to make the edit for you if
   that's easier).

### Turn off push notifications

Simplest way for now: unsubscribe from your ntfy topic in the ntfy app. To
remove it from the Worker entirely, delete the `NTFY_TOPIC` variable in the
Worker's Settings — it silently skips sending if that variable is unset.

### Search past meals

Use the search box on the calendar dashboard — it matches against
ingredients, tags, and your original message text, and highlights matching
days in the calendar grid. Click a day to see its full meal breakdown.

### Change the app password

Update `APP_SECRET` in the Worker's Settings > Variables. Then on your phone,
open the browser (not the installed app) to
`https://apineschi.github.io/meal-tracker/chat.html`, open dev tools or just
clear that site's data, so it prompts for the new password next time — or
simpler, just send one message, let it fail with "wrong password", and it'll
prompt again automatically.
