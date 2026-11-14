require('dotenv').config();
const {Pool}=require('pg');
if(!process.env.DATABASE_URL) throw Error('DATABASE_URL saknas');
module.exports=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:true}});
