import { sb, type TgUser } from "./common.ts";

export class ContentError extends Error {
  constructor(public status: number,message: string){super(message);}
}
const text=(v: unknown,max: number)=>String(v??"").trim().slice(0,max);
const id=(v: unknown)=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<1)throw new ContentError(400,"Неверный номер записи");return n;};
const optionalId=(v: unknown)=>v===null||v===undefined||v===""?null:id(v);
const offset=(v: unknown)=>Math.max(0,Math.min(1_000_000,Math.trunc(Number(v)||0)));
function check(result: any){
  if(result.error)throw new ContentError(result.error.code==="P0001"||result.error.code==="23505"?400:500,
    result.error.code==="P0001"?result.error.message:result.error.code==="23505"?"Такая запись уже существует":"Не удалось сохранить данные");
  return result.data;
}
const MIME: Record<string,string>={"image/jpeg":"jpg","image/png":"png","image/webp":"webp","video/mp4":"mp4","video/webm":"webm","video/quicktime":"mov"};

async function createUpload(uid: number,scope: "review"|"news"|"faq",body: any){
  const mime=String(body.mime??""),size=Number(body.size),ext=MIME[mime];
  if(!ext||!Number.isSafeInteger(size)||size<1||size>(mime.startsWith("image/")?5:25)*1024*1024)throw new ContentError(400,"Фото — до 5 МБ, видео MP4/MOV/WebM — до 25 МБ");
  const count=await sb.from("content_uploads").select("id",{count:"exact",head:true}).eq("telegram_id",uid).gte("created_at",new Date(Date.now()-3600_000).toISOString());
  check(count);if((count.count??0)>=30)throw new ContentError(429,"Лимит загрузок на час исчерпан. Попробуйте позже");
  const path=`${scope}/${crypto.randomUUID()}.${ext}`;
  const record=check(await sb.from("content_uploads").insert({telegram_id:uid,scope,path,mime,size}).select("id").single());
  const signed=await sb.storage.from("shop-content").createSignedUploadUrl(path);
  if(signed.error)throw new ContentError(500,"Не удалось подготовить загрузку");
  return {upload_id:record.id,signed_url:signed.data.signedUrl};
}

async function present(rows: any[],privateFields=false,ttl=3600){
  const paths=[...new Set(rows.flatMap(row=>(row.media??[]).map((m: any)=>m.path)))] as string[];
  const urls=paths.length?check(await sb.storage.from("shop-content").createSignedUrls(paths,ttl)):[];
  const byPath=Object.fromEntries(paths.map((path,i)=>[path,urls?.[i]?.signedUrl??null]));
  return rows.map(row=>{
    const {telegram_id,created_by,...safe}=row;
    return {...safe,...(privateFields?{telegram_id,created_by}:{}),media:(row.media??[]).map((m: any)=>({mime:m.mime,url:byPath[m.path],...(privateFields?{upload_id:m.upload_id}: {})}))};
  });
}
const mediaIds=(v: unknown)=>{
  if(!Array.isArray(v)||v.length>5||v.some(x=>typeof x!=="string"||!/^[0-9a-f-]{36}$/i.test(x)))throw new ContentError(400,"Проверьте приложенные файлы");return v;
};

export async function legalDocument(slug: unknown) {
  if (!["privacy","offer"].includes(String(slug))) throw new ContentError(400,"Документ не найден");
  const row=check(await sb.from("shop_documents").select("slug,title,body,version,updated_at").eq("slug",String(slug)).eq("published",true).maybeSingle());
  return {document:row,available:!!row};
}

