'use strict';
const crypto = require('crypto');
module.exports = (app, db) => {
  const wrap = fn => (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
  const validId = x => Number.isSafeInteger(Number(x)) && Number(x)>0 ? Number(x) : null;
  const error = (res,status,message)=>res.status(status).json({error:message});
  const list = async (client,companyId,projectId) => (await client.query(
    'SELECT id,name,quantity,unit,unit_price,rsk FROM materials WHERE company_id=$1 AND project_id=$2 ORDER BY id',
    [companyId,projectId]
  )).rows;
  const signature = items => crypto.createHash('sha256').update(JSON.stringify(items.map(m=>[String(m.id),String(m.name),Number(m.quantity),String(m.unit),Number(m.unit_price)]))).digest('hex');
  async function state(client,companyId,projectId){
    const materials=await list(client,companyId,projectId);
    const {rows:[review]}=await client.query('SELECT signature,reviewed_at FROM project_material_reviews WHERE company_id=$1 AND project_id=$2',[companyId,projectId]);
    return {materials,reviewed:materials.length===0 || (!!review && review.signature===signature(materials)),reviewed_at:review?.reviewed_at||null};
  }
  app.get('/api/billing/materials/:project',wrap(async(req,res)=>{
    const project=validId(req.params.project);if(!project)return error(res,400,'Ogiltig arbetsorder');
    const {rowCount}=await db.query('SELECT 1 FROM projects WHERE id=$1 AND company_id=$2',[project,req.user.companyId]);
    if(!rowCount)return error(res,404,'Arbetsordern saknas');
    res.json(await state(db,req.user.companyId,project));
  }));
  app.put('/api/billing/materials/:project',wrap(async(req,res)=>{
    const project=validId(req.params.project), entries=req.body?.rows;
    if(!project||!Array.isArray(entries)||entries.length>500)return error(res,400,'Ogiltig materiallista');
    const client=await db.connect();
    try{
      await client.query('BEGIN');
      const {rowCount}=await client.query('SELECT 1 FROM projects WHERE id=$1 AND company_id=$2 FOR UPDATE',[project,req.user.companyId]);
      if(!rowCount){await client.query('ROLLBACK');return error(res,404,'Arbetsordern saknas')}
      const current=await list(client,req.user.companyId,project);
      if(current.length!==entries.length || new Set(entries.map(x=>Number(x.id))).size!==entries.length || current.some(m=>!entries.some(x=>Number(x.id)===Number(m.id)))){
        await client.query('ROLLBACK');return error(res,409,'Materiallistan har ändrats. Uppdatera sidan och kontrollera igen.');
      }
      for(const item of entries){
        const price=Number(item.unit_price);
        if(item.unit_price===null||item.unit_price===undefined||String(item.unit_price).trim()===''||!Number.isFinite(price)||price<0||price>10000000||Math.abs(Math.round(price*100)-price*100)>1e-7){
          await client.query('ROLLBACK');return error(res,400,'Ange ett giltigt pris i kronor för varje materialrad (högst två decimaler).');
        }
        await client.query('UPDATE materials SET unit_price=$1 WHERE id=$2 AND project_id=$3 AND company_id=$4',[price,Number(item.id),project,req.user.companyId]);
      }
      const reviewed=await list(client,req.user.companyId,project);
      await client.query(`INSERT INTO project_material_reviews(company_id,project_id,signature,reviewed_at,reviewed_by)
       VALUES($1,$2,$3,NOW(),$4) ON CONFLICT(company_id,project_id) DO UPDATE SET signature=EXCLUDED.signature,reviewed_at=EXCLUDED.reviewed_at,reviewed_by=EXCLUDED.reviewed_by`,
       [req.user.companyId,project,signature(reviewed),req.user.userId]);
      await client.query('COMMIT');res.json({ok:true,reviewed:true,materials:reviewed});
    }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  }));
  // Shared guard: routes in index.js call this before saving a new invoice draft.
  return async (companyId,projectId)=>{
    const result=await state(db,companyId,projectId);
    return result.reviewed;
  };
};
