require('dotenv').config();
const express=require('express');
const path=require('path');
const helmet=require('helmet');
const jwt=require('jsonwebtoken');
const bcrypt=require('bcryptjs');
const rateLimit=require('express-rate-limit');
const db=require('./db');
if(!process.env.JWT_SECRET||process.env.JWT_SECRET.length<32) throw Error('JWT_SECRET måste vara minst 32 tecken');
const app=express();
app.disable('x-powered-by');
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'150kb'}));
app.use('/api/login',rateLimit({windowMs:15*60*1000,limit:12,standardHeaders:'draft-7',legacyHeaders:false}));
const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const fail=(res,code,message)=>res.status(code).json({error:message});
const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const num=x=>Number.isFinite(Number(x))?Number(x):0;
const required=(v,max=250)=>typeof v==='string'&&v.trim().length>0&&v.trim().length<=max;
const text=(v,max=500)=>typeof v==='string'?v.trim().slice(0,max):'';
function auth(req,res,next){
 const token=(req.headers.authorization||'').match(/^Bearer (.+)$/)?.[1];
 if(!token)return fail(res,401,'Logga in först');
 try{req.user=jwt.verify(token,process.env.JWT_SECRET,{algorithms:['HS256']});next();}catch{return fail(res,401,'Sessionen har gått ut');}
}
function admin(req,res,next){if(req.user.role!=='admin')return fail(res,403,'Endast administratör');next();}
const tenant=(req)=>req.user.companyId;
app.post('/api/login',asyncRoute(async(req,res)=>{
 const {email,password}=req.body||{};
 if(!required(email,320)||typeof password!=='string')return fail(res,400,'E-post och lösenord krävs');
 const {rows}=await db.query('SELECT id,company_id,email,password_hash,role FROM app_users WHERE lower(email)=lower($1) AND active=true',[email.trim()]);
 // En e-postadress kan förekomma i flera företag: välj inte ett konto godtyckligt.
 if(rows.length!==1||!await bcrypt.compare(password,rows[0].password_hash))return fail(res,401,'Fel e-post eller lösenord');
 const u=rows[0];const token=jwt.sign({userId:u.id,companyId:u.company_id,role:u.role},process.env.JWT_SECRET,{expiresIn:'8h',algorithm:'HS256'});
 res.json({token,user:{id:u.id,email:u.email,role:u.role,companyId:u.company_id}});
}));
app.use('/api',auth,asyncRoute(async(req,res,next)=>{const {rows}=await db.query('SELECT role FROM app_users WHERE id=$1 AND company_id=$2 AND active=true',[req.user.userId,tenant(req)]);if(!rows.length||rows[0].role!==req.user.role)return fail(res,401,'Kontot är inte längre aktivt');next();}));
app.get('/api/me',asyncRoute(async(req,res)=>{
 const {rows}=await db.query('SELECT u.id,u.email,u.role,u.full_name,c.name AS company FROM app_users u JOIN companies c ON c.id=u.company_id WHERE u.id=$1 AND u.company_id=$2 AND u.active=true',[req.user.userId,tenant(req)]);
 if(!rows.length)return fail(res,401,'Kontot är inaktiverat');res.json(rows[0]);
}));
// Personalen får bara åtkomst till egna tider och företagets arbetsorder.
function staff(req,res,next){if(!['employee','contractor'].includes(req.user.role))return fail(res,403,'Endast personal');next();}

// Anställda kan pausa en tilldelad order och fortsätta vid nästa besök.
app.post('/api/staff/projects/:id/pause',staff,asyncRoute(async(req,res)=>{
 const project=id(req.params.id);const reason=text(req.body?.reason,500);
 const active=await db.query('SELECT 1 FROM time_entries WHERE company_id=$1 AND user_id=$2 AND project_id=$3 AND check_out IS NULL LIMIT 1',[tenant(req),req.user.userId,project]);if(active.rowCount)return fail(res,409,'Checka ut innan du pausar arbetsordern');
 const {rows}=await db.query(`UPDATE projects p SET status='paused',paused_at=NOW(),pause_reason=$4
 WHERE p.id=$1 AND p.company_id=$2 AND p.status IN ('open','ongoing')
 AND EXISTS(SELECT 1 FROM project_assignments a WHERE a.project_id=p.id AND a.company_id=$2 AND a.user_id=$3)
 RETURNING p.id,p.status,p.paused_at`,[project,tenant(req),req.user.userId,reason]);
 if(!rows.length)return fail(res,404,'Tilldelad aktiv order saknas');res.json(rows[0]);
}));
app.post('/api/staff/projects/:id/resume',staff,asyncRoute(async(req,res)=>{
 const {rows}=await db.query(`UPDATE projects p SET status='ongoing',paused_at=NULL
 WHERE p.id=$1 AND p.company_id=$2 AND p.status='paused'
 AND EXISTS(SELECT 1 FROM project_assignments a WHERE a.project_id=p.id AND a.company_id=$2 AND a.user_id=$3)
 RETURNING p.id,p.status`,[id(req.params.id),tenant(req),req.user.userId]);
 if(!rows.length)return fail(res,404,'Pausad tilldelad order saknas');res.json(rows[0]);
}));

