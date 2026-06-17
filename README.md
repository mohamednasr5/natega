# 🎓 نتيجة الطالب — Student Result Viewer

تطبيق ويب متجاوب للاستعلام عن نتائج الامتحانات من موقع `natiga.edudk.net`.

## المميزات
- 📱 متوافق مع الجوال بالكامل (Mobile-first)
- 🔍 بحث برقم الجلوس
- 🖼️ تحميل النتيجة كصورة PNG
- 📄 تحميل النتيجة كـ PDF
- 💬 مشاركة النتيجة على واتساب كنص منسق
- 🌙 تصميم داكن أنيق

## النشر على GitHub Pages

1. ارفع الملفات على مستودع GitHub
2. اذهب إلى **Settings → Pages**
3. اختر `main` branch و `/root`
4. سيكون الرابط: `https://username.github.io/repo-name`

## إعداد Cloudflare Worker (اختياري)

لتجنب مشاكل CORS، أنشئ Cloudflare Worker بالكود التالي:

```javascript
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const seat = url.searchParams.get('seat');

    if (!seat || !/^\d+$/.test(seat)) {
      return Response.json({ ok: false, msg: 'رقم جلوس غير صحيح' }, { status: 400 });
    }

    const apiUrl = `https://natiga.edudk.net/P20262026/public/api_result.php?seat=${seat}`;

    const res = await fetch(apiUrl, {
      headers: {
        'Referer': 'https://natiga.edudk.net/P20262026/public/index.html',
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      },
      cf: { cacheTtl: 300 }
    });

    const data = await res.json();

    return Response.json(data, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      }
    });
  }
};
```

بعد النشر، غيّر في `index.html`:
```javascript
const WORKER_URL = 'https://your-worker.workers.dev';
```

## الملفات
- `index.html` — التطبيق الرئيسي
- `manifest.json` — إعدادات PWA
