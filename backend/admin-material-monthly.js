'use strict';
// REGISTER after the existing /api auth middleware and BEFORE app.use('/api',admin).
module.exports = (app, db) => {
  const wrap = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
  const bad = (res, status, msg) => res.status(status).json({error:msg});
  const allowed = (req,res,next) => ['employee','contractor','admin'].includes(req.user.role) ? next() : bad(res,403,'Ingen behörighet');
  const id = x => Number.isSafeInteger(Number(x)) && Number(x)>0 ? Number(x) : null;
  const str = (v,n) => typeof v === 'string' ? v.trim().slice(0,n) : '';
  app.get('/api/daily/monthly',allowed,wrap(async(req,res)=>{
    const month=String(req.query.month||'');
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return bad(res,400,'Ogiltig månad');
    const {rows}=await db.query(`
      SELECT a.id,a.check_in,a.check_out,
       COALESCE(b.seconds,0)::float8 AS break_seconds,
       GREATEST(0,EXTRACT(EPOCH FROM (a.check_out-a.check_in))-
        COALESCE(b.seconds,0)-COALESCE(a.manual_break_seconds,0))::float8 AS worked_seconds,
       COALESCE(a.manual_break_seconds,0)::float8 AS manual_break_seconds
      FROM daily_attendance a
      LEFT JOIN LATERAL (SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at,a.check_out)-started_at))) seconds
        FROM daily_attendance_breaks WHERE attendance_id=a.id) b ON TRUE
      WHERE a.company_id=$1 AND a.user_id=$2 AND a.check_out IS NOT NULL
       AND a.check_in >= (($3::text||'-01')::date AT TIME ZONE 'Europe/Stockholm')
       AND a.check_in < ((($3::text||'-01')::date+INTERVAL '1 month') AT TIME ZONE 'Europe/Stockholm')
      ORDER BY a.check_in ASC`,[req.user.companyId,req.user.userId,month]);
    // Work time is counted from DAILY attendance, not project times.
    const totalSeconds=rows.reduce((n,r)=>n+Number(r.worked_seconds),0);
    const breakSeconds=rows.reduce((n,r)=>n+Number(r.break_seconds)+Number(r.manual_break_seconds),0);
    res.set('Cache-Control','no-store').json({month,total_seconds:totalSeconds,break_seconds:breakSeconds,days:rows.length,entries:rows});
  }));
  // Register the admin editor BEFORE generic PUT/DELETE routes if possible. Authentication and tenant scoping come from index.js.
  app.put('/api/materials/:id/edit',allowed,wrap(async(req,res)=>{
    if(req.user.role!=='admin')return bad(res,403,'Endast administratör');
    const materialId=id(req.params.id),b=req.body||{};
    const name=str(b.name,250),unit=str(b.unit,20)||'st',rsk=str(b.rsk,100),supplier=str(b.supplier,150);
    const qty=Number(b.quantity),price=Number(b.unit_price),purchase=Number(b.purchase_price??0);
    if(!materialId||!name||!Number.isFinite(qty)||qty<=0||qty>100000||!Number.isFinite(price)||price<0||price>1e7||!Number.isFinite(purchase)||purchase<0||purchase>1e7)return bad(res,400,'Kontrollera material, antal och priser');
    const {rows}=await db.query(`UPDATE materials m SET name=$3,quantity=$4,unit=$5,unit_price=$6,purchase_price=$7,rsk=$8,supplier=$9
      WHERE m.id=$1 AND m.company_id=$2 AND NOT EXISTS
       (SELECT 1 FROM invoice_drafts i WHERE i.project_id=m.project_id AND i.company_id=m.company_id AND i.status='sent')
      RETURNING m.id,m.name,m.quantity,m.unit,m.unit_price,m.purchase_price,m.rsk,m.supplier`,
      [materialId,req.user.companyId,name,qty,unit,price,purchase,rsk,supplier]);
    if(!rows.length)return bad(res,409,'Materialet saknas eller arbetsordern har redan en skickad faktura');
    res.json(rows[0]);
  }));
};