export async function customerContent(action: string,b: any,user: TgUser){
  if(action==="faq") {
    const rows=check(await sb.from("shop_faq").select("id,question,answer,media,position,updated_at").eq("published",true).order("position").order("id").range(offset(b.offset),offset(b.offset)+49));
    return {faq:await present(rows),has_more:rows.length===50};
  }
  if(action==="createMediaUpload")return createUpload(user.id,"review",b);
  if(action==="stories"||action==="news"){
    const rows=check(await sb.rpc("ramp_live_stories",{p_offset:offset(b.offset)}));
    const now=Date.now();
    const stories=(await Promise.all(rows.slice(0,20).map((r:any)=>present([r],false,r.expires_at?Math.max(1,Math.min(3600,Math.floor((new Date(r.expires_at).getTime()-now)/1000))):3600)))).flat();
    return {stories,news:stories,server_time:new Date(now).toISOString(),has_more:rows.length>20};
  }
  if(action==="reviews"){
    const product=optionalId(b.product_id),start=offset(b.offset);
    const rating=b.rating===undefined||b.rating===null||b.rating===""?null:id(b.rating);
    if(rating!==null && rating>5)throw new ContentError(400,"Оценка — от 1 до 5");
    const media=String(b.media_filter??"all"),source=String(b.source_filter??"all");
    if(!["all","photo","video"].includes(media)||!["all","customer","store","marketplace"].includes(source))throw new ContentError(400,"Неверный фильтр отзывов");
    let mineQuery=sb.from("product_reviews").select("id,product_id,author_name,rating,body,status,media,moderation_note,created_at").eq("telegram_id",user.id).eq("source","customer");
    mineQuery=product?mineQuery.eq("product_id",product):mineQuery.is("product_id",null);
    const [feed,mine]=await Promise.all([sb.rpc("ramp_review_feed",{p_product_id:product,p_rating:rating,p_media:media,p_source:source,p_offset:start}),mineQuery.maybeSingle()]);
    const data=check(feed),own=check(mine),list=data.reviews;
    return {reviews:await present(list.slice(0,20)),mine:own?(await present([own],true))[0]:null,stats:data.stats,has_more:list.length>20};
  }
  if(action==="saveReview"){
    const result=check(await sb.rpc("ramp_save_review",{p_uid:user.id,p_id:optionalId(b.id),p_product_id:optionalId(b.product_id),p_source:"customer",p_author:"",p_rating:id(b.rating),p_body:text(b.body,3000),p_publish:false,p_media:mediaIds(b.media??[])}));
    return {review:(await present([result],true))[0]};
  }
  return undefined;
}