// Endast tilldelade jobb visas i personalens schema.
app.get('/api/staff/schedule',staff,asyncRoute(async(req,res)=>{
 const {rows}=await db.query(`SELECT p.id,p.project_number,p.title,p.description,p.category,p.status,p.scheduled_start,p.scheduled_end,c.name customer_name,c.address customer_address FROM project_assignments a JOIN projects p ON p.id=a.project_id AND p.company_id=a.company_id LEFT JOIN customers c ON c.id=p.customer_id AND c.company_id=p.company_id WHERE a.company_id=$1 AND a.user_id=$2 AND p.status IN ('open','ongoing','paused') ORDER BY p.scheduled_start NULLS LAST,p.id DESC`,[tenant(req),req.user.userId]);res.json(rows);
}));
// Arbetsorder skapas enbart av administratör.
app.get('/api/staff/customers',staff,asyncRoute(async(req,res)=>{const {rows}=await db.query('SELECT id,customer_number,name FROM customers WHERE company_id=$1 ORDER BY name LIMIT 500',[tenant(req)]);res.json(rows)}));
app.get('/api/staff/catalog',staff,asyncRoute(async(req,res)=>{const {rows}=await db.query('SELECT id,name,rsk,unit FROM material_catalog WHERE company_id=$1 AND active=true ORDER BY name',[tenant(req)]);res.json(rows)}));
app.post('/api/staff/time/:id/break/start',staff,asyncRoute(async(req,res)=>{
 const t=id(req.params.id);const {rows}=await db.query(`INSERT INTO time_breaks(company_id,time_entry_id) SELECT $1,id FROM time_entries WHERE id=$2 AND company_id=$1 AND user_id=$3 AND check_out IS NULL RETURNING id,started_at`,[tenant(req),t,req.user.userId]);if(!rows.length)return fail(res,404,'Ingen aktiv incheckning');res.status(201).json(rows[0]);
}));
app.post('/api/staff/time/:id/break/stop',staff,asyncRoute(async(req,res)=>{
 const {rows}=await db.query(`UPDATE time_breaks b SET ended_at=NOW() FROM time_entries t WHERE b.time_entry_id=t.id AND t.id=$1 AND t.company_id=$2 AND t.user_id=$3 AND t.check_out IS NULL AND b.ended_at IS NULL RETURNING b.id`,[id(req.params.id),tenant(req),req.user.userId]);if(!rows.length)return fail(res,404,'Ingen aktiv rast');res.json(rows[0]);
}));
app.get('/api/staff/projects',staff,asyncRoute(async(req,res)=>{
 const {rows}=await db.query(`SELECT p.id,p.project_number,p.title,p.description,p.status,c.name AS customer_name,c.address AS customer_address FROM projects p LEFT JOIN customers c ON c.id=p.customer_id AND c.company_id=p.company_id WHERE p.company_id=$1 AND p.status IN ('open','ongoing','paused') AND EXISTS(SELECT 1 FROM project_assignments a WHERE a.company_id=$1 AND a.project_id=p.id AND a.user_id=$2) ORDER BY p.id DESC LIMIT 200`,[tenant(req),req.user.userId]);res.json(rows);
}));
app.get('/api/staff/time',staff,asyncRoute(async(req,res)=>{
 const {rows}=await db.query(`SELECT t.id,t.project_id,t.check_in,t.check_out,t.break_minutes,t.work_type,p.title AS project_title FROM time_entries t JOIN projects p ON p.id=t.project_id AND p.company_id=t.company_id WHERE t.company_id=$1 AND t.user_id=$2 ORDER BY t.id DESC LIMIT 200`,[tenant(req),req.user.userId]);res.json(rows);
}));
app.post('/api/staff/time/start',staff,asyncRoute(async(req,res)=>{
 const project=id(req.body?.project_id);
 if(!project)return fail(res,400,'Välj en arbetsorder');
 const {rows}=await db.query(`INSERT INTO time_entries(company_id,user_id,project_id,employee_id,check_in,work_type) SELECT $1,$2,p.id,e.id,NOW(),$4 FROM projects p LEFT JOIN employees e ON e.company_id=$1 AND lower(e.email)=(SELECT lower(email) FROM app_users WHERE id=$2) WHERE p.id=$3 AND p.company_id=$1 AND p.status IN ('open','ongoing') AND EXISTS(SELECT 1 FROM project_assignments a WHERE a.company_id=$1 AND a.project_id=p.id AND a.user_id=$2) RETURNING id,project_id,check_in`,[tenant(req),req.user.userId,project,['ordinary','jour','overtime'].includes(req.body?.work_type)?req.body.work_type:'ordinary']);
 if(!rows.length)return fail(res,404,'Arbetsordern saknas eller är avslutad');res.status(201).json(rows[0]);
}));
app.post('/api/staff/time/:id/stop',staff,asyncRoute(async(req,res)=>{
 const {rows}=await db.query(`UPDATE time_entries t SET check_out=NOW(),break_minutes=LEAST(FLOOR(EXTRACT(EPOCH FROM (NOW()-t.check_in))/60)::int,COALESCE((SELECT FLOOR(SUM(EXTRACT(EPOCH FROM (COALESCE(b.ended_at,NOW())-b.started_at)))/60)::int FROM time_breaks b WHERE b.time_entry_id=t.id),0)) WHERE t.id=$1 AND t.company_id=$2 AND t.user_id=$3 AND t.check_out IS NULL RETURNING id,check_in,check_out,break_minutes`,[id(req.params.id),tenant(req),req.user.userId]);
 if(!rows.length)return fail(res,400,'Kan inte avsluta registreringen. Kontrollera rasttiden.');res.json(rows[0]);
}));
app.get('/api/staff/materials',staff,asyncRoute(async(req,res)=>{
 const {rows}=await db.query(`SELECT m.id,m.project_id,m.name,m.quantity,m.unit,m.rsk,m.source,m.supplier,p.title AS project_title FROM materials m JOIN projects p ON p.id=m.project_id AND p.company_id=m.company_id WHERE m.company_id=$1 ORDER BY m.id DESC LIMIT 100`,[tenant(req)]);res.json(rows);
}));
app.post('/api/staff/materials',staff,asyncRoute(async(req,res)=>{
 const b=req.body||{};const quantity=Number(b.quantity);
 if(!id(b.project_id)||!required(b.name)||!Number.isFinite(quantity)||quantity<=0||quantity>100000)return fail(res,400,'Ange arbetsorder, material och giltigt antal');
 const {rows}=await db.query(`INSERT INTO materials(company_id,project_id,name,quantity,unit,unit_price,purchase_price,supplier,source,rsk) SELECT $1,p.id,$3,$4,$5,0,0,$6,$7,$8 FROM projects p WHERE p.id=$2 AND p.company_id=$1 AND p.status IN ('open','ongoing','paused') AND EXISTS(SELECT 1 FROM project_assignments a WHERE a.company_id=$1 AND a.project_id=p.id AND a.user_id=$9) RETURNING id,name,quantity,unit`,[tenant(req),id(b.project_id),text(b.name,250),quantity,text(b.unit||'st',20),text(b.supplier,150),b.source==='supplier'?'supplier':'vehicle',text(b.rsk,100),req.user.userId]);
 if(!rows.length)return fail(res,404,'Arbetsordern saknas eller är avslutad');res.status(201).json(rows[0]);
}));
// All admin-API är server-skyddad och alltid företagsspecifik.
require('./daily-attendance-routes')(app,db);
require('./daily-attendance-admin-extra')(app,db);
require('./jobflow-routes')(app,db);
require('./admin-material-monthly')(app,db);
app.use('/api',admin);
const checkProjectMaterialReview=require('./material-pricing-routes')(app,db);
require('./quote-routes')(app,db);
app.get('/api/overview',asyncRoute(async(req,res)=>{
 const c=tenant(req);const {rows}=await db.query(`SELECT (SELECT count(*) FROM customers WHERE company_id=$1)::int customers,(SELECT count(*) FROM projects WHERE company_id=$1)::int projects,(SELECT count(*) FROM app_users WHERE company_id=$1 AND active=true)::int users,(SELECT count(*) FROM time_entries WHERE company_id=$1 AND check_out IS NULL)::int active_clocks`,[c]);res.json(rows[0]);
}));
app.get('/api/customers',asyncRoute(async(req,res)=>{const {rows}=await db.query('SELECT * FROM customers WHERE company_id=$1 ORDER BY id DESC LIMIT 500',[tenant(req)]);res.json(rows);}));
app.post('/api/customers',asyncRoute(async(req,res)=>{const b=req.body||{};if(!required(b.name))return fail(res,400,'Kundnamn krävs');const {rows}=await db.query("INSERT INTO customers(company_id,name,phone,email,address,customer_number) VALUES($1,$2,$3,$4,$5,'K-'||lpad(nextval('byggapp_customer_seq')::text,6,'0')) RETURNING *",[tenant(req),text(b.name,250),text(b.phone,60),text(b.email,250),text(b.address,500)]);res.status(201).json(rows[0]);}));
app.put('/api/customers/:id',asyncRoute(async(req,res)=>{const b=req.body||{};if(!id(req.params.id)||!required(b.name))return fail(res,400,'Ogiltig kund');const {rows}=await db.query('UPDATE customers SET name=$3,phone=$4,email=$5,address=$6 WHERE id=$1 AND company_id=$2 RETURNING *',[id(req.params.id),tenant(req),text(b.name,250),text(b.phone,60),text(b.email,250),text(b.address,500)]);if(!rows.length)return fail(res,404,'Kunden hittades inte');res.json(rows[0]);}));
app.delete('/api/customers/:id',asyncRoute(async(req,res)=>{const {rowCount}=await db.query('DELETE FROM customers WHERE id=$1 AND company_id=$2',[id(req.params.id),tenant(req)]);if(!rowCount)return fail(res,404,'Kunden kunde inte tas bort (kan ha arbetsorder)');res.json({ok:true});}));
app.get('/api/projects',asyncRoute(async(req,res)=>{const {rows}=await db.query('SELECT p.*,c.name customer_name FROM projects p LEFT JOIN customers c ON c.id=p.customer_id AND c.company_id=p.company_id WHERE p.company_id=$1 ORDER BY p.id DESC LIMIT 500',[tenant(req)]);res.json(rows);}));
app.post('/api/projects',asyncRoute(async(req,res)=>{
 const b=req.body||{};if(!required(b.title)||!id(b.customer_id))return fail(res,400,'Kund och titel krävs');
 const {rows}=await db.query(`INSERT INTO projects(company_id,customer_id,project_number,title,description,job_types,billing_mode,hourly_price,fixed_price,min_billable_minutes,vehicle_charge,discount_percent,rot_percent) SELECT $1,c.id,'P-'||to_char(NOW(),'YYYY')||'-'||lpad(nextval('byggapp_project_seq')::text,6,'0'),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12 FROM customers c WHERE c.id=$2 AND c.company_id=$1 RETURNING *`,[tenant(req),id(b.customer_id),text(b.title,250),text(b.description,2000),Array.isArray(b.job_types)?b.job_types.map(x=>text(x,100)).slice(0,20):[],b.billing_mode==='fixed'?'fixed':'hourly',num(b.hourly_price),num(b.fixed_price),Math.max(0,Math.floor(num(b.min_billable_minutes??120))),num(b.vehicle_charge),Math.max(0,Math.min(100,num(b.discount_percent))),0]);
 if(!rows.length)return fail(res,400,'Kunden tillhör inte företaget');await db.query('UPDATE projects SET category=$3 WHERE id=$1 AND company_id=$2',[rows[0].id,tenant(req),['service','entreprenad','jour','underhall','ovrigt'].includes(b.category)?b.category:'service']);res.status(201).json(rows[0]);
}));
app.patch('/api/projects/:id',asyncRoute(async(req,res)=>{const b=req.body||{};if(!['open','ongoing','paused','completed','invoiced'].includes(b.status))return fail(res,400,'Ogiltig status');const {rows}=await db.query('UPDATE projects SET status=$3 WHERE id=$1 AND company_id=$2 RETURNING *',[id(req.params.id),tenant(req),b.status]);if(!rows.length)return fail(res,404,'Arbetsordern saknas');res.json(rows[0]);}));
app.get('/api/users',asyncRoute(async(req,res)=>{const {rows}=await db.query('SELECT id,email,full_name,role,active,created_at FROM app_users WHERE company_id=$1 ORDER BY id DESC',[tenant(req)]);res.json(rows);}));
app.post('/api/users',asyncRoute(async(req,res)=>{const b=req.body||{};if(!required(b.full_name,200)||!required(b.email,320)||typeof b.password!=='string'||b.password.length<12||!['admin','employee','contractor'].includes(b.role))return fail(res,400,'E-post, roll och lösenord med minst 12 tecken krävs');const hash=await bcrypt.hash(b.password,12);const {rows}=await db.query('INSERT INTO app_users(company_id,email,password_hash,role,full_name) VALUES($1,$2,$3,$4,$5) RETURNING id,email,full_name,role,active',[tenant(req),text(b.email,320).toLowerCase(),hash,b.role,text(b.full_name,200)]);res.status(201).json(rows[0]);}));
app.put('/api/users/:id/name',asyncRoute(async(req,res)=>{if(!required(req.body?.full_name,200))return fail(res,400,'Namn krävs');const {rows}=await db.query('UPDATE app_users SET full_name=$3 WHERE id=$1 AND company_id=$2 RETURNING id,email,full_name',[id(req.params.id),tenant(req),text(req.body.full_name,200)]);if(!rows.length)return fail(res,404,'Användaren saknas');res.json(rows[0]);}));
app.patch('/api/users/:id',asyncRoute(async(req,res)=>{if(id(req.params.id)===Number(req.user.userId))return fail(res,400,'Du kan inte inaktivera dig själv');const {rows}=await db.query('UPDATE app_users SET active=$3 WHERE id=$1 AND company_id=$2 RETURNING id,email,full_name,role,active',[id(req.params.id),tenant(req),req.body?.active===true]);if(!rows.length)return fail(res,404,'Användaren saknas');res.json(rows[0]);}));
app.get('/api/assignments',asyncRoute(async(req,res)=>{const {rows}=await db.query(`SELECT a.project_id,a.user_id,u.email,u.full_name,p.title,p.project_number,p.scheduled_start,p.scheduled_end FROM project_assignments a JOIN app_users u ON u.id=a.user_id AND u.company_id=a.company_id JOIN projects p ON p.id=a.project_id AND p.company_id=a.company_id WHERE a.company_id=$1 ORDER BY p.scheduled_start NULLS LAST,p.id DESC`,[tenant(req)]);res.json(rows)}));
app.post('/api/assignments',asyncRoute(async(req,res)=>{const b=req.body||{};if(!id(b.project_id)||!id(b.user_id))return fail(res,400,'Välj jobb och anställd');const {rows}=await db.query(`INSERT INTO project_assignments(company_id,project_id,user_id) SELECT $1,p.id,u.id FROM projects p JOIN app_users u ON u.id=$3 AND u.company_id=$1 AND u.active=true AND u.role IN ('employee','contractor') WHERE p.id=$2 AND p.company_id=$1 ON CONFLICT DO NOTHING RETURNING *`,[tenant(req),id(b.project_id),id(b.user_id)]);if(!rows.length)return fail(res,409,'Tilldelningen finns redan eller uppgifterna är ogiltiga');res.status(201).json(rows[0])}));
app.delete('/api/assignments/:project/:user',asyncRoute(async(req,res)=>{await db.query('DELETE FROM project_assignments WHERE company_id=$1 AND project_id=$2 AND user_id=$3',[tenant(req),id(req.params.project),id(req.params.user)]);res.json({ok:true})}));
app.patch('/api/schedule/:project',asyncRoute(async(req,res)=>{const b=req.body||{};const start=b.start?new Date(b.start):null,end=b.end?new Date(b.end):null;if((start&&!Number.isFinite(+start))||(end&&!Number.isFinite(+end))||(start&&end&&end<start))return fail(res,400,'Ogiltiga datum');const {rows}=await db.query('UPDATE projects SET scheduled_start=$3,scheduled_end=$4 WHERE id=$1 AND company_id=$2 RETURNING id,scheduled_start,scheduled_end',[id(req.params.project),tenant(req),start,end]);if(!rows.length)return fail(res,404,'Arbetsordern saknas');res.json(rows[0])}));
app.get('/api/catalog',asyncRoute(async(req,res)=>{const {rows}=await db.query('SELECT * FROM material_catalog WHERE company_id=$1 AND active=true ORDER BY name',[tenant(req)]);res.json(rows)}));
app.post('/api/catalog',asyncRoute(async(req,res)=>{const b=req.body||{};if(!required(b.name))return fail(res,400,'Materialnamn krävs');const {rows}=await db.query('INSERT INTO material_catalog(company_id,name,rsk,unit) VALUES($1,$2,$3,$4) RETURNING *',[tenant(req),text(b.name),text(b.rsk,100),text(b.unit||'st',20)]);res.status(201).json(rows[0])}));
app.get('/api/time',asyncRoute(async(req,res)=>{const {rows}=await db.query('SELECT t.*,p.title project_title,u.email user_email,u.full_name user_name FROM time_entries t JOIN projects p ON p.id=t.project_id AND p.company_id=t.company_id LEFT JOIN app_users u ON u.id=t.user_id AND u.company_id=t.company_id WHERE t.company_id=$1 ORDER BY t.id DESC LIMIT 500',[tenant(req)]);res.json(rows);}));
app.post('/api/time/start',asyncRoute(async(req,res)=>{const p=id(req.body?.project_id);if(!p)return fail(res,400,'Välj arbetsorder');const {rows}=await db.query(`INSERT INTO time_entries(company_id,user_id,project_id,employee_id,check_in,work_type) SELECT $1,$2,p.id,e.id,NOW(),$4 FROM projects p LEFT JOIN employees e ON e.company_id=$1 AND lower(e.email)=(SELECT lower(email) FROM app_users WHERE id=$2) WHERE p.id=$3 AND p.company_id=$1 RETURNING *`,[tenant(req),req.user.userId,p,['ordinary','jour','overtime'].includes(req.body?.work_type)?req.body.work_type:'ordinary']);if(!rows.length)return fail(res,404,'Arbetsordern saknas');res.status(201).json(rows[0]);}));
app.post('/api/time/:id/stop',asyncRoute(async(req,res)=>{const br=Math.max(0,Math.floor(num(req.body?.break_minutes)));const {rows}=await db.query('UPDATE time_entries SET check_out=NOW(),break_minutes=$4 WHERE id=$1 AND company_id=$2 AND user_id=$3 AND check_out IS NULL RETURNING *',[id(req.params.id),tenant(req),req.user.userId,br]);if(!rows.length)return fail(res,404,'Ingen aktiv tidsregistrering hittades');res.json(rows[0]);}));
app.get('/api/materials',asyncRoute(async(req,res)=>{const {rows}=await db.query('SELECT m.*,p.title project_title FROM materials m JOIN projects p ON p.id=m.project_id AND p.company_id=m.company_id WHERE m.company_id=$1 ORDER BY m.id DESC LIMIT 500',[tenant(req)]);res.json(rows);}));
app.post('/api/materials',asyncRoute(async(req,res)=>{const b=req.body||{};if(!id(b.project_id)||!required(b.name)||num(b.quantity)<=0)return fail(res,400,'Arbetsorder, namn och antal krävs');const {rows}=await db.query(`INSERT INTO materials(company_id,project_id,name,quantity,unit,unit_price,purchase_price,supplier,source,rsk) SELECT $1,p.id,$3,$4,$5,$6,$7,$8,$9,$10 FROM projects p WHERE p.id=$2 AND p.company_id=$1 RETURNING *`,[tenant(req),id(b.project_id),text(b.name,250),num(b.quantity),text(b.unit||'st',20),num(b.unit_price),num(b.purchase_price),text(b.supplier,150),b.source==='supplier'?'supplier':'vehicle',text(b.rsk,100)]);if(!rows.length)return fail(res,404,'Arbetsordern saknas');res.status(201).json(rows[0]);}));
app.delete('/api/materials/:id',asyncRoute(async(req,res)=>{const {rowCount}=await db.query('DELETE FROM materials WHERE id=$1 AND company_id=$2',[id(req.params.id),tenant(req)]);if(!rowCount)return fail(res,404,'Materialet saknas');res.json({ok:true});}));
async function invoiceData(projectId,companyId,withRot=false){
 const {rows:[p]}=await db.query('SELECT * FROM projects WHERE id=$1 AND company_id=$2',[projectId,companyId]);if(!p)return null;
 const {rows:time}=await db.query('SELECT check_in,check_out,break_minutes,work_type FROM time_entries WHERE project_id=$1 AND company_id=$2 AND check_out IS NOT NULL',[projectId,companyId]);
 const {rows:materials}=await db.query('SELECT name,quantity,unit,unit_price FROM materials WHERE project_id=$1 AND company_id=$2',[projectId,companyId]);
 const {rows:[acceptedQuote]}=await db.query("SELECT * FROM project_quotes WHERE company_id=$1 AND project_id=$2 AND status='accepted' ORDER BY id DESC LIMIT 1",[companyId,projectId]);
 const actualMinutes=time.reduce((sum,t)=>sum+Math.max(0,(new Date(t.check_out)-new Date(t.check_in))/60000-num(t.break_minutes)),0);
 const billableMinutes=time.length?Math.max(num(p.min_billable_minutes),Math.ceil(actualMinutes/30)*30):0;
 const quoteMaterials=materials.length?materials:(acceptedQuote?acceptedQuote.material_rows:materials);
 const labor=acceptedQuote?Number(acceptedQuote.labor_amount):(p.billing_mode==='fixed'?num(p.fixed_price):billableMinutes/60*num(p.hourly_price));
 const materialTotal=quoteMaterials.reduce((sum,m)=>sum+num(m.quantity)*num(m.unit_price),0);
 const vehicleCharge=acceptedQuote?Number(acceptedQuote.other_amount):num(p.vehicle_charge);
 const discountPercent=acceptedQuote?Number(acceptedQuote.discount_percent):num(p.discount_percent);
 const subtotal=Math.round((labor+materialTotal+vehicleCharge)*100)/100;
 const discount=Math.round(subtotal*discountPercent)/100;
 const {rows:[vatConfig]}=await db.query('SELECT COALESCE(vat_percent,25) vat FROM company_invoice_settings WHERE company_id=$1',[companyId]);
 const vatRate=acceptedQuote?Number(acceptedQuote.vat_rate):Number(vatConfig?.vat??25);
 const eligibleLabor=Math.max(0,labor*(1-discountPercent/100));
 const rotDeduction=withRot?Math.round(eligibleLabor*(1+vatRate/100)*0.30*100)/100:0;
 const total=Math.max(0,Math.round((subtotal-discount)*100)/100);
 return {project:p,quoteId:acceptedQuote?.id||null,actualMinutes:Math.round(actualMinutes*100)/100,billableMinutes,labor,materials:quoteMaterials,materialTotal,vehicleCharge,subtotal,discount,rotDeduction,total,withRot,vatRate,warning:'Preliminärt fakturaunderlag exklusive moms. ROT gäller bara godkänt arbete, inte material eller servicebil. Kontrollera kundens rätt till avdrag.'};
}
// Löneunderlag: faktisk tid minus rast, ingen kundavrundning. Bara admin.
app.get('/api/payroll/summary',asyncRoute(async(req,res)=>{
 const month=String(req.query.month||'');if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))return fail(res,400,'Ange månad ÅÅÅÅ-MM');
 const {rows}=await db.query(`SELECT u.id,u.full_name,u.email,'ordinary'::text AS work_type,
 COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (a.check_out-a.check_in))-
 COALESCE(a.manual_break_seconds,b.break_seconds,0)))/60,0)::float8 AS minutes
 FROM app_users u LEFT JOIN daily_attendance a ON a.user_id=u.id AND a.company_id=u.company_id AND a.check_out IS NOT NULL
 AND a.check_in >= (($2::text||'-01')::date AT TIME ZONE 'Europe/Stockholm')
 AND a.check_in < ((($2::text||'-01')::date + INTERVAL '1 month') AT TIME ZONE 'Europe/Stockholm')
 LEFT JOIN LATERAL (SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(t.ended_at,a.check_out)-t.started_at))) AS break_seconds
 FROM daily_attendance_breaks t WHERE t.attendance_id=a.id) b ON TRUE
 WHERE u.company_id=$1 AND u.role IN ('employee','contractor')
 GROUP BY u.id,u.full_name,u.email ORDER BY u.full_name,u.email`,[tenant(req),month]);
 res.set('Cache-Control','no-store');res.json(rows);
}));
// Admin sparar separata ersättningar för varje anställd.
app.get('/api/payroll/rates',asyncRoute(async(req,res)=>{
 const {rows}=await db.query(`SELECT u.id,u.full_name,u.email,COALESCE(r.ordinary_rate,0)::float8 ordinary_rate,COALESCE(r.jour_rate,0)::float8 jour_rate,COALESCE(r.overtime_rate,0)::float8 overtime_rate FROM app_users u LEFT JOIN employee_pay_rates r ON r.company_id=u.company_id AND r.user_id=u.id WHERE u.company_id=$1 AND u.role IN ('employee','contractor') ORDER BY u.full_name,u.email`,[tenant(req)]);res.json(rows);
}));
app.put('/api/payroll/rates/:id',asyncRoute(async(req,res)=>{
 const userId=id(req.params.id),b=req.body||{};
 const rates=['ordinary_rate','jour_rate','overtime_rate'].map(k=>Number(b[k]));
 if(!userId||rates.some(x=>!Number.isFinite(x)||x<0||x>10000))return fail(res,400,'Ange giltiga ersättningar i kronor per timme');
 const {rows}=await db.query(`INSERT INTO employee_pay_rates(company_id,user_id,ordinary_rate,jour_rate,overtime_rate) SELECT $1,u.id,$3,$4,$5 FROM app_users u WHERE u.id=$2 AND u.company_id=$1 AND u.role IN ('employee','contractor') ON CONFLICT(company_id,user_id) DO UPDATE SET ordinary_rate=EXCLUDED.ordinary_rate,jour_rate=EXCLUDED.jour_rate,overtime_rate=EXCLUDED.overtime_rate,updated_at=NOW() RETURNING *`,[tenant(req),userId,...rates]);
 if(!rows.length)return fail(res,404,'Anställd saknas');res.json(rows[0]);
}));
app.post('/api/payroll/payslip',asyncRoute(async(req,res)=>{
 const b=req.body||{},userId=id(b.user_id),month=String(b.month||''),tax=num(b.tax_deduction),other=num(b.other_adjustment);
 if(!userId||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||tax<0||tax>1000000||Math.abs(other)>1000000)return fail(res,400,'Kontrollera person, månad, timlön och skatteavdrag');
 const {rows:[person]}=await db.query(`SELECT id,full_name,email FROM app_users WHERE id=$1 AND company_id=$2 AND role IN ('employee','contractor')`,[userId,tenant(req)]);
 if(!person)return fail(res,404,'Personen saknas');
 const {rows}=await db.query(`SELECT 'ordinary'::text AS work_type,
 COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (a.check_out-a.check_in))-
 COALESCE(a.manual_break_seconds,b.break_seconds,0)))/60,0)::float8 AS minutes
 FROM daily_attendance a
 LEFT JOIN LATERAL (SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(t.ended_at,a.check_out)-t.started_at))) AS break_seconds
 FROM daily_attendance_breaks t WHERE t.attendance_id=a.id) b ON TRUE
 WHERE a.company_id=$1 AND a.user_id=$2 AND a.check_out IS NOT NULL
 AND a.check_in >= (($3::text||'-01')::date AT TIME ZONE 'Europe/Stockholm')
 AND a.check_in < ((($3::text||'-01')::date + INTERVAL '1 month') AT TIME ZONE 'Europe/Stockholm')`,[tenant(req),userId,month]);
 const {rows:[savedRates]}=await db.query('SELECT ordinary_rate,jour_rate,overtime_rate FROM employee_pay_rates WHERE company_id=$1 AND user_id=$2',[tenant(req),userId]);
 if(!savedRates)return fail(res,400,'Spara först löneersättningar för den anställde');
 const rates={ordinary:Number(savedRates.ordinary_rate),jour:Number(savedRates.jour_rate),overtime:Number(savedRates.overtime_rate)};
 const minutes=rows.reduce((a,r)=>a+Number(r.minutes),0),gross=Math.round(rows.reduce((sum,r)=>sum+Number(r.minutes)/60*(rates[r.work_type]??rates.ordinary),0)*100)/100,net=Math.round((gross-tax+other)*100)/100;
 if(net<0)return fail(res,400,'Nettolönen kan inte vara negativ');
 const {rows:[employer]}=await db.query(`SELECT c.name,COALESCE(s.org_number,'') org_number,COALESCE(s.logo_data,'') logo_data FROM companies c LEFT JOIN company_invoice_settings s ON s.company_id=c.id WHERE c.id=$1`,[tenant(req)]);
 const doc=new PDFDocument({size:'A4',margin:48,info:{Title:'Lönespecifikation – utkast '+month}});
 const finished=new Promise((resolve,reject)=>{const chunks=[];doc.on('data',x=>chunks.push(x));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject)});
 const navy='#142238',ink='#263449',muted='#657489',line='#e2e8f0',light='#f3f6fa',accent='#d8a647';
 doc.rect(0,0,595,112).fill(navy);doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text('LÖNESPECIFIKATION',48,35,{width:350});
 doc.font('Helvetica').fontSize(10).fillColor('#d9e2ef').text('UTKAST • EJ SLUTLIG LÖNEKÖRNING',49,69);
 if(employer?.logo_data&&/^data:image\/(png|jpeg);base64,/.test(employer.logo_data)){try{doc.image(Buffer.from(employer.logo_data.split(',')[1],'base64'),438,26,{fit:[105,65]});}catch{}}
 doc.fillColor(ink).font('Helvetica-Bold').fontSize(13).text(employer?.name||'Arbetsgivare',48,140);
 doc.font('Helvetica').fontSize(9).fillColor(muted).text('Org.nr '+(employer?.org_number||'Ej angivet'),48,161);
 doc.font('Helvetica-Bold').fontSize(9).fillColor(muted).text('ANSTÄLLD',48,202).text('LÖNEPERIOD',340,202);
 doc.font('Helvetica-Bold').fontSize(12).fillColor(ink).text(person.full_name||person.email,48,220,{width:260}).text(month,340,220);
 doc.font('Helvetica').fontSize(9).fillColor(muted).text(person.email||'',48,241);
 doc.roundedRect(48,278,499,29,5).fill(light);doc.fillColor(ink).font('Helvetica-Bold').fontSize(10).text('Löneart',60,287).text('Timmar',310,287,{width:90,align:'right'}).text('Belopp',420,287,{width:112,align:'right'});
 const labels={ordinary:'Ordinarie arbetstid',jour:'Jour',overtime:'Övertid',weekend:'Helgarbete'};
 let y=318;for(const r of rows){const h=Number(r.minutes)/60;const rate=rates[r.work_type]??rates.ordinary;doc.font('Helvetica').fontSize(10).fillColor(ink).text(labels[r.work_type]||r.work_type||'Arbetstid',60,y).text(h.toLocaleString('sv-SE',{minimumFractionDigits:2,maximumFractionDigits:2}),310,y,{width:90,align:'right'}).text(kr(h*rate),420,y,{width:112,align:'right'});doc.moveTo(48,y+21).lineTo(547,y+21).strokeColor(line).stroke();y+=34;}
 y=Math.max(y+20,465);doc.font('Helvetica').fontSize(10).fillColor(ink).text('Totalt arbetade timmar',60,y).text((minutes/60).toLocaleString('sv-SE',{maximumFractionDigits:2})+' h',420,y,{width:112,align:'right'});y+=27;
 doc.text('Timlöner (ordinarie / jour / övertid)',60,y).text([rates.ordinary,rates.jour,rates.overtime].map(v=>Number(v).toFixed(0)).join(' / ')+' kr',350,y,{width:182,align:'right'});y+=27;
 doc.text('Bruttolön',60,y).text(kr(gross),420,y,{width:112,align:'right'});y+=27;
 doc.text('Skatteavdrag (manuellt)',60,y).text('− '+kr(tax),420,y,{width:112,align:'right'});y+=27;
 doc.text('Övrig justering',60,y).text(kr(other),420,y,{width:112,align:'right'});y+=35;
 doc.roundedRect(48,y,499,58,8).fill(navy);doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(12).text('BERÄKNAD NETTOLÖN',64,y+19).fontSize(17).text(kr(net),320,y+16,{width:210,align:'right'});
 doc.fillColor(muted).font('Helvetica').fontSize(8).text('UTKAST. Kontrollera skatt, OB/jour, semesterersättning, frånvaro och förmåner innan utbetalning.',48,755,{width:499});
 doc.end();
 const pdf=await finished;
 if(b.send===true){
  if(b.confirm!==true)return fail(res,400,'Bekräfta utskick');
  if(!process.env.SMTP_HOST||!process.env.SMTP_USER||!process.env.SMTP_PASS||!process.env.SMTP_FROM)return fail(res,503,'SMTP saknas');
  const nodemailer=require('nodemailer');const port=Number(process.env.SMTP_PORT||587);
  const transporter=nodemailer.createTransport({host:process.env.SMTP_HOST,port,secure:port===465,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});
  await transporter.sendMail({from:process.env.SMTP_FROM,to:person.email,subject:'Lönespecifikation – utkast '+month,text:'Bifogat finns ett utkast till lönespecifikation för '+month+'. Kontrollera uppgifterna med arbetsgivaren.',attachments:[{filename:'lonespecifikation-utkast.pdf',content:pdf}]});
  return res.json({ok:true,recipient:person.email});
 }
 res.type('application/pdf');res.set('Content-Disposition','attachment; filename="lonespecifikation-utkast.pdf"');res.send(pdf);
}));
app.get('/api/invoices/preview/:id',asyncRoute(async(req,res)=>{const result=await invoiceData(id(req.params.id),tenant(req),req.query.rot==='true');if(!result)return fail(res,404,'Arbetsordern saknas');res.json(result);}));
app.post('/api/invoices/drafts/:id',asyncRoute(async(req,res)=>{const projectId=id(req.params.id);if(!projectId)return fail(res,400,'Ogiltig arbetsorder');if(!await checkProjectMaterialReview(tenant(req),projectId))return fail(res,409,'Granska och spara materialpriser före fakturering.');const d=await invoiceData(id(req.params.id),tenant(req),req.body?.rot===true);if(!d)return fail(res,404,'Arbetsordern saknas');
 if(d.quoteId&&!['completed','invoiced'].includes(d.project.status))return fail(res,409,'Arbetsordern måste vara avslutad innan accepterad offert faktureras');
 if(d.withRot){
  const pn=String(req.body?.rot_personnummer||'').replace(/[^0-9]/g,'');
  const property=text(req.body?.rot_property,150),apartment=text(req.body?.rot_apartment,100);
  if(!/^\d{12}$/.test(pn)||!property)return fail(res,400,'Ange kundens personnummer (12 siffror) och fastighetsbeteckning eller bostadsrättsföreningens organisationsnummer');
  if(d.labor<=0)return fail(res,400,'ROT kräver positiv arbetskostnad. Kontrollera projekttid eller accepterad offert.');
  d.rotDetails={personnummer:pn,property,apartment};
 }const {rows}=await db.query("INSERT INTO invoice_drafts(company_id,project_id,subtotal,discount,rot_deduction,total,details,invoice_number) VALUES($1,$2,$3,$4,$5,$6,$7,'F-'||to_char(NOW(),'YYYY')||'-'||lpad(nextval('byggapp_invoice_seq')::text,6,'0')) RETURNING id,invoice_number,created_at",[tenant(req),id(req.params.id),d.subtotal,d.discount,d.rotDeduction,d.total,JSON.stringify(d)]);res.status(201).json(rows[0]);}));
