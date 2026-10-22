(() => {
  const sorts=['recommended','price_desc','price_asc','popular','newest','rating'];
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function delivery(p={}) {
    const min=p.delivery_min_days || 8,max=p.delivery_max_days || 10;
    const end=max%100>=11 && max%100<=14?'дней':max%10===1?'день':max%10>=2&&max%10<=4?'дня':'дней';
    return `${min===max?min:min+'–'+max} ${end}`;
  }
  function select(products,{query='',category='Все',sort='recommended',min=null,max=null,available=false}={},ranking={}) {
    const q=query.trim().toLocaleLowerCase('ru');
    return products.filter(p=>(category==='Все'||p.category===category)&&(!available||p.in_stock)&&
      (min===null||p.price>=min)&&(max===null||p.price<=max)&&
      (!q||`${p.name} ${p.sku||''}`.toLocaleLowerCase('ru').includes(q))).sort((a,b)=>{
        let difference=0;
        if(sort==='price_asc')difference=a.price-b.price;
        if(sort==='price_desc')difference=b.price-a.price;
        if(sort==='popular')difference=Number(ranking[b.id]?.sold||0)-Number(ranking[a.id]?.sold||0);
        if(sort==='rating')difference=Number(ranking[b.id]?.rating||0)-Number(ranking[a.id]?.rating||0)||Number(ranking[b.id]?.review_count||0)-Number(ranking[a.id]?.review_count||0);
        if(sort==='newest')difference=(Date.parse(b.created_at)||0)-(Date.parse(a.created_at)||0)||b.id-a.id;
        if(sort==='recommended')difference=Number(b.in_stock)-Number(a.in_stock);
        return difference||a.id-b.id;
      });
  }
  function related(product,products) {
    const active=products.filter(p=>p.active!==false && p.id!==product.id),byId=new Map(active.map(p=>[p.id,p]));
    // If an admin curated the shelf, preserve exactly those choices. A hidden
    // recommendation is omitted rather than replaced with an unrelated item.
    if(product.related_ids?.length)return product.related_ids.map(id=>byId.get(id)).filter(Boolean);
    return active.filter(p=>product.category && p.category===product.category).slice(0,8);
  }
  function gallery(root,photos=[],name='Фото товара') {
    root._galleryDispose?.();
    const controller=new AbortController(),signal=controller.signal;
    let frame=0,index=0;
    root._galleryDispose=()=>{controller.abort();cancelAnimationFrame(frame);};
    const sources=[...new Set(photos.filter(Boolean))].slice(0,10);
    root.innerHTML=sources.length?`<div class="product-gallery" role="region" aria-roledescription="карусель" aria-label="Фотографии: ${esc(name)}"><div class="gallery-track" tabindex="0">${sources.map((url,i)=>`<div class="gallery-slide" role="group" aria-label="${i+1} из ${sources.length}"><img class="img" src="${esc(url)}" alt="${esc(name)} — фото ${i+1}" ${i?'loading="lazy"':'fetchpriority="high"'} decoding="async" draggable="false"></div>`).join('')}</div>${sources.length>1?`<button class="gallery-arrow prev" data-gallery-step="-1" aria-label="Предыдущее фото">‹</button><button class="gallery-arrow next" data-gallery-step="1" aria-label="Следующее фото">›</button><span class="gallery-counter" aria-live="polite">1 / ${sources.length}</span><div class="gallery-dots">${sources.map((_,i)=>`<button data-gallery-index="${i}" class="${i===0?'on':''}" aria-label="Фото ${i+1}" aria-pressed="${i===0}"></button>`).join('')}</div>`:''}</div>`:'<div class="gallery-placeholder">RAMP</div>';
    const track=root.querySelector('.gallery-track');if(!track)return;
    const counter=root.querySelector('.gallery-counter');
    const sync=()=>{frame=0;index=Math.max(0,Math.min(sources.length-1,Math.round(track.scrollLeft/(track.clientWidth||1))));if(counter)counter.textContent=`${index+1} / ${sources.length}`;root.querySelectorAll('[data-gallery-index]').forEach((dot,i)=>{dot.classList.toggle('on',i===index);dot.setAttribute('aria-pressed',String(i===index));});};
    const go=n=>track.scrollTo({left:Math.max(0,Math.min(sources.length-1,n))*track.clientWidth,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    track.addEventListener('scroll',()=>{if(!frame)frame=requestAnimationFrame(sync);},{passive:true,signal});
    root.addEventListener('click',e=>{const dot=e.target.closest('[data-gallery-index]'),step=e.target.closest('[data-gallery-step]');if(dot)go(Number(dot.dataset.galleryIndex));if(step)go(index+Number(step.dataset.galleryStep));},{signal});
    track.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();go(index+(e.key==='ArrowRight'?1:-1));}},{signal});
    let mouse=null;
    track.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse' && e.button===0 && sources.length>1){mouse={x:e.clientX,left:track.scrollLeft};track.style.scrollSnapType='none';track.setPointerCapture(e.pointerId);}},{signal});
    track.addEventListener('pointermove',e=>{if(mouse)track.scrollLeft=mouse.left+mouse.x-e.clientX;},{signal});
    const finish=()=>{if(!mouse)return;mouse=null;track.style.scrollSnapType='';go(Math.round(track.scrollLeft/(track.clientWidth||1)));};
    track.addEventListener('pointerup',finish,{signal});track.addEventListener('pointercancel',finish,{signal});
  }
  window.RampCatalog={sorts,select,related,delivery,gallery};
})();
