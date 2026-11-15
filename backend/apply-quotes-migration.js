require('dotenv').config();
const fs=require('fs'),path=require('path');const db=require('./db');
(async()=>{try{await db.query(fs.readFileSync(path.join(__dirname,'quotes-migration.sql'),'utf8'));console.log('Offertdatabas uppdaterad.');}catch(e){console.error('Databasmigrering misslyckades:',e.message);process.exitCode=1}finally{if(db.end)await db.end()}})();
