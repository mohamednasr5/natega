// =============================================================================
//  نتيجة الطالب — Cloudflare Worker
//  يبحث عن نتيجة الشهادة الإعدادية (الدقهلية) من 3 مصادر بالترتيب التالي:
//    1) nezakr  → الأدق والأسرع، يرجع جدول المواد كاملاً
//    2) natiga4dk → fallback، لكن بنظام درجات مختلف (مضاعف) — استخدمه فقط عند فشل nezakr
//    3) official (natiga.edudk.net) → API الرسمي، حالياً يرجع 500 + body فارغ
//
//  التشخيص النهائي (تحقق منه على أرض الواقع):
//    - api_result.php?seat=... → HTTP 500 size=0  (الـ API الرسمي لا يعمل،
//      والموقع نفسه يعرض "بيانات تجريبية" — لا تعتمد عليه في 2026).
//    - nezakr يرجع صفحة HTML كاملة فيها جدول المواد (10 مواد) + meta description
//      فيها الاسم/المدرسة/الإدارة/المجموع.
//    - natiga4dk يحتاج رابط GET بصيغة /dakahlia/?type=num&k=<seat> ويرجع جدول
//      درجات، لكن القيم بنظام مضاعف (مثلاً عربي 73 بدلاً من 38) — استخدمه فقط
//      إذا فشل nezakr، واعتبر قيمه "تقريبية".
// =============================================================================

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
  // nezakr أولاً لأنه الأدق، ثم natiga4dk كـ fallback، ثم official.
  const sources = [fetchNezakr, fetchNatiga4dk, fetchOfficial];
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
// Helpers
// ───────────────────────────────────────────────────────────
function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

function numOr(v, fallback) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// يبني headers متصفح حقيقية لتجنب حجب bot-detection.
function browserHeaders(extra = {}) {
  return {
    Accept:
      extra.Accept ||
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ar,en-US;q=0.9,en;q=0.8",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    ...extra,
  };
}

// يبني كائن درجات فارغ بالـ schema المتوقع من index.html.
function emptyMapped(seat) {
  return {
    student_name: "",
    seat_no: seat,
    grade_name: "الثالث الإعدادي",
    school_name: "",
    admin_name: "",
    total: 0,
    percentage: null,
    grade: null,
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
  };
}

