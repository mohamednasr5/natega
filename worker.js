export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const seat = (url.searchParams.get("seat") || "").trim();
    const debug = url.searchParams.get("debug") === "1";

    if (!seat || !/^\d+$/.test(seat)) {
      return jsonResponse({ ok: false, msg: "رقم جلوس غير صحيح" });
    }

    try {
      const result = await searchAllSites(seat);
      if (!result) {
        return jsonResponse({ ok: false, msg: "لم يتم العثور على نتيجة لرقم الجلوس المدخل" });
      }

      const data = { ...result.mapped };
      if (debug) {
        // Diagnostic-only fields. index.html never requests debug=1,
        // so these never reach the normal app UI.
        data._source = result.source;
        data._endpoint = result.endpoint;
        data._raw = stripForDebug(result.raw);
      }
      return jsonResponse({ ok: true, data });
    } catch (e) {
      return jsonResponse({ ok: false, msg: "حدث خطأ أثناء جلب النتيجة، حاول مرة أخرى" });
    }
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), {
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      ...corsHeaders(),
    },
  });
}

// Strips <script>/<style> blocks and collapses whitespace before
// truncating, so the debug snippet is dense with actual visible
// content instead of being eaten up by boilerplate CSS/JS.
function stripForDebug(raw, limit = 6000) {
  if (raw == null) return null;
  let text = typeof raw === "string" ? raw : JSON.stringify(raw);
  text = text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, limit);
}

// Tries each source in order; first one that returns a usable result wins.
// Each fetch* function returns { mapped, source, endpoint, raw } or null.
async function searchAllSites(seat) {
  const sources = [fetchOfficial, fetchNezakr, fetchNatiga4dk];
  for (const fn of sources) {
    try {
      const result = await fn(seat);
      if (result) return result;
    } catch (e) {
      continue;
    }
  }
  return null;
}

