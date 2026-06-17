export default {
  async fetch(request) {
    const url = new URL(request.url);
    const seat = url.searchParams.get("seat");

    if (url.pathname === "/search" && seat) {
      const result = await searchAllSites(seat);
      return new Response(buildHTML(seat, result), {
        headers: { "Content-Type": "text/html;charset=UTF-8" },
      });
    }

    return new Response(buildHTML("", null), {
      headers: { "Content-Type": "text/html;charset=UTF-8" },
    });
  },
};

async function searchAllSites(seat) {
  const sites = [
    { name: "مديرية التربية والتعليم بالدقهلية (الرسمي)", fn: () => fetchOfficial(seat) },
    { name: "موقع نذاكر", fn: () => fetchNezakr(seat) },
    { name: "موقع natiga4dk", fn: () => fetchNatiga4dk(seat) },
  ];

  for (const site of sites) {
    try {
      const res = await site.fn();
      if (res && res.found) {
        res.source = site.name;
        return res;
      }
    } catch (e) {
      continue;
    }
  }

  return { found: false };
}

async function fetchOfficial(seat) {
  const r = await fetch(`https://natiga.edudk.net/P20262026/public/api/students/${seat}`, {
    headers: {
      Accept: "application/json",
      Referer: "https://natiga.edudk.net/P20262026/public/index.html",
      "User-Agent": "Mozilla/5.0",
    },
  });
  if (!r.ok) return { found: false };
  const text = await r.text();
  if (!text || text.trim() === "") return { found: false };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { found: false };
  }
  if (!data || (!data.name && !data.student_name && !data.ar_name)) return { found: false };
  return {
    found: true,
    name: data.name || data.student_name || data.ar_name || "—",
    seat,
    total: data.total || data.sum || data.degree || "—",
    outOf: data.out_of || data.max || data.total_mark || "—",
    percentage: data.percentage || data.percent || "—",
    grade: data.grade || data.result || data.taqdir || "—",
    school: data.school || data.school_name || data.ar_school || "—",
    admin: data.admin || data.admin_name || data.ar_admin || "—",
    term: data.term || data.semester || "—",
    year: data.year || "2025/2026",
    subjects: data.subjects || data.marks || [],
  };
}

async function fetchNezakr(seat) {
  const pageUrl = `https://natiga.nezakr.net/dakahlia/num/${seat}/`;
  const r = await fetch(pageUrl, {
    headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" },
  });
  if (!r.ok) return { found: false };
  const html = await r.text();
  if (html.includes("لم يتم العثور") || html.includes("غير موجود")) return { found: false };

  const nameMatch =
    html.match(/class="[^"]*student[^"]*"[^>]*>\s*([^<]{5,80})/i) ||
    html.match(/<h[123][^>]*>\s*([^\u0000-\u007F][^<]{4,79})\s*<\/h[123]>/i);
  const name = nameMatch ? nameMatch[1].trim() : null;
  if (!name || name.includes("نذاكر") || name.includes("نتيجة")) return { found: false };

  const totalMatch = html.match(/(\d+)\s*\/\s*(\d+)/);
  const percentMatch = html.match(/(\d+(?:\.\d+)?)\s*%/);
  const gradeMatch = html.match(/ممتاز|جيد جداً|جيد|مقبول|راسب|ضعيف/);

  return {
    found: true,
    name,
    seat,
    total: totalMatch ? totalMatch[1] : "—",
    outOf: totalMatch ? totalMatch[2] : "—",
    percentage: percentMatch ? percentMatch[1] + "%" : "—",
    grade: gradeMatch ? gradeMatch[0] : "—",
    school: extractBetween(html, "المدرسة") || "—",
    admin: extractBetween(html, "الإدارة") || "—",
    term: extractBetween(html, "الفصل") || "—",
    year: "2025/2026",
    subjects: [],
  };
}

