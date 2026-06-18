export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const seat = (url.searchParams.get("seat") || "").trim();

    if (!seat || !/^\d+$/.test(seat)) {
      return jsonResponse({ ok: false, msg: "رقم جلوس غير صحيح" });
    }

    try {
      const data = await searchAllSites(seat);
      if (data) return jsonResponse({ ok: true, data });
      return jsonResponse({ ok: false, msg: "لم يتم العثور على نتيجة لرقم الجلوس المدخل" });
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

// Tries each source in order; first one that returns a usable result wins.
async function searchAllSites(seat) {
  const sources = [fetchOfficial, fetchNezakr, fetchNatiga4dk];
  for (const fn of sources) {
    try {
      const data = await fn(seat);
      if (data) return data;
    } catch (e) {
      continue;
    }
  }
  return null;
}

// ───────────────────────────────────────────────────────────
// SOURCE 1: the official Dakahlia directorate site (authoritative).
// NOTE: I could not confirm the real AJAX endpoint this site uses —
// I don't have a way to inspect its JS/network calls from here.
// These two URLs are educated guesses (one from this repo's own
// README, one from the previous worker.js). If both miss, send me
// the real request from your browser's Network tab (open
// natiga.edudk.net/P20262026/public/index.html, search a real seat
// number, copy the XHR/fetch URL + raw JSON response) and I'll wire
// it in exactly instead of guessing.
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
      if (mapped) return mapped;
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
// as alternatives since the real response shape is unconfirmed.
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
// SOURCE 2 (fallback): nezakr — scraped via regex since there's no
// official API. Same caveat as above: I'm working from your patch's
// hints (title tag, label-then-nearby-fraction), not a real saved
// page, so treat this as a best effort. If it still misses, send me
// the actual HTML of a real result page from this site and I'll fit
// the patterns exactly.
// ───────────────────────────────────────────────────────────
async function fetchNezakr(seat) {
  const r = await fetch(`https://natiga.nezakr.net/dakahlia/num/${seat}/`, {
    headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" },
  });
  if (!r.ok) return null;
  const html = await r.text();
  if (html.includes("لم يتم العثور") || html.includes("غير موجود")) return null;

  const titleMatch = html.match(/<title>\s*نتيجة الطالب\s+([^<]+?)\s+بالشهادة/);
  const headingMatch = html.match(/<h[123][^>]*>\s*([^\u0000-\u007F][^<]{4,79})\s*<\/h[123]>/i);
  const name = titleMatch ? titleMatch[1].trim() : headingMatch ? headingMatch[1].trim() : null;
  if (!name || name.includes("نذاكر") || name.includes("نتيجة")) return null;

  const totalMatch = html.match(/([\d.]+)\s*\/\s*(\d+)/);
  const total = totalMatch ? parseFloat(totalMatch[1]) : 0;

  const school = extractBetween(html, "المدرسة");
  const admin = extractBetween(html, "الإدارة");

  const ar = extractSubject(html, "العربية");
  const en = extractSubject(html, "الانجليزية") || extractSubject(html, "الإنجليزية");
  const algebra = extractSubject(html, "الجبر");
  const geometry = extractSubject(html, "الهندسة");
  const science = extractSubject(html, "العلوم");
  const studies = extractSubject(html, "الدراسات");

  return {
    student_name: name,
    seat_no: seat,
    grade_name: "الثالث الإعدادي",
    school_name: school || "",
    admin_name: admin || "",
    total,
    ar,
    en,
    studies,
    algebra,
    geometry,
    math_total: algebra + geometry,
    science,
    religion: 0,
    art: 0,
    computer: 0,
    level1: null,
    level2: null,
  };
}

// Looks for a subject label, then the nearest "x/y" fraction after it.
function extractSubject(html, label) {
  const idx = html.indexOf(label);
  if (idx === -1) return 0;
  const chunk = html.slice(idx, idx + 200);
  const m = chunk.match(/([\d.]+)\s*\/\s*\d+/);
  return m ? parseFloat(m[1]) : 0;
}

function extractBetween(html, label) {
  const idx = html.indexOf(label);
  if (idx === -1) return null;
  const after = html.slice(idx + label.length, idx + label.length + 200);
  const m = after.match(/>\s*([^\u0000-\u007F][^<]{1,60})\s*</);
  return m ? m[1].trim() : null;
}

// ───────────────────────────────────────────────────────────
// SOURCE 3 (last-resort fallback): natiga4dk — only name + total
// recovered reliably without a real page sample to test selectors
// against. Better than nothing if the first two sources are down.
// ───────────────────────────────────────────────────────────
async function fetchNatiga4dk(seat) {
  const r = await fetch(`https://www.natiga4dk.com/dakahlia/seat/${seat}/`, {
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
  };
}
