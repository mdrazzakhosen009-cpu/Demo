const express = require('express');
const session = require('express-session');
const { createClient } = require('@libsql/client');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const production = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
if (production && (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN)) {
  console.error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN.');
  process.exit(1);
}
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN || undefined
});

app.set('view engine','ejs');
app.set('views',path.join(__dirname,'views'));
app.set('trust proxy',1);
app.use(express.urlencoded({extended:true,limit:'12mb'}));
app.use(express.json({limit:'12mb'}));
app.use(express.static(path.join(__dirname,'public')));

class TursoSessionStore extends session.Store {
  async get(sid,cb){try{const r=await db.execute({sql:'SELECT data,expires_at FROM sessions WHERE sid=?',args:[sid]});if(!r.rows.length)return cb(null,null);if(Number(r.rows[0].expires_at)<=Date.now()){await db.execute({sql:'DELETE FROM sessions WHERE sid=?',args:[sid]});return cb(null,null)}cb(null,JSON.parse(r.rows[0].data))}catch(e){cb(e)}}
  async set(sid,sess,cb){try{const exp=sess.cookie?.expires?new Date(sess.cookie.expires).getTime():Date.now()+604800000;await db.execute({sql:`INSERT INTO sessions(sid,data,expires_at) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at`,args:[sid,JSON.stringify(sess),exp]});cb(null)}catch(e){cb(e)}}
  async destroy(sid,cb){try{await db.execute({sql:'DELETE FROM sessions WHERE sid=?',args:[sid]});cb(null)}catch(e){cb(e)}}
  async touch(sid,sess,cb){try{const exp=sess.cookie?.expires?new Date(sess.cookie.expires).getTime():Date.now()+604800000;await db.execute({sql:'UPDATE sessions SET expires_at=? WHERE sid=?',args:[exp,sid]});cb(null)}catch(e){cb(e)}}
}
app.use(session({store:new TursoSessionStore(),secret:process.env.SESSION_SECRET||'llp-change-this-secret',resave:false,saveUninitialized:false,rolling:true,cookie:{httpOnly:true,secure:production,sameSite:'lax',maxAge:604800000}}));

const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024},fileFilter:(req,file,cb)=>file.mimetype?.startsWith('image/')?cb(null,true):cb(new Error('Only image files are allowed.'))});
const clean=(v,f='')=>typeof v==='string'?v.trim():f;
const num=(v,f=0)=>Number.isFinite(Number(v))&&Number(v)>=0?Number(v):f;
const money=v=>`৳${Number(v||0).toLocaleString('en-BD',{maximumFractionDigits:2})}`;
const imageData=file=>file?.buffer?`data:${file.mimetype};base64,${file.buffer.toString('base64')}`:null;
const hashPassword=v=>crypto.createHash('sha256').update(String(v)).digest('hex');
const escapeReg=s=>String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

