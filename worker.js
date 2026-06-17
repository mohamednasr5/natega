/**
 * Cloudflare Worker — نتيجة الشهادة الإعدادية الدقهلية 2026
 * Multi-source fallback: Official → nezakr → natiga4dk
 * يتوافق مع index.html (snake_case fields, total/280)
 */

export default {
  async fetch(request) {

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }

    const url  = new URL(request.url);
    const seat = (url.searchParams.get('seat') || '').trim();

    if (!seat || !/^\d+$/.test(seat)) {
      return Response.json(
        { ok: false, msg: 'رقم الجلوس غير صحيح' },
        { status: 400, headers: cors() }
      );
    }

    // ── شغّل المصادر الـ 3 بالتوازي ──────────────────────────
    const [r1, r2, r3] = await Promise.allSettled([
      source_official(seat),
      source_nezakr(seat),
      source_natiga4dk(seat),
    ]);

    const all = [r1, r2, r3];

    for (const r of all) {
      if (r.status === 'fulfilled' && r.value?.ok) {
        const { source, data } = r.value;
        return Response.json(
          { ok: true, source, data },
          { headers: cors() }
        );
      }
    }

    // كل المصادر فشلت
    return Response.json(
      {
        ok: false,
        msg: 'السيرفر تحت ضغط — حاول مرة أخرى',
        errors: all.map((r, i) => ({
          source : ['official','nezakr','natiga4dk'][i],
          reason : r.status === 'rejected'
                    ? r.reason?.message
                    : r.value?.msg,
        })),
      },
      { status: 503, headers: cors() }
    );
  }
};

/* ═══════════════════════════════════════════════════════════
   المصدر 1 — الموقع الرسمي  POST → JSON
   ══════════════════════════════════════════════════════════ */
async function source_official(seat) {
  const BASE = 'https://natiga.edudk.net/P20262026/public';

  const res = await timeout_fetch(`${BASE}/api_result.php`, {
    method : 'POST',
    headers: {
      'Content-Type'     : 'application/x-www-form-urlencoded',
      'Referer'          : `${BASE}/index.html`,
      'Origin'           : 'https://natiga.edudk.net',
      'X-Requested-With' : 'XMLHttpRequest',
      'User-Agent'       : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125',
    },
    body: `seat=${encodeURIComponent(seat)}`,
  }, 8000);

  const json = await res.json();
  if (!json.ok) throw new Error(json.msg || 'رقم الجلوس غير صحيح');

  // الـ API الرسمي بيرجع total من 140 (ترم واحد)
  // الـ index.html بيعرض /280 — نضاعف لو المجموع <= 140
  const d    = json.data;
  const norm = normalizeOfficial(d);

  return { ok: true, source: 'official', data: norm };
}

function normalizeOfficial(d) {
  const half = Number(d.total) || 0;
  return {
    seat_no      : String(d.seat_no   || ''),
    student_name : String(d.student_name || ''),
    grade_name   : String(d.grade_name   || 'الثالث الإعدادي'),
    school_name  : String(d.school_name  || ''),
    admin_name   : String(d.admin_name   || ''),
    // درجات (ترم 2 فقط — المجموع الكلي 280 بعد جمع الترمين)
    ar         : num(d.ar),
    en         : num(d.en),
    studies    : num(d.studies),
    algebra    : num(d.algebra),
    geometry   : num(d.geometry),
    math_total : num(d.math_total),
    science    : num(d.science),
    religion   : num(d.religion),
    art        : num(d.art),
    computer   : num(d.computer),
    level1     : d.level1 != null ? num(d.level1) : null,
    level2     : d.level2 != null ? num(d.level2) : null,
    // total: الـ index.html بيعرض /280
    // لو الـ API بعت مجموع الترم الثاني فقط (140) — نحتاج المجموع الكلي
    // في المرحلة دي بنبعت الـ total كما هو والـ UI هيعرضه على /280
    total      : half,
  };
}

/* ═══════════════════════════════════════════════════════════
   المصدر 2 — نذاكر  GET → HTML scraping
   ══════════════════════════════════════════════════════════ */
