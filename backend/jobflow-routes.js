// Byggapp – arbetsflöde för tilldelade jobb. Alla /api-rutter skyddas av index.js auth.
const express=require('express');
module.exports=function(app,db){
 const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
 const validId=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
 const allowed=req=>['employee','contractor'].includes(req.user.role);
 const deny=(res,status,msg)=>res.status(status).json({error:msg});
 const company=req=>req.user.companyId;
 const user=req=>req.user.userId;
 async function assigned(req,projectId){
  const r=await db.query(`SELECT p.id,p.status FROM projects p JOIN project_assignments a ON a.project_id=p.id AND a.company_id=p.company_id
   WHERE p.id=$1 AND p.company_id=$2 AND a.user_id=$3`,[projectId,company(req),user(req)]);
  return r.rows[0];
 }
 // Schemalagda arbetsorder med aktuellt arbetspass och raststatus.
 app.get('/api/staff/jobflow',wrap(async(req,res)=>{
  if(!allowed(req))return deny(res,403,'Endast personal');
  const {rows}=await db.query(`SELECT p.id,p.title,p.project_number,p.description,p.status,p.scheduled_start,p.scheduled_end,
   c.name customer_name,c.address customer_address,
   (SELECT t.id FROM time_entries t WHERE t.company_id=p.company_id AND t.user_id=$2 AND t.project_id=p.id AND t.check_out IS NULL ORDER BY t.id DESC LIMIT 1) active_time_id,
   (SELECT b.id FROM time_breaks b JOIN time_entries t ON t.id=b.time_entry_id WHERE t.project_id=p.id AND t.company_id=p.company_id AND t.user_id=$2 AND t.check_out IS NULL AND b.ended_at IS NULL LIMIT 1) active_break_id,
   EXISTS (SELECT 1 FROM job_reports r WHERE r.company_id=p.company_id AND r.project_id=p.id AND r.user_id=$2) reported
   FROM project_assignments a JOIN projects p ON p.id=a.project_id AND p.company_id=a.company_id
   LEFT JOIN customers c ON c.id=p.customer_id AND c.company_id=p.company_id
   WHERE a.company_id=$1 AND a.user_id=$2
   ORDER BY CASE WHEN p.status IN ('completed','invoiced') OR EXISTS
      (SELECT 1 FROM job_reports r WHERE r.company_id=p.company_id AND r.project_id=p.id AND r.user_id=$2)
     THEN 2 WHEN EXISTS
      (SELECT 1 FROM time_entries t WHERE t.company_id=p.company_id AND t.user_id=$2 AND t.project_id=p.id AND t.check_out IS NULL)
     THEN 0 ELSE 1 END,
     p.scheduled_start ASC NULLS LAST, p.id ASC LIMIT 200`,[company(req),user(req)]);
  res.json(rows);
 }));
 // Ladda upp foton (högst 6/person och jobb). Rå bytes, inte lokal disk (Render har flyktigt filsystem).
 app.post('/api/staff/jobs/:id/photos',express.raw({type:['image/jpeg','image/png','image/webp'],limit:'2mb'}),wrap(async(req,res)=>{
  if(!allowed(req))return deny(res,403,'Endast personal');
  const projectId=validId(req.params.id),p=await assigned(req,projectId);
  if(!p||!['open','ongoing','paused'].includes(p.status))return deny(res,404,'Arbetsordern är inte tillgänglig');
  const type=req.headers['content-type']?.split(';')[0]; const data=req.body;
  if(!Buffer.isBuffer(data)||!data.length||data.length>2*1024*1024)return deny(res,400,'Bild saknas eller är för stor (max 2 MB)');
  const jpeg=type==='image/jpeg'&&data[0]===255&&data[1]===216&&data[2]===255;
  const png=type==='image/png'&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const webp=type==='image/webp'&&data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP';
  if(!jpeg&&!png&&!webp)return deny(res,400,'Endast giltiga JPG, PNG eller WebP-bilder');
  const {rows}=await db.query(`INSERT INTO job_photos(company_id,project_id,user_id,content_type,photo_data)
   SELECT $1,$2,$3,$4,$5 WHERE (SELECT COUNT(*) FROM job_photos WHERE company_id=$1 AND project_id=$2 AND user_id=$3)<6 RETURNING id`,
   [company(req),projectId,user(req),type,data]);
  if(!rows.length)return deny(res,409,'Högst 6 bilder per jobb');res.status(201).json(rows[0]);
 }));
 app.get('/api/staff/jobs/:id/photos',wrap(async(req,res)=>{
  if(!allowed(req))return deny(res,403,'Endast personal');
  const projectId=validId(req.params.id);if(!await assigned(req,projectId))return deny(res,404,'Arbetsordern saknas');
  const {rows}=await db.query('SELECT id,created_at FROM job_photos WHERE company_id=$1 AND project_id=$2 AND user_id=$3 ORDER BY id',[company(req),projectId,user(req)]);res.json(rows);
 }));
 app.delete('/api/staff/jobs/:project/photos/:photo',wrap(async(req,res)=>{
  if(!allowed(req))return deny(res,403,'Endast personal');
  const p=validId(req.params.project),ph=validId(req.params.photo);const assignment=await assigned(req,p);
  if(!assignment||!['open','ongoing','paused'].includes(assignment.status))return deny(res,403,'Arbetsordern är avslutad');
  const {rowCount}=await db.query('DELETE FROM job_photos WHERE id=$1 AND company_id=$2 AND project_id=$3 AND user_id=$4',[ph,company(req),p,user(req)]);
  if(!rowCount)return deny(res,404,'Bilden finns inte');res.json({ok:true});
 }));
 // Avsluta: tid, materialrader och arbetsbeskrivning sparas i samma transaktion.
 app.post('/api/staff/jobs/:id/complete',wrap(async(req,res)=>{
  if(!allowed(req))return deny(res,403,'Endast personal');
  const pid=validId(req.params.id),description=String(req.body?.description||'').trim();
  const materials=req.body?.materials;
  if(!pid||description.length<3||description.length>5000)return deny(res,400,'Beskriv arbetet (3–5000 tecken)');
  if(!Array.isArray(materials)||materials.length>30)return deny(res,400,'Max 30 materialrader');
  for(const m of materials){if(typeof m.name!=='string'||!m.name.trim()||m.name.length>250||!Number.isFinite(Number(m.quantity))||Number(m.quantity)<=0||Number(m.quantity)>100000||!['st','m','m2','kg','l','förp'].includes(m.unit))return deny(res,400,'Kontrollera materialnamn, antal och enhet');}
  const client=await db.connect();
  try{
   await client.query('BEGIN');
   const {rows:[p]}=await client.query(`SELECT p.id,p.status FROM projects p JOIN project_assignments a ON a.project_id=p.id AND a.company_id=p.company_id
    WHERE p.id=$1 AND p.company_id=$2 AND a.user_id=$3 FOR UPDATE OF p`,[pid,company(req),user(req)]);
   if(!p||!['open','ongoing'].includes(p.status)){await client.query('ROLLBACK');return deny(res,409,'Arbetsordern saknas eller är pausad/avslutad');}
   const {rows:[active]}=await client.query(`SELECT id FROM time_entries WHERE company_id=$1 AND user_id=$2 AND project_id=$3 AND check_out IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE`,[company(req),user(req),pid]);
   if(!active){await client.query('ROLLBACK');return deny(res,409,'Starta jobbet innan du avslutar det');}
   const {rowCount:paused}=await client.query('SELECT 1 FROM time_breaks WHERE time_entry_id=$1 AND ended_at IS NULL LIMIT 1',[active.id]);
   if(paused){await client.query('ROLLBACK');return deny(res,409,'Avsluta rasten innan du slutför jobbet');}
   const {rowCount:exists}=await client.query('SELECT 1 FROM job_reports WHERE company_id=$1 AND project_id=$2 AND user_id=$3',[company(req),pid,user(req)]);
   if(exists){await client.query('ROLLBACK');return deny(res,409,'Jobbet har redan rapporterats');}
   await client.query(`UPDATE time_entries t SET check_out=NOW(),break_minutes=LEAST(FLOOR(EXTRACT(EPOCH FROM (NOW()-t.check_in))/60)::int,
    COALESCE((SELECT FLOOR(SUM(EXTRACT(EPOCH FROM (b.ended_at-b.started_at)))/60)::int FROM time_breaks b WHERE b.time_entry_id=t.id),0)) WHERE t.id=$1`,[active.id]);
   const {rows:[report]}=await client.query('INSERT INTO job_reports(company_id,project_id,user_id,description) VALUES($1,$2,$3,$4) RETURNING id',[company(req),pid,user(req),description]);
   for(const m of materials){const {rows:[item]}=await client.query(`INSERT INTO materials(company_id,project_id,name,quantity,unit,unit_price,purchase_price,source,rsk,supplier)
    VALUES($1,$2,$3,$4,$5,0,0,'vehicle',$6,'') RETURNING id`,[company(req),pid,m.name.trim(),Number(m.quantity),m.unit,String(m.rsk||'').slice(0,100)]);
    await client.query('INSERT INTO job_report_materials(report_id,material_id) VALUES($1,$2)',[report.id,item.id]);}
   // Stäng inte en arbetsorder innan ALLA tilldelade anställda har rapporterat klart.
   await client.query(`UPDATE projects p SET status='completed' WHERE p.id=$1 AND p.company_id=$2 AND NOT EXISTS
    (SELECT 1 FROM project_assignments a WHERE a.project_id=p.id AND a.company_id=p.company_id AND NOT EXISTS
    (SELECT 1 FROM job_reports r WHERE r.company_id=a.company_id AND r.project_id=a.project_id AND r.user_id=a.user_id))`,[pid,company(req)]);
   await client.query('COMMIT');res.json({ok:true});
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
 }));
 // Admin – jobbresultat, material och bilder.
 app.get('/api/job-reports',wrap(async(req,res)=>{
  if(req.user.role!=='admin')return deny(res,403,'Endast administratör');
  const {rows}=await db.query(`SELECT r.id,r.project_id,r.description,r.completed_at,p.title,p.project_number,
    u.full_name,u.email,(SELECT COUNT(*)::int FROM job_photos ph WHERE ph.company_id=r.company_id AND ph.project_id=r.project_id AND ph.user_id=r.user_id) photo_count,
    (SELECT COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (t.check_out-t.check_in))/60 - COALESCE(t.break_minutes,0))),0)::float8
     FROM time_entries t WHERE t.company_id=r.company_id AND t.project_id=r.project_id AND t.user_id=r.user_id AND t.check_out IS NOT NULL) worked_minutes
    FROM job_reports r JOIN projects p ON p.id=r.project_id AND p.company_id=r.company_id
    JOIN app_users u ON u.id=r.user_id AND u.company_id=r.company_id WHERE r.company_id=$1 ORDER BY r.completed_at DESC LIMIT 300`,[company(req)]);res.json(rows);
 }));
 app.get('/api/job-reports/:id/materials',wrap(async(req,res)=>{
  if(req.user.role!=='admin')return deny(res,403,'Endast administratör');
  const {rows:[report]}=await db.query('SELECT project_id FROM job_reports WHERE id=$1 AND company_id=$2',[validId(req.params.id),company(req)]);
  if(!report)return deny(res,404,'Rapport saknas');
  const {rows}=await db.query('SELECT m.name,m.quantity,m.unit,m.rsk FROM job_report_materials rm JOIN materials m ON m.id=rm.material_id AND m.company_id=$2 WHERE rm.report_id=$1 ORDER BY m.id',[validId(req.params.id),company(req)]);res.json(rows);
 }));
 app.get('/api/job-reports/:id/photos',wrap(async(req,res)=>{
  if(req.user.role!=='admin')return deny(res,403,'Endast administratör');
  const {rows:[report]}=await db.query('SELECT project_id,user_id FROM job_reports WHERE id=$1 AND company_id=$2',[validId(req.params.id),company(req)]);
  if(!report)return deny(res,404,'Rapport saknas');
  const {rows}=await db.query('SELECT id,created_at FROM job_photos WHERE company_id=$1 AND project_id=$2 AND user_id=$3 ORDER BY id',[company(req),report.project_id,report.user_id]);res.json(rows);
 }));
 app.get('/api/job-photos/:photo',wrap(async(req,res)=>{
  const ph=validId(req.params.photo);if(!ph)return deny(res,400,'Fel bild-ID');
  const {rows:[photo]}=await db.query('SELECT company_id,project_id,user_id,content_type,photo_data FROM job_photos WHERE id=$1 AND company_id=$2',[ph,company(req)]);
  if(!photo)return deny(res,404,'Bilden finns inte');
  if(req.user.role!=='admin'){
   if(!allowed(req)||Number(photo.user_id)!==Number(user(req))||!await assigned(req,photo.project_id))return deny(res,403,'Ingen behörighet');
  }
  res.set('Content-Type',photo.content_type);res.set('Cache-Control','private, no-store');res.send(photo.photo_data);
 }));
};