async function fetchNatiga4dk(seat) {
  const r = await fetch(`https://www.natiga4dk.com/dakahlia/seat/${seat}/`, {
    headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" },
  });
  if (!r.ok) return { found: false };
  const html = await r.text();
  if (html.includes("غير موجودة") || html.includes("404")) return { found: false };

  const nameMatch = html.match(/<h[123][^>]*>\s*([^\u0000-\u007F][^<]{4,79})\s*<\/h[123]>/i);
  const name = nameMatch ? nameMatch[1].trim() : null;
  if (!name) return { found: false };

  const totalMatch = html.match(/(\d+)\s*\/\s*(\d+)/);
  const percentMatch = html.match(/(\d+(?:\.\d+)?)\s*%/);
  const gradeMatch = html.match(/ممتاز|جيد جداً|جيد|مقبول|راسب|ضعيف/);

  return {
    found: true,
    name,
    seat,
    total: totalMatch ? totalMatch[1] : "—",
    outOf: totalMatch ? totalMatch[2] : "—",
    percentage: percentMatch ? percentMatch[1] + "%" : "—",
    grade: gradeMatch ? gradeMatch[0] : "—",
    school: "—",
    admin: "—",
    term: "—",
    year: "2025/2026",
    subjects: [],
  };
}

function extractBetween(html, label) {
  const idx = html.indexOf(label);
  if (idx === -1) return null;
  const after = html.slice(idx + label.length, idx + label.length + 200);
  const m = after.match(/>\s*([^\u0000-\u007F][^<]{1,60})\s*</);
  return m ? m[1].trim() : null;
}