// ───────────────────────────────────────────────────────────
// SOURCE 1 (preferred): nezakr — صفحة HTML فيها جدول موثوق
//   رابط: https://natiga.nezakr.net/dakahlia/num/<seat>/
//   الحقول المستخرجة:
//     - student_name  من <title>  "نتيجة الطالب <NAME> بالشهادة ..."
//     - school_name   من meta description "المقيد بمدرسة <SCHOOL>"
//     - admin_name    من meta description "بإدارة <ADMIN>"
//     - total         من meta description "مجموع <X> درجة من 140.00 درجة"
//     - ar/en/algebra/geometry/math_total/science/studies/religion/art/computer
//                     من أول <table> بالصفحة (عمود "المجموع")
// ───────────────────────────────────────────────────────────
async function fetchNezakr(seat) {
  const pageUrl = `https://natiga.nezakr.net/dakahlia/num/${seat}/`;
  const r = await fetch(pageUrl, {
    headers: browserHeaders({ Referer: "https://natiga.nezakr.net/" }),
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!r.ok) return null;
  const html = await r.text();
  // صفحات "غير موجود" عند nezakr بترجع 200 + نص "لم يتم العثور"
  if (
    html.includes("لم يتم العثور") ||
    html.includes("غير موجود") ||
    html.includes("لم نستطع العثور")
  ) {
    return null;
  }

  // 1) الاسم من <title>
  //    مثال: "نتيجة الطالب منى السيد عبد الهادى ابراهيم ابو الحسن بالشهادة الإعدادية ..."
  const titleMatch = html.match(
    /<title>\s*نتيجة الطالب\s+(.+?)\s+بالشهادة/
  );
  let name = titleMatch ? titleMatch[1].trim() : "";
  // fallback: من meta description
  if (!name) {
    const m = html.match(
      /نتيجة الطالب\s+(.+?)\s+بالشهادة/
    );
    if (m) name = m[1].trim();
  }
  if (!name) return null;
  if (name.includes("نذاكر") || name.includes("موقع")) return null;

  // 2) المدرسة + الإدارة + المجموع من meta description
  //    مثال: "...والمقيد بمدرسة دكرنس ع الحديثة بنات، والمقيد بإدارة دكرنس
  //           وقد حصل الطالب على مجموع 129.50 درجة من 140.00 درجة..."
  const metaMatch =
    html.match(
      /<meta\s+name="description"\s+content="([^"]+)"/
    ) || html.match(/<meta\s+content="([^"]+)"\s+name="description"/);
  const meta = metaMatch ? metaMatch[1] : "";

  const schoolMatch = meta.match(/المقيد بمدرسة\s+([^,،]+)/);
  const adminMatch = meta.match(/بإدارة\s+([^,،]+?)(?:\s+وقد|\s+و\s+قد|,|،|$)/);
  const totalMatch = meta.match(/مجموع\s+([\d.]+)\s*درجة\s*من\s*([\d.]+)\s*درجة/);
  const total = totalMatch ? parseFloat(totalMatch[1]) : null;

  // النسبة المئوية والتقدير إن وُجدا
  const pctMatch = html.match(/النسبة المئوية[^()]{0,40}\(\s*([\d.]+)\s*%\s*\)/);
  const percentage = pctMatch ? pctMatch[1] + "%" : null;
  const gradeMatch = html.match(/ممتاز|جيد جداً|جيد|مقبول|راسب|ضعيف/);
  const grade = gradeMatch ? gradeMatch[0] : null;

  // 3) جدول المواد
  //    nezakr فيه 3 جداول. الأول هو جدول الدرجات بأعمدة:
  //    "المادة | المجموع | النهاية العظمى | التقدير"
  //    نأخذ العمود الثاني (المجموع) ونطابقه مع أسماء المواد المعروفة.
  const subjects = parseNezakrSubjectsTable(html);

  // التحقق: لازم يكون عندنا على الأقل total أو جدول مواد
  if (total === null && Object.keys(subjects).length === 0) {
    return null;
  }

  // حساب المجموع من المواد الأساسية لو ما قرأناش من meta
  const ar = numOr(subjects["ar"], null);
  const en = numOr(subjects["en"], null);
  const studies = numOr(subjects["studies"], null);
  const algebra = numOr(subjects["algebra"], null);
  const geometry = numOr(subjects["geometry"], null);
  const mathTotal = numOr(
    subjects["math_total"],
    algebra !== null && geometry !== null ? algebra + geometry : null
  );
  const science = numOr(subjects["science"], null);
  const religion = numOr(subjects["religion"], null);
  const art = numOr(subjects["art"], null);
  const computer = numOr(subjects["computer"], null);

  // total المحسوب من المواد الأساسية (للتحقق)
  const computedTotal = [ar, en, studies, mathTotal, science]
    .filter((v) => v !== null)
    .reduce((a, b) => a + b, 0);
  const finalTotal =
    total !== null ? total : computedTotal > 0 ? computedTotal : 0;

  return {
    mapped: {
      student_name: name,
      seat_no: seat,
      grade_name: "الثالث الإعدادي",
      school_name: schoolMatch ? schoolMatch[1].trim() : "",
      admin_name: adminMatch ? adminMatch[1].trim() : "",
      total: finalTotal,
      percentage,
      grade,
      ar,
      en,
      studies,
      algebra,
      geometry,
      math_total: mathTotal,
      science,
      religion,
      art,
      computer,
      level1: null,
      level2: null,
    },
    source: "nezakr",
    endpoint: pageUrl,
    raw: html,
  };
}

// يقرأ أول <table> في صفحة nezakr ويرجع خريطة أسماء المواد إلى درجاتها.
//   المادة بالعربي   →  المفتاح في schema natega-main
//   اللغة العربية     ar
//   اللغة الانجليزية  en
//   الجبر              algebra
//   الهندسة            geometry
//   مجموع الرياضيات  math_total
//   العلوم             science
//   الدراسات الاجتماعية  studies
//   التربية الدينية    religion
//   التربية الفنية     art
//   الحاسب الآلي       computer
function parseNezakrSubjectsTable(html) {
  const out = {};
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  if (tables.length === 0) return out;

  const firstTable = tables[0];
  const rows = firstTable.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [];
    if (cells.length < 2) continue;
    const cellText = (c) =>
      c
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    const subjectName = cellText(cells[0]);
    const scoreStr = cellText(cells[1]); // "المجموع" column
    const key = mapSubjectNameToKey(subjectName);
    if (!key) continue;
    const score = parseFloat(scoreStr);
    if (Number.isFinite(score)) {
      out[key] = score;
    }
  }
  return out;
}

