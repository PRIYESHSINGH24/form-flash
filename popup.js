'use strict';
const $ = s => document.querySelector(s);
const norm = s => String(s||'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();

const FORM_URL = /^https:\/\/(docs\.google\.com\/forms\/|forms\.office\.com\/|forms\.microsoft\.com\/|forms\.cloud\.microsoft\/)/;

const DEFAULTS = [
  {keys:['=name','full name','your name','student name','candidate name','participant name'],value:''},
  {keys:['email','e mail','mail id','email address'],value:''},
  {keys:['phone','mobile','contact number','whatsapp'],value:''},
  {keys:['college','university','institute','institution'],value:''},
  {keys:['roll number','roll no','enrollment','enrolment','registration number','student id'],value:''},
  {keys:['branch','department','course','program'],value:''},
  {keys:['cgpa','gpa'],value:''},
  {keys:['linkedin'],value:''},
  {keys:['github'],value:''},
  {keys:['city','current city'],value:''},
];

let entries=[], tab=null, saveTimer;
let filterText='';

// ── storage ──
async function loadEntries(){
  const {entries:saved}=await chrome.storage.local.get('entries');
  entries=Array.isArray(saved)?saved:JSON.parse(JSON.stringify(DEFAULTS));
  if(!Array.isArray(saved)) await chrome.storage.local.set({entries});
}
function persist(){
  clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>chrome.storage.local.set({entries}),250);
}

// ── result msg ──
function setResult(text,type=''){
  const el=$('#result');
  el.textContent=text;
  el.className='result-msg'+(type?' '+type:'');
}

// ── answer rows ──
function renderRows(){
  const list=$('#rows');
  list.textContent='';
  const q=norm(filterText);
  const visible=entries.filter(e=>
    !q||e.keys.some(k=>norm(k).includes(q))||norm(e.value).includes(q)
  );
  if(!visible.length){
    const li=document.createElement('li');
    li.className='empty-state';
    li.innerHTML=`<span class="big">📋</span>${q?'No matches':'Nothing saved yet. Add your first answer.'}`;
    list.append(li);
    return;
  }
  visible.forEach(entry=>{
    const i=entries.indexOf(entry);
    const li=document.createElement('li');
    li.className='ans-row';

    const keys=document.createElement('input');
    keys.type='text';
    keys.className='ans-field mono';
    keys.placeholder='keywords, comma separated';
    keys.setAttribute('aria-label','Keywords');
    keys.value=(entry.keys||[]).join(', ');
    keys.addEventListener('input',()=>{
      entry.keys=keys.value.split(',').map(k=>k.trim()).filter(Boolean);
      persist();
    });

    const val=document.createElement('textarea');
    val.rows=1;
    val.className='ans-field';
    val.placeholder='your answer';
    val.setAttribute('aria-label','Answer');
    val.value=entry.value||'';
    val.addEventListener('input',()=>{entry.value=val.value;persist();});
    // auto-grow
    val.addEventListener('input',()=>{val.style.height='auto';val.style.height=val.scrollHeight+'px';});

    const del=document.createElement('button');
    del.className='del-btn';
    del.textContent='×';
    del.setAttribute('aria-label','Delete');
    del.addEventListener('click',()=>{
      entries.splice(i,1);
      persist();
      renderRows();
    });

    li.append(keys,val,del);
    list.append(li);
  });
}

$('#search').addEventListener('input',e=>{
  filterText=e.target.value;
  renderRows();
});

$('#add').addEventListener('click',()=>{
  entries.unshift({keys:[],value:''});
  persist();
  filterText='';
  $('#search').value='';
  renderRows();
  setTimeout(()=>{
    const first=document.querySelector('#rows .ans-field');
    if(first) first.focus();
  },50);
});

// ── tabs ──
document.querySelectorAll('.tab').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.tab').forEach(t=>{t.classList.remove('active');t.setAttribute('aria-selected','false');});
    document.querySelectorAll('.tab-body').forEach(b=>b.classList.add('hidden'));
    btn.classList.add('active');
    btn.setAttribute('aria-selected','true');
    $(`#tab-${btn.dataset.tab}`).classList.remove('hidden');
  });
});