app.get('/api/invoices/drafts',asyncRoute(async(req,res)=>{const {rows}=await db.query('SELECT i.id,i.project_id,i.total,i.created_at,i.invoice_number,i.status,p.project_number,p.title FROM invoice_drafts i JOIN projects p ON p.id=i.project_id AND p.company_id=i.company_id WHERE i.company_id=$1 ORDER BY i.id DESC LIMIT 200',[tenant(req)]);res.json(rows);}));

const PDFDocument=require('pdfkit');
const nodemailer=require('nodemailer');
function pdfBuffer(doc){return new Promise((resolve,reject)=>{const chunks=[];doc.on('data',x=>chunks.push(x));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);doc.end();});}
const kr=v=>Number(v||0).toLocaleString('sv-SE',{minimumFractionDigits:2,maximumFractionDigits:2})+' kr';
async function invoiceDocument(invoice,company,customer){
 const d=invoice.details;const doc=new PDFDocument({size:'A4',margin:48,info:{Title:'Faktura '+invoice.invoice_number}});
 const navy='#142238',ink='#263449',muted='#657489',light='#f3f6fa',lineColor='#e2e8f0';
 const issue=new Date(invoice.created_at),due=new Date(issue.getTime()+Number(company.payment_terms||30)*86400000);
 doc.rect(0,0,595,118).fill(navy);doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(29).text('FAKTURA',48,36);
 doc.font('Helvetica').fontSize(10).fillColor('#d9e2ef').text(invoice.invoice_number,49,78);
 if(company.logo_data&&/^data:image\/(png|jpeg);base64,/.test(company.logo_data)){try{doc.image(Buffer.from(company.logo_data.split(',')[1],'base64'),425,27,{fit:[120,67]});}catch{}}
 doc.fillColor(ink).font('Helvetica-Bold').fontSize(13).text(company.company_name||'',48,143,{width:240});
 doc.font('Helvetica').fontSize(9).fillColor(muted).text([company.street_address,company.postal_address,'Org.nr: '+(company.org_number||'Ej angivet'),company.email,company.phone].filter(Boolean).join('\n'),48,165,{width:245,lineGap:3});
 doc.font('Helvetica-Bold').fontSize(9).fillColor(muted).text('FAKTURERAS TILL',325,143);
 doc.font('Helvetica-Bold').fontSize(11).fillColor(ink).text(customer.name||'',325,162,{width:222});
 doc.font('Helvetica').fontSize(9).fillColor(muted).text([customer.address,customer.email].filter(Boolean).join('\n'),325,184,{width:222,lineGap:3});
 doc.roundedRect(48,252,499,75,7).fill(light);
 const meta=(x,label,value)=>{doc.fillColor(muted).font('Helvetica-Bold').fontSize(8).text(label,x,267,{width:150});doc.fillColor(ink).font('Helvetica').fontSize(10).text(value,x,285,{width:150});};
 meta(63,'FAKTURANUMMER',invoice.invoice_number);meta(238,'FAKTURADATUM',issue.toLocaleDateString('sv-SE'));meta(410,'FÖRFALLODAG',due.toLocaleDateString('sv-SE'));
 doc.fillColor(muted).font('Helvetica').fontSize(9).text('Projekt: '+(d.project.project_number||'')+' – '+(d.project.title||''),48,347,{width:499});
 const head=()=>{doc.roundedRect(48,377,499,30,5).fill(light);doc.fillColor(ink).font('Helvetica-Bold').fontSize(9).text('BESKRIVNING',60,387).text('BELOPP',427,387,{width:105,align:'right'});};head();
 let y=418;
 const row=(label,amount)=>{if(y>674){doc.addPage();y=75;doc.fillColor(ink).font('Helvetica-Bold').fontSize(9).text('BESKRIVNING',60,54).text('BELOPP',427,54,{width:105,align:'right'});}doc.fillColor(ink).font('Helvetica').fontSize(9).text(String(label),60,y,{width:350}).text(kr(amount),427,y,{width:105,align:'right'});doc.moveTo(48,y+23).lineTo(547,y+23).strokeColor(lineColor).stroke();y+=32;};
 row('Arbete ('+(d.billableMinutes/60).toLocaleString('sv-SE')+' debiterbara timmar)',d.labor);
 for(const m of d.materials||[])row(m.name+' × '+m.quantity+' '+m.unit,Number(m.quantity)*Number(m.unit_price));
 if(Number(d.vehicleCharge))row('Servicebil',d.vehicleCharge);
 if(Number(d.discount))row('Rabatt',-Number(d.discount));
 const base=Number(d.total),vatRate=Number(d.vatRate??company.vat_percent??25),vat=Math.round(base*vatRate)/100,rot=Number(d.rotDeduction||0),pay=Math.max(0,base+vat-rot);
 if(y>588){doc.addPage();y=90;}else y=Math.max(y+10,523);
 doc.fillColor(ink).font('Helvetica').fontSize(10).text('Belopp exklusive moms',280,y,{width:150}).text(kr(base),435,y,{width:98,align:'right'});y+=24;
 doc.text('Moms '+vatRate+' %',280,y,{width:150}).text(kr(vat),435,y,{width:98,align:'right'});y+=24;
 if(rot>0){doc.text('Preliminärt ROT-avdrag',280,y,{width:150}).text('− '+kr(rot),435,y,{width:98,align:'right'});y+=27;}
 doc.roundedRect(48,y+12,499,65,8).fill(navy);doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(13).text('ATT BETALA',65,y+34).fontSize(20).text(kr(pay),290,y+30,{width:240,align:'right'});
 doc.fillColor(muted).font('Helvetica').fontSize(9).text('Bankgiro: '+(company.bankgiro||'Ej angivet')+'   •   Ange fakturanummer vid betalning',48,747,{width:499});
 if(rot>0){
  const rd=d.rotDetails||{};
  doc.fontSize(8).text('ROT (preliminärt): Kund '+(rd.personnummer||'saknas')+' · Fastighet/BRF '+(rd.property||'saknas')+(rd.apartment?' · Lägenhet '+rd.apartment:''),48,715,{width:499});
  doc.fontSize(8).text('ROT-avdraget är preliminärt och förutsätter godkännande från Skatteverket.',48,766,{width:499});
 }
 return pdfBuffer(doc);
}
async function getInvoice(idValue,companyId){
 const {rows}=await db.query(`SELECT i.*,c.name company_name,c.org_number,c.street_address,c.postal_address,c.phone,c.email,c.bankgiro,c.payment_terms,c.vat_percent,c.logo_data,
 cu.name customer_name,cu.address customer_address,cu.email customer_email
 FROM invoice_drafts i JOIN projects p ON p.id=i.project_id AND p.company_id=i.company_id
 JOIN customers cu ON cu.id=p.customer_id AND cu.company_id=i.company_id
 JOIN (SELECT companies.id,companies.name,COALESCE(s.org_number,'') org_number,COALESCE(s.street_address,'') street_address,COALESCE(s.postal_address,'') postal_address,COALESCE(s.phone,'') phone,COALESCE(s.email,'') email,COALESCE(s.bankgiro,'') bankgiro,COALESCE(s.payment_terms,30) payment_terms,COALESCE(s.vat_percent,25) vat_percent,COALESCE(s.logo_data,'') logo_data FROM companies LEFT JOIN company_invoice_settings s ON s.company_id=companies.id) c ON c.id=i.company_id
 WHERE i.id=$1 AND i.company_id=$2`,[idValue,companyId]);return rows[0]||null;
}
app.get('/api/invoices/settings',asyncRoute(async(req,res)=>{
 const {rows}=await db.query(`SELECT c.name company_name,COALESCE(s.org_number,'') org_number,COALESCE(s.street_address,'') street_address,COALESCE(s.postal_address,'') postal_address,COALESCE(s.phone,'') phone,COALESCE(s.email,'') email,COALESCE(s.bankgiro,'') bankgiro,COALESCE(s.payment_terms,30) payment_terms,COALESCE(s.vat_percent,25) vat_percent,(COALESCE(s.logo_data,'')<>'') has_logo FROM companies c LEFT JOIN company_invoice_settings s ON s.company_id=c.id WHERE c.id=$1`,[tenant(req)]);res.json(rows[0]);
}));
app.put('/api/invoices/settings',asyncRoute(async(req,res)=>{
 const b=req.body||{};if(!Number.isInteger(Number(b.payment_terms))||Number(b.payment_terms)<1||Number(b.payment_terms)>120||!Number.isFinite(Number(b.vat_percent))||Number(b.vat_percent)<0||Number(b.vat_percent)>30)return fail(res,400,'Kontrollera betalningsvillkor och moms');
 const logo=typeof b.logo_data==='string'&&b.logo_data.length<300000&&/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(b.logo_data)?b.logo_data:null;
 await db.query(`INSERT INTO company_invoice_settings(company_id,org_number,street_address,postal_address,phone,email,bankgiro,payment_terms,vat_percent,logo_data)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::text,'')) ON CONFLICT(company_id) DO UPDATE SET org_number=EXCLUDED.org_number,street_address=EXCLUDED.street_address,postal_address=EXCLUDED.postal_address,phone=EXCLUDED.phone,email=EXCLUDED.email,bankgiro=EXCLUDED.bankgiro,payment_terms=EXCLUDED.payment_terms,vat_percent=EXCLUDED.vat_percent,logo_data=CASE WHEN $10::text IS NULL THEN company_invoice_settings.logo_data ELSE EXCLUDED.logo_data END`,[tenant(req),text(b.org_number,40),text(b.street_address,250),text(b.postal_address,250),text(b.phone,80),text(b.email,250),text(b.bankgiro,80),Number(b.payment_terms),Number(b.vat_percent),logo]);res.json({ok:true});
}));
app.get('/api/invoices/drafts/:id/pdf',asyncRoute(async(req,res)=>{
 const i=await getInvoice(id(req.params.id),tenant(req));if(!i)return fail(res,404,'Fakturan saknas');
 const pdf=await invoiceDocument(i,{...i,company_name:i.company_name},{name:i.customer_name,address:i.customer_address,email:i.customer_email});
 res.set('Content-Type','application/pdf');res.set('Content-Disposition',`attachment; filename="faktura-${i.invoice_number}.pdf"`);res.send(pdf);
}));
app.post('/api/invoices/drafts/:id/send',asyncRoute(async(req,res)=>{const previousDraft=await db.query('SELECT project_id,details FROM invoice_drafts WHERE id=$1 AND company_id=$2',[id(req.params.id),tenant(req)]);
 if(previousDraft.rowCount){const pid=Number(previousDraft.rows[0].project_id);
  if(!await checkProjectMaterialReview(tenant(req),pid))return fail(res,409,'Materialpriser har inte granskats – fakturan kan inte skickas.');
  const {rows:actual}=await db.query('SELECT name,quantity,unit,unit_price FROM materials WHERE company_id=$1 AND project_id=$2',[tenant(req),pid]);
  const billed=previousDraft.rows[0].details?.materials||[];
  const normalize=items=>items.map(x=>[String(x.name),Number(x.quantity),String(x.unit),Number(x.unit_price)]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if(actual.length&&JSON.stringify(normalize(actual))!==JSON.stringify(normalize(billed)))return fail(res,409,'Fakturautkastet innehåller andra materialpriser än de granskade. Skapa nytt utkast.');
 }
 if(req.body?.confirm!==true)return fail(res,400,'Bekräfta utskick av fakturan');
 const i=await getInvoice(id(req.params.id),tenant(req));if(!i)return fail(res,404,'Fakturan saknas');
 if(i.status==='sent')return fail(res,409,'Fakturan är redan skickad');
 if(!i.customer_email||!/^\S+@\S+\.\S+$/.test(i.customer_email))return fail(res,400,'Kunden saknar giltig e-postadress');
 if(!i.org_number||!i.bankgiro||!i.street_address||!i.postal_address)return fail(res,400,'Fyll i företagsuppgifter och bankgiro innan utskick');
 if(!process.env.SMTP_HOST||!process.env.SMTP_USER||!process.env.SMTP_PASS||!process.env.SMTP_FROM)return fail(res,503,'E-postutskick är inte konfigurerat (SMTP)');
 const pdf=await invoiceDocument(i,{...i,company_name:i.company_name},{name:i.customer_name,address:i.customer_address,email:i.customer_email});
 const transporter=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:Number(process.env.SMTP_PORT||587)===465,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});
 await transporter.sendMail({from:process.env.SMTP_FROM,to:i.customer_email,subject:'Faktura '+i.invoice_number+' från '+i.company_name,text:'Hej! Bifogat finns faktura '+i.invoice_number+'. Vänliga hälsningar, '+i.company_name,attachments:[{filename:'faktura-'+i.invoice_number+'.pdf',content:pdf}]});
 await db.query(`UPDATE invoice_drafts SET status='sent',sent_at=NOW(),recipient_email=$3 WHERE id=$1 AND company_id=$2`,[i.id,tenant(req),i.customer_email]);res.json({ok:true,recipient:i.customer_email});
}));

