/**
 * meal-tracker Cloudflare Worker
 *
 * Single-file Worker meant to be pasted directly into the Cloudflare dashboard's
 * "Quick Edit" code editor (Workers & Pages > Create Worker > Edit code). No
 * npm/wrangler install needed.
 *
 * Required binding (Worker Settings > Bindings > Add > Workers AI):
 *   AI                 - variable name "AI". This is what makes env.AI.run()
 *                        work below, at no cost (Cloudflare's free Workers AI
 *                        daily allowance) and with no separate account/key.
 *
 * Required secrets (Worker Settings > Variables > "Encrypt" toggle on):
 *   GITHUB_TOKEN       - fine-grained PAT, scoped to ONLY the meal-tracker repo,
 *                        Contents: Read and write permission
 *   NTFY_TOPIC         - an unguessable slug, e.g. "apineschi-meals-8f2a1c"
 *   APP_SECRET         - a password only you know. The Worker's URL and this
 *                        file's source are visible to anyone who views the
 *                        GitHub Pages source, so without this check anyone
 *                        who finds the URL could write junk into your log.
 *                        The front end sends it back in the X-App-Secret
 *                        header on every request.
 *
 * Plain variables (not secret, but fine to also set as encrypted):
 *   GITHUB_OWNER       - e.g. "apineschi"
 *   GITHUB_REPO        - e.g. "meal-tracker"
 *   ALLOWED_ORIGIN     - e.g. "https://apineschi.github.io"
 */

// Check the Workers AI models catalog (dashboard > AI > Models) if this ID
// ever gets retired - swap in another free text-generation/chat model.
const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

const CALORIE_SYSTEM_PROMPT =
  "You are a calorie-logging assistant. The user will describe a meal in free text, " +
  "possibly including tags like 'lunch' or 'vegetarian'. Break it into individual food " +
  "items, estimate reasonable calorie values per item using standard nutritional knowledge, " +
  "sum the total, and extract any tags (lowercase). If quantities are vague, assume a " +
  "typical single serving.\n\n" +
  "Respond with ONLY a single JSON object and no other text, in exactly this shape:\n" +
  '{"items":[{"name":"...","quantity":"...","calories":123}],"total_calories":123,"tags":["..."],"reply":"..."}\n\n' +
  "\"reply\" is a short, friendly one-to-two sentence confirmation of what was logged and " +
  "its total calories - do not mention the daily total there, that is appended separately.";

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Secret",
  };
}

function checkSecret(request, env) {
  return request.headers.get("X-App-Secret") === env.APP_SECRET;
}

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

async function githubApi(env, path, options = {}) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "meal-tracker-worker",
      Accept: "application/vnd.github+json",
      ...(options.headers || {}),
    },
  });
  return res;
}

async function getJsonFile(env, path, fallback) {
  const res = await githubApi(env, path);
  if (res.status === 404) {
    return { data: fallback, sha: null };
  }
  if (!res.ok) {
    throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  const content = atob(body.content.replace(/\n/g, ""));
  return { data: JSON.parse(content), sha: body.sha };
}

async function putJsonFile(env, path, data, sha, message) {
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
  const res = await githubApi(env, path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content,
      sha: sha || undefined,
      committer: { name: "meal-tracker-bot", email: "bot@meal-tracker.local" },
    }),
  });
  if (!res.ok) {
    throw new Error(`GitHub PUT ${path} failed: ${res.status} ${await res.text()}`);
  }
}

async function callWorkersAI(env, message) {
  const result = await env.AI.run(AI_MODEL, {
    messages: [
      { role: "system", content: CALORIE_SYSTEM_PROMPT },
      { role: "user", content: message },
    ],
  });

  const raw = (result && result.response) || "";
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("Couldn't parse a reply from the model - try rephrasing your message.");
  }

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    throw new Error("Couldn't parse a reply from the model - try rephrasing your message.");
  }

  if (!Array.isArray(parsed.items) || typeof parsed.total_calories !== "number") {
    throw new Error("Model response was missing required fields - try rephrasing your message.");
  }

  return parsed;
}

async function postNtfy(env, message, title) {
  if (!env.NTFY_TOPIC) return;
  try {
    await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
      method: "POST",
      headers: { Title: title, Priority: "default" },
      body: message,
    });
  } catch (err) {
    // Never let a notification failure break the meal-logging response.
    console.error("ntfy post failed", err);
  }
}

async function handleSettings(request, env, origin) {
  const body = await request.json();
  const dailyLimit = Number(body.daily_limit);
  if (!dailyLimit || dailyLimit <= 0) {
    return jsonResponse({ error: "Missing or invalid 'daily_limit'" }, 400, origin);
  }

  const { data: settings, sha } = await getJsonFile(env, "docs/settings.json", {});
  settings.daily_limit = dailyLimit;

  await putJsonFile(env, "docs/settings.json", settings, sha, `Update daily limit to ${dailyLimit}`);

  return jsonResponse({ daily_limit: dailyLimit }, 200, origin);
}

async function handleChat(request, env, origin) {
  const { text, localDate } = await request.json();
  if (!text || typeof text !== "string") {
    return jsonResponse({ error: "Missing 'text' field" }, 400, origin);
  }

  const parsed = await callWorkersAI(env, text);

  const date = /^\d{4}-\d{2}-\d{2}$/.test(localDate)
    ? localDate
    : new Date().toISOString().slice(0, 10);

  const [{ data: log, sha: logSha }, { data: settings }] = await Promise.all([
    getJsonFile(env, "docs/log.json", {}),
    getJsonFile(env, "docs/settings.json", { daily_limit: 2000 }),
  ]);

  if (!log[date]) {
    log[date] = { meals: [], total_calories: 0 };
  }

  const meal = {
    time: new Date().toISOString(),
    raw_input: text,
    items: parsed.items,
    tags: (parsed.tags || []).map((t) => t.toLowerCase()),
    total_calories: Math.round(parsed.total_calories),
  };

  log[date].meals.push(meal);
  log[date].total_calories = log[date].meals.reduce((sum, m) => sum + m.total_calories, 0);

  await putJsonFile(
    env,
    "docs/log.json",
    log,
    logSha,
    `Log meal: ${meal.tags.join(", ") || "untagged"} (${date})`
  );

  const dailyTotal = log[date].total_calories;
  const limit = settings.daily_limit;
  const overLimit = dailyTotal >= limit;

  if (overLimit) {
    await postNtfy(
      env,
      `Daily total is ${dailyTotal} kcal, over your ${limit} kcal limit.`,
      "Calorie limit reached"
    );
  }

  return jsonResponse(
    {
      reply: parsed.reply,
      total_today: dailyTotal,
      limit,
      over_limit: overLimit,
    },
    200,
    origin
  );
}

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    if ((url.pathname === "/chat" || url.pathname === "/settings") && request.method === "POST") {
      if (!checkSecret(request, env)) {
        return jsonResponse({ error: "Unauthorized" }, 401, origin);
      }
      try {
        if (url.pathname === "/chat") return await handleChat(request, env, origin);
        return await handleSettings(request, env, origin);
      } catch (err) {
        console.error(err);
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    return jsonResponse({ error: "Not found" }, 404, origin);
  },
};
