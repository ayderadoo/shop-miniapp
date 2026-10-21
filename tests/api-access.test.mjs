import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { isUzbekPhone } from '../supabase/functions/_shared/validation.ts';
async function fixture() {
 const profile={telegram_id:101,blocked:false,tg_phone:'+998901234567',subscription_verified_at:null,subscription_channel:null};let handler;
 const context=vm.createContext({Request,Response,URL,console,Date,Number,JSON,Deno:{serve(h){handler=h;}}});
 const fail=()=>{throw new Error('Unexpected data access');};
 const sb={from(table){assert.equal(table,'profiles');return {select(){return this;},eq(){return this;},maybeSingle:async()=>({data:profile,error:null}),single:async()=>({data:profile,error:null})};}};
 const api={sb,cfg:async()=>({payments:{card:'Карта'}}),verifyInitData:async raw=>raw==='signed'?{id:101}:null,isUzbekPhone,
  getReferralLink:fail,applyReferral:fail,bestEffort:fail,esc:String,fmt:String,getBotUsername:fail,isAdmin:fail,notifyAdmins:fail,receiptKeyboard:fail,statusKeyboard:fail,shopButton:fail,SUPPORT_USERNAME:'ramphelper',tg:fail,pickVariant:fail};
 const common=new vm.SyntheticModule(Object.keys(api),function(){for(const[k,v]of Object.entries(api))this.setExport(k,v);},{context});
 class ContentError extends Error {constructor(status,message){super(message);this.status=status;}}
 const contentApi={ContentError,customerContent:fail,legalDocument:async slug=>{if(!['privacy','offer'].includes(slug))throw new ContentError(400,'Документ не найден');return {document:null,available:false};}};
 const content=new vm.SyntheticModule(Object.keys(contentApi),function(){for(const[k,v]of Object.entries(contentApi))this.setExport(k,v);},{context});
 const subApi={CHANNEL_USERNAME:'ramp_uz',CHANNEL_URL:'https://t.me/ramp_uz',hasSubscription:p=>!!p.subscription_verified_at&&p.subscription_channel==='ramp_uz',verifySubscription:async()=>({subscribed:false,unavailable:false})};
 const sub=new vm.SyntheticModule(Object.keys(subApi),function(){for(const[k,v]of Object.entries(subApi))this.setExport(k,v);},{context});
 const mod=new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/api/index.ts',import.meta.url),'utf8'),{mode:'transform'}),{context});
 await mod.link(name=>name.includes('content.ts')?content:name.includes('subscription.ts')?sub:common);await mod.evaluate();
 return {profile,send:async(body,signed=true)=>handler(new Request('https://qa/api',{method:'POST',headers:{'content-type':'application/json','x-init-data':signed?'signed':''},body:JSON.stringify(body)}))};
}
test('API refuses unsigned requests and forged subscription flags; own UZ phone alone cannot bypass subscription',async()=>{
 const f=await fixture();assert.equal((await f.send({action:'orders'},false)).status,401);
 const r=await f.send({action:'cartSet',subscribed:true,subscription_verified:true,product_id:1,qty:1});assert.equal(r.status,403);assert.equal((await r.json()).code,'need_subscription');
 f.profile.subscription_verified_at=new Date().toISOString();f.profile.subscription_channel='other_channel';assert.equal((await f.send({action:'orders'})).status,403);
 f.profile.subscription_channel='ramp_uz';f.profile.tg_phone='+79991234567';const phone=await f.send({action:'orders'});assert.equal((await phone.json()).code,'need_phone');
 f.profile.blocked=true;assert.equal((await f.send({action:'checkSubscription'})).status,403);
});
test('only published legal documents are publicly readable before registration; unknown document names are rejected',async()=>{
 const f=await fixture();const r=await f.send({action:'legal',slug:'privacy'},false);assert.equal(r.status,200);assert.deepEqual(await r.json(),{document:null,available:false});
 assert.equal((await f.send({action:'legal',slug:'profiles'},false)).status,400);
 assert.equal((await f.send({action:'documents'},false)).status,401);
});
