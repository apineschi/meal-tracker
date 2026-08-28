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

// Check the Workers AI models catalog (dashboard > AI > Models, or
// developers.cloudflare.com/workers-ai/models/) if either ID ever gets
// retired - swap in another free text-generation/chat or vision model.
const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

const CALORIE_SYSTEM_PROMPT =
  "You are a calorie-logging assistant. The user will describe a meal in free text, " +
  "possibly including tags like 'lunch' or 'vegetarian'. Break it into individual food " +
  "items, estimate reasonable calorie values per item using standard nutritional knowledge, " +
  "sum the total, and extract any tags (lowercase). If quantities are vague, assume a " +
  "typical single serving.\n\n" +
  "Fractions and portions apply ONLY to the specific item they're stated next to, never to " +
  "the whole message. '1/3 of 200g blueberries, one empanada' means: blueberries effective " +
  "quantity is about 67g (1/3 of 200g) - estimate calories for that reduced amount only - " +
  "while the empanada is a full, separate item estimated normally at its usual size. If a " +
  "fraction is given without a base weight (e.g. 'half of my sandwich'), first estimate the " +
  "full item's typical calories, then apply the stated fraction to that one item only.\n\n" +
  "For each item, also report a natural single-unit reference: 'unit_label' is a short " +
  "description of ONE standard unit WITHOUT a leading number or article (e.g. 'egg', " +
  "'tbsp (14g)', '100g'), and 'unit_calories' is the calories for that one unit. Pick " +
  "whatever unit is natural for the food (a whole item like 'egg' or 'banana', or a common " +
  "serving size like a tablespoon or 100g for things measured in bulk). If the logged " +
  "quantity already IS one natural unit (e.g. 'a banana'), unit_calories should just equal " +
  "calories and unit_label should describe that single item.\n\n" +
  "'reply' should be a short, friendly one-to-two sentence confirmation of what was logged " +
  "and its total calories - do not mention the daily total there, that is appended separately.";

const PHOTO_SYSTEM_PROMPT =
  "You are a calorie-logging assistant reading a photo of either a nutrition facts label or " +
  "a restaurant menu. The user may include a caption naming the dish they had or giving other " +
  "context - use it if present.\n\n" +
  "If the photo is a nutrition label: read the calories per serving and the number of " +
  "servings shown, and use the caption (if any) to figure out how many servings the user " +
  "actually had, defaulting to 1 serving if that's unclear.\n\n" +
  "If the photo is a menu: find the specific dish the caption names. If there's no caption " +
  "and the photo is clearly focused on one dish, use that one. If the menu lists a calorie " +
  "count next to the dish, use it directly rather than estimating. If only an ingredient " +
  "list or description is shown, estimate calories from those ingredients the same way you " +
  "would from a typed description.\n\n" +
  "If you can't find a matching dish or clear serving info, say so honestly in 'reply' and " +
  "still make a best-effort single-item estimate rather than failing.\n\n" +
  "Break the result into individual items (usually just one dish, or its listed components " +
  "if useful), extract any tags, and respond via the required JSON shape. For each item, " +
  "also report 'unit_label' (a short description of one natural unit, no leading number or " +
  "article, e.g. 'taco', '100g') and 'unit_calories' (that unit's calories) - if the item is " +
  "already a single natural unit, unit_calories should just equal calories. 'reply' should " +
  "be a short, friendly one-to-two sentence confirmation - do not mention the daily total, " +
  "that is appended separately.";

// Enforced via response_format below (Workers AI "JSON Mode") rather than
// hoping the model follows a text instruction - much more reliable, though
// Cloudflare still can't guarantee 100% schema compliance on every model.
const MEAL_JSON_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          quantity: { type: "string" },
          calories: { type: "number" },
          unit_label: { type: "string" },
          unit_calories: { type: "number" },
        },
        required: ["name", "calories", "unit_label", "unit_calories"],
      },
    },
    total_calories: { type: "number" },
    tags: { type: "array", items: { type: "string" } },
    reply: { type: "string" },
  },
  required: ["items", "total_calories", "tags", "reply"],
};

const ITEM_CALORIE_SCHEMA = {
  type: "object",
  properties: { calories: { type: "number" } },
  required: ["calories"],
};

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

function extractMealJson(result, errorHint) {
  // In JSON Mode, result.response is normally the already-parsed object, but
  // fall back to parsing it as a JSON string in case a model/version returns
  // it that way instead.
  let parsed = result && result.response;
  if (typeof parsed === "string") {
    const match = parsed.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error(`Couldn't parse a reply from the model - ${errorHint}`);
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch (err) {
      throw new Error(`Couldn't parse a reply from the model - ${errorHint}`);
    }
  }

  if (!parsed || !Array.isArray(parsed.items) || typeof parsed.total_calories !== "number") {
    throw new Error(`Model response was missing required fields - ${errorHint}`);
  }

  return parsed;
}

async function callWorkersAI(env, message) {
  const result = await env.AI.run(AI_MODEL, {
    messages: [
      { role: "system", content: CALORIE_SYSTEM_PROMPT },
      { role: "user", content: message },
    ],
    response_format: { type: "json_schema", json_schema: MEAL_JSON_SCHEMA },
  });

  return extractMealJson(result, "try rephrasing your message.");
}

