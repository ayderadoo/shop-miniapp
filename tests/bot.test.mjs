import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { normalizeOptions, pickVariant, parseInitData, isUzbekPhone, normalizeSku } from '../supabase/functions/_shared/validation.ts';

test('variant prices are validated; required choices cannot be skipped',()=>{
 const p={price:89000,options:normalizeOptions([{name:'Размер',values:[{label:'XL',add:10000}]}])};
 assert.equal(pickVariant(p,{}).ok,false);assert.equal(pickVariant(p,{'Размер':'XL'}).price,99000);
 assert.throws(()=>normalizeOptions([{name:'Размер',values:[{label:'M'},{label:'M'}]}]));
 assert.equal(pickVariant({price:1,options:[{name:'Цвет',values:[{label:'А',add:-100}]}]},{'Цвет':'А'}).ok,false);
});
test('Telegram data rejects missing, future, expired, duplicate and invalid user values',()=>{
 const now=Date.now(),valid=new URLSearchParams({hash:'a'.repeat(64),auth_date:String(Math.floor(now/1000)),user:JSON.stringify({id:101})});
 assert.ok(parseInitData(valid.toString(),now));
 for(const date of ['NaN','0',String(now/1000+100),String(now/1000-86401)]){const p=new URLSearchParams(valid);p.set('auth_date',date);assert.equal(parseInitData(p.toString(),now),null);}
 valid.append('user','{}');assert.equal(parseInitData(valid.toString(),now),null);
});