async function source_nezakr(seat) {
  const res = await timeout_fetch(
    `https://natiga.nezakr.net/dakahlia/seat/${seat}/`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125',
        'Accept'    : 'text/html,application/xhtml+xml',
        'Referer'   : 'https://natiga.nezakr.net/dakahlia/',
      }
    }, 9000
  );

  const html = await res.text();

  if (
    html.includes('ضغط شديد') ||
    html.includes('لم تكتمل')  ||
    html.includes('أعد المحاولة')
  ) throw new Error('nezakr: ضغط شديد');

  const data = scrape_nezakr(html, seat);
  if (!data) throw new Error('nezakr: لا توجد بيانات');

  return { ok: true, source: 'nezakr', data };
}

function scrape_nezakr(html, seat) {
  // نذاكر بيعرض البيانات في meta tags + structured divs
  const name   = meta(html, 'student_name') || between(html, 'class="student-name">', '<');
  const school = meta(html, 'school_name')  || between(html, 'class="school-name">',  '<');
  const admin  = meta(html, 'admin_name')   || between(html, 'class="admin-name">',   '<');
  const total  = meta(html, 'total_score')  || between(html, 'class="total-score">',  '<');

  if (!name) return null;

  return {
    seat_no      : seat,
    student_name : clean(name),
    grade_name   : 'الثالث الإعدادي',
    school_name  : clean(school || ''),
    admin_name   : clean(admin  || ''),
    total        : Number(clean(total || '0')) || 0,
    ar: 0, en: 0, studies: 0,
    algebra: 0, geometry: 0, math_total: 0,
    science: 0, religion: 0, art: 0, computer: 0,
    level1: null, level2: null,
  };
}

/* ═══════════════════════════════════════════════════════════
   المصدر 3 — natiga4dk  Next.js _next/data → JSON
   ══════════════════════════════════════════════════════════ */
async function source_natiga4dk(seat) {
  // جيب الـ buildId أول
  const home = await timeout_fetch('https://www.natiga4dk.net/', {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/125' }
  }, 6000);

  const homeHtml  = await home.text();
  const buildMatch = homeHtml.match(/"buildId"\s*:\s*"([^"]+)"/);
  if (!buildMatch) throw new Error('natiga4dk: buildId not found');

  const buildId = buildMatch[1];

  const dataRes = await timeout_fetch(
    `https://www.natiga4dk.net/_next/data/${buildId}/dakahlia/seat/${seat}.json`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 Chrome/125',
        'Accept'    : 'application/json',
        'Referer'   : `https://www.natiga4dk.net/dakahlia/seat/${seat}`,
      }
    }, 8000
  );

  if (!dataRes.ok) throw new Error(`natiga4dk: HTTP ${dataRes.status}`);

  const json = await dataRes.json();

  const s = json?.pageProps?.student
         || json?.pageProps?.result
         || json?.pageProps?.data;

  if (!s) throw new Error('natiga4dk: no student in pageProps');

  return {
    ok: true,
    source: 'natiga4dk',
    data: {
      seat_no      : String(seat),
      student_name : s.student_name || s.name   || '',
      grade_name   : s.grade_name   || s.grade  || 'الثالث الإعدادي',
      school_name  : s.school_name  || s.school || '',
      admin_name   : s.admin_name   || s.admin  || '',
      total        : num(s.total  || s.score),
      ar           : num(s.ar     || s.arabic),
      en           : num(s.en     || s.english),
      studies      : num(s.studies),
      algebra      : num(s.algebra),
      geometry     : num(s.geometry),
      math_total   : num(s.math_total || s.math),
      science      : num(s.science),
      religion     : num(s.religion),
      art          : num(s.art),
      computer     : num(s.computer),
      level1       : s.level1 != null ? num(s.level1) : null,
      level2       : s.level2 != null ? num(s.level2) : null,
    }
  };
}

/* ═══════════════════════════════════════════════════════════
   Utility Functions
   ══════════════════════════════════════════════════════════ */
async function timeout_fetch(url, options = {}, ms = 8000) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      ...options,
      signal: ctrl.signal,
      cache : 'no-store',
    });
  } finally {
    clearTimeout(timer);
  }
}

function between(str, start, end) {
  if (!str) return null;
  const i = str.indexOf(start);
  if (i === -1) return null;
  const j = str.indexOf(end, i + start.length);
  if (j === -1) return null;
  return str.slice(i + start.length, j);
}

function meta(html, name) {
  const m = html.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`));
  return m ? m[1] : null;
}

function clean(str) {
  if (!str) return '';
  return str.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').trim();
}

function num(v) {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function cors() {
  return {
    'Access-Control-Allow-Origin' : '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type'                : 'application/json; charset=UTF-8',
  };
}