// ── export / import ──
$('#export').addEventListener('click',()=>{
  const blob=new Blob([JSON.stringify({app:'formflash',v:1,entries},null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='formflash-answers.json';
  a.click();
  URL.revokeObjectURL(a.href);
});
$('#import').addEventListener('click',()=>$('#file').click());
$('#file').addEventListener('change',async e=>{
  const file=e.target.files[0]; e.target.value='';
  if(!file) return;
  try{
    const data=JSON.parse(await file.text());
    const incoming=Array.isArray(data)?data:data.entries;
    if(!Array.isArray(incoming)) throw new Error();
    const clean=incoming.filter(x=>x&&Array.isArray(x.keys)).map(x=>({keys:x.keys.map(String),value:String(x.value??'')}));
    if(!confirm(`Replace ${entries.length} saved answers with ${clean.length} from this file?`)) return;
    entries=clean;
    await chrome.storage.local.set({entries});
    renderRows();
    setResult(`Imported ${clean.length} answers.`,'ok');
  }catch{setResult('Not a valid FormFlash export.','err');}
});
$('#clear-all').addEventListener('click',async()=>{
  if(!confirm(`Delete all ${entries.length} saved answers? This cannot be undone.`)) return;
  entries=[];
  await chrome.storage.local.set({entries});
  renderRows();
  setResult('All answers cleared.','warn');
});

// ── unmatched ──
function renderNeeds(unmatched){
  const box=$('#needs');
  const list=$('#needsList');
  list.textContent='';
  if(!unmatched||!unmatched.length){box.hidden=true;return;}
  box.hidden=false;
  $('#needs-count').textContent=unmatched.length;

  unmatched.forEach(u=>{
    const li=document.createElement('li');
    li.className='need';

    const q=document.createElement('div');
    q.className='need-q';
    q.textContent=u.label;

    const row=document.createElement('div');
    row.className='need-row';

    let field;
    if((u.type==='radio'||u.type==='select'||u.type==='dropdown')&&u.options&&u.options.length){
      field=document.createElement('select');
      const first=document.createElement('option');
      first.value='';first.textContent='Pick the answer to save';
      field.append(first);
      u.options.forEach(o=>{
        const opt=document.createElement('option');
        opt.value=o;opt.textContent=o;
        field.append(opt);
      });
    }else{
      field=document.createElement('input');
      field.type='text';
      field.placeholder=u.type==='checkbox'?'choices, comma separated':'your answer';
    }
    field.setAttribute('aria-label','Answer for '+u.label);

    const save=document.createElement('button');
    save.className='save-btn';
    save.textContent='Save';
    save.addEventListener('click',async()=>{
      const value=field.value.trim();
      if(!value){field.focus();return;}
      const key=norm(u.label);
      const ex=entries.find(e=>(e.keys||[]).some(k=>norm(k)===key));
      if(ex) ex.value=value;
      else entries.push({keys:[key],value});
      const remaining=unmatched.filter(x=>x.label!==u.label);
      await chrome.storage.local.set({entries});
      await updateLastRun(remaining);
      renderRows();
      renderNeeds(remaining);
      setResult('Saved. Fill the form again to apply it.','ok');
    });

    row.append(field,save);
    li.append(q,row);
    list.append(li);
  });
}

async function updateLastRun(unmatched){
  const {lastRun}=await chrome.storage.local.get('lastRun');
  if(lastRun) await chrome.storage.local.set({lastRun:{...lastRun,unmatched}});
}

// ── fill ──
async function sendFill(){
  const msg={type:'FORMFLASH_FILL'};
  try{return await chrome.tabs.sendMessage(tab.id,msg);}
  catch{
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});
    return await chrome.tabs.sendMessage(tab.id,msg);
  }
}

$('#fill').addEventListener('click',async()=>{
  const btn=$('#fill');
  btn.disabled=true;
  btn.querySelector('.fill-label').textContent='Filling…';
  setResult('');
  try{
    const res=await sendFill();
    if(!res||!res.ok) throw new Error(res&&res.error);
    const {filled,total,unmatched}=res.report;
    if(total===0){
      setResult('No questions found yet. Let the form finish loading.','warn');
    }else if(unmatched.length){
      setResult(`Filled ${filled} of ${total} · ${unmatched.length} need your answer below`,'warn');
    }else{
      setResult(`All ${filled} of ${total} filled ✓ — check it, then submit`,'ok');
    }
    renderNeeds(unmatched);
  }catch(err){
    setResult('Could not fill. Reload the form and try again.','err');
    console.error(err);
  }finally{
    btn.disabled=!tab||!tab.url||!FORM_URL.test(tab.url);
    btn.querySelector('.fill-label').textContent='Fill this form';
  }
});

// ── init ──
(async function init(){
  await loadEntries();
  renderRows();

  [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  const onForm=tab&&tab.url&&FORM_URL.test(tab.url);

  const badge=$('#tab-badge');
  if(onForm){
    badge.textContent='Form detected';
    badge.className='badge badge--on';
  }else{
    badge.textContent='No form';
    badge.className='badge badge--off';
  }
  $('#fill').disabled=!onForm;
  if(!onForm) setResult('Open a Google or Microsoft Form to use the fill button.','');

  if(onForm){
    const {lastRun}=await chrome.storage.local.get('lastRun');
    if(lastRun&&lastRun.url===tab.url.split('#')[0]) renderNeeds(lastRun.unmatched);
  }
})();
