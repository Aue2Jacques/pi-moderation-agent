// Minimal static pages: dashboard (SSE metrics + recent reviews) and human review page. No external assets, no raw text by default.
export const DASHBOARD_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>moderation dashboard</title>
<style>body{font:14px system-ui,sans-serif;margin:16px;color:#222}h1{font-size:18px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px}.card{border:1px solid #ddd;border-radius:6px;padding:8px}.k{color:#666;font-size:12px}.v{font-size:22px;font-weight:600}table{border-collapse:collapse;width:100%;margin-top:12px}td,th{border-bottom:1px solid #eee;padding:4px 6px;text-align:left;font-size:12px}.paused{color:#b00}</style></head>
<body><h1>内容审核 agent 系统 · 仪表盘 <span id="paused" class="paused"></span></h1><div class="grid" id="cards"></div>
<h2 style="font-size:15px">最近审次</h2><table><thead><tr><th>review_id</th><th>state</th><th>attempt</th><th>release</th><th>used_micro</th><th>updated</th></tr></thead><tbody id="rows"></tbody></table>
<script>
const keys=["intake_rate","fast_rate","agent_rate","pass_pct","block_pct","suspicious_pct","release_pct","release_fast_pct","release_agent_pct","queue_intake","queue_agent","queue_human","outstanding_total","p50_fast","p95_fast","p50_agent","p95_agent","cost_micro_per_1k","cost_denominator","cost_estimated_reviews","judge_abstain_pct","over_budget_count","outbox_pending","calib_mode","calib_ver"];
const cards=document.getElementById("cards");for(const k of keys){const d=document.createElement("div");d.className="card";d.innerHTML='<div class="k">'+k+'</div><div class="v" id="m_'+k+'">–</div>';cards.appendChild(d);}
const es=new EventSource("/api/metrics");es.onmessage=e=>{const m=JSON.parse(e.data);for(const k of keys){const el=document.getElementById("m_"+k);if(el)el.textContent=typeof m[k]==="number"?(Number.isInteger(m[k])?m[k]:m[k].toFixed(2)):m[k];}document.getElementById("paused").textContent=m.replay_paused?"（回放已暂停：背压）":"";};
async function rows(){const r=await fetch("/api/reviews?limit=30");const xs=await r.json();document.getElementById("rows").innerHTML=xs.map(x=>'<tr><td>'+x.review_id+'</td><td>'+x.state+'</td><td>'+x.attempt+'</td><td>'+(x.release_reason||"")+'</td><td>'+(x.used_micro??"")+'</td><td>'+new Date(x.updated_at).toLocaleTimeString()+'</td></tr>').join("");}
rows();setInterval(rows,3000);
</script></body></html>`;

export const HUMAN_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>human review</title>
<style>body{font:14px system-ui,sans-serif;margin:16px;max-width:720px}input,select,textarea,button{font:inherit;margin:4px 0}pre{background:#f6f6f6;padding:8px;white-space:pre-wrap;font-size:12px}.warn{color:#b00;font-size:12px}</style></head>
<body><h1 style="font-size:18px">人审（默认只显示结构化元数据）</h1>
<div>reviewer <input id="rev" value="rev1"> token <input id="tok" type="password"> <button onclick="claim()">领取一条</button></div>
<pre id="meta">（未领取）</pre>
<div><button onclick="restricted()">查看原文与证据（受限，写审计）</button> <span class="warn">点开即记录审计</span></div><pre id="restricted"></pre>
<div>动作 <select id="action"><option>pass</option><option>limit</option><option>takedown</option></select> 规则 <input id="rules" placeholder="limit/takedown 必填，如 ABUSE-001"> 理由 <input id="reason" size="30"> <button onclick="submit()">提交裁决</button></div>
<pre id="out"></pre>
<script>
let cur=null;const H=()=>({"authorization":"Bearer "+document.getElementById("tok").value,"x-reviewer":document.getElementById("rev").value,"content-type":"application/json"});
async function claim(){const r=await fetch("/api/human/claim",{method:"POST",headers:H()});const j=await r.json();cur=j.review;document.getElementById("meta").textContent=JSON.stringify(j,null,1);document.getElementById("restricted").textContent="";}
async function restricted(){if(!cur)return;const r=await fetch("/api/reviews/"+encodeURIComponent(cur.review_id)+"/restricted",{headers:{...H(),"x-confirm":"yes"}});document.getElementById("restricted").textContent=JSON.stringify(await r.json(),null,1);}
async function submit(){if(!cur)return;const rules=document.getElementById("rules").value.split(",").map(s=>s.trim()).filter(Boolean);const r=await fetch("/api/human/submit",{method:"POST",headers:H(),body:JSON.stringify({review_id:cur.review_id,action:document.getElementById("action").value,rule_ids:rules,reason:document.getElementById("reason").value})});document.getElementById("out").textContent=r.status+" "+JSON.stringify(await r.json(),null,1);}
</script></body></html>`;
