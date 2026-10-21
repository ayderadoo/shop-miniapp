import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture() {
 const context=vm.createContext({window:{},Map,Promise});vm.runInContext(readFileSync(new URL('../assets/wishlist.js',import.meta.url),'utf8'),context);
 const requests=[],errors=[];let items=[];
 const engine=context.window.RampWishlist.create({send:(id,wished)=>new Promise((resolve,reject)=>requests.push({id,wished,resolve,reject})),onChange:next=>items=next,onError:e=>errors.push(e)});
 return {engine,requests,errors,get ids(){return [...items].map(x=>x.id).sort();}};
}
test('favorites change before the server responds and rapid opposite gestures persist the latest intent',async()=>{
 const f=fixture();const task=f.engine.toggle({id:1});assert.deepEqual(f.ids,[1]);assert.equal(f.requests.length,1);
 f.engine.toggle({id:1});assert.deepEqual(f.ids,[]);assert.equal(f.requests.length,1);
 f.requests[0].resolve({});await flush();assert.equal(f.requests[1].wished,false);assert.deepEqual(f.ids,[]);
 f.requests[1].resolve({});await task;assert.deepEqual(f.ids,[]);
});
test('independent products and stale profile responses cannot overwrite a newer favorite gesture',async()=>{
 const f=fixture(),snapshot=f.engine.version;const one=f.engine.toggle({id:1}),two=f.engine.toggle({id:2});
 f.engine.replace([],snapshot);assert.deepEqual(f.ids,[1,2]);f.requests[1].resolve({});await two;
 f.requests[0].reject(new Error('offline'));await one;assert.deepEqual(f.ids,[2]);assert.equal(f.errors.length,1);
 f.engine.replace([],snapshot);assert.deepEqual(f.ids,[2]);
});
test('a failed older write still sends the newer absolute state and repeated toggles coalesce',async()=>{
 const f=fixture(),task=f.engine.toggle({id:1});f.engine.toggle({id:1});f.requests[0].reject(new Error('connection interrupted'));await flush();
 assert.equal(f.requests[1].wished,false);f.requests[1].resolve({});await task;assert.deepEqual(f.ids,[]);
 const last=f.engine.toggle({id:2});f.engine.toggle({id:2});f.engine.toggle({id:2});f.requests[2].resolve({});await last;
 assert.equal(f.requests.length,3);assert.deepEqual(f.ids,[2]);
});
