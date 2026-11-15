require('dotenv').config();
const fs=require('fs');const db=require('./db');
(async()=>{try{await db.query(fs.readFileSync(require('path').join(__dirname,'material-pricing.sql'),'utf8'));console.log('Materialgranskning: databastabell OK');process.exitCode=0}catch(e){console.error('Databasmigrering misslyckades:',e.message);process.exitCode=1}finally{if(db.end)await db.end()}})();
