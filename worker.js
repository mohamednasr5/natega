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

      const data = finalizeMappedResult(result.mapped);

      if (debug) {
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

async function searchAllSites(seat) {
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
    result_status: null,
    term_name: null,
    is_old_result: false,
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

function normalizeArabicText(s) {
  if (!s) return "";
  return String(s)
    .replace(/أ|إ|آ/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeGradeText(grade) {
  if (!grade) return null;
  const g = normalizeArabicText(grade);

  if (g.includes("ممتاز")) return "ممتاز";
  if (g.includes("جيد جدا")) return "جيد جدًا";
  if (g === "جيد" || g.includes(" جيد ")) return "جيد";
  if (g.includes("مقبول")) return "مقبول";
  if (g.includes("ضعيف")) return "ضعيف";
  if (g.includes("راسب")) return "راسب";

  return grade.trim();
}

function parsePercentage(value) {
  if (value === null || value === undefined || value === "") return null;
  const m = String(value).match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}

function deriveGradeFromPercentage(percentage) {
  const p = Number(percentage);
  if (!Number.isFinite(p)) return null;
  if (p >= 85) return "ممتاز";
  if (p >= 75) return "جيد جدًا";
  if (p >= 65) return "جيد";
  if (p >= 50) return "مقبول";
  return "ضعيف";
}

function deriveStatus({ grade, percentage, total, maxTotal = 140 }) {
  const g = normalizeArabicText(grade || "");

  if (g.includes("راسب")) return "راسب";
  if (g.includes("ممتاز") || g.includes("جيد") || g.includes("مقبول")) return "ناجح";

  const p = parsePercentage(percentage);
  if (p !== null) return p >= 50 ? "ناجح" : "راسب";

  const t = Number(total);
  if (Number.isFinite(t)) return t >= maxTotal / 2 ? "ناجح" : "راسب";

  return null;
}

function finalizeMappedResult(mapped) {
  const out = { ...mapped };

  const p = parsePercentage(out.percentage);
  if (p !== null) {
    out.percentage = `${p}%`;
  }

  out.grade = normalizeGradeText(out.grade) || deriveGradeFromPercentage(p);
  out.result_status = out.result_status || deriveStatus({
    grade: out.grade,
    percentage: out.percentage,
    total: out.total,
    maxTotal: 140,
  });

  return out;
}

async function fetchNezakr(seat) {
  const pageUrl = `https://natiga.nezakr.net/dakahlia/num/${seat}/`;
  const r = await fetch(pageUrl, {
    headers: browserHeaders({ Referer: "https://natiga.nezakr.net/" }),
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!r.ok) return null;

  const html = await r.text();

  if (
    html.includes("لم يتم العثور") ||
    html.includes("غير موجود") ||
    html.includes("لم نستطع العثور")
  ) {
    return null;
  }

  const titleMatch = html.match(/<title>\s*نتيجة الطالب\s+(.+?)\s+بالشهادة/);
  let name = titleMatch ? titleMatch[1].trim() : "";

  if (!name) {
    const m = html.match(/نتيجة الطالب\s+(.+?)\s+بالشهادة/);
    if (m) name = m[1].trim();
  }

  if (!name) return null;
  if (name.includes("نذاكر") || name.includes("موقع")) return null;

  const metaMatch =
    html.match(/<meta\s+name="description"\s+content="([^"]+)"/) ||
    html.match(/<meta\s+content="([^"]+)"\s+name="description"/);
  const meta = metaMatch ? metaMatch[1] : "";

  const schoolMatch = meta.match(/المقيد بمدرسة\s+([^,،]+)/);
  const adminMatch = meta.match(/بإدارة\s+([^,،]+?)(?:\s+وقد|\s+و\s+قد|,|،|$)/);
  const totalMatch = meta.match(/مجموع\s+([\d.]+)\s*درجة\s*من\s*([\d.]+)\s*درجة/);
  const total = totalMatch ? parseFloat(totalMatch[1]) : null;

  const pctMatch =
    html.match(/####\s*([\d.]+)%\s*[\s\S]{0,120}?النسبة المئوية/) ||
    html.match(/بلغت النسبة المئوية[^()]*\(([\d.]+)%\)/) ||
    html.match(/النسبة المئوية[^()]{0,40}\(\s*([\d.]+)\s*%\s*\)/);
  const percentage = pctMatch ? `${pctMatch[1]}%` : null;

  const gradeBlockMatch =
    html.match(/####\s*(ممتاز|جيد جداً|جيد جدًا|جيد|مقبول|راسب|ضعيف)\s*[\s\S]{0,120}?التقدير العام/) ||
    html.match(/التقدير العام[:\s]+(?:<\/[^>]+>\s*)*(ممتاز|جيد جداً|جيد جدًا|جيد|مقبول|راسب|ضعيف)/) ||
    html.match(/تقدير\s+(ممتاز|جيد جداً|جيد جدًا|جيد|مقبول|راسب|ضعيف)/);
  const grade = gradeBlockMatch ? normalizeGradeText(gradeBlockMatch[1]) : null;

  const termMatch = html.match(/الفصل الدراسي:\s*[\s\S]{0,80}?(الفصل الدراسي الأول|الفصل الدراسي الثاني)/);
  const termName = termMatch ? termMatch[1].trim() : null;

  const oldResultFlag = /هذه النتيجة قديمة تخص الفصل الدراسي الأول 2026/.test(html);

  const subjects = parseNezakrSubjectsTable(html);

  if (total === null && Object.keys(subjects).length === 0) {
    return null;
  }

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

  const computedTotal = [ar, en, studies, mathTotal, science]
    .filter((v) => v !== null)
    .reduce((a, b) => a + b, 0);

  const finalTotal =
    total !== null ? total : computedTotal > 0 ? computedTotal : 0;

  const result_status = deriveStatus({
    grade,
    percentage,
    total: finalTotal,
    maxTotal: 140,
  });

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
      result_status,
      term_name: termName,
      is_old_result: oldResultFlag,
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
      level1: termName === "الفصل الدراسي الأول" ? finalTotal : null,
      level2: termName === "الفصل الدراسي الثاني" ? finalTotal : null,
    },
    source: "nezakr",
    endpoint: pageUrl,
    raw: html,
  };
}

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
    const scoreStr = cellText(cells[1]);
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
  if (name.includes("اللغة العربية") || name.includes("اللغه العربية")) return "ar";
  if (
    name.includes("اللغة الانجليزية") ||
    name.includes("اللغه الانجليزية") ||
    name.includes("اللغة الإنجليزية") ||
    name.includes("اللغه الإنجليزية")
  ) return "en";
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

async function fetchNatiga4dk(seat) {
  const pageUrl = `https://www.natiga4dk.com/dakahlia/?type=num&k=${seat}`;
  const r = await fetch(pageUrl, {
    headers: browserHeaders({ Referer: "https://www.natiga4dk.com/dakahlia/" }),
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!r.ok) return null;

  const html = await r.text();

  if (
    html.includes("رقم الجلوس الذي أدخلته خاطئ") ||
    html.includes("النتيجة لم تظهر بعد") ||
    html.includes("غير موجودة") ||
    html.includes("404")
  ) {
    return null;
  }

  const titleMatch = html.match(/<title>\s*نتيجة الطالب\s+(.+?)\s+بالشهادة/);
  const name = titleMatch ? titleMatch[1].trim() : "";
  if (!name) return null;

  const totalMatch =
    html.match(/المجموع الكلي[^<>]*?<\/td>\s*<td[^>]*>([^<]+)/i) ||
    html.match(/المجموع الكلي[\s:]*([\d.]+)/);
  const total = totalMatch ? parseFloat(totalMatch[1]) : null;

  const schoolMatch = html.match(/المدرسة[^<>]*?<\/td>\s*<td[^>]*>([^<]+)/i);
  const adminMatch = html.match(/الإدارة التعليمية[^<>]*?<\/td>\s*<td[^>]*>([^<]+)/i);
  const statusMatch = html.match(/حالة الطالب[^<>]*?<\/td>\s*<td[^>]*>([^<]+)/i);
  const percentageMatch = html.match(/النسبة المئوية[^<>]*?<\/td>\s*<td[^>]*>([^<]+)/i);

  const grade = statusMatch ? normalizeGradeText(statusMatch[1].trim()) : null;
  const percentage = percentageMatch ? `${parsePercentage(percentageMatch[1])}%` : null;

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

  const halve = (v) => (v !== null ? Math.round((v / 2) * 100) / 100 : null);
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

  const computedTotal = [ar, en, studies, mathTotal, science]
    .filter((v) => v !== null)
    .reduce((a, b) => a + b, 0);

  const finalTotal =
    total !== null && total > 0
      ? total
      : computedTotal > 0
      ? Math.round(computedTotal * 100) / 100
      : 0;

  const result_status = deriveStatus({
    grade,
    percentage,
    total: finalTotal,
    maxTotal: 140,
  });

  return {
    mapped: {
      student_name: name,
      seat_no: seat,
      grade_name: "الثالث الإعدادي",
      school_name: cleanNatiga4dkText(schoolMatch ? schoolMatch[1] : ""),
      admin_name: cleanNatiga4dkText(adminMatch ? adminMatch[1] : ""),
      total: finalTotal,
      percentage,
      grade,
      result_status,
      term_name: null,
      is_old_result: false,
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

function parseNatiga4dkSubjectsTable(html) {
  const out = {};
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  if (tables.length < 2) return out;

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
  return s.replace(/عرض[^<]*$/g, "").replace(/\s+/g, " ").trim();
}

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
        return { mapped: finalizeMappedResult(mapped), source: "official", endpoint: apiUrl, raw: text };
      }
    } catch (e) {
      continue;
    }
  }
  return null;
}

function mapOfficial(raw) {
  if (!raw) return null;
  const d = raw.data || raw.result || raw;
  const name = pick(d, ["student_name", "name", "ar_name"]);
  if (!name) return null;

  const algebra = numOr(pick(d, ["algebra"]), 0);
  const geometry = numOr(pick(d, ["geometry"]), 0);

  return {
    student_name: name,
    seat_no: pick(d, ["seat_no", "seat", "seat_number"]) ?? "",
    grade_name: pick(d, ["grade_name", "grade_name_ar", "stage"]) ?? "الثالث الإعدادي",
    school_name: pick(d, ["school_name", "school", "ar_school"]) ?? "",
    admin_name: pick(d, ["admin_name", "admin", "ar_admin"]) ?? "",
    total: numOr(pick(d, ["total", "sum", "degree"]), 0),
    percentage: pick(d, ["percentage", "percent"]) ?? null,
    grade: normalizeGradeText(pick(d, ["grade", "appreciation"])) ?? null,
    result_status: pick(d, ["result_status", "status", "student_status"]) ?? null,
    term_name: pick(d, ["term_name", "term"]) ?? null,
    is_old_result: false,
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