function mapSubjectNameToKey(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  if (name.includes("اللغة العربية") || name.includes("اللغه العربية")) return "ar";
  if (
    name.includes("اللغة الانجليزية") ||
    name.includes("اللغه الانجليزية") ||
    name.includes("اللغة الإنجليزية") ||
    name.includes("اللغه الإنجليزية")
  )
    return "en";
  if (name.includes("الجبر") || name.includes("الاحصاء والجبر") || name.includes("الإحصاء والجبر")) return "algebra";
  if (name.includes("الهندسة")) return "geometry";
  if (name.includes("مجموع الرياضيات")) return "math_total";
  if (name.includes("العلوم")) return "science";
  if (name.includes("الدراسات")) return "studies";
  if (name.includes("التربية الدينية") || name.includes("دين")) return "religion";
  if (name.includes("التربية الفنية") || name.includes("فنية")) return "art";
  if (name.includes("الحاسب")) return "computer";
  return null;
}

// ───────────────────────────────────────────────────────────
// SOURCE 2 (fallback): natiga4dk — بنظام درجات مختلف (مضاعف)
//   رابط: https://www.natiga4dk.com/dakahlia/?type=num&k=<seat>
//   ملاحظة مهمة: natiga4dk يعرض القيم بنظام درجات مضاعف مقارنة بـ nezakr
//   (مثلاً عربي 73 بدلاً من 38.5). استخدمه فقط عند فشل nezakr، واعتبر
//   قيمه "تقريبية".
// ───────────────────────────────────────────────────────────
async function fetchNatiga4dk(seat) {
  const pageUrl = `https://www.natiga4dk.com/dakahlia/?type=num&k=${seat}`;
  const r = await fetch(pageUrl, {
    headers: browserHeaders({ Referer: "https://www.natiga4dk.com/dakahlia/" }),
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!r.ok) return null;
  const html = await r.text();
  if (
    html.includes("غير موجودة") ||
    html.includes("404") ||
    html.length < 5000
  ) {
    return null;
  }

  // 1) الاسم من <title>
  //    مثال: "نتيجة الطالب امجد عزيز محمد حافظ رفاعى بالشهادة الإعدادية ..."
  const titleMatch = html.match(
    /<title>\s*نتيجة الطالب\s+(.+?)\s+بالشهادة/
  );
  const name = titleMatch ? titleMatch[1].trim() : "";
  if (!name) return null;

  // 2) جدول "بيانات الطالب" فيه: المجموع، المجموع الكلي، النسبة، الحالة
  //    نأخذ "المجموع الكلي" (القيمة من 140) لأنه هو القيمة الموحدة للشهادة.
  //    إذا ما وجدناش، نحاول نحسبه من المواد الأساسية.
  const totalMatch =
    html.match(/المجموع الكلي[^<>]*?<\/td>\s*<td[^>]*>([^<]+)/i) ||
    html.match(/المجموع الكلي[\s:]*([\d.]+)/);
  const total = totalMatch ? parseFloat(totalMatch[1]) : null;

  const schoolMatch = html.match(/المدرسة[^<>]*?<\/td>\s*<td[^>]*>([^<]+)/i);
  const adminMatch = html.match(
    /الإدارة التعليمية[^<>]*?<\/td>\s*<td[^>]*>([^<]+)/i
  );
  const statusMatch = html.match(/حالة الطالب[^<>]*?<\/td>\s*<td[^>]*>([^<]+)/i);
  const grade = statusMatch ? statusMatch[1].trim() : null;

  // 3) جدول "درجات المواد" فيه عمودين: المادة | الدرجة
  //    natiga4dk بيظهر القيم بنظام مضاعف، فنحاول نصفها على 2 للحصول على
  //    القيم الحقيقية المتوافقة مع نظام الشهادة.
  const subjects = parseNatiga4dkSubjectsTable(html);

  const rawAr = numOr(subjects["ar"], null);
  const rawEn = numOr(subjects["en"], null);
  const rawStudies = numOr(subjects["studies"], null);
  const rawAlgebra = numOr(subjects["algebra"], null);
  const rawGeometry = numOr(subjects["geometry"], null);
  const rawMathTotal = numOr(subjects["math_total"], null);
  const rawScience = numOr(subjects["science"], null);
  const rawReligion = numOr(subjects["religion"], null);
  const rawArt = numOr(subjects["art"], null);
  const rawComputer = numOr(subjects["computer"], null);

  // natiga4dk بنظام مضاعف، فنقسم على 2 لتقريب القيم لنظام الشهادة الحقيقي
  // (140 درجة). القيم الناتجة تقريبية لكنها قابلة للعرض.
  const halve = (v) => (v !== null ? Math.round(v * 50) / 100 : null);
  const ar = halve(rawAr);
  const en = halve(rawEn);
  const studies = halve(rawStudies);
  const algebra = halve(rawAlgebra);
  const geometry = halve(rawGeometry);
  const mathTotal =
    rawMathTotal !== null
      ? halve(rawMathTotal)
      : algebra !== null && geometry !== null
      ? Math.round((algebra + geometry) * 100) / 100
      : null;
  const science = halve(rawScience);
  const religion = halve(rawReligion);
  const art = halve(rawArt);
  const computer = halve(rawComputer);

  // المجموع المحسوب
  const computedTotal = [ar, en, studies, mathTotal, science]
    .filter((v) => v !== null)
    .reduce((a, b) => a + b, 0);
  const finalTotal =
    total !== null && total > 0
      ? total
      : computedTotal > 0
      ? Math.round(computedTotal * 100) / 100
      : 0;

  if (finalTotal === 0 && !name) return null;

  return {
    mapped: {
      student_name: name,
      seat_no: seat,
      grade_name: "الثالث الإعدادي",
      school_name: cleanNatiga4dkText(schoolMatch ? schoolMatch[1] : ""),
      admin_name: cleanNatiga4dkText(adminMatch ? adminMatch[1] : ""),
      total: finalTotal,
      percentage: null,
      grade,
      ar,
      en,
      studies,
      algebra,
      geometry,
      math_total: mathTotal,
      science,
      religion,
      art,
      computer,
      level1: null,
      level2: null,
    },
    source: "natiga4dk",
    endpoint: pageUrl,
    raw: html,
  };
}

// يقرأ جدول "درجات المواد" في natiga4dk
function parseNatiga4dkSubjectsTable(html) {
  const out = {};
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  if (tables.length < 2) return out;

  // نبحث عن الجدول الذي يحتوي على "درجات المواد"
  let target = null;
  for (const t of tables) {
    if (t.includes("درجات المواد") || t.includes("اللغة العربية")) {
      target = t;
      break;
    }
  }
  if (!target) target = tables[tables.length - 1];

  const rows = target.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [];
    if (cells.length < 2) continue;
    const cellText = (c) =>
      c
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    const subjectName = cellText(cells[0]);
    const scoreStr = cellText(cells[1]);
    // نتخطى صفوف العناوين ("أولاً مواد تُضاف للمجموع"، إلخ)
    if (!subjectName || !/[\d.]/.test(scoreStr)) continue;

    const key = mapSubjectNameToKey(subjectName);
    if (!key) continue;
    const score = parseFloat(scoreStr);
    if (Number.isFinite(score)) {
      out[key] = score;
    }
  }
  return out;
}

function cleanNatiga4dkText(s) {
  if (!s) return "";
  return s
    .replace(/عرض[^<]*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ───────────────────────────────────────────────────────────
// SOURCE 3 (last-resort): the official Dakahlia directorate site.
//   حالياً api_result.php بيرجع HTTP 500 + body فارغ — الموقع نفسه
//   بيقول "يتم عرض بيانات تجريبية للاختبار فقط". خليه آخر fallback
//   لأنه لو رجع لشغل، يكون هو المصدر الأكثر موثوقية.
// ───────────────────────────────────────────────────────────
async function fetchOfficial(seat) {
  const candidates = [
    `https://natiga.edudk.net/P20262026/public/api_result.php?seat=${seat}`,
    `https://natiga.edudk.net/P20262026/public/api/students/${seat}`,
  ];

  for (const apiUrl of candidates) {
    try {
      const r = await fetch(apiUrl, {
        headers: browserHeaders({
          Accept: "application/json",
          Referer: "https://natiga.edudk.net/P20262026/public/index.html",
        }),
        cf: { cacheTtl: 60, cacheEverything: true },
      });
      // 500 + body فارغ = الـ API مش شغال — نتخطى بسرعة
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
