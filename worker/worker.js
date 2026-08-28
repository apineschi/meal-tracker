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
 *   NTFY_TOPIC         - an unguessable slug
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
 *
 * Optional secret (improves calorie accuracy, everything works without it):
 *   USDA_API_KEY       - free key from fdc.nal.usda.gov/api-key-signup. When
 *                        set, real USDA nutrition facts are looked up per
 *                        item and fed back to the model as grounding instead
 *                        of relying purely on its memorized "knowledge". If
 *                        unset, or a lookup finds nothing, logging still
 *                        works exactly as before - this only ever improves
 *                        results, never breaks them.
 */

// Check the Workers AI models catalog (dashboard > AI > Models, or
// developers.cloudflare.com/workers-ai/models/) if either ID ever gets
// retired - swap in another free text-generation/chat or vision model.
const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

const CALORIE_SYSTEM_PROMPT =
  "You are a calorie-logging assistant. The user will describe a meal in free text, " +
  "possibly including tags like 'lunch' or 'vegetarian'. Break it into individual DISTINCT " +
  "food items, estimate reasonable calorie values per item using standard nutritional " +
  "knowledge, sum the total, and extract any tags (lowercase). If quantities are vague, " +
  "assume a typical single serving.\n\n" +
  "If the same food appears multiple times or in a count (e.g. '5 eggs', '3 cookies'), " +
  "report it as ONE item with that count in 'quantity' and 'calories' equal to the total for " +
  "all of them combined - never repeat the same food as separate item entries.\n\n" +
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
  "Also report 'estimated_gram_weight': your best real-world estimate of the total weight in " +
  "grams of the quantity actually stated for that item (e.g. '5 eggs' - about 250g total since " +
  "one large egg is roughly 50g; '1 large tomato' - about 150g; if a weight is already given " +
  "like '300g blueberries', just use that number). This is used to cross-check your calorie " +
  "math against reference nutrition data, so estimate it carefully using real-world knowledge " +
  "of how much that quantity of that food actually weighs - do not skip or guess randomly.\n\n" +
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
  "Break the result into individual DISTINCT items (usually just one dish, or its listed " +
  "components if useful) - if something is counted or repeated (e.g. '3 tacos'), report it " +
  "as ONE item with that count in 'quantity' and 'calories' for all of them combined, never " +
  "as separate repeated entries. Extract any tags, and respond via the required JSON shape. " +
  "For each item, " +
  "also report 'unit_label' (a short description of one natural unit, no leading number or " +
  "article, e.g. 'taco', '100g') and 'unit_calories' (that unit's calories) - if the item is " +
  "already a single natural unit, unit_calories should just equal calories. Also report " +
  "'estimated_gram_weight': your best real-world estimate of the total weight in grams of the " +
  "quantity actually stated (e.g. '3 tacos' - about 300g total). 'reply' should be a short, " +
  "friendly one-to-two sentence confirmation - do not mention the daily total, that is " +
  "appended separately.";

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
          estimated_gram_weight: { type: "number" },
        },
        required: ["name", "calories", "unit_label", "unit_calories", "estimated_gram_weight"],
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
  properties: {
    calories: { type: "number" },
    unit_label: { type: "string" },
    unit_calories: { type: "number" },
  },
  required: ["calories", "unit_label", "unit_calories"],
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

  // Workers AI JSON Mode is not a 100% guarantee, especially on a "fast" model
  // under a schema with several required fields per item - fill in sensible
  // defaults for anything missing/malformed rather than failing the whole
  // request or silently showing blank info.
  parsed.items = parsed.items.map((it) => {
    const calories = typeof it.calories === "number" ? it.calories : 0;
    return {
      name: it.name || "item",
      quantity: it.quantity || "",
      calories,
      unit_label: it.unit_label || it.quantity || it.name || "item",
      unit_calories: typeof it.unit_calories === "number" ? it.unit_calories : calories,
      estimated_gram_weight: typeof it.estimated_gram_weight === "number" ? it.estimated_gram_weight : null,
    };
  });

  // Safety net for the same failure mode the system prompt already asks the
  // model to avoid ("5 eggs" coming back as five separate "egg" entries
  // instead of one item with quantity "5") - collapse duplicate names into
  // one combined entry rather than trusting the instruction was followed.
  const merged = new Map();
  for (const it of parsed.items) {
    const key = it.name.toLowerCase();
    if (merged.has(key)) {
      const existing = merged.get(key);
      existing.calories += it.calories;
      if (existing.estimated_gram_weight != null && it.estimated_gram_weight != null) {
        existing.estimated_gram_weight += it.estimated_gram_weight;
      }
      existing._count += 1;
    } else {
      merged.set(key, { ...it, _count: 1 });
    }
  }
  parsed.items = [...merged.values()].map(({ _count, ...it }) => {
    if (_count > 1 && !it.quantity) it.quantity = String(_count);
    return it;
  });

  if (!Array.isArray(parsed.tags)) parsed.tags = [];

  if (!parsed.reply || !String(parsed.reply).trim()) {
    const summary = parsed.items.map((it) => it.name).join(", ");
    parsed.reply = `Logged ${summary} — ${Math.round(parsed.total_calories)} kcal total.`;
  }

  return parsed;
}

