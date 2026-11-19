/* Mahdek server: a small go-between from Mahdek (in the browser) to Claude.
   - Only someone whose GitHub key can open the PRIVATE repo may use it (Fouad's own key, already in Mahdek).
   - The Claude API key stays here as a secret (ANTHROPIC_API_KEY); it never reaches the browser.
   - Nothing is stored: each request is answered and forgotten. */

const CHECK_PROMPT = `זה מסמך הנהלת חשבונות ישראלי (חשבונית, קבלה, חשבון עסקה, דרישת תשלום וכדומה). קרא אותו וזהה:
- supplier: מי הוציא את המסמך (הספק). לא מי שהמסמך נשלח אליו ("לכבוד", "לקוח").
- id: מספר עוסק / ח.פ של הספק, 9 ספרות בלבד, או ריק.
- type: אחד מאלה בלבד: "חשבונית מס", "חשבונית מס קבלה", "קבלה", "חשבונית זיכוי", "חשבון עסקה", "דרישת תשלום", "אחר".
- number: מספר המסמך כפי שמודפס. number4: 4 הספרות האחרונות שלו.
- date: תאריך המסמך בפורמט YYYY-MM-DD, או ריק.
- total: הסכום הכולל לתשלום כמספר, או null.
- recipient: שם הלקוח שהמסמך נשלח אליו, או ריק.
- confidence: "high" / "medium" / "low" – כמה אתה בטוח בספק ובמספר.
- note: הערה קצרה בעברית אם משהו לא ברור, אחרת ריק.
אל תנחש. אם שדה לא קריא, השאר אותו ריק.
החזר JSON בלבד, בלי שום טקסט נוסף:
{"supplier":"","id":"","type":"","number":"","number4":"","date":"","total":null,"recipient":"","confidence":"","note":""}`;


const ROLES = {
  mail: 'מאיה, אחראית קליטת המיילים: קוראת וממיינת את המיילים, שומרת קבצים, מכירה את הלקוחות.',
  files: 'איתי, אחראי בדיקת הקבצים ומעבדת הזיהוי: בודק חשבוניות וקבלות, מזהה ספקים, ספר הספקים.',
  prep: 'יעל, אחראית ההכנה לפעולה: מה לעשות עם כל מייל, מה להדפיס, טיוטות תשובה.',
  reports: 'דנה, אחראית הדיווחים: מועדי מע"מ, מקדמות, ניכויים וביטוח לאומי, מה חסר מכל לקוח.',
  manager: 'נועם, מנהל המשרד: סדר היום של פואד, חלוקת עבודה בצוות, בדיקות מערכת.'
};
function askSystem(to) {
  return `אתה ${ROLES[to] || ROLES.files} אתה עובד במשרד של פואד, רואה חשבון בישראל, ועונה לו ישירות.
ענה בעברית, קצר, ברור ומעשי, כמו עובד מקצועי שמכיר את המשרד. השתמש רק בנתונים שקיבלת למטה. אם משהו לא מופיע בנתונים, אמור זאת בפשטות ואל תמציא שמות, סכומים או תאריכים.
אתה לא שולח מיילים, לא משלם ולא משנה כלום: אתה עונה, בודק, מסכם ומכין טיוטות.
אם הבקשה דורשת עבודה ארוכה (פתיחת קבצים, הרצת בדיקות, שינוי במהדק), כתוב מה מצאת מהנתונים, וסיים בשורה "להמשך בריצה המלאה: <מה בדיוק לעשות>".`;
}

const okTokens = new Map(); // token -> expiry (in this worker's memory only)

