'use strict';
// Additional admin-only endpoints. Register AFTER existing daily-attendance-routes
// and BEFORE app.use('/api', admin) in backend/index.js.
const PDFDocument = require('pdfkit');
const zlib = require('zlib');
module.exports = function attendanceAdmin(app, db) {
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req,res,next)).catch(next);
  const onlyAdmin = (req,res,next) => req.user?.role==='admin' ? next() : res.status(403).json({error:'Endast administratör'});
  const monthValid = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(s||'');
  const company = req => req.user.companyId;
  const intId = x => Number.isSafeInteger(Number(x)) && Number(x)>0 ? Number(x) : null;
  const clean = (s,max=500) => String(s??'').trim().slice(0,max);
  const fail = (res, code, message) => res.status(code).json({error:message});
  const noCache = res => res.set('Cache-Control','no-store');
  const reportQuery = `
    SELECT a.id,a.user_id,u.full_name,u.email,a.check_in,a.check_out,
      a.manual_break_seconds,
      COALESCE(b.original_seconds,0)::float8 AS original_break_seconds,
      COALESCE(a.manual_break_seconds, b.original_seconds,0)::float8 AS break_seconds,
      GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(a.check_out,NOW())-a.check_in))
        - COALESCE(a.manual_break_seconds,b.original_seconds,0))::float8 AS worked_seconds,
      EXISTS(SELECT 1 FROM daily_attendance_edits e WHERE e.attendance_id=a.id AND e.company_id=a.company_id) AS corrected,
      COALESCE(r.ordinary_rate,0)::float8 AS hourly_rate
    FROM daily_attendance a
    JOIN app_users u ON u.id=a.user_id AND u.company_id=a.company_id
    LEFT JOIN employee_pay_rates r ON r.user_id=a.user_id AND r.company_id=a.company_id
    LEFT JOIN LATERAL (
      SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at,NOW())-started_at))) AS original_seconds
      FROM daily_attendance_breaks WHERE attendance_id=a.id
    ) b ON TRUE
    WHERE a.company_id=$1 AND a.check_in >= ($2::date AT TIME ZONE 'Europe/Stockholm')
      AND a.check_in < (($2::date + INTERVAL '1 month') AT TIME ZONE 'Europe/Stockholm')
      AND ($3::bigint IS NULL OR a.user_id=$3)
    ORDER BY a.check_in DESC,a.id DESC LIMIT 10001`;
  async function getReport(req,res) {
    const month = clean(req.query.month,7);
    if(!monthValid(month)) {fail(res,400,'Välj en giltig månad (ÅÅÅÅ-MM)');return null;}
    const userId = req.query.user_id ? intId(req.query.user_id) : null;
    if(req.query.user_id && !userId) {fail(res,400,'Ogiltig anställd');return null;}
    const {rows}=await db.query(reportQuery,[company(req),month+'-01',userId]);
    if(rows.length>10000){fail(res,422,'För många pass. Välj en anställd eller kontakta administratören.');return null;}
    return {month,rows};
  }
  app.get('/api/daily/admin/users',onlyAdmin,wrap(async(req,res)=>{
    noCache(res);
    const {rows}=await db.query(`SELECT id,full_name,email,role,active FROM app_users
       WHERE company_id=$1 AND role IN ('employee','contractor') ORDER BY full_name NULLS LAST,email`,[company(req)]);
    res.json(rows);
  }));
  app.get('/api/daily/admin/report',onlyAdmin,wrap(async(req,res)=>{
    const data=await getReport(req,res);if(!data)return;
    noCache(res);res.json(data);
  }));
  app.get('/api/daily/admin/edits/:id',onlyAdmin,wrap(async(req,res)=>{
    const attendanceId=intId(req.params.id);if(!attendanceId)return fail(res,400,'Ogiltig registrering');
    const {rows}=await db.query(`SELECT e.*,u.full_name AS editor_name,u.email AS editor_email
      FROM daily_attendance_edits e JOIN app_users u ON u.id=e.edited_by AND u.company_id=e.company_id
      WHERE e.company_id=$1 AND e.attendance_id=$2 ORDER BY e.created_at DESC`,[company(req),attendanceId]);
    noCache(res);res.json(rows);
  }));
  app.put('/api/daily/admin/attendance/:id',onlyAdmin,wrap(async(req,res)=>{
    const attendanceId=intId(req.params.id), b=req.body||{};
    const reason=clean(b.reason,500);
    if(!attendanceId)return fail(res,400,'Ogiltig registrering');
    if(reason.length<5)return fail(res,400,'Ange anledning till ändringen (minst 5 tecken)');
    const start=new Date(b.check_in),end=new Date(b.check_out);
    const min=Number(b.break_minutes);
    if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||
      !Number.isInteger(min)||min<0||min>2160 || end<=start ||
      end-start>36*3600*1000 || min*60000>end-start || end.getTime()>Date.now()+60000)
      return fail(res,400,'Kontrollera starttid, sluttid och rast. Max 36 timmar per pass.');
    const client=await db.connect();
    try {
      await client.query('BEGIN');
      const {rows:[old]}=await client.query(`SELECT id,company_id,user_id,check_in,check_out,manual_break_seconds
        FROM daily_attendance WHERE id=$1 AND company_id=$2 FOR UPDATE`,[attendanceId,company(req)]);
      if(!old){await client.query('ROLLBACK');return fail(res,404,'Arbetspasset saknas');}
      if(!old.check_out){await client.query('ROLLBACK');return fail(res,409,'Avsluta arbetspasset innan du rättar tider');}
      await client.query(`UPDATE daily_attendance SET check_in=$3, check_out=$4, manual_break_seconds=$5
        WHERE id=$1 AND company_id=$2`,[attendanceId,company(req),start,end,min*60]);
      await client.query(`INSERT INTO daily_attendance_edits
        (company_id,attendance_id,edited_by,previous_check_in,previous_check_out,previous_manual_break_seconds,
         new_check_in,new_check_out,new_manual_break_seconds,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [company(req),attendanceId,req.user.userId,old.check_in,old.check_out,old.manual_break_seconds,start,end,min*60,reason]);
      await client.query('COMMIT');
      noCache(res);res.json({ok:true,id:attendanceId});
    }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
  }));
  const secs = s => Math.round(Number(s||0));
  const fmt = s => (secs(s)/3600).toFixed(2);
  const when = x => x ? new Date(x).toLocaleString('sv-SE',{timeZone:'Europe/Stockholm',hour12:false}) : '';
  const calculate = rows => {
    const map=new Map();
    for(const r of rows){if(!r.check_out)continue;const k=String(r.user_id);
      if(!map.has(k))map.set(k,{user_id:r.user_id,name:r.full_name||r.email,email:r.email,seconds:0,break_seconds:0,shifts:0,hourly_rate:Number(r.hourly_rate||0)});
      const x=map.get(k);x.seconds+=Number(r.worked_seconds);x.break_seconds+=Number(r.break_seconds);x.shifts++;
    }
    return [...map.values()].sort((a,b)=>a.name.localeCompare(b.name,'sv'));
  };
  app.get('/api/daily/admin/payroll',onlyAdmin,wrap(async(req,res)=>{
    const data=await getReport(req,res);if(!data)return;
    noCache(res);res.json({month:data.month,summary:calculate(data.rows),note:'Preliminärt underlag med ordinarie timlön. Jour, OB, övertid, semesterersättning, skatt och frånvaro måste kontrolleras separat.'});
  }));
  const safeSpreadsheet = x => {let s=String(x??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return s;};
  const escapeCsv = x => '"'+safeSpreadsheet(x).replace(/"/g,'""')+'"';
  const excelRows = data => {
    const headers=['Anställd','E-post','Start','Slut','Rast timmar','Arbetstid timmar','Status','Rättad','Timlön kr','Preliminärt belopp kr'];
    const rows=data.rows.map(r=>[r.full_name||r.email,r.email,when(r.check_in),when(r.check_out),fmt(r.break_seconds),r.check_out?fmt(r.worked_seconds):'',r.check_out?'Avslutad':'Pågår',r.corrected?'Ja':'Nej',Number(r.hourly_rate).toFixed(2),r.check_out?(Number(r.hourly_rate)*Number(r.worked_seconds)/3600).toFixed(2):'']);
    return [headers,...rows];
  };
  app.get('/api/daily/admin/export/csv',onlyAdmin,wrap(async(req,res)=>{
    const data=await getReport(req,res);if(!data)return;
    const contents='\uFEFF'+excelRows(data).map(row=>row.map(escapeCsv).join(';')).join('\r\n');
    noCache(res);res.type('text/csv; charset=utf-8');res.attachment('narvaro-'+data.month+'.csv');res.send(contents);
  }));
  // Minimal genuine XLSX writer using only Node built-ins (no new npm dependency).
  function crc32(buf){let c=0xffffffff;for(const b of buf){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
  function zip(items){const locals=[],centrals=[];let offset=0;for(const [name,contents] of items){
    const n=Buffer.from(name),raw=Buffer.from(contents),packed=zlib.deflateRawSync(raw),crc=crc32(raw);
    const loc=Buffer.alloc(30);loc.writeUInt32LE(0x04034b50,0);loc.writeUInt16LE(20,4);loc.writeUInt16LE(0,6);loc.writeUInt32LE(crc,14);loc.writeUInt32LE(packed.length,18);loc.writeUInt32LE(raw.length,22);loc.writeUInt16LE(n.length,26);
    locals.push(loc,n,packed);
    const cen=Buffer.alloc(46);cen.writeUInt32LE(0x02014b50,0);cen.writeUInt16LE(20,4);cen.writeUInt16LE(20,6);cen.writeUInt16LE(0,8);cen.writeUInt32LE(crc,16);cen.writeUInt32LE(packed.length,20);cen.writeUInt32LE(raw.length,24);cen.writeUInt16LE(n.length,28);cen.writeUInt32LE(offset,42);
    centrals.push(cen,n);offset+=loc.length+n.length+packed.length;
  }const c=Buffer.concat(centrals);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(items.length,8);end.writeUInt16LE(items.length,10);end.writeUInt32LE(c.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,c,end]);}
  const xml=s=>String(s??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[ch]));
  function xlsx(table){
    const sheet='<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="16"/><sheetData>'+table.map((r,i)=>'<row r="'+(i+1)+'">'+r.map((v,j)=>{
      let x=j+1,col='';while(x){x--;col=String.fromCharCode(65+x%26)+col;x=Math.floor(x/26);}return '<c r="'+col+(i+1)+'" t="inlineStr"><is><t>'+xml(safeSpreadsheet(v))+'</t></is></c>';
    }).join('')+'</row>').join('')+'</sheetData></worksheet>';
    return zip([
      ['[Content_Types].xml','<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
      ['_rels/.rels','<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ['xl/workbook.xml','<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Närvaro" sheetId="1" r:id="rId1"/></sheets></workbook>'],
      ['xl/_rels/workbook.xml.rels','<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
      ['xl/worksheets/sheet1.xml','<?xml version="1.0" encoding="UTF-8"?>'+sheet]
    ]);
  }
  app.get('/api/daily/admin/export/xlsx',onlyAdmin,wrap(async(req,res)=>{
    const data=await getReport(req,res);if(!data)return;
    noCache(res);res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.attachment('narvaro-'+data.month+'.xlsx');res.send(xlsx(excelRows(data)));
  }));
  app.get('/api/daily/admin/export/pdf',onlyAdmin,wrap(async(req,res)=>{
    const data=await getReport(req,res);if(!data)return;
    const summary=calculate(data.rows);
    noCache(res);res.type('application/pdf');res.attachment('narvaro-'+data.month+'.pdf');
    const doc=new PDFDocument({size:'A4',layout:'landscape',margin:38});doc.pipe(res);
    doc.font('Helvetica-Bold').fontSize(20).text('BYGGAPP - Narvarorapport '+data.month);
    doc.font('Helvetica').fontSize(9).fillColor('#666').text('Avslutade arbetspass. Ej slutlig lonerapport. Alla tider visas i svensk tid.');doc.moveDown();
    const headings=['Anstalld','Pass','Arbete (h)','Rast (h)','Timlon','Preliminar bruttolon'];
    const widths=[195,55,98,95,75,130];const x0=38;
    function drawRow(vals,y,bold=false){let x=x0;doc.font(bold?'Helvetica-Bold':'Helvetica').fontSize(9).fillColor('#222');vals.forEach((v,i)=>{doc.text(String(v),x,y,{width:widths[i]-8,ellipsis:true});x+=widths[i];});}
    let y=doc.y+10;drawRow(headings,y,true);y+=25;
    for(const r of summary){if(y>doc.page.height-70){doc.addPage();y=48;drawRow(headings,y,true);y+=24;}
      drawRow([r.name,r.shifts,fmt(r.seconds),fmt(r.break_seconds),r.hourly_rate.toFixed(2)+' kr',(r.seconds/3600*r.hourly_rate).toFixed(2)+' kr'],y);y+=22;
    }
    if(!summary.length)doc.text('Ingen avslutad arbetstid for denna manad.',38,y);
    doc.end();
  }));
};