// ───────────────────────────────────────────────────────────
// SOURCE 1: the official Dakahlia directorate site (authoritative).
// NOTE: I have not been able to confirm the real AJAX endpoint this
// site uses from outside a browser. These two candidate URLs are
// guesses (one from this repo's README, one from an earlier version
// of this worker). Use ?seat=...&debug=1 to see which one (if any)
// actually returns usable JSON, and what its real field names are.
// ───────────────────────────────────────────────────────────
async function fetchOfficial(seat) {
  const candidates = [
    `https://natiga.edudk.net/P20262026/public/api_result.php?seat=${seat}`,
    `https://natiga.edudk.net/P20262026/public/api/students/${seat}`,
  ];

  for (const apiUrl of candidates) {
    try {
      const r = await fetch(apiUrl, {
        headers: {
          Accept: "application/json",
          Referer: "https://natiga.edudk.net/P20262026/public/index.html",
          "User-Agent": "Mozilla/5.0",
        },
      });
      if (!r.ok) continue;
      const text = await r.text();
      if (!text || !text.trim()) continue;
      let raw;
      try {
        raw = JSON.parse(text);
      } catch {
        continue;
      }
      const mapped = mapOfficial(raw);
      if (mapped) {
        return { mapped, source: "official", endpoint: apiUrl, raw: text };
      }
    } catch (e) {
      continue;
    }
  }
  return null;
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Maps whatever shape the official API returns into the exact schema
// index.html's renderResult() expects. Field-name guesses are listed
// as alternatives since the real response shape is still unconfirmed —
// check the debug output before trusting these numbers.
function mapOfficial(raw) {
  if (!raw) return null;
  const d = raw.data || raw.result || raw; // unwrap common envelope shapes
  const name = pick(d, ["student_name", "name", "ar_name"]);
  if (!name) return null;

  const algebra = numOr(pick(d, ["algebra"]), 0);
  const geometry = numOr(pick(d, ["geometry"]), 0);

  return {
    student_name: name,
    seat_no: pick(d, ["seat_no", "seat", "seat_number"]) ?? "",
    grade_name: pick(d, ["grade_name", "grade", "stage"]) ?? "الثالث الإعدادي",
    school_name: pick(d, ["school_name", "school", "ar_school"]) ?? "",
    admin_name: pick(d, ["admin_name", "admin", "ar_admin"]) ?? "",
    total: numOr(pick(d, ["total", "sum", "degree"]), 0),
    ar: numOr(pick(d, ["ar", "arabic"]), 0),
    en: numOr(pick(d, ["en", "english"]), 0),
    studies: numOr(pick(d, ["studies", "social_studies"]), 0),
    algebra,
    geometry,
    math_total: numOr(pick(d, ["math_total", "math"]), algebra + geometry),
    science: numOr(pick(d, ["science"]), 0),
    religion: numOr(pick(d, ["religion"]), 0),
    art: numOr(pick(d, ["art"]), 0),
    computer: numOr(pick(d, ["computer"]), 0),
    level1: pick(d, ["level1"]) ?? null,
    level2: pick(d, ["level2"]) ?? null,
  };
}

// ───────────────────────────────────────────────────────────
// SOURCE 2 (fallback): nezakr — scraped via regex.
//
// IMPORTANT: the patterns below are a best-effort guess at nezakr's
// phrasing (things like "مجموع كلي قدره X درجة"). I have NOT verified
// them against a real saved nezakr result page — I don't have a way
// to browse it directly from here. If a comment elsewhere claimed
// these were "verified against live pages," that's not accurate;
// treat this source as unconfirmed until debug=1 shows it actually
// firing with sane values.
// ───────────────────────────────────────────────────────────
async function fetchNezakr(seat) {
  const pageUrl = `https://natiga.nezakr.net/dakahlia/num/${seat}/`;
  const r = await fetch(pageUrl, {
    headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" },
  });
  if (!r.ok) return null;
  const html = await r.text();
  if (html.includes("لم يتم العثور") || html.includes("غير موجود") || html.includes("لم نستطع العثور")) {
    return null;
  }

  const titleMatch = html.match(/<title>\s*نتيجة الطالب\s+([^<]+?)\s+بالشهادة/);
  const proseMatch = html.match(/نتيجة الطالب\/الطالبة:?\s*([^\n<]{4,80}?)\s+في الشهادة/);
  const name = (titleMatch && titleMatch[1]) || (proseMatch && proseMatch[1]);
  if (!name) return null;
  const cleanName = name.trim();
  if (cleanName.includes("نذاكر") || cleanName.includes("موقع")) return null;

  const scoreMatch = html.match(/مجموع[^\d]{0,30}([\d.]+)\s*درجة[^\d]{0,70}([\d.]+)\s*درجة/);
  const total = scoreMatch ? parseFloat(scoreMatch[1]) : null;
  if (total === null) return null; // couldn't reliably read the score — don't return guessed garbage

  const pctMatch = html.match(/النسبة المئوية[^()]{0,40}\(\s*([\d.]+)\s*%\s*\)/);
  const percentage = pctMatch ? pctMatch[1] + "%" : null;

  const gradeMatch = html.match(/ممتاز|جيد جداً|جيد|مقبول|راسب|ضعيف/);
  const grade = gradeMatch ? gradeMatch[0] : null;

  const schoolMatch = html.match(/مستوى المدرسة\s*\(\s*مدرسة\s*([^)]+?)\)\s*:/);
  const adminMatch = html.match(/مستوى الإدارة\s*\(\s*إدارة\s*([^)]+?)\)\s*:/);

  return {
    mapped: {
      student_name: cleanName,
      seat_no: seat,
      grade_name: "الثالث الإعدادي",
      school_name: schoolMatch ? schoolMatch[1].trim() : "",
      admin_name: adminMatch ? adminMatch[1].trim() : "",
      total,
      percentage,
      grade,
      ar: null,
      en: null,
      studies: null,
      algebra: null,
      geometry: null,
      math_total: null,
      science: null,
      religion: null,
      art: null,
      computer: null,
      level1: null,
      level2: null,
    },
    source: "nezakr",
    endpoint: pageUrl,
    raw: html,
  };
}

// ───────────────────────────────────────────────────────────
// SOURCE 3 (last-resort fallback): natiga4dk.
// Same caveat: name extraction (h1/h2/h3) seems to work, but the
// "first x/y pattern on the page" used for total is unreliable — it
// can latch onto an unrelated number (pagination, a date, etc.).
// Use debug=1 to capture a real page and pin down the real score
// location instead of guessing further.
// ───────────────────────────────────────────────────────────
async function fetchNatiga4dk(seat) {
  const pageUrl = `https://www.natiga4dk.com/dakahlia/seat/${seat}/`;
  const r = await fetch(pageUrl, {
    headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" },
  });
  if (!r.ok) return null;
  const html = await r.text();
  if (html.includes("غير موجودة") || html.includes("404")) return null;

  const nameMatch = html.match(/<h[123][^>]*>\s*([^\u0000-\u007F][^<]{4,79})\s*<\/h[123]>/i);
  const name = nameMatch ? nameMatch[1].trim() : null;
  if (!name) return null;

  const totalMatch = html.match(/([\d.]+)\s*\/\s*(\d+)/);
  const total = totalMatch ? parseFloat(totalMatch[1]) : 0;

  return {
    mapped: {
      student_name: name,
      seat_no: seat,
      grade_name: "الثالث الإعدادي",
      school_name: "",
      admin_name: "",
      total,
      ar: 0,
      en: 0,
      studies: 0,
      algebra: 0,
      geometry: 0,
      math_total: 0,
      science: 0,
      religion: 0,
      art: 0,
      computer: 0,
      level1: null,
      level2: null,
    },
    source: "natiga4dk",
    endpoint: pageUrl,
    raw: html,
  };
}