async function usdaSearchList(env, query, dataType) {
  let url =
    `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${env.USDA_API_KEY}` +
    `&query=${encodeURIComponent(query)}&pageSize=5`;
  if (dataType) url += `&dataType=${encodeURIComponent(dataType)}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return data.foods || [];
}

// FDC often splits a plain food into separate component/variant records (egg
// -> "egg white" / "egg yolk" / "egg substitute", milk -> "dry milk", chicken
// -> "chicken gizzard") that can rank above the plain whole-food entry in
// search results. If the description names a component/variant the user's
// own query didn't ask for, it's very likely the wrong match even though its
// calorie value alone looks perfectly plausible.
const USDA_COMPONENT_QUALIFIERS = [
  "white", "yolk", "substitute", "powder", "dried", "dry", "shell", "gizzard", "liver", "skin",
];

function isPlausibleMatch(query, description) {
  const q = query.toLowerCase();
  const d = description.toLowerCase();
  return !USDA_COMPONENT_QUALIFIERS.some((word) => d.includes(word) && !q.includes(word));
}

function pickBestFood(query, foods) {
  for (const food of foods) {
    if (!isPlausibleMatch(query, food.description)) continue;
    const kcal = extractKcalPer100g(food);
    if (kcal != null) return { food, kcal };
  }
  // Nothing both well-matched and plausible - fall back to the first
  // plausible-calorie result even with a mismatched qualifier, rather than
  // giving up on grounding this item entirely.
  for (const food of foods) {
    const kcal = extractKcalPer100g(food);
    if (kcal != null) return { food, kcal };
  }
  return null;
}

async function lookupUsdaFood(env, query) {
  if (!env.USDA_API_KEY) {
    console.log("USDA_API_KEY not set - skipping nutrition lookup, using model estimate only");
    return null;
  }
  try {
    // Generic/raw foods (Foundation, SR Legacy) first - much better match for
    // typical logged ingredients than packaged "Branded" products. Fall back
    // to the full catalog (including Branded) if nothing generic turns up.
    let best = pickBestFood(query, await usdaSearchList(env, query, "Foundation,SR Legacy"));
    if (!best) {
      best = pickBestFood(query, await usdaSearchList(env, query, null));
    }
    if (!best) return null;

    console.log(`USDA match for "${query}": "${best.food.description}" = ${best.kcal} kcal/100g`);
    return { description: best.food.description, kcalPer100g: best.kcal, fdcId: best.food.fdcId };
  } catch (err) {
    console.error("USDA lookup failed", err);
    return null;
  }
}

// Real food essentially never exceeds pure fat's ~900 kcal/100g. FDC's search
// results can list "Energy" more than once per food (kcal and kJ variants,
// plus Foundation Foods' separate "Atwater General/Specific Factors" energy
// entries) and the reported unitName isn't reliable enough to trust blindly -
// a kJ figure mistaken for kcal, or a mismatched high-fat product, both show
// up as an implausibly large number. Scan every "Energy" entry and take the
// first one that's actually plausible, rather than the first one found.
const USDA_MAX_PLAUSIBLE_KCAL_PER_100G = 900;

function extractKcalPer100g(food) {
  const candidates = (food.foodNutrients || []).filter(
    (n) => n.nutrientName === "Energy" && typeof n.value === "number" && n.value > 0
  );
  const plausible = candidates.find((n) => n.value <= USDA_MAX_PLAUSIBLE_KCAL_PER_100G);
  return plausible ? plausible.value : null;
}

async function runCalorieModel(env, systemPrompt, message) {
  const result = await env.AI.run(AI_MODEL, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: message },
    ],
    response_format: { type: "json_schema", json_schema: MEAL_JSON_SCHEMA },
  });

  return extractMealJson(result, "try rephrasing your message.");
}

function parseGrams(quantity) {
  const m = String(quantity || "").trim().match(/^([\d.]+)\s*g(rams?)?$/i);
  return m ? parseFloat(m[1]) : null;
}

function parseCount(quantity) {
  const m = String(quantity || "").trim().match(/^([\d.]+)$/);
  return m ? parseFloat(m[1]) : null;
}

async function callWorkersAI(env, message) {
  const firstPass = await runCalorieModel(env, CALORIE_SYSTEM_PROMPT, message);

  const factsByName = new Map();
  for (const item of firstPass.items) {
    const food = await lookupUsdaFood(env, item.name);
    if (food) factsByName.set(item.name.toLowerCase(), food);
  }

  if (!factsByName.size) {
    return firstPass;
  }

  const factLines = [...factsByName.entries()].map(
    ([name, food]) => `- ${name}: USDA "${food.description}" has ${Math.round(food.kcalPer100g)} kcal per 100g.`
  );

  const groundedPrompt =
    CALORIE_SYSTEM_PROMPT +
    "\n\nYou already made an initial pass at this meal. Below are authoritative USDA " +
    "nutrition facts for some of the items - use them instead of your own memory for those " +
    "items, converting from the 100g figure to whatever quantity was actually stated (e.g. " +
    "scale '143 kcal per 100g' to the real weight/count logged). For any item with no fact " +
    "provided, keep using your own best estimate. Recompute the total and per-unit figures " +
    "to match.\n\nUSDA facts:\n" +
    factLines.join("\n");

  let final;
  try {
    final = await runCalorieModel(env, groundedPrompt, message);
  } catch (err) {
    // Grounding is a pure accuracy improvement - if the second pass fails for
    // any reason, the ungrounded first pass is still a perfectly valid result.
    console.error("Grounded re-pass failed, using first-pass estimate", err);
    return firstPass;
  }

  // Tag whichever items in the final result correspond to a USDA fact we
  // looked up, so the front end can show the reader what was actually used
  // ("(USDA)") rather than presenting every number as equally sourced.
  //
  // Also recompute calories/unit_calories ourselves rather than trusting the
  // model's "convert 100g to the real quantity" math - that conversion has
  // proven unreliable in practice (it tends to treat "kcal per 100g" as if
  // 100g were one whole unit, badly overestimating a food that's actually
  // much lighter per piece, e.g. a ~50g egg). The model is asked for
  // 'estimated_gram_weight' (a plain real-world weight guess, which models
  // are decent at) instead, and the actual scaling arithmetic happens here
  // in code, not inside the model's structured output.
  final.items = final.items.map((it) => {
    const food = factsByName.get(it.name.toLowerCase());
    if (!food) return it;

    const withSource = {
      ...it,
      usda_source: true,
      usda_food: food.description,
      usda_kcal_per_100g: Math.round(food.kcalPer100g),
      usda_url: food.fdcId ? `https://fdc.nal.usda.gov/food-details/${food.fdcId}/nutrients` : null,
    };

    // An explicit gram quantity ("300g") is more trustworthy than the
    // model's estimate, since there's nothing to estimate - use it first.
    const explicitGrams = parseGrams(it.quantity);
    const grams = explicitGrams != null ? explicitGrams : it.estimated_gram_weight;
    if (typeof grams !== "number" || grams <= 0) return withSource;

    const total = Math.round((food.kcalPer100g * grams) / 100);
    const count = parseCount(it.quantity);
    const unitCalories = count ? Math.round(total / count) : total;
    const unitLabel = it.unit_label || (count ? it.name : "100g");

    return { ...withSource, calories: total, unit_calories: unitCalories, unit_label: unitLabel };
  });

  // Keep the meal total consistent with whatever just got overridden above.
  final.total_calories = final.items.reduce((sum, it) => sum + it.calories, 0);

  return final;
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

  const food = await lookupUsdaFood(env, description);
  const factLine = food
    ? `\n\nAuthoritative USDA fact: "${food.description}" has ${Math.round(food.kcalPer100g)} ` +
      "kcal per 100g - if this is a good match for the description, use it (converted to the " +
      "actual stated quantity) instead of your own memory."
    : "";

  const result = await env.AI.run(AI_MODEL, {
    messages: [
      {
        role: "system",
        content:
          "Estimate a reasonable calorie count for the single food item described (it may " +
          "include a quantity or weight, e.g. '300g blueberries' or '5.5 eggs'), using " +
          "standard nutritional knowledge. If the quantity is vague, assume a typical " +
          "single serving. Also report 'unit_label' (a short description of one natural " +
          "unit, no leading number or article, e.g. 'egg', '100g') and 'unit_calories' " +
          "(that one unit's calories) - if the description already is one natural unit, " +
          "unit_calories should equal calories." +
          factLine,
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

  const calories = Math.round(parsed.calories);
  return jsonResponse(
    {
      calories,
      unit_label: parsed.unit_label || description,
      unit_calories: typeof parsed.unit_calories === "number" ? Math.round(parsed.unit_calories) : calories,
    },
    200,
    origin
  );
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
      `Daily total is ${dailyTotal} kcal, ${dailyTotal - limit} kcal over your ${limit} kcal limit.`,
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