export async function adminContent(action: string,b: any,user: TgUser){
  if(action==="faq") {
    let q=sb.from("shop_faq").select("*").order("position").order("id").range(offset(b.offset),offset(b.offset)+49);
    if(b.filter==="published")q=q.eq("published",true);
    if(b.filter==="draft")q=q.eq("published",false);
    const rows=check(await q);return {faq:await present(rows,true),has_more:rows.length===50};
  }
  if(action==="saveFaq") {
    const position=Number(b.position ?? 0);
    if(!Number.isSafeInteger(position)||Math.abs(position)>10000)throw new ContentError(400,"Порядок — от −10000 до 10000");
    const item=check(await sb.rpc("ramp_save_faq",{p_uid:user.id,p_id:optionalId(b.id),p_question:text(b.question,200),p_answer:text(b.answer,6000),p_published:b.published===true,p_position:position,p_media:mediaIds(b.media ?? [])}));
    return {faq:(await present([item],true))[0]};
  }
  if(action==="deleteFaq"){check(await sb.from("shop_faq").delete().eq("id",id(b.id)));return {ok:true};}
  if(action==="stories") {
    let q=sb.from("shop_news").select("*").order("created_at",{ascending:false}).order("id",{ascending:false}).range(offset(b.offset),offset(b.offset)+49);
    const now=new Date().toISOString();
    if(b.filter==="active")q=q.eq("published",true).or(`expires_at.is.null,expires_at.gt.${now}`);
    if(b.filter==="expired")q=q.eq("published",true).lte("expires_at",now);
    if(b.filter==="draft")q=q.eq("published",false);
    const rows=check(await q);return {stories:await present(rows,true),has_more:rows.length===50};
  }
  if(action==="saveStory") {
    const hours=b.duration_hours===null?null:Number(b.duration_hours??24);
    if(hours!==null && (!Number.isSafeInteger(hours)||hours<1||hours>720))throw new ContentError(400,"Срок истории — от 1 часа до 30 дней");
    const result=check(await sb.rpc("ramp_save_story",{p_uid:user.id,p_id:optionalId(b.id),p_title:text(b.title,160),p_body:text(b.body,6000),p_published:b.published!==false,p_duration_hours:hours,p_media:mediaIds(b.media??[])}));
    return {story:(await present([result],true))[0]};
  }
  if(action==="deleteStory"){check(await sb.from("shop_news").delete().eq("id",id(b.id)));return {ok:true};}
  if(action==="documents")return {documents:check(await sb.from("shop_documents").select("*").order("slug"))};
  if(action==="saveDocument") {
    const slug=String(b.slug),title=text(b.title,160),body=text(b.body,20000),version=id(b.version);
    if(!["privacy","offer"].includes(slug)||!title||body.length<10)throw new ContentError(400,"Заполните название и текст документа");
    if(b.published===true && /\{\{[^}]+\}\}/.test(body))throw new ContentError(400,"Перед публикацией заполните реквизиты в двойных фигурных скобках");
    const saved=check(await sb.from("shop_documents").update({title,body,published:b.published===true,version:version+1,updated_at:new Date().toISOString(),updated_by:user.id}).eq("slug",slug).eq("version",version).select().maybeSingle());
    if(!saved)throw new ContentError(409,"Документ уже изменён. Откройте актуальную редакцию и повторите");
    return {document:saved};
  }
  if(action==="createMediaUpload")return createUpload(user.id,b.scope==="news"?"news":b.scope==="faq"?"faq":"review",b);
  if(action==="news"){
    let query=sb.from("shop_news").select("*").order("pinned",{ascending:false}).order("position").order("created_at",{ascending:false}).range(offset(b.offset),offset(b.offset)+49);
    if(b.filter==="draft")query=query.eq("published",false);
    const rows=check(await query);return {news:await present(rows,true),has_more:rows.length===50};
  }
  if(action==="saveNews"){
    const position=Math.trunc(Number(b.position)||0);if(Math.abs(position)>10000)throw new ContentError(400,"Порядок — от −10000 до 10000");
    const result=check(await sb.rpc("ramp_save_news",{p_uid:user.id,p_id:optionalId(b.id),p_title:text(b.title,160),p_body:text(b.body,6000),p_published:b.published===true,p_pinned:b.pinned===true,p_position:position,p_media:mediaIds(b.media??[])}));
    return {news:(await present([result],true))[0]};
  }
  if(action==="deleteNews"){check(await sb.from("shop_news").delete().eq("id",id(b.id)));return {ok:true};}
  if(action==="reviews"){
    let query=sb.from("product_reviews").select("*,product:products(name,sku)").order("created_at",{ascending:false}).range(offset(b.offset),offset(b.offset)+49);
    if(["pending","approved","rejected"].includes(b.status))query=query.eq("status",b.status);
    const rows=check(await query);return {reviews:await present(rows,true),has_more:rows.length===50};
  }
  if(action==="saveStoreReview"){
    const origin=text(b.origin_name,80)||null,url=text(b.origin_url,1000)||null;
    if(url && (!origin || !/^https:\/\/[^\s]+$/.test(url)))throw new ContentError(400,"Укажите название источника и HTTPS-ссылку");
    const result=check(await sb.rpc("ramp_save_store_review",{p_uid:user.id,p_id:optionalId(b.id),p_product_id:optionalId(b.product_id),p_author:text(b.author_name,80),p_rating:id(b.rating),p_body:text(b.body,3000),p_publish:b.published===true,p_media:mediaIds(b.media??[]),p_origin_name:origin,p_origin_url:url}));
    return {review:(await present([result],true))[0]};
  }
  if(action==="moderateReview"){
    if(!["approved","rejected"].includes(b.status))throw new ContentError(400,"Выберите решение по отзыву");
    check(await sb.from("product_reviews").update({status:b.status,moderation_note:text(b.note,500)||null,updated_at:new Date().toISOString()}).eq("id",id(b.id)));
    return {ok:true};
  }
  if(action==="deleteStoreReview"){
    check(await sb.from("product_reviews").delete().eq("id",id(b.id)).eq("source","store"));return {ok:true};
  }
  return undefined;
}
