// Mount after app.use('/api', admin), using the existing auth and tenant protections.
const PDFDocument=require('pdfkit');
const nodemailer=require('nodemailer');
module.exports=(app,db)=>{
 const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
 const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
 const bad=(res,msg,code=400)=>res.status(code).json({error:msg});
 const money=v=>Number(v||0).toLocaleString('sv-SE',{minimumFractionDigits:2,maximumFractionDigits:2})+' kr';
 const amount=v=>{const n=Number(v);return Number.isFinite(n)&&n>=0&&n<=100000000?Math.round(n*100)/100:null};
 const quoteQuery=`SELECT q.*,p.project_number,p.title,p.status AS project_status,c.name AS customer_name,c.email AS customer_email,c.address AS customer_address
 FROM project_quotes q JOIN projects p ON p.id=q.project_id AND p.company_id=q.company_id
 JOIN customers c ON c.id=p.customer_id AND c.company_id=p.company_id WHERE q.company_id=$1`;
 const list=async(req)=> (await db.query(quoteQuery+' ORDER BY q.id DESC LIMIT 300',[req.user.companyId])).rows;
 const get=async(req,qid)=> (await db.query(quoteQuery+' AND q.id=$2',[req.user.companyId,qid])).rows[0];
 const settings=async(cid)=> (await db.query(`SELECT c.name, s.org_number,s.street_address,s.postal_address,s.email,s.phone,s.vat_percent
 FROM companies c LEFT JOIN company_invoice_settings s ON s.company_id=c.id WHERE c.id=$1`,[cid])).rows[0];
 const calc=q=>{const rows=q.material_rows||[];const mat=rows.reduce((x,r)=>x+Number(r.quantity)*Number(r.unit_price),0);
  const labor=Number(q.labor_amount),other=Number(q.other_amount),subtotal=labor+mat+other;
  const discount=subtotal*Number(q.discount_percent)/100;
  const vat=Number(q.vat_rate);return {materialTotal:mat,subtotal,discount,totalEx:subtotal-discount,vat,totalInc:(subtotal-discount)*(1+vat/100)};
 };
 async function renderPdf(q,cid){const company=await settings(cid);const sums=calc(q);
  const doc=new PDFDocument({size:'A4',margin:48});const chunks=[];
  doc.on('data',chunk=>chunks.push(chunk));const ready=new Promise((resolve,reject)=>{doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject)});
  let y=55;doc.font('Helvetica-Bold').fontSize(22).text('OFFERT',48,y);y+=45;
  doc.font('Helvetica').fontSize(10).text('Offertnummer: O-'+q.id,48,y).text('Datum: '+new Date(q.created_at).toLocaleDateString('sv-SE'),310,y);y+=30;
  doc.font('Helvetica-Bold').fontSize(12).text(company?.name||'',48,y);y+=24;
  doc.font('Helvetica').fontSize(10).text([company?.org_number,company?.street_address,company?.postal_address].filter(Boolean).join(' | '),48,y,{width:500});y+=40;
  doc.font('Helvetica-Bold').fontSize(12).text('Kund: '+q.customer_name,48,y);y+=22;
  doc.font('Helvetica').fontSize(10).text(q.customer_address||'',48,y);y+=30;
  doc.font('Helvetica-Bold').fontSize(12).text(q.project_number+' – '+q.title,48,y);y+=27;
  doc.font('Helvetica').fontSize(10).text(q.description||'Offert för arbete och material',48,y,{width:490});y=doc.y+24;
  const row=(label,value)=>{if(y>700){doc.addPage();y=55;}doc.font('Helvetica').fontSize(10).text(label,48,y,{width:370}).text(money(value),425,y,{width:120,align:'right'});y+=24};
  row('Arbete',q.labor_amount);for(const m of q.material_rows||[])row(m.name+' ('+m.quantity+' '+m.unit+')',Number(m.quantity)*Number(m.unit_price));
  if(Number(q.other_amount))row('Övrigt / servicebil',q.other_amount);
  if(sums.discount)row('Rabatt',-sums.discount);
  y+=12;doc.font('Helvetica-Bold');row('Summa exkl. moms',sums.totalEx);row('Moms '+sums.vat+' %',sums.totalInc-sums.totalEx);row('Totalt inkl. moms',sums.totalInc);
  y+=26;doc.font('Helvetica').fontSize(9).text('Offert – ej faktura. ROT prövas separat i samband med fakturering och ingår inte i offerten.',48,y,{width:490});
  doc.end();return ready;
 }
 app.get('/api/quotes',asyncRoute(async(req,res)=>res.json(await list(req))));
 app.post('/api/quotes',asyncRoute(async(req,res)=>{
  const b=req.body||{},projectId=id(b.project_id),labor=amount(b.labor_amount),other=amount(b.other_amount||0),discount=amount(b.discount_percent||0);
  if(!projectId||labor===null||other===null||discount===null||discount>100)return bad(res,'Kontrollera projekt och belopp');
  if(!Array.isArray(b.material_rows)||b.material_rows.length>100)return bad(res,'Material ska anges som högst 100 rader');
  const rows=[];
  for(const r of b.material_rows){const name=String(r.name||'').trim().slice(0,250),qty=amount(r.quantity),price=amount(r.unit_price);
    if(!name||qty===null||qty===0||price===null)return bad(res,'Materialrad måste ha namn, antal och pris');
    rows.push({name,quantity:qty,unit:String(r.unit||'st').trim().slice(0,20),unit_price:price});
  }
  const cfg=await settings(req.user.companyId);const vat=amount(cfg?.vat_percent??25);
  if(vat===null||vat>30)return bad(res,'Felaktig momsinställning');
  const result=await db.query(`INSERT INTO project_quotes(company_id,project_id,description,labor_amount,material_rows,other_amount,discount_percent,vat_rate)
   SELECT $1,p.id,$3,$4,$5::jsonb,$6,$7,$8 FROM projects p WHERE p.company_id=$1 AND p.id=$2
   RETURNING id,status`,[req.user.companyId,projectId,String(b.description||'').slice(0,3000),labor,JSON.stringify(rows),other,discount,vat]);
  if(!result.rowCount)return bad(res,'Arbetsordern finns inte',404);
  res.status(201).json(result.rows[0]);
 }));
 app.get('/api/quotes/:id/pdf',asyncRoute(async(req,res)=>{const q=await get(req,id(req.params.id));if(!q)return bad(res,'Offert saknas',404);
  res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="offert-${q.id}.pdf"`);res.send(await renderPdf(q,req.user.companyId));
 }));
 app.post('/api/quotes/:id/send',asyncRoute(async(req,res)=>{
  if(req.body?.confirm!==true)return bad(res,'Bekräfta utskick');const q=await get(req,id(req.params.id));
  if(!q)return bad(res,'Offert saknas',404);if(q.status!=='draft'&&q.status!=='sent')return bad(res,'Offerten är redan beslutad',409);
  if(!q.customer_email||!/^\S+@\S+\.\S+$/.test(q.customer_email))return bad(res,'Kunden saknar giltig e-post');
  const pdf=await renderPdf(q,req.user.companyId);
  if(process.env.RESEND_API_KEY){
   const from=process.env.RESEND_FROM||process.env.SMTP_FROM;
   if(!from)return bad(res,'RESEND_FROM saknas på Render',503);
   const response=await fetch('https://api.resend.com/emails',{
    method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({from,to:[q.customer_email],subject:'Offert '+q.project_number,
     text:'Hej! Bifogat finns vår offert för '+q.title+'. Vänliga hälsningar.',
     attachments:[{filename:'offert-'+q.id+'.pdf',content:pdf.toString('base64')} ]})
   });
   if(!response.ok){const msg=(await response.text()).slice(0,250);return bad(res,'E-postleverantören avvisade utskicket: '+msg,502)}
  } else {
   if(!process.env.SMTP_HOST||!process.env.SMTP_USER||!process.env.SMTP_PASS||!process.env.SMTP_FROM)
    return bad(res,'E-post är inte konfigurerad. Använd RESEND_API_KEY + RESEND_FROM på gratis Render eller SMTP på betald server.',503);
   const port=Number(process.env.SMTP_PORT||587);
   const transport=nodemailer.createTransport({host:process.env.SMTP_HOST,port,secure:port===465,
    auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});
   await transport.sendMail({from:process.env.SMTP_FROM,to:q.customer_email,subject:'Offert '+q.project_number,
    text:'Hej! Bifogat finns vår offert för '+q.title+'. Vänliga hälsningar.',
    attachments:[{filename:'offert-'+q.id+'.pdf',content:pdf}]});
  }
  await db.query(`UPDATE project_quotes SET status='sent',sent_at=NOW(),updated_at=NOW() WHERE id=$1 AND company_id=$2`,[q.id,req.user.companyId]);
  res.json({ok:true,recipient:q.customer_email});
 }));
 app.post('/api/quotes/:id/decision',asyncRoute(async(req,res)=>{
  const status=req.body?.status;if(!['accepted','rejected'].includes(status))return bad(res,'Välj accepterad eller nekad');
  const q=await get(req,id(req.params.id));if(!q)return bad(res,'Offert saknas',404);
  if(q.status==='accepted'||q.status==='rejected')return bad(res,'Beslutet är redan registrerat',409);
  if(q.status!=='sent')return bad(res,'Skicka offerten till kunden först',409);
  const result=await db.query(`UPDATE project_quotes SET status=$3,decided_at=NOW(),updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING id,status`,[q.id,req.user.companyId,status]);res.json(result.rows[0]);
 }));
};