function cors(req, env) {
  const o = req.headers.get('Origin') || '';
  const allow = o === env.ALLOW_ORIGIN || /^http:\/\/localhost(:\d+)?$/.test(o) ? o : env.ALLOW_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Mime',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
const json = (obj, status, h) => new Response(JSON.stringify(obj), { status: status || 200, headers: { ...h, 'Content-Type': 'application/json; charset=utf-8' } });

async function allowed(auth, env) {
  const t = auth.slice(7);
  const exp = okTokens.get(t);
  if (exp && exp > Date.now()) return true;
  const r = await fetch(`https://api.github.com/repos/${env.REPO}`, {
    headers: { Authorization: 'Bearer ' + t, Accept: 'application/vnd.github+json', 'User-Agent': 'mahdek-api', 'X-GitHub-Api-Version': '2022-11-28' }
  });
  if (r.status !== 200) return false;
  const j = await r.json();
  if (!j || j.private !== true || j.full_name !== env.REPO) return false;
  okTokens.set(t, Date.now() + 10 * 60 * 1000);
  return true;
}

export default {
  async fetch(req, env) {
    const h = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/') return json({ ok: true, name: 'mahdek-api', model: env.MODEL, ready: !!env.ANTHROPIC_API_KEY }, 200, h);
    if (req.method !== 'POST' || (url.pathname !== '/check' && url.pathname !== '/ask')) return json({ error: 'not_found' }, 404, h);

    const auth = req.headers.get('Authorization') || '';
    if (!/^Bearer [A-Za-z0-9_\-]{20,}$/.test(auth)) return json({ error: 'auth' }, 401, h);
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'no_key' }, 503, h);
    if (!(await allowed(auth, env))) return json({ error: 'auth' }, 401, h);

    if (url.pathname === '/ask') {
      let q = null; try { q = await req.json(); } catch (_) { q = null; }
      if (!q || typeof q.text !== 'string' || !q.text.trim() || q.text.length > 3000) return json({ error: 'bad_data' }, 400, h);
      const ctx = typeof q.context === 'string' ? q.context.slice(0, 60000) : '';
      const msg = `הנתונים של המשרד (מהמאגר הפרטי, היום ${String(q.day || '').slice(0, 10)}):\n${ctx}\n\nהבקשה של פואד:\n${q.text}`;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: env.ASK_MODEL || 'claude-haiku-5-5', max_tokens: 1200, system: askSystem(q.to), messages: [{ role: 'user', content: msg }] })
      });
      if (!r.ok) return json({ error: 'claude', status: r.status, detail: (await r.text()).slice(0, 300) }, 502, h);
      const j = await r.json();
      const answer = (j.content || []).map(c => c.text || '').join('').trim();
      return json({ answer, model: j.model, usage: j.usage }, 200, h);
    }
    const mime = req.headers.get('X-Mime') || '';
    if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(mime)) return json({ error: 'type' }, 415, h);
    const len = Number(req.headers.get('Content-Length') || 0);
    if (len > 7000000) return json({ error: 'too_big' }, 413, h);
    const b64 = await req.text();
    if (!b64 || b64.length > 7000000 || b64.indexOf('"') !== -1 || b64.indexOf('\\') !== -1) return json({ error: 'bad_data' }, 400, h);

    const block = mime === 'application/pdf'
      ? `{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"${b64}"}}`
      : `{"type":"image","source":{"type":"base64","media_type":"${mime}","data":"${b64}"}}`;
    const body = `{"model":${JSON.stringify(env.MODEL)},"max_tokens":600,"messages":[{"role":"user","content":[${block},{"type":"text","text":${JSON.stringify(CHECK_PROMPT)}}]}]}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      return json({ error: 'claude', status: r.status, detail }, 502, h);
    }
    const j = await r.json();
    const text = (j.content || []).map(c => c.text || '').join('');
    let result = null;
    try { const m = text.match(/\{[\s\S]*\}/); result = m ? JSON.parse(m[0]) : null; } catch (_) { result = null; }
    if (!result) return json({ error: 'parse', text: text.slice(0, 300) }, 502, h);
    return json({ result, model: j.model, usage: j.usage }, 200, h);
  }
};