async function upsertSetting(key,value){await db.execute({sql:'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',args:[key,String(value??'')]})}
async function getSettings(){const r=await db.execute('SELECT key,value FROM settings');const s={};for(const x of r.rows)s[x.key]=x.value;return s}
async function ensureColumn(table,col,def){const r=await db.execute(`PRAGMA table_info(${table})`);if(!r.rows.some(x=>String(x.name).toLowerCase()===col.toLowerCase()))await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`)}

async function initDb(){
  await db.execute(`CREATE TABLE IF NOT EXISTS admin(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,category TEXT NOT NULL,price REAL NOT NULL DEFAULT 0,old_price REAL NOT NULL DEFAULT 0,image TEXT,description TEXT,is_featured INTEGER NOT NULL DEFAULT 0,gallery_json TEXT DEFAULT '[]')`);
  await db.execute(`CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id TEXT UNIQUE NOT NULL,customer_name TEXT NOT NULL,phone TEXT NOT NULL,address TEXT NOT NULL,total REAL NOT NULL DEFAULT 0,payment_method TEXT NOT NULL,trx_id TEXT,status TEXT NOT NULL DEFAULT 'Pending',items_json TEXT DEFAULT '[]',created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY,data TEXT NOT NULL,expires_at INTEGER NOT NULL)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS agents(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,whatsapp TEXT,messenger_url TEXT,active INTEGER NOT NULL DEFAULT 1)`);
  await ensureColumn('products','gallery_json',"TEXT DEFAULT '[]'");
  await ensureColumn('orders','items_json',"TEXT DEFAULT '[]'");

  const defaults={
    store_name:'LLP',store_tagline:'Long Life Products',currency:'৳',delivery_time:'ঢাকার ভিতরে 1–2 দিন, ঢাকার বাইরে 2–4 দিন।',opening_hours:'প্রতিদিন সকাল 10টা থেকে রাত 10টা।',store_info:'Long Life Products-এর premium wellness collection সম্পর্কে customer-কে সঠিক তথ্য দিন।',contact_phone:'+880 1700-000000',contact_email:'support@llpstore.com',whatsapp_link:'',instagram_link:'',facebook_link:'',tiktok_link:'',bkash_number:'',nagad_number:'',rocket_number:'',cod_enabled:'1',payment_note:'Payment করার পর Transaction ID দিলে order verify করা হবে।',chat_order_prompt:'Order নিতে customer-এর নাম, mobile number, delivery address, product এবং quantity নিশ্চিত করুন।',agent_instruction:'তুমি LLP-এর official shopping assistant। শুধু database-এ থাকা product, price, delivery, payment, policy ও admin-provided information ব্যবহার করবে। কোনো স্বাস্থ্যগত রোগ নিরাময়ের দাবি বা বানানো তথ্য দেবে না। Order নেওয়ার আগে সব তথ্য customer-এর কাছ থেকে নিয়ে confirmation চাইবে।',ai_q1_title:'Delivery Information',ai_q1_text:'',ai_q2_title:'Product Information',ai_q2_text:'',ai_q3_title:'Payment Information',ai_q3_text:'',ai_q4_title:'Return / Replacement Policy',ai_q4_text:'',ai_q5_title:'Customer Support',ai_q5_text:'',ai_q6_title:'Usage / General Note',ai_q6_text:'',ai_q7_title:'Offer / Campaign',ai_q7_text:'',ai_q8_title:'Custom Handler Note',ai_q8_text:''
  };
  for(const [k,v] of Object.entries(defaults))await db.execute({sql:'INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)',args:[k,v]});
  const admin=await db.execute('SELECT id FROM admin WHERE username=?',['admin']);
  if(!admin.rows.length){const p=process.env.ADMIN_SECRET_FALLBACK_PASSWORD||'admin123';await db.execute({sql:'INSERT INTO admin(username,password) VALUES(?,?)',args:['admin',await bcrypt.hash(p,12)]});}
  const count=await db.execute('SELECT COUNT(*) AS c FROM products');
  if(Number(count.rows[0].c)<8){
    const assets=['creative-01.jpg','creative-02.jpg','creative-03.jpg','creative-04.jpg','creative-05.jpg','creative-06.jpg','creative-07.jpg','creative-08.jpg'];
    const seed=[
      ['Collagen Mix Beetroot Juice','Wellness',1250,1600],
      ['Slim & Fit Juice','Weight Management',1150,1600],
      ['Collagen Mix Beetroot Juice','Wellness',1280,1660],
      ['Beetroot Juice (Energy Blend)','Energy',1100,1550],
      ['Nutrition Mix','Natural Wellness',1000,1400],
      ['Slim Fit Detox','Weight Management',1200,1750],
      ['LLP Premium Pack','Premium Pack',1400,1900],
      ['Natural Energy','Energy',1050,1650]
    ];
    const existingNames=new Set((await db.execute('SELECT name FROM products')).rows.map(r=>String(r.name)));
    for(let i=0;i<seed.length;i++){
      const [name,category,price,old_price]=seed[i];
      if(existingNames.has(name) && i!==2) continue;
      const file=path.join(__dirname,'public/assets',assets[i]);
      const image=fs.existsSync(file)?`data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`:`/assets/${assets[i]}`;
      const gallery=assets.map(n=>`/assets/${n}`);
      await db.execute({sql:'INSERT INTO products(name,category,price,old_price,image,description,is_featured,gallery_json) VALUES(?,?,?,?,?,?,?,?)',args:[name,category,price,old_price,image,'LLP premium wellness product. Pricing, availability and product information can be edited from the Admin Panel.',1,JSON.stringify(gallery)]});
      if((await db.execute('SELECT COUNT(*) AS c FROM products')).rows[0].c>=8) break;
    }
  }
  await db.execute({sql:'DELETE FROM sessions WHERE expires_at<?',args:[Date.now()]});
}

app.use(async(req,res,next)=>{try{res.locals.settings=await getSettings();res.locals.admin=req.session.admin||null;res.locals.cartCount=(req.session.cart||[]).reduce((a,x)=>a+Number(x.qty||0),0);next()}catch(e){next(e)}});

app.get('/',async(req,res,next)=>{try{const f=await db.execute('SELECT * FROM products WHERE is_featured=1 ORDER BY id DESC LIMIT 8');const p=await db.execute('SELECT * FROM products ORDER BY id DESC LIMIT 8');res.render('index',{featured:f.rows,products:p.rows})}catch(e){next(e)}});
app.get('/shop',async(req,res,next)=>{try{const category=clean(req.query.category,'All'),search=clean(req.query.search);let sql='SELECT * FROM products WHERE 1=1',args=[];if(category!=='All'){sql+=' AND category=?';args.push(category)}if(search){sql+=' AND (name LIKE ? OR category LIKE ? OR description LIKE ?)';args.push(`%${search}%`,`%${search}%`,`%${search}%`)}sql+=' ORDER BY id DESC';const [p,c]=await Promise.all([db.execute({sql,args}),db.execute('SELECT DISTINCT category FROM products ORDER BY category')]);res.render('shop',{products:p.rows,categories:c.rows,currentCategory:category,search})}catch(e){next(e)}});
app.get('/product/:id',async(req,res,next)=>{try{const p=await db.execute({sql:'SELECT * FROM products WHERE id=?',args:[req.params.id]});if(!p.rows.length)return res.status(404).send('Product not found');const r=await db.execute({sql:'SELECT * FROM products WHERE category=? AND id!=? LIMIT 4',args:[p.rows[0].category,req.params.id]});res.render('product',{product:p.rows[0],related:r.rows})}catch(e){next(e)}});

app.post('/cart/add',async(req,res,next)=>{try{const id=clean(req.body.id);const p=await db.execute({sql:'SELECT id,name,price,image FROM products WHERE id=?',args:[id]});if(!p.rows.length)return res.status(404).send('Product not found');if(!req.session.cart)req.session.cart=[];const existing=req.session.cart.find(x=>String(x.id)===String(id));if(existing)existing.qty++;else req.session.cart.push({...p.rows[0],qty:1});res.redirect('/cart')}catch(e){next(e)}});
app.post('/cart/remove',(req,res)=>{const id=clean(req.body.id);req.session.cart=(req.session.cart||[]).filter(x=>String(x.id)!==id);res.redirect('/cart')});
app.post('/cart/update',(req,res)=>{const id=clean(req.body.id),qty=Math.max(0,parseInt(req.body.qty,10)||0);req.session.cart=(req.session.cart||[]).map(x=>String(x.id)===id?{...x,qty}:x).filter(x=>x.qty>0);res.redirect('/cart')});
app.get('/cart',(req,res)=>res.render('cart',{cart:req.session.cart||[]}));
app.get('/checkout',(req,res)=>{const cart=req.session.cart||[];if(!cart.length)return res.redirect('/cart');res.render('checkout',{cart,total:cart.reduce((a,x)=>a+Number(x.price)*x.qty,0)})});

function makeOrderId(){return `LLP-${Date.now().toString().slice(-7)}${crypto.randomInt(10,99)}`}
async function createOrder({name,phone,address,payment,trx,cart}){const total=cart.reduce((a,x)=>a+Number(x.price)*x.qty,0),order_id=makeOrderId();await db.execute({sql:'INSERT INTO orders(order_id,customer_name,phone,address,total,payment_method,trx_id,status,items_json) VALUES(?,?,?,?,?,?,?,?,?)',args:[order_id,name,phone,address,total,payment,trx||'', 'Pending',JSON.stringify(cart)]});return {order_id,name,phone,address,total,payment,trx,status:'Pending'}}
app.post('/order/place',async(req,res,next)=>{try{const cart=req.session.cart||[];if(!cart.length)return res.redirect('/cart');const name=clean(req.body.customer_name),phone=clean(req.body.phone),address=clean(req.body.address),payment=clean(req.body.payment_method,'COD'),trx=clean(req.body.trx_id);if(!name||!phone||!address)return res.status(400).send('Name, phone and address are required.');if(!['bKash','Nagad','Rocket','COD'].includes(payment))return res.status(400).send('Invalid payment method.');if(payment!=='COD'&&!trx)return res.status(400).send('Transaction ID is required.');const order=await createOrder({name,phone,address,payment,trx,cart});req.session.cart=[];res.render('tracking',{order,success:true,order_id:order.order_id})}catch(e){next(e)}});
app.get('/track',async(req,res,next)=>{try{const order_id=clean(req.query.order_id);let order=null;if(order_id){const r=await db.execute({sql:'SELECT * FROM orders WHERE order_id=?',args:[order_id]});order=r.rows[0]||null}res.render('tracking',{order,success:false,order_id})}catch(e){next(e)}});

// ---------------- ADMIN ----------------
app.get('/admin/login',(req,res)=>res.render('admin/login',{error:null}));
app.post('/admin/login',async(req,res)=>{try{const u=clean(req.body.username),p=String(req.body.password||'');const r=await db.execute({sql:'SELECT * FROM admin WHERE username=?',args:[u]});if(!r.rows.length||!(await bcrypt.compare(p,r.rows[0].password)))return res.status(401).render('admin/login',{error:'Invalid username or password'});req.session.regenerate(err=>{if(err)return res.status(500).render('admin/login',{error:'Secure session error'});req.session.admin={id:r.rows[0].id,username:r.rows[0].username};req.session.save(()=>res.redirect('/admin/dashboard'))})}catch(e){res.status(500).render('admin/login',{error:'Database error'})}});
app.get('/admin/logout',(req,res)=>req.session.destroy(()=>res.redirect('/admin/login')));
function auth(req,res,next){if(!req.session.admin)return res.redirect('/admin/login');next()}
app.get('/admin/dashboard',auth,async(req,res,next)=>{try{const [rev,oc,pc,recent]=await Promise.all([db.execute('SELECT COALESCE(SUM(total),0) rev FROM orders'),db.execute('SELECT COUNT(*) c FROM orders'),db.execute('SELECT COUNT(*) c FROM products'),db.execute('SELECT * FROM orders ORDER BY id DESC LIMIT 6')]);res.render('admin/dashboard',{revenue:Number(rev.rows[0].rev||0),ordersCount:Number(oc.rows[0].c||0),productsCount:Number(pc.rows[0].c||0),recentOrders:recent.rows})}catch(e){next(e)}});
app.get('/admin/products',auth,async(req,res,next)=>{try{const p=await db.execute('SELECT * FROM products ORDER BY id DESC');res.render('admin/products',{products:p.rows})}catch(e){next(e)}});
app.post('/admin/products/add',auth,upload.single('image'),async(req,res,next)=>{try{const name=clean(req.body.name),category=clean(req.body.category,'Wellness'),price=num(req.body.price),old=num(req.body.old_price,price),desc=clean(req.body.description);if(!name)return res.status(400).send('Product name is required.');await db.execute({sql:'INSERT INTO products(name,category,price,old_price,image,description,is_featured,gallery_json) VALUES(?,?,?,?,?,?,?,?)',args:[name,category,price,old,imageData(req.file)||'/assets/creative-01.jpg',desc,req.body.is_featured?1:0,'[]']});res.redirect('/admin/products')}catch(e){next(e)}});
app.get('/admin/products/edit/:id',auth,async(req,res,next)=>{try{const r=await db.execute({sql:'SELECT * FROM products WHERE id=?',args:[req.params.id]});if(!r.rows.length)return res.status(404).send('Product not found');res.render('admin/products-edit',{product:r.rows[0]})}catch(e){next(e)}});
app.post('/admin/products/edit/:id',auth,upload.single('image'),async(req,res,next)=>{try{const name=clean(req.body.name),category=clean(req.body.category,'Wellness'),price=num(req.body.price),old=num(req.body.old_price,price),desc=clean(req.body.description);const args=req.file?[name,category,price,old,imageData(req.file),desc,req.body.is_featured?1:0,req.params.id]:[name,category,price,old,desc,req.body.is_featured?1:0,req.params.id];const sql=req.file?'UPDATE products SET name=?,category=?,price=?,old_price=?,image=?,description=?,is_featured=? WHERE id=?':'UPDATE products SET name=?,category=?,price=?,old_price=?,description=?,is_featured=? WHERE id=?';await db.execute({sql,args});res.redirect('/admin/products')}catch(e){next(e)}});
app.post('/admin/products/delete/:id',auth,async(req,res,next)=>{try{await db.execute({sql:'DELETE FROM products WHERE id=?',args:[req.params.id]});res.redirect('/admin/products')}catch(e){next(e)}});

app.get('/admin/orders',auth,async(req,res,next)=>{try{const r=await db.execute('SELECT * FROM orders ORDER BY id DESC');res.render('admin/orders',{orders:r.rows})}catch(e){next(e)}});
app.post('/admin/orders/status/:id',auth,async(req,res,next)=>{try{const allowed=['Pending','Processing','Shipped','Completed','Cancelled'];const s=clean(req.body.status);if(!allowed.includes(s))return res.status(400).send('Invalid status');await db.execute({sql:'UPDATE orders SET status=? WHERE id=?',args:[s,req.params.id]});res.redirect('/admin/orders')}catch(e){next(e)}});

app.get('/admin/settings',auth,async(req,res,next)=>{try{const s=await getSettings();res.render('admin/settings',{s,message:null,error:null})}catch(e){next(e)}});
app.post('/admin/settings',auth,async(req,res,next)=>{try{const keys=['store_name','store_tagline','currency','delivery_time','opening_hours','store_info','contact_phone','contact_email','whatsapp_link','instagram_link','facebook_link','tiktok_link','bkash_number','nagad_number','rocket_number','cod_enabled','payment_note','chat_order_prompt'];for(const k of keys)await upsertSetting(k,clean(req.body[k]));res.render('admin/settings',{s:await getSettings(),message:'Store settings saved to Turso.',error:null})}catch(e){next(e)}});

app.get('/admin/ai-bot',auth,async(req,res,next)=>{try{res.render('admin/ai-bot',{s:await getSettings(),message:null,error:null})}catch(e){next(e)}});
app.post('/admin/ai-bot',auth,async(req,res,next)=>{try{for(let i=1;i<=8;i++){await upsertSetting(`ai_q${i}_title`,clean(req.body[`ai_q${i}_title`],`Information ${i}`));await upsertSetting(`ai_q${i}_text`,clean(req.body[`ai_q${i}_text`]))}await upsertSetting('agent_instruction',clean(req.body.agent_instruction));res.render('admin/ai-bot',{s:await getSettings(),message:'AI Bot knowledge saved. The bot will use Turso data automatically.',error:null})}catch(e){next(e)}});

app.get('/admin/agents',auth,async(req,res,next)=>{try{const r=await db.execute('SELECT * FROM agents ORDER BY id DESC');res.render('admin/agents',{agents:r.rows})}catch(e){next(e)}});
app.post('/admin/agents/add',auth,async(req,res,next)=>{try{await db.execute({sql:'INSERT INTO agents(name,whatsapp,messenger_url,active) VALUES(?,?,?,?)',args:[clean(req.body.name,'Support Agent'),clean(req.body.whatsapp),clean(req.body.messenger_url),1]});res.redirect('/admin/agents')}catch(e){next(e)}});
app.post('/admin/agents/toggle/:id',auth,async(req,res,next)=>{try{await db.execute({sql:'UPDATE agents SET active=CASE WHEN active=1 THEN 0 ELSE 1 END WHERE id=?',args:[req.params.id]});res.redirect('/admin/agents')}catch(e){next(e)}});
app.post('/admin/agents/delete/:id',auth,async(req,res,next)=>{try{await db.execute({sql:'DELETE FROM agents WHERE id=?',args:[req.params.id]});res.redirect('/admin/agents')}catch(e){next(e)}});

app.get('/admin/password',auth,(req,res)=>res.render('admin/password',{message:null,error:null}));
app.post('/admin/password',auth,async(req,res,next)=>{try{const old=String(req.body.current_password||''),nextP=String(req.body.new_password||'');const r=await db.execute({sql:'SELECT password FROM admin WHERE id=?',args:[req.session.admin.id]});if(!r.rows.length||!(await bcrypt.compare(old,r.rows[0].password)))return res.status(400).render('admin/password',{message:null,error:'Current password is incorrect.'});if(nextP.length<8)return res.status(400).render('admin/password',{message:null,error:'New password must be at least 8 characters.'});await db.execute({sql:'UPDATE admin SET password=? WHERE id=?',args:[await bcrypt.hash(nextP,12),req.session.admin.id]});res.render('admin/password',{message:'Password changed successfully.',error:null})}catch(e){next(e)}});

// ---------------- DATABASE-POWERED SHOPPING AGENT ----------------
function productSearch(rows,q){const terms=q.toLowerCase().split(/[^a-z0-9\u0980-\u09ff]+/).filter(x=>x.length>1);return rows.filter(p=>{const hay=`${p.name} ${p.category} ${p.description||''}`.toLowerCase();return terms.some(t=>hay.includes(t))}).slice(0,6)}
async function agentReply(req,message){
  const s=await getSettings();
  const pr=(await db.execute('SELECT id,name,category,price,old_price,image,description,is_featured FROM products ORDER BY is_featured DESC,id DESC')).rows;
  const q=message.toLowerCase();
  const knowledge=[];for(let i=1;i<=8;i++){if(s[`ai_q${i}_text`])knowledge.push({title:s[`ai_q${i}_title`],text:s[`ai_q${i}_text`]})}
  const state=req.session.llp_agent_order||{};
  const save=()=>{req.session.llp_agent_order=state;req.session.save(()=>{})};
  const orderIdMatch=message.match(/\bLLP[- ]?\d{6,10}\b/i);
  if(orderIdMatch||/track|status|অর্ডার.*স্ট্যাটাস|কোথায়.*অর্ডার/i.test(q)){
    const oid=orderIdMatch?orderIdMatch[0].replace(' ','-').toUpperCase():'';
    if(!oid)return {reply:'আপনার Order ID দিন, যেমন LLP-12345678।'};
    const r=await db.execute({sql:'SELECT order_id,total,status,created_at FROM orders WHERE order_id=?',args:[oid]});
    return {reply:r.rows.length?`Order <strong>${r.rows[0].order_id}</strong> এখন <strong>${r.rows[0].status}</strong> status-এ আছে। Total ${money(r.rows[0].total)}।`:`${oid} নামে কোনো order পাওয়া যায়নি। Order ID আবার check করুন।`};
  }
  // Continue an in-progress order.
  if(state.active){
    if(!state.product_id){const found=productSearch(pr,q)[0];if(found)state.product_id=found.id;else if(/order|buy|কিন|অর্ডার/i.test(q))return {reply:'কোন product order করবেন? Product-এর নাম বলুন।'};}
    if(state.product_id&&!state.name&&q.length>1&&state.step==='name'){state.name=message;state.step='phone'}
    else if(state.product_id&&!state.phone&&state.step==='phone'&&/\d{7,15}/.test(message.replace(/\D/g,''))){state.phone=message.replace(/\D/g,'');state.step='address'}
    else if(state.product_id&&!state.address&&state.step==='address'){state.address=message;state.step='payment'}
    else if(state.product_id&&!state.payment&&state.step==='payment'){const pm=/bkash/i.test(q)?'bKash':/nagad/i.test(q)?'Nagad':/rocket/i.test(q)?'Rocket':/cod|cash/i.test(q)?'COD':'';if(pm)state.payment=pm;else return {reply:'Payment method বলুন: bKash, Nagad, Rocket বা Cash on Delivery (COD)।'}}
    else if(state.product_id&&state.payment&&state.payment!=='COD'&&!state.trx){if(message.length>=3){state.trx=message;state.step='confirm'}else return {reply:'Payment-এর Transaction ID দিন।'}}
    const p=pr.find(x=>Number(x.id)===Number(state.product_id));
    if(!p){delete req.session.llp_agent_order;return {reply:'এই product আর catalog-এ নেই। অন্য product বেছে নিন।'}}
    if(!state.name){state.step='name';save();return {reply:`${p.name} — ${money(p.price)}। Order করতে আপনার নাম দিন।`}}
    if(!state.phone){state.step='phone';save();return {reply:'আপনার mobile number দিন।'}}
    if(!state.address){state.step='address';save();return {reply:'Delivery address দিন।'}}
    if(!state.payment){state.step='payment';save();return {reply:`Payment method বলুন: bKash, Nagad, Rocket${s.cod_enabled==='1'?' বা Cash on Delivery':''}।`}}
    if(state.payment!=='COD'&&!state.trx){state.step='trx';save();const pn=s[state.payment.toLowerCase()+'_number']||'Admin এখনো number দেননি';return {reply:`${state.payment} number: <strong>${pn}</strong><br>${s.payment_note||'Payment করে Transaction ID দিন।'}`}}
    if(state.step!=='confirm'){state.step='confirm';save();return {reply:`Order summary:<br><strong>${p.name}</strong><br>Name: ${state.name}<br>Phone: ${state.phone}<br>Address: ${state.address}<br>Payment: ${state.payment}<br>${state.trx?`Transaction ID: ${state.trx}<br>`:''}Price: ${money(p.price)}<br><br>সব ঠিক থাকলে <strong>confirm</strong> লিখুন।`}}
    if(/confirm|হ্যাঁ|ঠিক আছে|জি|yes|ok/i.test(q)){
      const cart=[{id:p.id,name:p.name,price:p.price,image:p.image,qty:1}];const order=await createOrder({name:state.name,phone:state.phone,address:state.address,payment:state.payment,trx:state.trx||'',cart});delete req.session.llp_agent_order;return {reply:`Order সফলভাবে নেওয়া হয়েছে ❤️<br>Order ID: <strong>${order.order_id}</strong><br>${p.name}<br>Total: <strong>${money(order.total)}</strong><br>Status: Pending`,order_id:order.order_id}
    }
    return {reply:'Confirmation-এর জন্য <strong>confirm</strong> লিখুন।'};
  }
  if(/hello|hi|hey|হাই|আসসালামু|salam/i.test(q))return {reply:`আসসালামু আলাইকুম ❤️ ${s.store_name||'LLP'}-তে স্বাগতম। আমি আপনার shopping assistant। Product, price, delivery, payment, support বা order—যেকোনো বিষয়ে বলুন।`};
  for(const k of knowledge){const terms=(k.title+' '+k.text).toLowerCase().split(/\s+/).filter(x=>x.length>3);if(terms.some(t=>q.includes(t)))return {reply:k.text}}
  if(/delivery|shipping|কুরিয়ার|ডেলিভারি|কতদিন|কয়দিন/i.test(q))return {reply:s.delivery_time||'Delivery information Admin সেট করেননি।'};
  if(/payment|bkash|nagad|rocket|cod|ক্যাশ|পেমেন্ট/i.test(q)){const p=[];if(s.bkash_number)p.push(`bKash: ${s.bkash_number}`);if(s.nagad_number)p.push(`Nagad: ${s.nagad_number}`);if(s.rocket_number)p.push(`Rocket: ${s.rocket_number}`);if(s.cod_enabled==='1')p.push('Cash on Delivery available');return {reply:(p.join('<br>')||s.payment_note||'Payment information Admin সেট করেননি।')}}
  if(/price|budget|under|below|দাম|টাকা|বাজেট/i.test(q)){const ns=(message.match(/\d[\d,]*/g)||[]).map(x=>Number(x.replace(/,/g,'')));const max=ns.length?Math.max(...ns):Infinity;const m=pr.filter(p=>Number(p.price)>0&&Number(p.price)<=max).slice(0,6);return {reply:m.length?`আপনার budget-এর মধ্যে ${m.length}টি product পেয়েছি।`:max<Infinity?'এই budget-এ product পাওয়া যায়নি। অন্য budget বলুন।':'কোন budget-এর মধ্যে খুঁজব? যেমন 1000 বা 2000 টাকা।',products:m}};
  if(/order|buy|purchase|কিনতে|অর্ডার/i.test(q)){const found=productSearch(pr,q)[0];if(found){req.session.llp_agent_order={active:true,product_id:found.id,step:'name'};save();return {reply:`${found.name} — ${money(found.price)}। Order শুরু করছি। আপনার নাম দিন।`}}return {reply:s.chat_order_prompt||'Product-এর নাম বলুন, আমি order process শুরু করছি।'}}
  if(/recommend|suggest|best|popular|featured|ভালো|সাজেস্ট|পছন্দ/i.test(q)){const m=pr.filter(p=>Number(p.is_featured)===1).slice(0,6);return {reply:m.length?'এই মুহূর্তে আমার recommended products:':'Catalog-এ এখন product নেই।',products:m}};
  if(/about|store|কি বিক্রি|what.*sell|company|llp|information|তথ্য/i.test(q))return {reply:s.store_info||'LLP store information Admin সেট করেননি।'};
  if(/contact|support|agent|যোগাযোগ|সাপোর্ট/i.test(q)){const a=(await db.execute('SELECT name,whatsapp,messenger_url FROM agents WHERE active=1 ORDER BY id')).rows;return {reply:`Support: ${s.contact_phone||''}${s.contact_email?`<br>${s.contact_email}`:''}`,agents:a}};
  const m=productSearch(pr,q);return m.length?{reply:'আপনার কথার সাথে মিলে এমন product পেয়েছি:',products:m}:{reply:'আমি live Turso database থেকে product, price, delivery, payment, support, order এবং order tracking handle করতে পারি। আপনি কী খুঁজছেন?'};
}
app.post('/api/agent/chat',async(req,res,next)=>{try{const message=clean(req.body.message);if(!message)return res.status(400).json({success:false,message:'Message required'});res.json({success:true,...await agentReply(req,message)})}catch(e){next(e)}});
app.post('/api/ai/match',upload.single('customer_image'),async(req,res,next)=>{try{const p=await db.execute('SELECT id,name,category,price,image FROM products ORDER BY is_featured DESC,id DESC LIMIT 6');res.json({success:true,message:'ছবিটি database-এর live catalog-এর সাথে মিলিয়ে দেখার জন্য বর্তমান products দেখানো হলো।',matched_products:p.rows})}catch(e){next(e)}});

app.use((err,req,res,next)=>{console.error(err);if(err instanceof multer.MulterError||err.message==='Only image files are allowed.')return res.status(400).send(err.message);res.status(500).send('Server error. Please try again.')});
initDb().then(()=>app.listen(PORT,'0.0.0.0',()=>console.log(`LLP server running on ${PORT}`))).catch(e=>{console.error('DB init failed',e);process.exit(1)});
