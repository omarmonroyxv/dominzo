/* ============================================================
   DOMINZO - Servidor full-stack (cero dependencias externas)
   Node >= 22 (usa node:sqlite nativo). Arranca con: node server.js
   ============================================================ */
'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.DOMINZO_SECRET || 'dominzo-dev-secret-change-me';
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';        // sk_test_... o sk_live_...
const BASE_URL = process.env.BASE_URL || '';                    // ej. https://dominzo.onrender.com (opcional)
const PORKBUN_KEY = process.env.PORKBUN_API_KEY || '';         // pk1_...
const PORKBUN_SECRET = process.env.PORKBUN_SECRET_KEY || '';   // sk1_...
const REGISTRAR_ON = !!(PORKBUN_KEY && PORKBUN_SECRET);
const ROOT = __dirname;
const DB_PATH = process.env.DOMINZO_DB || path.join(ROOT, 'dominzo.db');

/* ---------------- DB ---------------- */
const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, email TEXT UNIQUE, pass TEXT, salt TEXT, created INTEGER
);
CREATE TABLE IF NOT EXISTS domains(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER, name TEXT, tld TEXT, price REAL, renew REAL,
  status TEXT DEFAULT 'active', ssl INTEGER DEFAULT 1, privacy INTEGER DEFAULT 1,
  registered INTEGER, expires INTEGER, visits INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER, total REAL, items TEXT, created INTEGER
);
`);

/* ---------------- Auth ---------------- */
function hashPass(pass, salt){ return crypto.pbkdf2Sync(pass, salt, 120000, 32, 'sha256').toString('hex'); }
function signToken(payload){
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(token){
  if(!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if(sig !== expect) return null;
  try{ const p = JSON.parse(Buffer.from(body,'base64url').toString()); if(p.exp && Date.now()>p.exp) return null; return p; }
  catch{ return null; }
}
function authUser(req){
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const p = verifyToken(token);
  if(!p) return null;
  return db.prepare('SELECT id,name,email,created FROM users WHERE id=?').get(p.uid) || null;
}

/* ---------------- Motor de dominios ---------------- */
const TLDS = [
  {tld:'.com',price:6.99,renew:8.99,tag:'best'},{tld:'.io',price:24.99,renew:24.99,tag:'hot'},
  {tld:'.ai',price:54.99,renew:54.99,tag:null},{tld:'.co',price:9.99,renew:11.99,tag:null},
  {tld:'.net',price:7.99,renew:9.99,tag:null},{tld:'.shop',price:3.99,renew:5.99,tag:null},
  {tld:'.store',price:3.49,renew:6.99,tag:null},{tld:'.dev',price:12.99,renew:12.99,tag:null},
  {tld:'.app',price:13.99,renew:13.99,tag:null},{tld:'.online',price:2.99,renew:8.99,tag:null},
  {tld:'.xyz',price:1.99,renew:3.99,tag:null},{tld:'.tech',price:4.99,renew:14.99,tag:null}
];
function hash(s){let h=0;for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))>>>0;return h;}
function isAvailable(name,tld){
  const h=hash(name.toLowerCase()+tld);
  const taken = tld==='.com'?0.55 : tld==='.io'?0.4 : tld==='.net'?0.45 : 0.25;
  return (h%100)/100 > taken;
}
function cleanName(raw){return String(raw||'').toLowerCase().trim().replace(/\s+/g,'').replace(/\.[a-z]+$/,'').replace(/[^a-z0-9-]/g,'');}
function parseTLD(raw){const m=String(raw||'').trim().toLowerCase().match(/(\.[a-z]+)$/);return m?m[1]:null;}
function searchDomains(query){
  const name=cleanName(query);
  if(!name) return {name:'',results:[]};
  const reqTLD=parseTLD(query);
  let list=[...TLDS];
  if(reqTLD) list.sort((a,b)=>(a.tld===reqTLD?-1:0)-(b.tld===reqTLD?-1:0));
  const results=list.map(t=>({name,tld:t.tld,price:t.price,renew:t.renew,tag:t.tag,available:isAvailable(name,t.tld)}));
  return {name,results};
}

/* ---------------- IA de naming ---------------- */
const AI={
  prefix:['nova','lumi','zen','volt','aura','flux','vibe','echo','orbit','sage','pulse','nest','peak','dawn','loop','bold','kite','mint','arco','vela'],
  suffix:['ly','io','hub','lab','ify','wave','base','spot','flow','kit','craft','works','go','now','app','byte'],
  themes:{
    cafe:['cafe','brew','bean','tostado','barra','grano','aroma','cup'],
    fitness:['fit','pulse','move','vigor','core','reps','flex','atleta'],
    ropa:['hilo','tela','moda','wear','estilo','trama','vesti'],
    finanzas:['capital','fondo','mone','finz','saldo','vault','cifra'],
    tech:['byte','data','cloud','code','logic','neuro','quantum','pixel'],
    choco:['cacao','dulce','choco','trufa','bombon','cocoa']
  }
};
function detectTheme(p){p=p.toLowerCase();
  if(/caf|coffee|brew|tueste/.test(p))return'cafe';
  if(/fit|gym|deport|entren|salud/.test(p))return'fitness';
  if(/rop|moda|cloth|vesti|textil/.test(p))return'ropa';
  if(/financ|dinero|invers|banc|fintech|consultor/.test(p))return'finanzas';
  if(/choco|cacao|dulce|postre/.test(p))return'choco';
  if(/ai|ia|tech|app|software|digital|data/.test(p))return'tech';
  return null;
}
function aiNames(prompt){
  const theme=detectTheme(prompt);
  const seeds=theme?AI.themes[theme]:AI.prefix;
  const names=new Set(); let g=0; const base=hash(prompt||'idea');
  while(names.size<8 && g<200){ g++;
    const h=(base+g*2654435761)>>>0, mode=h%4, s=seeds[(h>>>3)%seeds.length];
    let nm;
    if(mode===0)nm=s+AI.suffix[(h>>>7)%AI.suffix.length];
    else if(mode===1)nm=AI.prefix[(h>>>5)%AI.prefix.length]+s;
    else if(mode===2)nm='get'+s;
    else nm=s+AI.prefix[(h>>>9)%AI.prefix.length];
    nm=String(nm).replace(/[^a-z0-9]/g,'');
    if(nm.length>=4&&nm.length<=14)names.add(nm);
  }
  const pool=[{t:'.com',p:6.99},{t:'.io',p:24.99},{t:'.ai',p:54.99},{t:'.co',p:9.99},{t:'.app',p:13.99}];
  return [...names].map(nm=>{
    let chosen=pool[hash(nm)%pool.length];
    for(const c of pool){if(isAvailable(nm,c.t)){chosen=c;break;}}
    return {name:nm,tld:chosen.t,price:chosen.p};
  });
}

/* ---------------- Divisas (API real + fallback) ---------------- */
const FX_FALLBACK={USD:1,EUR:0.92,MXN:17.1,GBP:0.79,JPY:151,CAD:1.36,AUD:1.52,BRL:5.0,ARS:880,COP:3900,CLP:920,PEN:3.75,CNY:7.2,INR:83,CHF:0.88};
function fetchJSON(url,timeoutMs=4500){
  return new Promise((resolve,reject)=>{
    const lib=url.startsWith('https')?https:http;
    const req=lib.get(url,{timeout:timeoutMs,headers:{'User-Agent':'Dominzo/1.0'}},r=>{
      let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{resolve(JSON.parse(d))}catch(e){reject(e)}});
    });
    req.on('timeout',()=>{req.destroy();reject(new Error('timeout'))});
    req.on('error',reject);
  });
}
/* ---------------- Stripe (API directa, sin dependencias) ---------------- */
// Llama a la API de Stripe con form-encoding y autenticacion Bearer.
function stripeCall(method, apiPath, params){
  return new Promise((resolve,reject)=>{
    const body = params ? new URLSearchParams(flattenStripe(params)).toString() : '';
    const opts={
      method, host:'api.stripe.com', path:'/v1/'+apiPath,
      headers:{
        'Authorization':'Bearer '+STRIPE_KEY,
        'Content-Type':'application/x-www-form-urlencoded',
        'Content-Length':Buffer.byteLength(body)
      }, timeout:9000
    };
    const req=https.request(opts,r=>{
      let d='';r.on('data',c=>d+=c);
      r.on('end',()=>{try{const j=JSON.parse(d); if(j.error) reject(new Error(j.error.message||'Stripe error')); else resolve(j);}catch(e){reject(e);}});
    });
    req.on('timeout',()=>{req.destroy();reject(new Error('Stripe timeout'));});
    req.on('error',reject);
    if(body) req.write(body);
    req.end();
  });
}
// Stripe usa claves anidadas tipo line_items[0][price_data][...]: aplanamos el objeto.
function flattenStripe(obj, prefix, out){
  out=out||{}; prefix=prefix||'';
  for(const k in obj){
    const v=obj[k]; const key=prefix?`${prefix}[${k}]`:k;
    if(v&&typeof v==='object') flattenStripe(v,key,out); else out[key]=v;
  }
  return out;
}
/* ---------------- Porkbun (registrador real, sin dependencias) ---------------- */
// POST JSON a la API de Porkbun. La autenticación va en el body (apikey + secretapikey).
function porkbunPost(apiPath, payload){
  return new Promise((resolve,reject)=>{
    const body=JSON.stringify(Object.assign({apikey:PORKBUN_KEY, secretapikey:PORKBUN_SECRET}, payload||{}));
    const opts={method:'POST',host:'api.porkbun.com',path:'/api/json/v3/'+apiPath,
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},timeout:12000};
    const req=https.request(opts,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});});
    req.on('timeout',()=>{req.destroy();reject(new Error('Porkbun timeout'));});
    req.on('error',reject);
    req.write(body);req.end();
  });
}
// Disponibilidad real de un dominio (devuelve {available, price} o null si falla)
async function porkbunCheck(domain){
  try{
    const r=await porkbunPost('domain/checkDomain/'+encodeURIComponent(domain));
    if(r && r.status==='SUCCESS' && r.response){
      return { available: r.response.avail==='yes', price: parseFloat(r.response.price)||null };
    }
  }catch(e){ /* cae a motor simulado */ }
  return null;
}
// Registro real de un dominio tras el pago (1 año). Devuelve true si OK.
async function porkbunRegister(domain, years){
  try{
    const r=await porkbunPost('domain/create/'+encodeURIComponent(domain), { years: String(years||1) });
    return !!(r && r.status==='SUCCESS');
  }catch(e){ return false; }
}
/* ---------------- Precios reales de TODAS las extensiones (Porkbun pricing, público) ---------------- */
let TLD_CACHE=null, TLD_CACHE_TS=0;
const TLD_CACHE_MS=6*60*60*1000;             // refrescar cada 6 h
const MARKUP=Number(process.env.DOMINZO_MARKUP||'1.0'); // margen sobre costo (1.0 = a costo; 1.15 = +15%)
const TLD_FALLBACK=TLDS.map(t=>({tld:t.tld,price:t.price,renew:t.renew,tag:t.tag}));
async function getTLDs(){
  if(TLD_CACHE && (Date.now()-TLD_CACHE_TS)<TLD_CACHE_MS) return TLD_CACHE;
  try{
    const data=await fetchJSON('https://api.porkbun.com/api/json/v3/pricing/get', 10000);
    if(data && data.status==='SUCCESS' && data.pricing){
      const popular=['.com','.io','.ai','.co','.net','.org','.shop','.store','.dev','.app','.online','.xyz','.tech','.me','.info','.biz','.site','.club','.live','.pro','.us','.mx','.cloud','.digital','.studio','.agency','.design','.fun','.world','.life'];
      const all=Object.keys(data.pricing).map(ext=>{
        const p=data.pricing[ext];
        const reg=parseFloat(p.registration)||0, ren=parseFloat(p.renewal)||reg;
        return { tld:'.'+ext, price:+(reg*MARKUP).toFixed(2), renew:+(ren*MARKUP).toFixed(2), cost:reg };
      }).filter(t=>t.price>0);
      // ordenar: populares primero (en su orden), luego por precio
      all.sort((a,b)=>{
        const ia=popular.indexOf(a.tld), ib=popular.indexOf(b.tld);
        if(ia!==-1||ib!==-1){ if(ia===-1)return 1; if(ib===-1)return -1; return ia-ib; }
        return a.price-b.price;
      });
      // tags para destacar
      all.forEach(t=>{ t.tag = t.tld==='.com'?'best' : t.tld==='.io'?'hot' : null; });
      TLD_CACHE=all; TLD_CACHE_TS=Date.now();
      return all;
    }
  }catch(e){ /* fallback */ }
  return TLD_FALLBACK;
}
// Búsqueda usando la lista real de TLDs
async function searchDomainsReal(query){
  const name=cleanName(query);
  if(!name) return {name:'',results:[]};
  const tlds=await getTLDs();
  const reqTLD=parseTLD(query);
  let list=[...tlds];
  if(reqTLD) list.sort((a,b)=>(a.tld===reqTLD?-1:0)-(b.tld===reqTLD?-1:0));
  // limitar a 40 para no saturar la UI
  list=list.slice(0,40);
  const results=list.map(t=>({name,tld:t.tld,price:t.price,renew:t.renew,tag:t.tag,available:isAvailable(name,t.tld)}));
  return {name,results,source:TLD_CACHE?'porkbun':'fallback'};
}
async function convertCurrency(from,to,amount){
  from=(from||'USD').toUpperCase(); to=(to||'EUR').toUpperCase(); amount=Number(amount)||0;
  try{
    const data=await fetchJSON('https://api.exchangerate.host/convert?from='+from+'&to='+to+'&amount='+amount);
    if(data && typeof data.result==='number') return {result:data.result,rate:(data.info&&data.info.rate)||(amount?data.result/amount:0),source:'live',from,to,amount};
    if(data && data.rates && data.rates[to]) return {result:data.rates[to]*amount,rate:data.rates[to],source:'live',from,to,amount};
  }catch(e){}
  const rf=FX_FALLBACK[from],rt=FX_FALLBACK[to];
  if(rf&&rt){const rate=rt/rf;return {result:rate*amount,rate,source:'offline',from,to,amount};}
  return {error:'Moneda no soportada',from,to};
}

/* ---------------- Traductor (API real + fallback) ---------------- */
const DICT={'hola':'hello','gracias':'thank you','dominio':'domain','precio':'price','comprar':'buy','buscar':'search','barato':'cheap','hello':'hola','thank you':'gracias','domain':'dominio','price':'precio','buy':'comprar','cheap':'barato','welcome':'bienvenido','bienvenido':'welcome'};
async function translateText(text,from,to){
  text=String(text||'').trim(); from=from||'es'; to=to||'en';
  if(!text) return {translation:'',source:'none'};
  try{
    const pair=(from==='auto'?'es':from)+'|'+to;
    const data=await fetchJSON('https://api.mymemory.translated.net/get?q='+encodeURIComponent(text)+'&langpair='+encodeURIComponent(pair));
    if(data && data.responseData && data.responseData.translatedText) return {translation:data.responseData.translatedText,source:'live',from,to};
  }catch(e){}
  const out=text.split(/\b/).map(w=>{const k=w.toLowerCase();return DICT[k]||w;}).join('');
  return {translation:out,source:'offline',from,to};
}

/* ---------------- HTTP utils ---------------- */
function send(res,code,data,headers={}){
  const body=typeof data==='string'?data:JSON.stringify(data);
  res.writeHead(code,{'Content-Type':typeof data==='string'?'text/html; charset=utf-8':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS',...headers});
  res.end(body);
}
function readBody(req){return new Promise(r=>{let d='';req.on('data',c=>d+=c);req.on('end',()=>{try{r(d?JSON.parse(d):{})}catch{r({})}});});}
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.md':'text/markdown','.ico':'image/x-icon','.png':'image/png'};

/* ---------------- Router ---------------- */
const server=http.createServer(async (req,res)=>{
  const u=new URL(req.url,'http://localhost:'+PORT);
  const p=u.pathname;
  if(req.method==='OPTIONS') return send(res,204,'');
  try{
    if(p==='/api/search') return send(res,200, await searchDomainsReal(u.searchParams.get('q')||''));
    if(p==='/api/tlds') return send(res,200,{ tlds: await getTLDs() });
    // Verificación real de disponibilidad de UN dominio exacto (usa Porkbun si está configurado)
    if(p==='/api/check'){
      const dom=(u.searchParams.get('domain')||'').toLowerCase().trim();
      if(!REGISTRAR_ON) return send(res,200,{ real:false });
      const r=await porkbunCheck(dom);
      if(r) return send(res,200,{ real:true, domain:dom, available:r.available, price:r.price });
      return send(res,200,{ real:false });
    }
    if(p==='/api/ai') return send(res,200,{names:aiNames(u.searchParams.get('prompt')||'')});
    if(p==='/api/convert') return send(res,200,await convertCurrency(u.searchParams.get('from'),u.searchParams.get('to'),u.searchParams.get('amount')));
    if(p==='/api/translate') return send(res,200,await translateText(u.searchParams.get('text'),u.searchParams.get('from'),u.searchParams.get('to')));
    if(p==='/api/register' && req.method==='POST'){
      const b=await readBody(req);
      if(!b.email||!b.pass||!b.name) return send(res,400,{error:'Faltan datos'});
      if(db.prepare('SELECT id FROM users WHERE email=?').get(b.email.toLowerCase())) return send(res,409,{error:'Ese email ya esta registrado'});
      const salt=crypto.randomBytes(16).toString('hex');
      const info=db.prepare('INSERT INTO users(name,email,pass,salt,created) VALUES(?,?,?,?,?)').run(b.name,b.email.toLowerCase(),hashPass(b.pass,salt),salt,Date.now());
      const token=signToken({uid:Number(info.lastInsertRowid),exp:Date.now()+7*864e5});
      return send(res,200,{token,user:{id:Number(info.lastInsertRowid),name:b.name,email:b.email.toLowerCase()}});
    }
    if(p==='/api/login' && req.method==='POST'){
      const b=await readBody(req);
      const us=db.prepare('SELECT * FROM users WHERE email=?').get((b.email||'').toLowerCase());
      if(!us || us.pass!==hashPass(b.pass||'',us.salt)) return send(res,401,{error:'Email o contrasena incorrectos'});
      const token=signToken({uid:us.id,exp:Date.now()+7*864e5});
      return send(res,200,{token,user:{id:us.id,name:us.name,email:us.email}});
    }
    if(p==='/api/me'){ const us=authUser(req); if(!us) return send(res,401,{error:'No autenticado'}); return send(res,200,{user:us}); }
    if(p==='/api/domains'){ const us=authUser(req); if(!us) return send(res,401,{error:'No autenticado'}); return send(res,200,{domains:db.prepare('SELECT * FROM domains WHERE user_id=? ORDER BY registered DESC').all(us.id)}); }
    // ¿Stripe está configurado? (para que el frontend sepa qué flujo usar)
    if(p==='/api/payment-config'){
      return send(res,200,{ stripe: !!STRIPE_KEY });
    }
    // Crear sesión de Stripe Checkout
    if(p==='/api/create-checkout-session' && req.method==='POST'){
      const us=authUser(req); if(!us) return send(res,401,{error:'Debes iniciar sesion para comprar'});
      if(!STRIPE_KEY) return send(res,400,{error:'Stripe no configurado'});
      const b=await readBody(req); const items=Array.isArray(b.items)?b.items:[];
      if(!items.length) return send(res,400,{error:'Carrito vacio'});
      const origin = b.origin || BASE_URL || ('https://'+(req.headers.host||'localhost'));
      const params={
        mode:'payment',
        success_url: origin+'/?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: origin+'/?canceled=1',
        customer_email: us.email,
        client_reference_id: String(us.id),
        metadata:{ items: JSON.stringify(items).slice(0,480) },
        line_items: items.map(it=>({
          quantity:1,
          price_data:{
            currency:'usd',
            unit_amount: Math.round((Number(it.price)||0)*100),
            product_data:{ name: (it.name+it.tld)+' — registro 1 año' }
          }
        }))
      };
      try{
        const sess=await stripeCall('POST','checkout/sessions',params);
        // guardamos el carrito asociado a la sesión para registrarlo tras el pago
        db.prepare('INSERT INTO orders(user_id,total,items,created) VALUES(?,?,?,?)')
          .run(us.id, items.reduce((s,i)=>s+(Number(i.price)||0),0), JSON.stringify({sid:sess.id,items,pending:true}), Date.now());
        return send(res,200,{ url: sess.url, id: sess.id });
      }catch(e){ return send(res,502,{error:'Stripe: '+e.message}); }
    }
    // Confirmar sesión tras volver de Stripe: verifica pago y registra dominios
    if(p==='/api/confirm-session' && req.method==='POST'){
      const us=authUser(req); if(!us) return send(res,401,{error:'No autenticado'});
      if(!STRIPE_KEY) return send(res,400,{error:'Stripe no configurado'});
      const b=await readBody(req); const sid=b.session_id;
      if(!sid) return send(res,400,{error:'Falta session_id'});
      try{
        const sess=await stripeCall('GET','checkout/sessions/'+encodeURIComponent(sid));
        if(sess.payment_status!=='paid') return send(res,402,{error:'Pago no completado',status:sess.payment_status});
        let items=[]; try{ items=JSON.parse(sess.metadata.items||'[]'); }catch{}
        const now=Date.now(), yr=365*864e5;
        const ins=db.prepare('INSERT INTO domains(user_id,name,tld,price,renew,status,registered,expires,visits) VALUES(?,?,?,?,?,?,?,?,?)');
        for(const it of items){
          // Si el registrador real está configurado, registra el dominio de verdad
          let status='active';
          if(REGISTRAR_ON){
            const ok=await porkbunRegister(it.name+it.tld, 1);
            status = ok ? 'active' : 'pending_registration'; // si falla, queda pendiente (pagado, por registrar)
          }
          ins.run(us.id,it.name,it.tld,Number(it.price)||0,Number(it.renew)||Number(it.price)||0,status,now,now+yr,Math.floor(Math.random()*5000));
        }
        return send(res,200,{ok:true,paid:true,registrar:REGISTRAR_ON,domains:db.prepare('SELECT * FROM domains WHERE user_id=? ORDER BY registered DESC').all(us.id)});
      }catch(e){ return send(res,502,{error:'Stripe: '+e.message}); }
    }
    if(p==='/api/checkout' && req.method==='POST'){
      const us=authUser(req); if(!us) return send(res,401,{error:'Debes iniciar sesion para comprar'});
      const b=await readBody(req); const items=Array.isArray(b.items)?b.items:[];
      if(!items.length) return send(res,400,{error:'Carrito vacio'});
      let total=0; const now=Date.now(), yr=365*864e5;
      const ins=db.prepare('INSERT INTO domains(user_id,name,tld,price,renew,status,registered,expires,visits) VALUES(?,?,?,?,?,?,?,?,?)');
      for(const it of items){ total+=Number(it.price)||0; ins.run(us.id,it.name,it.tld,Number(it.price)||0,Number(it.renew)||Number(it.price)||0,'active',now,now+yr,Math.floor(Math.random()*5000)); }
      db.prepare('INSERT INTO orders(user_id,total,items,created) VALUES(?,?,?,?)').run(us.id,total,JSON.stringify(items),now);
      return send(res,200,{ok:true,total,domains:db.prepare('SELECT * FROM domains WHERE user_id=? ORDER BY registered DESC').all(us.id)});
    }
    if(p==='/api/stats'){
      const us=authUser(req); if(!us) return send(res,401,{error:'No autenticado'});
      const rows=db.prepare('SELECT * FROM domains WHERE user_id=?').all(us.id);
      const visits=rows.reduce((s,d)=>s+(d.visits||0),0);
      const next=rows.filter(d=>d.expires).sort((a,b)=>a.expires-b.expires)[0];
      const days=next?Math.max(0,Math.round((next.expires-Date.now())/864e5)):null;
      return send(res,200,{count:rows.length,visits,nextDays:days,nextDomain:next?(next.name+next.tld):null});
    }
    // static
    let file=p==='/'?'app.html':p.slice(1);
    file=file.replace(/\.\./g,'');
    const fp=path.join(ROOT,file);
    if(fs.existsSync(fp)&&fs.statSync(fp).isFile()){
      res.writeHead(200,{'Content-Type':MIME[path.extname(fp)]||'application/octet-stream'});
      return fs.createReadStream(fp).pipe(res);
    }
    return send(res,404,{error:'No encontrado'});
  }catch(e){ console.error(e); return send(res,500,{error:'Error del servidor'}); }
});
server.listen(PORT,()=>{
  console.log('\n  Dominzo corriendo en http://localhost:'+PORT);
  console.log('  Base de datos: '+DB_PATH+'\n');
});
