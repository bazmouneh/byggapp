(() => {
 'use strict';
 const $=x=>document.getElementById(x);
 const safe=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=n=>Number(n||0).toLocaleString('sv-SE',{style:'currency',currency:'SEK'});
 let mountedForm=null,request=0;
 function getAuth(){return sessionStorage.getItem('byggapp_token')}
 async function requestApi(url,options={}){
  const resp=await fetch('/api'+url,{...options,headers:{'Content-Type':'application/json',Authorization:'Bearer '+getAuth(),...(options.headers||{})}});
  const json=await resp.json();if(!resp.ok)throw Error(json.error||'Serverfel');return json;
 }
 function eligible(){const form=$('f');return form&&form.querySelector('select[name="project_id"]')&&form.parentElement?.querySelector('h2')?.textContent?.trim()==='Skapa faktura'?form:null}
 async function load(form){
  const box=$('materialPriceBox');if(!box)return;
  const project=form.querySelector('[name="project_id"]').value;
  box.querySelector('.price-results').textContent='Hämtar material...';
  const seq=++request;
  try{
   const data=await requestApi('/billing/materials/'+encodeURIComponent(project));if(seq!==request)return;
   const rows=data.materials||[];
   box.querySelector('.price-results').innerHTML=rows.length?rows.map(item=>`<div class="price-line" data-id="${Number(item.id)}" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid #ddd"><span style="flex:2;min-width:150px">${safe(item.name)} <small>(${safe(item.quantity)} ${safe(item.unit||'st')})</small></span><label style="flex:1;min-width:130px">Pris per styck (kr)<input type="number" class="material-price" value="${Number(item.unit_price)||0}" min="0" max="10000000" step="0.01" required></label><strong class="line-total" style="min-width:120px">${money(Number(item.quantity)*Number(item.unit_price))}</strong></div>`).join(''):'Inget material registrerat på jobbet.';
   const status=box.querySelector('.price-status');status.textContent=rows.length?(data.reviewed?'✓ Materialpriser granskade':'Granska materialpriser och spara innan fakturan skapas'):'Inget material – ingen prisgranskning krävs.';
   box.querySelector('.price-save').disabled=!rows.length;
   for(const line of box.querySelectorAll('.price-line')){
    const input=line.querySelector('input');input.oninput=()=>{const item=rows.find(x=>String(x.id)===line.dataset.id);line.querySelector('.line-total').textContent=money(Number(input.value)*Number(item.quantity));status.textContent='Osparade priser – klicka Spara och godkänn';};
   }
  }catch(e){box.querySelector('.price-results').textContent=e.message;box.querySelector('.price-save').disabled=true;}
 }
 function mount(){
  const form=eligible();if(!form||form===mountedForm)return;
  mountedForm=form;
  const box=document.createElement('div');box.id='materialPriceBox';box.className='panel';box.style.cssText='padding:15px;margin:14px 0;border:1px solid #ddd;border-radius:12px;grid-column:1/-1;';
  box.innerHTML='<h3>Materialpriser – endast admin</h3><p>Materialet och antalet kommer från personalens jobbrapport. Ange pris/styck före fakturering.</p><div class="price-results"></div><p class="price-status"></p><button type="button" class="price-save">Spara och godkänn materialpriser</button>';
  form.parentElement.insertBefore(box,form.nextSibling);
  form.querySelector('[name="project_id"]').addEventListener('change',()=>load(form));
  box.querySelector('.price-save').onclick=async()=>{
   const project=form.querySelector('[name="project_id"]').value;
   const rows=[...box.querySelectorAll('.price-line')].map(line=>({id:Number(line.dataset.id),unit_price:line.querySelector('input').value}));
   try{await requestApi('/billing/materials/'+encodeURIComponent(project),{method:'PUT',body:JSON.stringify({rows})});await load(form);alert('Materialpriser granskade och sparade. Nu kan du förhandsgranska fakturan.');}
   catch(e){alert('Kunde inte spara priserna: '+e.message)}
  };
  load(form);
 }
 // The dashboard rebuilds its main area when switching tabs.
 const observer=new MutationObserver(()=>mount());
 observer.observe(document.body,{subtree:true,childList:true});
 mount();
})();