async function callWorkersAIVision(env, imageDataUrl, caption) {
  const result = await env.AI.run(VISION_MODEL, {
    messages: [
      { role: "system", content: PHOTO_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: caption || "What dish or nutrition info is shown here?" },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
    response_format: { type: "json_schema", json_schema: MEAL_JSON_SCHEMA },
  });

  return extractMealJson(result, "try a clearer photo, or add a short text caption.");
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

async function handleEstimateItem(request, env, origin) {
  const { description } = await request.json();
  if (!description || typeof description !== "string") {
    return jsonResponse({ error: "Missing 'description' field" }, 400, origin);
  }

  const result = await env.AI.run(AI_MODEL, {
    messages: [
      {
        role: "system",
        content:
          "Estimate a reasonable calorie count for the single food item described, using " +
          "standard nutritional knowledge. If the quantity is vague, assume a typical " +
          "single serving.",
      },
      { role: "user", content: description },
    ],
    response_format: { type: "json_schema", json_schema: ITEM_CALORIE_SCHEMA },
  });

  let parsed = result && result.response;
  if (typeof parsed === "string") {
    const match = parsed.match(/\{[\s\S]*\}/);
    try {
      parsed = match ? JSON.parse(match[0]) : null;
    } catch (err) {
      parsed = null;
    }
  }

  if (!parsed || typeof parsed.calories !== "number") {
    return jsonResponse({ error: "Couldn't estimate that - try a clearer description." }, 502, origin);
  }

  return jsonResponse({ calories: Math.round(parsed.calories) }, 200, origin);
}

function normalizeTags(value) {
  if (Array.isArray(value)) {
    return value.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

async function handleChat(request, env, origin) {
  const { text, image, localDate, tags: manualTags } = await request.json();
  const caption = typeof text === "string" ? text.trim() : "";

  if (!caption && !image) {
    return jsonResponse({ error: "Missing 'text' or 'image' field" }, 400, origin);
  }
  if (image && typeof image !== "string") {
    return jsonResponse({ error: "'image' must be a data URL string" }, 400, origin);
  }

  const parsed = image ? await callWorkersAIVision(env, image, caption) : await callWorkersAI(env, caption);

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

  const combinedTags = [...new Set([...normalizeTags(parsed.tags), ...normalizeTags(manualTags)])];

  const meal = {
    time: new Date().toISOString(),
    raw_input: caption || (image ? "(photo)" : ""),
    from_photo: Boolean(image),
    items: parsed.items,
    tags: combinedTags,
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
      items: meal.items,
      tags: meal.tags,
      meal_total: meal.total_calories,
      total_today: dailyTotal,
      limit,
      over_limit: overLimit,
    },
    200,
    origin
  );
}

async function handleEditMeal(request, env, origin) {
  const { date, index, items, tags } = await request.json();

  if (
    typeof date !== "string" ||
    typeof index !== "number" ||
    !Array.isArray(items) ||
    items.some((i) => typeof i.name !== "string" || typeof i.calories !== "number")
  ) {
    return jsonResponse({ error: "Missing or invalid fields" }, 400, origin);
  }

  const { data: log, sha } = await getJsonFile(env, "docs/log.json", {});
  if (!log[date] || !log[date].meals[index]) {
    return jsonResponse({ error: "Meal not found" }, 404, origin);
  }

  const totalCalories = Math.round(items.reduce((sum, i) => sum + Number(i.calories || 0), 0));
  log[date].meals[index] = {
    ...log[date].meals[index],
    items,
    tags: normalizeTags(tags),
    total_calories: totalCalories,
  };
  log[date].total_calories = log[date].meals.reduce((sum, m) => sum + m.total_calories, 0);

  await putJsonFile(env, "docs/log.json", log, sha, `Edit meal (${date} #${index})`);

  return jsonResponse({ day_total: log[date].total_calories }, 200, origin);
}

async function handleDeleteMeal(request, env, origin) {
  const { date, index } = await request.json();

  if (typeof date !== "string" || typeof index !== "number") {
    return jsonResponse({ error: "Missing or invalid fields" }, 400, origin);
  }

  const { data: log, sha } = await getJsonFile(env, "docs/log.json", {});
  if (!log[date] || !log[date].meals[index]) {
    return jsonResponse({ error: "Meal not found" }, 404, origin);
  }

  log[date].meals.splice(index, 1);
  log[date].total_calories = log[date].meals.reduce((sum, m) => sum + m.total_calories, 0);

  await putJsonFile(env, "docs/log.json", log, sha, `Delete meal (${date} #${index})`);

  return jsonResponse({ day_total: log[date].total_calories }, 200, origin);
}

const ROUTES = {
  "/chat": handleChat,
  "/settings": handleSettings,
  "/edit-meal": handleEditMeal,
  "/delete-meal": handleDeleteMeal,
  "/estimate-item": handleEstimateItem,
};

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    const handler = ROUTES[url.pathname];

    if (handler && request.method === "POST") {
      if (!checkSecret(request, env)) {
        return jsonResponse({ error: "Unauthorized" }, 401, origin);
      }
      try {
        return await handler(request, env, origin);
      } catch (err) {
        console.error(err);
        return jsonResponse({ error: err.message }, 500, origin);
      }
    }

    return jsonResponse({ error: "Not found" }, 404, origin);
  },
};