function escapeHTML(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function gradeColor(g) {
  if (!g || g === "—") return "#6b7280";
  if (g.includes("ممتاز")) return "#16a34a";
  if (g.includes("جيد جداً")) return "#2563eb";
  if (g.includes("جيد")) return "#7c3aed";
  if (g.includes("مقبول")) return "#d97706";
  return "#dc2626";
}

function subjectsTable(subjects) {
  if (!subjects || subjects.length === 0) return "";
  const rows = subjects
    .map((s) => {
      const grade = s.grade || s.taqdir || "—";
      return `
    <tr>
      <td>${escapeHTML(s.name || s.subject || s.ar_name || "—")}</td>
      <td><strong>${escapeHTML(s.degree || s.mark || s.score || "—")}</strong></td>
      <td>${escapeHTML(s.out_of || s.max || s.full_mark || "—")}</td>
      <td style="color:${gradeColor(grade)}">${escapeHTML(grade)}</td>
    </tr>`;
    })
    .join("");
  return `
    <div class="subjects-card">
      <h3>📋 درجات المواد</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>المادة</th><th>الدرجة</th><th>من</th><th>التقدير</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function buildHTML(seat, result) {
  const resultSection =
    result === null
      ? ""
      : result.found
      ? `<div class="result-card">
        <div class="student-name">${escapeHTML(result.name)}</div>
        <span class="badge" style="background:${gradeColor(result.grade)}">${escapeHTML(result.grade)}</span>
        <div class="stats">
          <div class="stat"><div class="val">${escapeHTML(result.total)}/${escapeHTML(result.outOf)}</div><div class="lbl">المجموع</div></div>
          <div class="stat"><div class="val">${escapeHTML(result.percentage)}</div><div class="lbl">النسبة</div></div>
          <div class="stat"><div class="val">${escapeHTML(result.year)}</div><div class="lbl">العام الدراسي</div></div>
        </div>
        <div class="info-grid">
          <div class="info-item"><span class="info-lbl">🏫 المدرسة</span><span>${escapeHTML(result.school)}</span></div>
          <div class="info-item"><span class="info-lbl">🏛️ الإدارة</span><span>${escapeHTML(result.admin)}</span></div>
          <div class="info-item"><span class="info-lbl">📅 الفصل</span><span>${escapeHTML(result.term)}</span></div>
          <div class="info-item"><span class="info-lbl">🔢 رقم الجلوس</span><span>${escapeHTML(result.seat)}</span></div>
        </div>
        ${subjectsTable(result.subjects)}
        <div class="source-tag">✅ المصدر: ${escapeHTML(result.source)}</div>
      </div>`
      : `<div class="error-card">❌ لم يتم العثور على نتيجة لرقم الجلوس: <strong>${escapeHTML(seat)}</strong><br>تأكد من الرقم أو انتظر ظهور النتيجة الرسمية.</div>`;

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>نتيجة الشهادة الإعدادية - الدقهلية 2026</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:linear-gradient(135deg,#1e3a5f,#2d6a9f);min-height:100vh;padding:20px;color:#333}
.container{max-width:700px;margin:0 auto}
.header{text-align:center;color:#fff;margin-bottom:30px}
.header h1{font-size:1.8rem;margin-bottom:8px}
.header p{opacity:.85;font-size:.95rem}
.search-card{background:#fff;border-radius:16px;padding:30px;box-shadow:0 8px 32px rgba(0,0,0,.15);margin-bottom:24px}
.search-card h2{margin-bottom:20px;color:#1e3a5f;font-size:1.2rem}
.input-row{display:flex;gap:10px}
input[type=text]{flex:1;padding:14px 18px;border:2px solid #e5e7eb;border-radius:10px;font-size:1rem;direction:ltr;text-align:center;transition:.2s}
input[type=text]:focus{outline:none;border-color:#2d6a9f}
button{padding:14px 28px;background:linear-gradient(135deg,#1e3a5f,#2d6a9f);color:#fff;border:none;border-radius:10px;font-size:1rem;cursor:pointer;font-weight:bold;transition:.2s}
button:hover{opacity:.9;transform:translateY(-1px)}
.result-card{background:#fff;border-radius:16px;padding:30px;box-shadow:0 8px 32px rgba(0,0,0,.15);margin-top:24px;text-align:center}
.student-name{font-size:1.6rem;font-weight:bold;color:#1e3a5f;margin-bottom:12px}
.badge{display:inline-block;color:#fff;padding:6px 20px;border-radius:20px;font-size:1rem;font-weight:bold;margin-bottom:20px}
.stats{display:flex;gap:16px;justify-content:center;margin-bottom:24px;flex-wrap:wrap}
.stat{background:#f0f4ff;border-radius:12px;padding:16px 24px;min-width:130px}
.val{font-size:1.4rem;font-weight:bold;color:#1e3a5f}
.lbl{font-size:.8rem;color:#6b7280;margin-top:4px}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;text-align:right;margin-bottom:20px}
.info-item{background:#f9fafb;border-radius:10px;padding:12px 16px;display:flex;flex-direction:column;gap:4px}
.info-lbl{font-size:.8rem;color:#6b7280}
.subjects-card{background:#f9fafb;border-radius:12px;padding:20px;margin-top:20px;text-align:right}
.subjects-card h3{margin-bottom:14px;color:#1e3a5f}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th{background:#1e3a5f;color:#fff;padding:10px;text-align:center}
td{padding:9px 10px;text-align:center;border-bottom:1px solid #e5e7eb}
tr:hover td{background:#f0f4ff}
.source-tag{margin-top:16px;font-size:.8rem;color:#6b7280;background:#f0f4ff;display:inline-block;padding:4px 12px;border-radius:20px}
.error-card{background:#fff;border-radius:16px;padding:30px;box-shadow:0 8px 32px rgba(0,0,0,.15);margin-top:24px;text-align:center;color:#dc2626;font-size:1.1rem;line-height:1.8}
footer{text-align:center;color:#fff;opacity:.7;font-size:.8rem;margin-top:30px}
@media(max-width:480px){.info-grid{grid-template-columns:1fr}.stats{gap:10px}.stat{padding:12px 16px;min-width:100px}}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>📜 نتيجة الشهادة الإعدادية</h1>
    <p>محافظة الدقهلية - العام الدراسي 2025/2026</p>
  </div>

  <div class="search-card">
    <h2>🔍 ابحث برقم الجلوس</h2>
    <form method="GET" action="/search">
      <div class="input-row">
        <input type="text" name="seat" placeholder="أدخل رقم الجلوس" value="${escapeHTML(seat)}" required pattern="\\d+" inputmode="numeric" maxlength="10">
        <button type="submit">بحث</button>
      </div>
    </form>
  </div>

  ${resultSection}

  <footer>هذه الخدمة تجمع النتائج من مصادر متعددة لتسهيل الوصول إليها، ويُنصح دائمًا بالتأكد من الموقع الرسمي.</footer>
</div>
</body>
</html>`;
}