app.use('/api',(req,res)=>fail(res,404,'API-adressen finns inte'));
app.get('/login',(req,res)=>res.sendFile(path.join(__dirname,'../admin/index.html')));
app.get('/material-pricing-admin.js',(req,res)=>res.sendFile(path.join(__dirname,'../admin/material-pricing-admin.js')));
app.get('/dashboard',(req,res)=>res.sendFile(path.join(__dirname,'../admin/dashboard.html')));
app.get('/jobbrapporter',(req,res)=>res.sendFile(path.join(__dirname,'../admin/jobbrapporter.html')));
app.get('/narvaro',(req,res)=>res.sendFile(path.join(__dirname,'../admin/daglig-narvaro.html')));
app.get('/personal',(req,res)=>res.sendFile(path.join(__dirname,'../admin/personal.html')));
app.get('/',(req,res)=>res.redirect('/login'));
app.use((err,req,res,next)=>{console.error('Serverfel:',err.code||err.message);if(err.code==='23505')return fail(res,409,'Uppgiften finns redan eller du är redan incheckad');if(err.code==='23503')return fail(res,409,'Posten används av andra uppgifter');if(err.code==='23514'||err.code==='22P02')return fail(res,400,'Ogiltiga uppgifter');return fail(res,500,'Serverfel');});
const port=Number(process.env.PORT)||4000;
app.listen(port,'0.0.0.0',()=>console.log('Byggapp: http://localhost:'+port+'/login'));