async function setup() {
 const rows={profiles:[],bot_updates:[]},sent=[],claims=new Map(),members=new Map();let nextNo=0;
 class Query {
  constructor(table){this.table=table;this.operation='select';this.filters=[];}
  select(){return this;}eq(k,v){this.filters.push(r=>r[k]===v);return this;}or(){return this;}
  maybeSingle(){this.one=true;return this;}single(){this.one=true;return this;}
  insert(v){this.operation='insert';this.values=v;return this;}update(v){this.operation='update';this.values=v;return this;}
  then(resolve,reject){try{let data=rows[this.table].filter(r=>this.filters.every(f=>f(r)));
   if(this.operation==='insert'){const row={...this.values,public_id:`RAMP-${100000+ ++nextNo}`,user_no:nextNo,tg_phone:null,blocked:false,phone:null};rows[this.table].push(row);data=[row];}
   if(this.operation==='update')data.forEach(r=>Object.assign(r,this.values));
   resolve({data:this.one ? data[0]??null : data,error:null});
  }catch(e){reject(e);}}
 }
 const sb={from:t=>new Query(t),rpc:async(name,args)=>{
  assert.equal(name,'ramp_claim_update');const key=args.p_bot+args.p_update_id;
  const row=rows.bot_updates.find(r=>r.bot_kind===args.p_bot&&r.update_id===args.p_update_id);
  if(row?.processed)return {data:'done'};if(claims.has(key))return {data:'busy'};
  claims.set(key,true);rows.bot_updates.push({bot_kind:args.p_bot,update_id:args.p_update_id});return {data:'claimed'};
 }};
 const config={promo:{welcomePct:10,welcomeDays:30,minQualifyingOrder:200000,inviterPct:33,inviteeNextPct:11},admins:[1],botToken:'admin-token',shopToken:'shop-token'};
 const api={isUzbekPhone,sb,cfg:async()=>config,tg:async(method,body,bot='shop')=>{sent.push({method,body,bot});if(method==='getMe')return {ok:true,result:{id:999,username:'ramp_uzbot'}};if(method==='getChatMember')return {ok:true,result:{status:body.user_id===999?'administrator':members.get(body.user_id) || 'member'}};return {ok:true,result:{message_id:1}};},tokenOf:async bot=>bot==='shop'?config.shopToken:config.botToken,
  webhookSecret:async bot=>bot+'-secret',safeEqual:(a,b)=>a===b,isAdmin:async id=>id===1,getBotUsername:async()=>'ramp_uzbot',singleBot:async()=>false,
  shopButton:()=>({inline_keyboard:[[{text:'Открыть',web_app:{url:'https://shop.example'}}]]}),esc:String,fmt:String,normPhone:p=>'+'+p.replace(/\D/g,''),SUPPORT_USERNAME:'ramphelper',MINIAPP_URL:'https://shop.example',ADMIN_URL:'https://shop.example/admin.html',STATUS:{},
  answerPhotoRequest:async()=>null,applyReferral:async()=>({ok:true}),relayToClient:async()=>({ok:true}),reviewReceipt:async()=>({ok:true}),setOrderStatus:async()=>null,setupBots:async()=>[]};
 const context=vm.createContext({console,Request,Response,URL,URLSearchParams,Date,Number,JSON,Deno:{serve(){}},crypto});
 const common=new vm.SyntheticModule(Object.keys(api),function(){for(const [k,v]of Object.entries(api))this.setExport(k,v);},{context});
 const code=stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/bot/index.ts',import.meta.url),'utf8'),{mode:'transform'});
 const subscription=new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/_shared/subscription.ts',import.meta.url),'utf8'),{mode:'transform'}),{context});await subscription.link(()=>common);
 const mod=new vm.SourceTextModule(code,{context});await mod.link(name=>name.includes('subscription')?subscription:common);await mod.evaluate();
 let update=0;
 const send=async(bot,msg,id=++update)=>mod.namespace.handler(new Request('https://qa/bot',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':bot+'-secret'},body:JSON.stringify({update_id:id,message:{chat:{id:msg.from?.id??101,type:'private'},...msg}})}));
 const callback=async(bot,cb,id=++update)=>mod.namespace.handler(new Request('https://qa/bot',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':bot+'-secret'},body:JSON.stringify({update_id:id,callback_query:cb})}));
 return {rows,sent,send,callback,config,members,subscription:subscription.namespace,handler:mod.namespace.handler};
}
test('admin /start and contacts never create customer profiles or request a phone',async()=>{
 const f=await setup();await f.send('admin',{from:{id:1},text:'/start'});
 assert.equal(f.rows.profiles.length,0);assert.ok(f.sent.every(x=>x.bot==='admin'));
 assert.ok(f.sent.every(x=>!JSON.stringify(x.body).includes('request_contact')));
 await f.send('admin',{from:{id:1},contact:{user_id:1,phone_number:'998900000001'}});
 assert.equal(f.rows.profiles.length,0);assert.match(f.sent.at(-1).body.text,/@ramp_uzbot/);
});
test('shop /start, own phone verification, stable ID and webhook deduplication',async()=>{
 const f=await setup();assert.equal((await f.send('shop',{from:{id:101,first_name:'QA'},text:'/start'},10)).status,200);
 const id=f.rows.profiles[0].public_id;
 assert.ok(f.sent.at(-1).body.reply_markup.keyboard[0][0].request_contact);assert.equal(f.sent.at(-1).bot,'shop');
 await f.send('shop',{from:{id:101},contact:{user_id:102,phone_number:'998900000002'}},11);assert.equal(f.rows.profiles[0].tg_phone,null);
 await f.send('shop',{from:{id:101},contact:{user_id:101,phone_number:'998900000001'}},12);assert.equal(f.rows.profiles[0].tg_phone,'+998900000001');
 await f.send('shop',{from:{id:101},text:'/start'},13);assert.equal(f.rows.profiles[0].public_id,id);assert.equal(f.rows.profiles.length,1);
 const count=f.sent.length;await f.send('shop',{from:{id:101},text:'/start'},13);assert.equal(f.sent.length,count);
 f.config.shopToken='';assert.equal((await f.send('shop',{from:{id:101},text:'/start'},14)).status,403);
});

test("UZ phone format and SKU normalization",()=>{assert.ok(isUzbekPhone("+998901234567"));for(const phone of ["+79991234567","+99890123456","+9989012345678","998901234567",null])assert.equal(isUzbekPhone(phone),false);for(const [raw,sku] of [[" rm-600001 ","RM-600001"],["600123","RM-600123"],["rm 0600124","RM-600124"],["RM-1234567","RM-1234567"]])assert.equal(normalizeSku(raw),sku);for(const bad of ["","RMP-001","RM-599999","RM-12","RM-1000000000","RM-6000x1"])assert.throws(()=>normalizeSku(bad));});

test('foreign own contact is rejected and does not verify the profile',async()=>{
 const f=await setup();await f.send('shop',{from:{id:101},text:'/start'},20);
 await f.send('shop',{from:{id:101},contact:{user_id:101,phone_number:'79991234567'}},21);
 assert.equal(f.rows.profiles[0].tg_phone,null);
 assert.match(f.sent.at(-1).body.text,/Узбекистана/);
 assert.ok(f.sent.at(-1).body.reply_markup.keyboard[0][0].request_contact);
 const count=f.sent.length;
 await f.send('shop',{from:{id:101},text:'/myid'},22);
 assert.equal(f.sent.length,count+1);assert.ok(f.sent.at(-1).body.reply_markup.keyboard);
});

test('subscription blocks contact registration until Telegram confirms membership, callback resumes phone step',async()=>{
 const f=await setup();f.members.set(101,'left');await f.send('shop',{from:{id:101},text:'/start'},31);
 assert.equal(f.rows.profiles[0].subscription_verified_at,null);
 assert.equal(f.sent.at(-1).body.reply_markup.inline_keyboard[1][0].style,'success');
 assert.match(f.sent.at(-1).body.text,/<b>.*канал/);
 await f.send('shop',{from:{id:101},contact:{user_id:101,phone_number:'998900000001'}},32);
 assert.equal(f.rows.profiles[0].tg_phone,null);
 await f.callback('shop',{id:'cb1',data:'subscription:check',from:{id:101},message:{message_id:3,chat:{id:101,type:'private'}}},33);
 assert.ok(f.sent.find(x=>x.method==='answerCallbackQuery' && x.body.show_alert));
 f.members.set(101,'member');await f.callback('shop',{id:'cb2',data:'subscription:check',from:{id:101},message:{message_id:3,chat:{id:101,type:'private'}}},34);
 assert.ok(f.rows.profiles[0].subscription_verified_at);assert.equal(f.rows.profiles[0].subscription_channel,'ramp_uz');
 assert.ok(f.sent.at(-1).body.reply_markup.keyboard[0][0].request_contact);
 await f.send('shop',{from:{id:101},contact:{user_id:101,phone_number:'998900000001'}},35);assert.equal(f.rows.profiles[0].tg_phone,'+998900000001');
 for(const status of ['left','kicked'])assert.equal(f.subscription.isChannelMember({status}),false);
 assert.equal(f.subscription.isChannelMember({status:'restricted',is_member:false}),false);
 assert.equal(f.subscription.isChannelMember({status:'restricted',is_member:true}),true);
});
