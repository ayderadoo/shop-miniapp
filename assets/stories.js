(() => {
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function create({onError=()=>{},refresh}) {
    const rail=document.getElementById('storyRail'),viewer=document.getElementById('storyViewer');
    let rows=[],si=0,mi=0,raf=0,expiryTimer=0,offset=0,opened=false,elapsed=0,last=0,paused=false,ready=false,sound=false,seen={};
    try{seen=JSON.parse(localStorage.getItem('ramp:seen-stories') || '{}');}catch{}
    const now=()=>Date.now()+offset;
    const live=r=>!r.expires_at || new Date(r.expires_at).getTime()>now();
    const key=r=>r.id+':'+r.updated_at;
    const slide=()=>rows[si]?.media?.[mi];
    const player=()=>viewer.querySelector('video');
    const count=r=>Math.max(1,r.media?.length || 0);
    function paintRail() {
      document.getElementById('homeStories').hidden=!rows.length;
      rail.innerHTML=rows.map((r,i)=>{const m=r.media?.[0];const cover=m?.url && m.mime?.startsWith('image/')?`<img src="${esc(m.url)}" alt="" loading="lazy">`:m?.url?'<span class="story-video-icon">▶</span>':'<span class="story-letter">R</span>';return `<button class="story-teaser ${seen[key(r)]?'seen':''}" data-story-index="${i}" aria-label="История: ${esc(r.title)}"><span class="story-ring">${cover}</span><span class="story-label">${esc(r.title)}</span></button>`;}).join('');
    }
    function scheduleExpiry() {
      clearTimeout(expiryTimer);
      const times=rows.filter(r=>r.expires_at).map(r=>new Date(r.expires_at).getTime()-now());
      if(times.length)expiryTimer=setTimeout(()=>set(rows),Math.min(2147483647,Math.max(1,Math.min(...times)+10)));
    }
    function set(list,serverTime) {
      if(serverTime)offset=new Date(serverTime).getTime()-Date.now();
      const id=opened?rows[si]?.id:null;
      rows=list.filter(live);paintRail();scheduleExpiry();
      if(opened){const index=rows.findIndex(r=>r.id===id);if(index<0){close();onError('Время истории истекло');}else si=index;}
    }
    function close() {
      opened=false;cancelAnimationFrame(raf);player()?.pause();viewer.querySelector('.story-stage').replaceChildren();viewer.hidden=true;
      document.body.classList.remove('story-open');window.Telegram?.WebApp?.BackButton?.hide();
    }
    function step(direction) {
      if(!rows.length)return close();
      mi+=direction;
      if(mi>=count(rows[si])){si++;mi=0;}
      if(mi<0){si--;if(si>=0)mi=count(rows[si])-1;}
      if(si<0){si=0;mi=0;}
      if(si>=rows.length)return close();
      show();
    }
    function tick(time) {
      if(!opened || document.hidden)return;
      if(!live(rows[si]))return set(rows);
      const video=player();
      if(!paused && ready && !video)elapsed+=Math.max(0,time-last);
      last=time;
      const progress=video?(video.duration>0?video.currentTime/video.duration:0):elapsed/5000;
      viewer.querySelectorAll('.story-progress i').forEach((bar,i)=>{bar.style.transform=`scaleX(${i<mi?1:i===mi?Math.min(1,progress):0})`;});
      if(!video && elapsed>=5000)return step(1);
      raf=requestAnimationFrame(tick);
    }
    function show() {
      cancelAnimationFrame(raf);player()?.pause();
      const r=rows[si];if(!r || !live(r))return set(rows);
      elapsed=0;paused=false;ready=false;last=performance.now();
      const stage=viewer.querySelector('.story-stage'),m=slide();stage.replaceChildren();
      viewer.querySelector('.story-progress').innerHTML=Array.from({length:count(r)},()=>'<span><i></i></span>').join('');
      viewer.querySelector('.story-caption h2').textContent=r.title;
      viewer.querySelector('.story-caption p').textContent=r.body || '';
      viewer.querySelector('[data-story-sound]').hidden=!m?.mime?.startsWith('video/');viewer.querySelector('[data-story-sound]').textContent=sound?'Выключить звук':'Включить звук';
      viewer.querySelector('[data-story-pause]').textContent='Пауза';
      viewer.querySelector('.story-counter').textContent=`${si+1} / ${rows.length}`;
      if(m?.url && /^https:\/\//.test(m.url)) {
        if(m.mime?.startsWith('video/')) {
          const v=document.createElement('video');v.src=m.url;v.controls=true;v.playsInline=true;v.muted=!sound;v.preload='auto';stage.append(v);
          v.addEventListener('ended',()=>step(1));v.addEventListener('pause',()=>{if(v===player() && !document.hidden && !v.ended){paused=true;viewer.querySelector('[data-story-pause]').textContent='Смотреть';}});v.addEventListener('play',()=>{if(v===player()){paused=false;viewer.querySelector('[data-story-pause]').textContent='Пауза';}});v.addEventListener('loadeddata',()=>{ready=true;});
          v.play().catch(()=>{paused=true;viewer.querySelector('[data-story-pause]').textContent='Смотреть';});
        } else {
          const img=document.createElement('img');img.alt=r.title;img.onload=()=>{ready=true;};img.src=m.url;stage.append(img);
        }
      } else {const text=document.createElement('div');text.className='story-text-slide';text.textContent='RAMP';stage.append(text);ready=true;}
      stage.querySelector('img,video')?.addEventListener('error',()=>{ready=true;const p=document.createElement('p');p.className='story-media-error';p.textContent='Не удалось загрузить файл. Откройте историю снова или перейдите дальше.';stage.append(p);});
      seen[key(r)]=true;const keys=Object.keys(seen);if(keys.length>200)delete seen[keys[0]];
      try{localStorage.setItem('ramp:seen-stories',JSON.stringify(seen));}catch{}
      paintRail();raf=requestAnimationFrame(tick);
    }
    function open(index=0) {
      set(rows);if(!rows.length)return;
      si=Math.min(index,rows.length-1);mi=0;opened=true;viewer.hidden=false;document.body.classList.add('story-open');window.Telegram?.WebApp?.BackButton?.show();show();
      if(refresh)Promise.resolve(refresh()).then(d=>{set(d.stories || [],d.server_time);}).catch(()=>{});
    }
    rail.addEventListener('click',e=>{const b=e.target.closest('[data-story-index]');if(b)open(Number(b.dataset.storyIndex));});
    viewer.addEventListener('click',e=>{
      if(e.target.closest('[data-story-close]'))return close();
      if(e.target.closest('[data-story-next]'))return step(1);
      if(e.target.closest('[data-story-prev]'))return step(-1);
      if(e.target.closest('[data-story-sound]')){sound=!sound;const v=player();if(v)v.muted=!sound;e.target.closest('button').textContent=sound?'Выключить звук':'Включить звук';}
      if(e.target.closest('[data-story-pause]')){paused=!paused;const v=player();if(v){if(paused)v.pause();else v.play().catch(()=>{});}e.target.closest('button').textContent=paused?'Смотреть':'Пауза';}
    });
    document.addEventListener('visibilitychange',()=>{if(!opened)return;cancelAnimationFrame(raf);if(document.hidden)player()?.pause();else{last=performance.now();if(!paused)player()?.play().catch(()=>{});raf=requestAnimationFrame(tick);}});
    document.addEventListener('keydown',e=>{if(opened){if(e.key==='Escape')close();if(e.key==='ArrowRight')step(1);if(e.key==='ArrowLeft')step(-1);}});
    return {set,open,close,get isOpen(){return opened;}};
  }
  window.RampStories={create};
})();
